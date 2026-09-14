/**
 * Move every account we host to a NEUTRAL PDS hostname and handle domain
 * (MS §3, federation-phase ruling 3: `pds.freeskool.directory` / `*.freeskool.directory`).
 *
 *   pnpm --filter @freeschool/appview migrate-pds-hostname -- \
 *     --handle-domain=freeskool.directory --service-endpoint=https://pds.freeskool.directory
 *
 * Dry run by default. `--apply` writes. See `docs/runbooks/pds-hostname-migration.md`.
 *
 * ── THE MECHANISM, and why it is this one ────────────────────────────────────────
 *
 * A DID document names its PDS. Changing `PDS_HOSTNAME` on the server changes what the
 * PDS *serves*; it changes NOTHING in the DID documents already published to
 * plc.directory. Every existing account keeps pointing at the old endpoint until someone
 * signs a new PLC operation for it. The reference PDS never does that on its own — it is
 * not a migration tool, and there is no admin endpoint that says "republish everyone".
 *
 * The four candidate paths, and what each one actually does (read against
 * `@atproto/pds` 0.5.34, the image the dev stack runs):
 *
 *   a. `com.atproto.identity.updateHandle` (session) — `accountManager.updateHandle` →
 *      `plcClient.updateHandle` → `updateHandleOp`, which is
 *      `createUpdateOp(lastOp, …, n => ({ ...n, alsoKnownAs }))`. `n` is the normalized
 *      LAST OP, so `services` is copied forward verbatim. It refreshes the handle and
 *      ONLY the handle. It does not touch the service endpoint. (This is the thing worth
 *      checking before anything else, and the answer is no.)
 *   b. `com.atproto.identity.requestPlcOperationSignature` + `signPlcOperation` (session)
 *      — `signPlcOperation` throws `InvalidRequestError('email confirmation token
 *      required')` unless it can consume a `plc_operation` email token, which the PDS
 *      mails to the ACCOUNT's address. For a custodial member that is the member's own
 *      inbox. Unusable for an operator-run migration, and we would not want it: we do not
 *      ask 200 people to click a link so our hostname can change.
 *   c. `com.atproto.identity.submitPlcOperation` (session) — takes an ALREADY SIGNED op,
 *      no email token. It would work, but it needs a session per account (so: the
 *      custodial password for each, and an app password for the school/authority), and it
 *      insists `op.services.atproto_pds.endpoint === ctx.cfg.service.publicUrl`, i.e. the
 *      PDS must already be on the new hostname. Kept as the documented fallback.
 *   d. What this script does. Two writes per account, NEITHER of which needs a session, a
 *      password, or an email token:
 *
 *        1. THE ENDPOINT. We hold `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` — the very
 *           key the PDS signs its own PLC operations with, and the only key in
 *           `rotationKeys` for every account it created. So we build the update operation
 *           ourselves (`createUpdateOp`'s shape: normalize the last op, change
 *           `services.atproto_pds.endpoint`, set `prev` to the last op's CID, sign the
 *           dag-cbor with secp256k1/low-S) and POST it straight to plc.directory.
 *        2. THE HANDLE. `com.atproto.admin.updateAccountHandle`, authorized by the Basic
 *           `admin:<PDS_ADMIN_PASSWORD>` token this AppView already holds. In a PDS with
 *           no entryway it calls `accountManager.updateHandle(did, handle,
 *           { allowAnyValid: true })`, which signs the handle PLC op with the same
 *           rotation key, writes the PDS's own account row, and sequences an identity
 *           event onto the firehose.
 *
 *      Endpoint first, handle second, deliberately: step 2 is the one that emits the
 *      `#identity` event, so the event a relay sees follows the FINAL document rather
 *      than a half-migrated one.
 *
 * `com.atproto.admin.searchAccounts` rejects the Basic admin token (it wants a moderator
 * service auth), so the account list comes from `com.atproto.sync.listRepos` (public) +
 * `com.atproto.admin.getAccountInfos` (Basic admin), exactly as `src/lib/pds.ts` does.
 *
 * ── Idempotent and resumable ─────────────────────────────────────────────────────
 *
 * Every account is planned from its CURRENT state: an endpoint that already matches skips
 * step 1, a handle that already matches skips step 2, and an account whose rotation keys
 * no longer include ours (a member who took ownership and rotated) is reported, never
 * forced. Re-running after a crash, a rate limit or a partial batch does the remainder and
 * nothing else. `--limit` runs it in stages.
 *
 * Output is COUNTS ONLY (R9): no DID, handle or email ever reaches stdout.
 */
import crypto from 'node:crypto'
import { eq } from 'drizzle-orm'
import { encode as cborEncode } from '@atproto/lex-cbor'
import { closeDb, getDb } from '../src/db/index.js'
import { appMeta, custodialAccount } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { HANDLE_CACHE_KEY } from '../src/lib/handle-change.js'
import { isMain } from '../src/lib/is-main.js'

/* ────────────────────────────── PLC operation shapes ────────────────────────────── */

export interface PlcService {
  type: string
  endpoint: string
}

/** The modern `plc_operation`, as plc.directory stores and returns it. */
export interface PlcOperation {
  type: 'plc_operation'
  rotationKeys: string[]
  verificationMethods: Record<string, string>
  alsoKnownAs: string[]
  services: Record<string, PlcService>
  prev: string | null
  sig?: string
}

/** The pre-2023 genesis operation. Still the first entry in a few very old logs. */
interface LegacyCreateOperation {
  type: 'create'
  signingKey: string
  recoveryKey: string
  handle: string
  service: string
  prev: string | null
  sig?: string
}

type AnyOperation = PlcOperation | LegacyCreateOperation

export interface AuditEntry {
  cid: string
  operation: AnyOperation
  nullified?: boolean
}

const PDS_SERVICE_ID = 'atproto_pds'
const PDS_SERVICE_TYPE = 'AtprotoPersonalDataServer'

const ensureAtprotoPrefix = (handle: string) => (handle.startsWith('at://') ? handle : `at://${handle}`)
const ensureHttpPrefix = (url: string) => (/^https?:\/\//.test(url) ? url : `https://${url}`)

/**
 * `@did-plc/lib`'s `normalizeOp`, reimplemented (the package is not a dependency of this
 * workspace and pulling it in for one function is not worth the lockfile churn). Strips
 * the signature and lifts a legacy `create` into the modern shape, which is what
 * `createUpdateOp` feeds its mutator.
 */
export function normalizeOp(op: AnyOperation): Omit<PlcOperation, 'sig'> {
  if (op.type === 'plc_operation') {
    const { sig: _sig, ...rest } = op
    return { ...rest, type: 'plc_operation' }
  }
  if (op.type === 'create') {
    return {
      type: 'plc_operation',
      verificationMethods: { atproto: op.signingKey },
      rotationKeys: [op.recoveryKey, op.signingKey],
      alsoKnownAs: [ensureAtprotoPrefix(op.handle)],
      services: { [PDS_SERVICE_ID]: { type: PDS_SERVICE_TYPE, endpoint: ensureHttpPrefix(op.service) } },
      prev: op.prev,
    }
  }
  throw new Error(`unsupported PLC operation type: ${(op as { type: string }).type}`)
}

/* ─────────────────────────── the PDS rotation key, locally ─────────────────────── */

/** secp256k1 group order, for low-S normalization. */
const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58btc(buf: Buffer): string {
  let n = BigInt(`0x${buf.toString('hex') || '0'}`)
  let out = ''
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of buf) {
    if (b !== 0) break
    out = `1${out}`
  }
  return out
}

/**
 * Wrap a raw 32-byte secp256k1 private key in SEC1 DER so Node's `crypto` will import it.
 * The optional public-key field is omitted; OpenSSL derives it from the scalar.
 */
function sec1Der(privateKeyHex: string): Buffer {
  const priv = Buffer.from(privateKeyHex.replace(/^0x/, ''), 'hex')
  if (priv.length !== 32) throw new Error('rotation key must be 32 bytes of hex')
  const secp256k1Oid = Buffer.from('06052b8104000a', 'hex') // 1.3.132.0.10
  const body = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]), // version 1
    Buffer.from([0x04, 0x20]),
    priv,
    Buffer.from([0xa0, secp256k1Oid.length]),
    secp256k1Oid,
  ])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

export interface RotationKey {
  /** `did:key:zQ3s…` — what `rotationKeys` in the DID document must contain. */
  didKey: string
  /** base64url, 64-byte compact r||s, low-S. What PLC verifies. */
  sign(bytes: Uint8Array): string
}

export function rotationKeyFromHex(privateKeyHex: string): RotationKey {
  const key = crypto.createPrivateKey({ key: sec1Der(privateKeyHex), format: 'der', type: 'sec1' })
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' })
  // SPKI for an EC key ends in the uncompressed point: 0x04 || X(32) || Y(32).
  const point = spki.subarray(spki.length - 65)
  if (point[0] !== 0x04) throw new Error('unexpected public key encoding for the rotation key')
  const compressed = Buffer.concat([Buffer.from([(point[64]! & 1) === 0 ? 0x02 : 0x03]), point.subarray(1, 33)])
  // multicodec secp256k1-pub = 0xe7 0x01, then base58btc with the `z` multibase prefix.
  const didKey = `did:key:z${base58btc(Buffer.concat([Buffer.from([0xe7, 0x01]), compressed]))}`
  return {
    didKey,
    sign(bytes: Uint8Array): string {
      const raw = crypto.sign('sha256', bytes, { key, dsaEncoding: 'ieee-p1363' })
      const r = raw.subarray(0, 32)
      let s = BigInt(`0x${Buffer.from(raw.subarray(32)).toString('hex')}`)
      // PLC (like atproto's own signer) requires the canonical low-S form.
      if (s > SECP256K1_N / 2n) s = SECP256K1_N - s
      const sBytes = Buffer.from(s.toString(16).padStart(64, '0'), 'hex')
      return Buffer.concat([r, sBytes]).toString('base64url')
    },
  }
}

/**
 * `@did-plc/lib`'s `createUpdateOp`, minus the CID computation: plc.directory's audit log
 * already tells us the CID of the entry we are chaining onto, so `prev` is a lookup rather
 * than a dag-cbor hash we have to reproduce.
 */
export function buildUpdateOp(
  last: AuditEntry,
  key: RotationKey,
  mutate: (op: Omit<PlcOperation, 'sig'>) => Omit<PlcOperation, 'sig' | 'prev'>,
): PlcOperation {
  const normalized = normalizeOp(last.operation)
  const unsigned = { ...mutate(normalized), prev: last.cid }
  // `@atproto/lex-cbor`'s `LexValue` models a *record*, whose nested objects it types as
  // `LexValue` maps; a PLC operation's `services` is `Record<string, {type, endpoint}>`,
  // which is structurally fine dag-cbor but not that type. The encoding is canonical
  // either way (sorted keys, definite lengths) — which is what PLC verifies against — so
  // the cast is about the type model, not about the bytes.
  const bytes = cborEncode(unsigned as unknown as Parameters<typeof cborEncode>[0])
  return { ...unsigned, sig: key.sign(bytes) }
}

export const withEndpoint = (endpoint: string) => (op: Omit<PlcOperation, 'sig'>) => ({
  ...op,
  services: { ...op.services, [PDS_SERVICE_ID]: { type: PDS_SERVICE_TYPE, endpoint: ensureHttpPrefix(endpoint) } },
})

/* ──────────────────────────────────── ports ─────────────────────────────────────── */

export interface PlcPort {
  /** The newest non-nullified audit entry, with its CID. */
  lastOp(did: string): Promise<AuditEntry>
  submit(did: string, op: PlcOperation): Promise<void>
  /** The resolved DID document, for verification. */
  document(did: string): Promise<{ alsoKnownAs?: string[]; service?: Array<{ id: string; serviceEndpoint: string }> }>
}

export interface PdsPort {
  /** Every repo hosted here. */
  listRepos(): Promise<string[]>
  /** `did → handle`, admin-side, in batches. */
  accountInfos(dids: string[]): Promise<Array<{ did: string; handle: string }>>
  /** `com.atproto.admin.updateAccountHandle` (Basic admin). Signs the handle PLC op. */
  updateAccountHandle(did: string, handle: string): Promise<void>
  resolveHandle(handle: string): Promise<string | null>
}

/** Only what the DB writes need, so tests can pass a recorder. */
export interface StorePort {
  setCustodialHandle(did: string, handle: string): Promise<number>
  setCachedHandle(did: string, handle: string): Promise<void>
  custodialDids(): Promise<Set<string>>
}

/* ─────────────────────────────────── planning ───────────────────────────────────── */

export type AccountKind = 'school' | 'authority' | 'custodial' | 'other'

/** A "nothing to do here" plan still carries a reason, so the counts explain themselves. */
export type SkipReason = 'already-migrated' | 'foreign-rotation-key' | 'not-selected' | 'handle-taken'

export interface Account {
  did: string
  /** As the PDS believes it. */
  handle: string
}

export interface PlanEntry {
  did: string
  kind: AccountKind
  currentHandle: string
  newHandle: string
  /** false when the DID document already names the target endpoint. */
  needsEndpoint: boolean
  /** false when the DID document AND the PDS already name the target handle. */
  needsHandle: boolean
  skip?: SkipReason
}

export interface PlanOptions {
  /** No leading dot. `freeskool.directory`. */
  handleDomain: string
  /** `https://pds.freeskool.directory` */
  serviceEndpoint: string
  schoolDid: string
  authorityDid: string
  /** Ruling 3: the school account becomes `boulder.<domain>`. */
  schoolLabel: string
  /** Ruling 3: the taxonomy authority becomes `skills.<domain>`. */
  authorityLabel: string
  accounts: 'custodial' | 'all'
  /**
   * Restrict the run to these DIDs. Two uses: retrying the handful of accounts a partial
   * run left behind, and the dev rehearsal, which must move ONE throwaway account and
   * leave every other dev identity alone.
   */
  only?: Set<string>
}

export function accountKind(did: string, opts: Pick<PlanOptions, 'schoolDid' | 'authorityDid'>, custodial: Set<string>): AccountKind {
  if (did && did === opts.schoolDid) return 'school'
  if (did && did === opts.authorityDid) return 'authority'
  return custodial.has(did) ? 'custodial' : 'other'
}

/**
 * The new handle for one account. Custodial members keep their PREFIX — the handle is the
 * name they chose (or were given) and the migration is not an occasion to change it — and
 * only the domain moves. The school and the authority take the labels ruling 3 fixes,
 * because `boulder.freeskool.xyz` is being freed for the city app host and `skills.…` is
 * the taxonomy authority's published name.
 */
export function plannedHandle(account: Account, kind: AccountKind, opts: Pick<PlanOptions, 'handleDomain' | 'schoolLabel' | 'authorityLabel'>): string {
  const domain = opts.handleDomain.replace(/^\./, '').toLowerCase()
  if (kind === 'school') return `${opts.schoolLabel}.${domain}`
  if (kind === 'authority') return `${opts.authorityLabel}.${domain}`
  const prefix = account.handle.split('.')[0] ?? ''
  if (!prefix) throw new Error('cannot derive a handle prefix')
  return `${prefix}.${domain}`
}

export interface CurrentState {
  /** `services.atproto_pds.endpoint` as published. */
  endpoint: string | undefined
  /** `alsoKnownAs[0]` without the `at://`, as published. */
  publishedHandle: string | undefined
  rotationKeys: string[]
}

/**
 * `--accounts=custodial` means the accounts we custody PLUS the two institutional ones —
 * a member who has taken ownership of their identity is not ours to move by default, and
 * `--accounts=all` is the deliberate opt-in that includes them. `--only` narrows further.
 */
export function selected(did: string, kind: AccountKind, opts: Pick<PlanOptions, 'accounts' | 'only'>): boolean {
  if (opts.only && !opts.only.has(did)) return false
  return opts.accounts === 'all' || kind !== 'other'
}

export function planAccount(
  account: Account,
  kind: AccountKind,
  state: CurrentState,
  opts: PlanOptions,
  rotationDidKey: string,
): PlanEntry {
  const newHandle = plannedHandle(account, kind, opts)
  const endpoint = ensureHttpPrefix(opts.serviceEndpoint)
  const base: PlanEntry = {
    did: account.did,
    kind,
    currentHandle: account.handle,
    newHandle,
    needsEndpoint: state.endpoint !== endpoint,
    needsHandle: state.publishedHandle !== newHandle || account.handle !== newHandle,
  }
  if (!selected(account.did, kind, opts)) return { ...base, needsEndpoint: false, needsHandle: false, skip: 'not-selected' }
  if (!base.needsEndpoint && !base.needsHandle) return { ...base, skip: 'already-migrated' }
  // The PDS signs with OUR rotation key and so do we; an account that rotated its keys
  // away (a member who took ownership) can only be moved by its owner. Report, never force.
  if (!state.rotationKeys.includes(rotationDidKey)) return { ...base, needsEndpoint: false, needsHandle: false, skip: 'foreign-rotation-key' }
  return base
}

/* ─────────────────────────────────── verification ───────────────────────────────── */

export interface VerifyResult {
  ok: boolean
  endpointOk: boolean
  handleOk: boolean
  resolvesOk: boolean
}

export async function verifyAccount(entry: PlanEntry, plc: PlcPort, pds: PdsPort, serviceEndpoint: string): Promise<VerifyResult> {
  const doc = await plc.document(entry.did)
  const endpoint = doc.service?.find((s) => s.id === '#atproto_pds' || s.id.endsWith(PDS_SERVICE_ID))?.serviceEndpoint
  const endpointOk = endpoint === ensureHttpPrefix(serviceEndpoint)
  const handleOk = (doc.alsoKnownAs ?? []).includes(`at://${entry.newHandle}`)
  const resolvesOk = (await pds.resolveHandle(entry.newHandle)) === entry.did
  return { ok: endpointOk && handleOk && resolvesOk, endpointOk, handleOk, resolvesOk }
}

/* ──────────────────────────────────── the run ───────────────────────────────────── */

export interface MigrationCounts {
  considered: number
  planned: number
  endpointUpdated: number
  handleUpdated: number
  verified: number
  failedVerification: number
  failed: number
  skipped: Record<SkipReason, number>
  byKind: Record<AccountKind, number>
}

const emptyCounts = (): MigrationCounts => ({
  considered: 0,
  planned: 0,
  endpointUpdated: 0,
  handleUpdated: 0,
  verified: 0,
  failedVerification: 0,
  failed: 0,
  skipped: { 'already-migrated': 0, 'foreign-rotation-key': 0, 'not-selected': 0, 'handle-taken': 0 },
  byKind: { school: 0, authority: 0, custodial: 0, other: 0 },
})

export interface RunOptions extends PlanOptions {
  apply: boolean
  limit?: number
  /** Absent in a dry run; required to sign. */
  key?: RotationKey
}

export interface Ports {
  plc: PlcPort
  pds: PdsPort
  store: StorePort
}

export async function migratePdsHostname(opts: RunOptions, ports: Ports): Promise<MigrationCounts> {
  const counts = emptyCounts()
  const custodial = await ports.store.custodialDids()
  const dids = await ports.pds.listRepos()
  const infos = await ports.pds.accountInfos(dids)
  const rotationDidKey = opts.key?.didKey ?? ''

  const plan: PlanEntry[] = []
  for (const info of infos) {
    counts.considered += 1
    const kind = accountKind(info.did, opts, custodial)
    // Selection BEFORE the network round trip: on a PDS with a thousand repos, reading
    // every audit log to discover we wanted none of them costs a minute for nothing.
    if (!selected(info.did, kind, opts)) {
      counts.skipped['not-selected'] += 1
      continue
    }
    let state: CurrentState
    try {
      const last = await ports.plc.lastOp(info.did)
      const normalized = normalizeOp(last.operation)
      state = {
        endpoint: normalized.services[PDS_SERVICE_ID]?.endpoint,
        publishedHandle: normalized.alsoKnownAs[0]?.replace(/^at:\/\//, ''),
        rotationKeys: normalized.rotationKeys,
      }
    } catch {
      counts.failed += 1
      continue
    }
    const entry = planAccount(info, kind, state, opts, rotationDidKey)
    if (entry.skip) {
      counts.skipped[entry.skip] += 1
      continue
    }
    counts.byKind[kind] += 1
    plan.push(entry)
    if (opts.limit && plan.length >= opts.limit) break
  }
  counts.planned = plan.length

  if (!opts.apply) return counts

  const key = opts.key
  if (!key) throw new Error('--apply needs PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX')

  for (const entry of plan) {
    try {
      // 1. The endpoint: our own signed PLC operation, straight to the directory.
      if (entry.needsEndpoint) {
        const last = await ports.plc.lastOp(entry.did)
        await ports.plc.submit(entry.did, buildUpdateOp(last, key, withEndpoint(opts.serviceEndpoint)))
        counts.endpointUpdated += 1
      }
      // 2. The handle: the PDS's own admin path, which also sequences the identity event.
      if (entry.needsHandle) {
        await ports.pds.updateAccountHandle(entry.did, entry.newHandle)
        counts.handleUpdated += 1
        const rows = await ports.store.setCustodialHandle(entry.did, entry.newHandle)
        if (rows > 0) await ports.store.setCachedHandle(entry.did, entry.newHandle)
      }
    } catch {
      counts.failed += 1
      continue
    }
    const verdict = await verifyAccount(entry, ports.plc, ports.pds, opts.serviceEndpoint).catch(() => null)
    if (verdict?.ok) counts.verified += 1
    else counts.failedVerification += 1
  }
  return counts
}

/* ───────────────────────────── real ports (HTTP + Postgres) ─────────────────────── */

export function httpPlc(plcUrl: string): PlcPort {
  const base = plcUrl.replace(/\/$/, '')
  return {
    async lastOp(did) {
      const res = await fetch(`${base}/${encodeURIComponent(did)}/log/audit`)
      if (!res.ok) throw new Error(`PLC audit log failed: ${res.status}`)
      const log = (await res.json()) as AuditEntry[]
      const live = log.filter((e) => !e.nullified)
      const last = live[live.length - 1]
      if (!last) throw new Error('empty PLC audit log')
      return last
    },
    async submit(did, op) {
      const res = await fetch(`${base}/${encodeURIComponent(did)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
      })
      if (!res.ok) throw new Error(`PLC submit failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    },
    async document(did) {
      const res = await fetch(`${base}/${encodeURIComponent(did)}`)
      if (!res.ok) throw new Error(`PLC document failed: ${res.status}`)
      return (await res.json()) as { alsoKnownAs?: string[]; service?: Array<{ id: string; serviceEndpoint: string }> }
    },
  }
}

export function httpPds(pdsUrl: string, adminPassword: string): PdsPort {
  const base = pdsUrl.replace(/\/$/, '')
  const auth = `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`
  return {
    async listRepos() {
      const dids: string[] = []
      let cursor: string | undefined
      do {
        const url = new URL('/xrpc/com.atproto.sync.listRepos', base)
        url.searchParams.set('limit', '500')
        if (cursor) url.searchParams.set('cursor', cursor)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`listRepos failed: ${res.status}`)
        const json = (await res.json()) as { repos?: Array<{ did?: string }>; cursor?: string }
        for (const r of json.repos ?? []) if (r.did) dids.push(r.did)
        cursor = json.cursor && (json.repos?.length ?? 0) > 0 ? json.cursor : undefined
      } while (cursor)
      return dids
    },
    async accountInfos(dids) {
      const out: Array<{ did: string; handle: string }> = []
      for (let i = 0; i < dids.length; i += 50) {
        const url = new URL('/xrpc/com.atproto.admin.getAccountInfos', base)
        for (const did of dids.slice(i, i + 50)) url.searchParams.append('dids', did)
        const res = await fetch(url, { headers: { authorization: auth } })
        if (!res.ok) throw new Error(`getAccountInfos failed: ${res.status}`)
        const json = (await res.json()) as { infos?: Array<{ did?: string; handle?: string }> }
        for (const info of json.infos ?? []) if (info.did && info.handle) out.push({ did: info.did, handle: info.handle })
      }
      return out
    },
    async updateAccountHandle(did, handle) {
      const res = await fetch(`${base}/xrpc/com.atproto.admin.updateAccountHandle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: auth },
        body: JSON.stringify({ did, handle }),
      })
      if (!res.ok) throw new Error(`updateAccountHandle failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    },
    async resolveHandle(handle) {
      const url = new URL('/xrpc/com.atproto.identity.resolveHandle', base)
      url.searchParams.set('handle', handle)
      const res = await fetch(url)
      if (!res.ok) return null
      return ((await res.json()) as { did?: string }).did ?? null
    },
  }
}

export function postgresStore(): StorePort {
  return {
    async custodialDids() {
      const rows = await getDb().select({ did: custodialAccount.did }).from(custodialAccount)
      return new Set(rows.map((r) => r.did))
    },
    async setCustodialHandle(did, handle) {
      const res = await getDb().update(custodialAccount).set({ handle }).where(eq(custodialAccount.did, did))
      return res.rowCount ?? 0
    },
    async setCachedHandle(did, handle) {
      const now = new Date()
      const value = { handle, resolvedAt: now.toISOString() }
      await getDb()
        .insert(appMeta)
        .values({ key: HANDLE_CACHE_KEY(did), value, updatedAt: now })
        .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
    },
  }
}

/* ─────────────────────────────────────── CLI ────────────────────────────────────── */

function flag(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
}

/**
 * Dev-only affordance for the rehearsal in the runbook: mint a throwaway account through
 * the ordinary signup path (admin invite code → `com.atproto.server.createAccount`) so the
 * real run has something of its own to move. Refuses against anything but a loopback PDS.
 */
async function createRehearsalAccount(pdsUrl: string, adminPassword: string, prefix: string, domain: string): Promise<void> {
  const host = new URL(pdsUrl).hostname
  if (host !== 'localhost' && host !== '127.0.0.1') throw new Error('--create-rehearsal-account is only allowed against a loopback PDS')
  const auth = `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}`
  const invite = await fetch(`${pdsUrl.replace(/\/$/, '')}/xrpc/com.atproto.server.createInviteCode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ useCount: 1 }),
  })
  if (!invite.ok) throw new Error(`createInviteCode failed: ${invite.status}`)
  const { code } = (await invite.json()) as { code: string }
  const res = await fetch(`${pdsUrl.replace(/\/$/, '')}/xrpc/com.atproto.server.createAccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `${prefix}@rehearsal.invalid`,
      handle: `${prefix}.${domain.replace(/^\./, '')}`,
      password: crypto.randomBytes(24).toString('hex'),
      inviteCode: code,
    }),
  })
  if (!res.ok) throw new Error(`createAccount failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const { did, handle } = (await res.json()) as { did: string; handle: string }
  // The ONE place this script prints an identifier, and only for a loopback PDS: the
  // rehearsal needs to know which throwaway DID to watch.
  console.log(`rehearsal account: ${handle} ${did}`)
}

export async function main(): Promise<number> {
  const c = config()
  const apply = process.argv.includes('--apply')
  const handleDomain = (flag('handle-domain') || '').replace(/^\./, '')
  if (!handleDomain) {
    console.error('usage: migrate-pds-hostname --handle-domain=<domain> [--service-endpoint=<url>] [--accounts=custodial|all] [--only=<did,did>] [--limit=N] [--apply]')
    return 1
  }
  const pdsUrl = flag('pds') || c.PDS_URL
  const serviceEndpoint = flag('service-endpoint') || c.PDS_URL
  const plcUrl = flag('plc') || 'https://plc.directory'
  const accounts = flag('accounts') === 'all' ? 'all' : 'custodial'
  const limitRaw = flag('limit')
  const onlyRaw = flag('only')
  const adminPassword = c.PDS_ADMIN_PASSWORD
  if (!adminPassword) {
    console.error('PDS_ADMIN_PASSWORD is not set')
    return 1
  }

  const rehearsal = flag('create-rehearsal-account')
  if (rehearsal) {
    await createRehearsalAccount(pdsUrl, adminPassword, rehearsal, handleDomain)
    return 0
  }

  const keyHex = process.env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX ?? ''
  if (apply && !keyHex) {
    console.error('PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX is not set; it is what signs the endpoint operation')
    return 1
  }
  // Even a dry run wants the key: without it we cannot tell "we can move this" from
  // "this account rotated its keys away", and the plan would over-promise.
  const key = keyHex ? rotationKeyFromHex(keyHex) : undefined

  const opts: RunOptions = {
    apply,
    handleDomain,
    serviceEndpoint,
    schoolDid: c.SCHOOL_DID,
    authorityDid: c.AUTHORITY_DID,
    schoolLabel: flag('school-label') || 'boulder',
    authorityLabel: flag('authority-label') || 'skills',
    accounts,
    only: onlyRaw ? new Set(onlyRaw.split(',').map((d) => d.trim()).filter(Boolean)) : undefined,
    limit: limitRaw ? Number(limitRaw) : undefined,
    key,
  }

  const counts = await migratePdsHostname(opts, {
    plc: httpPlc(plcUrl),
    pds: httpPds(pdsUrl, adminPassword),
    store: postgresStore(),
  })

  const skipped = Object.entries(counts.skipped).filter(([, n]) => n > 0)
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} → ${handleDomain} @ ${serviceEndpoint} (accounts=${accounts})`)
  console.log(`considered=${counts.considered} planned=${counts.planned}`)
  console.log(`  by kind: ${Object.entries(counts.byKind).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`)
  console.log(`  skipped: ${skipped.map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`)
  if (apply) {
    console.log(`endpoint-ops=${counts.endpointUpdated} handle-ops=${counts.handleUpdated}`)
    console.log(`verified=${counts.verified} failed-verification=${counts.failedVerification} failed=${counts.failed}`)
  } else if (counts.failed > 0) {
    console.log(`unreadable=${counts.failed}`)
  }
  return counts.failed + counts.failedVerification > 0 ? 2 : 0
}

if (isMain(import.meta.url)) {
  const code = await main()
  await closeDb()
  process.exit(code)
}
