/**
 * Move every account we host to a NEUTRAL PDS hostname and handle domain
 * (MS §3, federation-phase ruling 3: `pds.freeskool.directory` / `*.freeskool.directory`).
 *
 *   pnpm --filter @freeschool/appview migrate-pds-hostname -- \
 *     --handle-domain=freeskool.directory \
 *     --service-endpoint=https://pds.freeskool.directory --apply
 *
 * Dry run unless `--apply`. See `docs/runbooks/pds-hostname-migration.md`.
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
 * ── Safety rails, because this writes a permanent public record ──────────────────
 *
 * `--service-endpoint` is REQUIRED and checked before anything is signed: https, no
 * loopback or private address, no path, and its host must match the PDS we are talking to.
 * There is no default, because the default would have been `config().PDS_URL`, whose own
 * default is `http://localhost:3000` — one unset variable away from writing a loopback
 * endpoint into every production DID document, permanently. `--allow-loopback-endpoint`
 * opts out, and only when the PDS is loopback too (the dev rehearsal).
 *
 * The rotation key is required for a DRY RUN as well as an apply: without it we cannot
 * tell "this account rotated its keys away from us" from "we do not have the key", and a
 * plan that cannot tell those apart is a plan that lies.
 *
 * ── Idempotent, resumable, repairable ───────────────────────────────────────────
 *
 * Every account is planned from its CURRENT published state: an endpoint that already
 * matches skips step 1, a handle that already matches skips step 2, and an account whose
 * DID document is already right but whose `fs_custodial_account` row is not (a crash
 * between the PLC write and the database write) is REPAIRED — that is what `db-repaired`
 * counts. Re-running after a crash, a rate limit or a partial batch does the remainder and
 * nothing else. `--limit` runs it in stages; `--only` retries named accounts.
 *
 * Output is COUNTS ONLY on stdout (R9). Per-account failures go to stderr with a
 * TRUNCATED DID and a reason — enough to find the account in an operator's own notes,
 * never a full identifier, and never a handle or an email.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { encode as cborEncode } from '@atproto/lex-cbor'
import { closeDb, getDb } from '../src/db/index.js'
import { appMeta, custodialAccount, school } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { HANDLE_CACHE_KEY } from '../src/lib/handle-change.js'
import { RESERVED_LABELS } from '../src/lib/handles.js'
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

/** One spelling of an endpoint, so "already migrated" is never a trailing-slash question. */
export const normalizeEndpoint = (url: string) => ensureHttpPrefix(url.trim()).replace(/\/+$/, '')

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
export function sec1Der(privateKeyHex: string): Buffer {
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
  services: { ...op.services, [PDS_SERVICE_ID]: { type: PDS_SERVICE_TYPE, endpoint: normalizeEndpoint(endpoint) } },
})

/* ─────────────────────── the endpoint guard (blocking review #3) ────────────────── */

/**
 * RFC1918, loopback, link-local and the reserved TLDs. A DID document is permanent and
 * world-readable: an endpoint nobody outside this machine can dial is not a typo you get
 * to fix, it is a repo the network can never reach again until somebody signs N more
 * operations.
 */
const PRIVATE_HOST_RE =
  /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i
const RESERVED_TLD_RE = /\.(test|test2|localhost|local|internal|invalid|example|alt|onion|home|lan)$/i

export function isLoopbackHost(hostname: string): boolean {
  return /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$/i.test(hostname)
}

export type EndpointVerdict = { ok: true; endpoint: string } | { ok: false; reason: string }

export function checkServiceEndpoint(
  raw: string,
  opts: { pdsHost: string; allowLoopback: boolean },
): EndpointVerdict {
  let url: URL
  try {
    url = new URL(normalizeEndpoint(raw))
  } catch {
    return { ok: false, reason: '--service-endpoint is not a URL' }
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return { ok: false, reason: '--service-endpoint must be a bare origin (no path, query or fragment)' }
  }
  const endpoint = normalizeEndpoint(url.toString())
  // The escape hatch is not "trust me": it only opens when BOTH ends are loopback, which
  // is exactly the dev rehearsal and cannot be a production deployment by construction.
  if (opts.allowLoopback) {
    if (!isLoopbackHost(url.hostname)) return { ok: false, reason: '--allow-loopback-endpoint but the endpoint is not loopback' }
    if (!isLoopbackHost(opts.pdsHost.replace(/:\d+$/, ''))) {
      return { ok: false, reason: '--allow-loopback-endpoint but the PDS is not loopback — refusing' }
    }
    return { ok: true, endpoint }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: '--service-endpoint must be https (or --allow-loopback-endpoint on a dev PDS)' }
  if (PRIVATE_HOST_RE.test(url.hostname)) return { ok: false, reason: '--service-endpoint is a loopback or private address' }
  if (RESERVED_TLD_RE.test(url.hostname)) return { ok: false, reason: '--service-endpoint uses a reserved TLD' }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.startsWith('[')) {
    return { ok: false, reason: '--service-endpoint must be a hostname, not an IP literal' }
  }
  if (url.host !== opts.pdsHost) {
    return { ok: false, reason: `--service-endpoint host does not match the PDS we are talking to (${opts.pdsHost})` }
  }
  return { ok: true, endpoint }
}

/* ──────────────────────────────────── ports ─────────────────────────────────────── */

export interface PlcPort {
  /** The newest non-nullified audit entry, with its CID. */
  lastOp(did: string): Promise<AuditEntry>
  /** The whole audit log, for `--snapshot`. */
  auditLog(did: string): Promise<AuditEntry[]>
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
  /**
   * `https://<handle>/.well-known/atproto-did`, over the PUBLIC name — the path the rest
   * of the network actually takes. Distinct from `resolveHandle`, which asks our own PDS
   * and so can say yes while DNS, Caddy or the certificate says no.
   */
  wellKnownDid(handle: string): Promise<string | null>
}

/** Only what the DB reads and writes need, so tests can pass a recorder. */
export interface StorePort {
  /** `did → handle` for every account we custody. */
  custodialAccounts(): Promise<Map<string, string>>
  /** `did → label` for every school this deployment hosts (`fs_school`). */
  schools(): Promise<Map<string, string>>
  setCustodialHandle(did: string, handle: string): Promise<number>
  setCachedHandle(did: string, handle: string): Promise<void>
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
  /** true when the identity is right but `fs_custodial_account` / the cache is not. */
  needsDb: boolean
  skip?: SkipReason
}

export interface PlanOptions {
  /** No leading dot. `freeskool.directory`. */
  handleDomain: string
  /** `https://pds.freeskool.directory`, already through `checkServiceEndpoint`. */
  serviceEndpoint: string
  /** `did → label` for every school. A school actor's handle is `<label>.<domain>`. */
  schools: Map<string, string>
  authorityDid: string
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

export function accountKind(did: string, opts: Pick<PlanOptions, 'schools' | 'authorityDid'>, custodial: Set<string>): AccountKind {
  if (opts.schools.has(did)) return 'school'
  if (did && did === opts.authorityDid) return 'authority'
  return custodial.has(did) ? 'custodial' : 'other'
}

/**
 * `--accounts=custodial` means the accounts we custody PLUS the institutional ones — a
 * member who has taken ownership of their identity is not ours to move by default, and
 * `--accounts=all` is the deliberate opt-in that includes them. `--only` narrows further.
 */
export function selected(did: string, kind: AccountKind, opts: Pick<PlanOptions, 'accounts' | 'only'>): boolean {
  if (opts.only && !opts.only.has(did)) return false
  return opts.accounts === 'all' || kind !== 'other'
}

/**
 * The new handle for one account. Custodial members keep their PREFIX — the handle is the
 * name they chose (or were given) and the migration is not an occasion to change it — and
 * only the domain moves. A SCHOOL takes its own label from `fs_school`, which is what
 * makes this correct for a second school: Denver's actor becomes `denver.<domain>`, not
 * whatever prefix its handle happens to carry. The authority takes the label ruling 3
 * fixes, because `skills.<domain>` is the taxonomy authority's published name.
 */
export function plannedHandle(account: Account, kind: AccountKind, opts: Pick<PlanOptions, 'handleDomain' | 'schools' | 'authorityLabel'>): string {
  const domain = opts.handleDomain.replace(/^\./, '').toLowerCase()
  if (kind === 'school') {
    const label = opts.schools.get(account.did)
    if (!label) throw new Error('a school account with no label in fs_school')
    return `${label}.${domain}`
  }
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
  /** `fs_custodial_account.handle`, or undefined for an account we do not custody. */
  storedHandle?: string
}

export function planAccount(
  account: Account,
  kind: AccountKind,
  state: CurrentState,
  opts: PlanOptions,
  rotationDidKey: string,
): PlanEntry {
  const newHandle = plannedHandle(account, kind, opts)
  const endpoint = normalizeEndpoint(opts.serviceEndpoint)
  const base: PlanEntry = {
    did: account.did,
    kind,
    currentHandle: account.handle,
    newHandle,
    needsEndpoint: normalizeEndpoint(state.endpoint ?? '') !== endpoint,
    needsHandle: state.publishedHandle !== newHandle || account.handle !== newHandle,
    // A crash between the PLC write and the database write leaves the identity right and
    // the app serving a stale handle. That is repairable and must be repaired, not
    // reported as "already migrated" and left.
    needsDb: state.storedHandle !== undefined && state.storedHandle !== newHandle,
  }
  if (!selected(account.did, kind, opts)) return { ...base, needsEndpoint: false, needsHandle: false, needsDb: false, skip: 'not-selected' }
  if (!base.needsEndpoint && !base.needsHandle && !base.needsDb) return { ...base, skip: 'already-migrated' }
  // The PDS signs with OUR rotation key and so do we; an account that rotated its keys
  // away (a member who took ownership) can only be moved by its owner. Report, never
  // force. A DB-only repair does not need any key, so it survives this.
  if (!state.rotationKeys.includes(rotationDidKey)) {
    return base.needsDb
      ? { ...base, needsEndpoint: false, needsHandle: false }
      : { ...base, needsEndpoint: false, needsHandle: false, needsDb: false, skip: 'foreign-rotation-key' }
  }
  return base
}

/**
 * What handle EVERY account on the PDS would end up with, whether or not it is actually
 * in `plan` — a "not-selected" account (`--accounts=custodial` skipping someone who took
 * ownership), a "foreign-rotation-key" one, or one this batch simply has not reached yet
 * because of `--limit`, still occupies (or will occupy) a name on the target domain, and
 * `markCollisions` has to know that BEFORE anything is signed. `accounts` is every DID
 * `ports.pds.accountInfos` returned — i.e. the whole PDS, never a narrowed set.
 */
export function targetHandleUniverse(
  accounts: Account[],
  opts: Pick<PlanOptions, 'handleDomain' | 'schools' | 'authorityDid' | 'authorityLabel'>,
  custodial: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>()
  for (const account of accounts) {
    const kind = accountKind(account.did, opts, custodial)
    try {
      out.set(account.did, plannedHandle(account, kind, opts))
    } catch {
      /* an account with no derivable prefix cannot collide with anything */
    }
  }
  return out
}

/**
 * Collisions, before a single operation is signed. Two members whose prefixes differ only
 * by the domain they are on would land on one handle; a member whose prefix is a reserved
 * label (`boulder`, `skills`, `www`…) would land on a name the school, the authority or
 * the app already owns. Either one means `admin.updateAccountHandle` fails halfway through
 * a batch, so we refuse the whole run instead.
 *
 * `universe` (optional, did → the handle that account would land on) widens the check
 * beyond `plan` itself: a plan entry that collides with an account this batch never
 * selected, or cut off with `--limit`, is caught here too — not discovered as an
 * `updateAccountHandle` failure on THIS run, or silently as a collision on the NEXT one
 * once the other side finally gets its turn.
 */
export function markCollisions(
  plan: PlanEntry[],
  reserved: ReadonlySet<string>,
  universe: ReadonlyMap<string, string> = new Map(),
): PlanEntry[] {
  // One entry per DID: a plan entry's own (freshly computed) target handle wins over
  // whatever `universe` says for that same DID, but every OTHER DID's hypothetical
  // target still counts — that is the whole point of passing `universe` in.
  const byDid = new Map(universe)
  for (const e of plan) byDid.set(e.did, e.newHandle)
  const seen = new Map<string, number>()
  for (const handle of byDid.values()) seen.set(handle, (seen.get(handle) ?? 0) + 1)
  return plan.map((e) => {
    if (e.skip) return e
    const prefix = e.newHandle.split('.')[0]!
    const duplicated = (seen.get(e.newHandle) ?? 0) > 1
    // A school's or the authority's own reserved label is the POINT, not a collision.
    const stealsReserved = (e.kind === 'custodial' || e.kind === 'other') && reserved.has(prefix)
    return duplicated || stealsReserved ? { ...e, skip: 'handle-taken' as const, needsEndpoint: false, needsHandle: false, needsDb: false } : e
  })
}

/* ─────────────────────────────────── verification ───────────────────────────────── */

export interface VerifyResult {
  ok: boolean
  endpointOk: boolean
  handleOk: boolean
  resolvesOk: boolean
  /** `https://<new handle>/.well-known/atproto-did` over the public name. */
  externalOk: boolean
  /** The old handle must not resolve to somebody ELSE. Gone, or still us, are both fine. */
  oldHandleOk: boolean
}

export async function verifyAccount(
  entry: PlanEntry,
  plc: PlcPort,
  pds: PdsPort,
  serviceEndpoint: string,
  opts: { skipExternal: boolean } = { skipExternal: false },
): Promise<VerifyResult> {
  const doc = await plc.document(entry.did)
  const endpoint = doc.service?.find((s) => s.id === '#atproto_pds' || s.id.endsWith(PDS_SERVICE_ID))?.serviceEndpoint
  const endpointOk = normalizeEndpoint(endpoint ?? '') === normalizeEndpoint(serviceEndpoint)
  const handleOk = (doc.alsoKnownAs ?? []).includes(`at://${entry.newHandle}`)
  const resolvesOk = (await pds.resolveHandle(entry.newHandle)) === entry.did
  const externalOk = opts.skipExternal ? true : (await pds.wellKnownDid(entry.newHandle)) === entry.did
  let oldHandleOk = true
  if (entry.currentHandle !== entry.newHandle) {
    const old = await pds.resolveHandle(entry.currentHandle)
    oldHandleOk = old === null || old === entry.did
  }
  return { ok: endpointOk && handleOk && resolvesOk && externalOk && oldHandleOk, endpointOk, handleOk, resolvesOk, externalOk, oldHandleOk }
}

/* ──────────────────────────────────── the run ───────────────────────────────────── */

export interface MigrationCounts {
  considered: number
  planned: number
  endpointUpdated: number
  handleUpdated: number
  dbRepaired: number
  verified: number
  failedVerification: number
  failed: number
  collisions: number
  skipped: Record<SkipReason, number>
  byKind: Record<AccountKind, number>
}

const emptyCounts = (): MigrationCounts => ({
  considered: 0,
  planned: 0,
  endpointUpdated: 0,
  handleUpdated: 0,
  dbRepaired: 0,
  verified: 0,
  failedVerification: 0,
  failed: 0,
  collisions: 0,
  skipped: { 'already-migrated': 0, 'foreign-rotation-key': 0, 'not-selected': 0, 'handle-taken': 0 },
  byKind: { school: 0, authority: 0, custodial: 0, other: 0 },
})

/**
 * Enough of a DID to match against an operator's own notes, never enough to BE one. The
 * method-specific id is the secret part; four characters of it is a hint, not a name.
 */
export const shortDid = (did: string) => `${did.slice(0, 8)}${did.slice(8, 12)}…`

export interface RunOptions extends PlanOptions {
  apply: boolean
  limit?: number
  key: RotationKey
  skipExternalVerify?: boolean
  /** Directory to write each account's full PLC audit log into before any write. */
  snapshotDir?: string
  /** Where per-account failures go. */
  onFailure?: (did: string, reason: string) => void
}

export interface Ports {
  plc: PlcPort
  pds: PdsPort
  store: StorePort
}

export async function migratePdsHostname(opts: RunOptions, ports: Ports): Promise<MigrationCounts> {
  const counts = emptyCounts()
  const fail = opts.onFailure ?? (() => {})
  const custodialHandles = await ports.store.custodialAccounts()
  const custodial = new Set(custodialHandles.keys())
  const reserved = new Set<string>([...RESERVED_LABELS, ...opts.schools.values(), opts.authorityLabel])
  const dids = await ports.pds.listRepos()
  const infos = await ports.pds.accountInfos(dids)
  const rotationDidKey = opts.key.didKey

  let plan: PlanEntry[] = []
  for (const info of infos) {
    // `considered` counts every account on the PDS, whatever `--limit` does to the plan:
    // a staged run must not make the denominator shrink.
    counts.considered += 1
    const kind = accountKind(info.did, opts, custodial)
    // Selection BEFORE the network round trip: on a PDS with a thousand repos, reading
    // every audit log to discover we wanted none of them costs a minute for nothing.
    if (!selected(info.did, kind, opts)) {
      counts.skipped['not-selected'] += 1
      continue
    }
    if (opts.limit && plan.length >= opts.limit) continue
    let state: CurrentState
    try {
      const last = await ports.plc.lastOp(info.did)
      const normalized = normalizeOp(last.operation)
      state = {
        endpoint: normalized.services[PDS_SERVICE_ID]?.endpoint,
        publishedHandle: normalized.alsoKnownAs[0]?.replace(/^at:\/\//, ''),
        rotationKeys: normalized.rotationKeys,
        storedHandle: custodialHandles.get(info.did),
      }
    } catch (err) {
      counts.failed += 1
      fail(info.did, `unreadable PLC log: ${(err as Error).message}`)
      continue
    }
    let entry: PlanEntry
    try {
      entry = planAccount(info, kind, state, opts, rotationDidKey)
    } catch (err) {
      counts.failed += 1
      fail(info.did, (err as Error).message)
      continue
    }
    if (entry.skip) {
      counts.skipped[entry.skip] += 1
      continue
    }
    plan.push(entry)
  }

  // `infos` is every account `ports.pds.listRepos()` returned — never narrowed by
  // selection or `--limit` — which is exactly what the collision check needs to see past
  // this batch's own plan.
  const universe = targetHandleUniverse(infos, opts, custodial)
  plan = markCollisions(plan, reserved, universe)
  const collided = plan.filter((e) => e.skip === 'handle-taken')
  for (const e of collided) {
    counts.skipped['handle-taken'] += 1
    counts.collisions += 1
    fail(e.did, 'new handle collides with a reserved label or another account')
  }
  plan = plan.filter((e) => !e.skip)
  for (const e of plan) counts.byKind[e.kind] += 1
  counts.planned = plan.length

  if (counts.collisions > 0 && opts.apply) {
    throw new Error(`${counts.collisions} handle collision(s): refusing to apply. Resolve them and re-run.`)
  }
  if (!opts.apply) return counts

  if (opts.snapshotDir) {
    for (const entry of plan) {
      const log = await ports.plc.auditLog(entry.did)
      fs.writeFileSync(path.join(opts.snapshotDir, `${entry.did.replace(/[^a-z0-9:]/gi, '_')}.json`), JSON.stringify(log, null, 2))
    }
  }

  for (const entry of plan) {
    try {
      // 1. The endpoint: our own signed PLC operation, straight to the directory.
      if (entry.needsEndpoint) {
        await submitWithRetry(ports.plc, entry.did, opts.key, opts.serviceEndpoint)
        counts.endpointUpdated += 1
      }
      // 2. The handle: the PDS's own admin path, which also sequences the identity event.
      if (entry.needsHandle) {
        await ports.pds.updateAccountHandle(entry.did, entry.newHandle)
        counts.handleUpdated += 1
      }
      // 3. The app's own copies, including the repair case where 1 and 2 were already done.
      if (entry.needsHandle || entry.needsDb) {
        const rows = await ports.store.setCustodialHandle(entry.did, entry.newHandle)
        if (rows > 0) {
          await ports.store.setCachedHandle(entry.did, entry.newHandle)
          if (!entry.needsHandle && !entry.needsEndpoint) counts.dbRepaired += 1
        }
      }
    } catch (err) {
      counts.failed += 1
      fail(entry.did, (err as Error).message)
      continue
    }
    let verdict: VerifyResult | null = null
    try {
      verdict = await verifyAccount(entry, ports.plc, ports.pds, opts.serviceEndpoint, {
        skipExternal: opts.skipExternalVerify ?? false,
      })
    } catch (err) {
      fail(entry.did, `verification could not run: ${(err as Error).message}`)
    }
    if (verdict?.ok) {
      counts.verified += 1
    } else {
      counts.failedVerification += 1
      if (verdict) {
        const bad = Object.entries(verdict)
          .filter(([k, v]) => k !== 'ok' && v === false)
          .map(([k]) => k)
        fail(entry.did, `verification failed: ${bad.join(', ')}`)
      }
    }
  }
  return counts
}

/**
 * plc.directory rejects an operation whose `prev` is not the current head. That happens
 * for one benign reason — something else (the PDS's own handle op, a concurrent run) moved
 * the head between our read and our write — and the fix is to read the head again and
 * rebuild. Once: a second failure is a real failure and must surface.
 */
async function submitWithRetry(plc: PlcPort, did: string, key: RotationKey, endpoint: string): Promise<void> {
  const last = await plc.lastOp(did)
  try {
    await plc.submit(did, buildUpdateOp(last, key, withEndpoint(endpoint)))
  } catch (err) {
    const fresh = await plc.lastOp(did)
    if (fresh.cid === last.cid) throw err // not a stale head; the failure is real
    await plc.submit(did, buildUpdateOp(fresh, key, withEndpoint(endpoint)))
  }
}

/* ───────────────────────────── real ports (HTTP + Postgres) ─────────────────────── */

export function httpPlc(plcUrl: string): PlcPort {
  const base = plcUrl.replace(/\/$/, '')
  const log = async (did: string): Promise<AuditEntry[]> => {
    const res = await fetch(`${base}/${encodeURIComponent(did)}/log/audit`)
    if (!res.ok) throw new Error(`PLC audit log failed: ${res.status}`)
    return (await res.json()) as AuditEntry[]
  }
  return {
    auditLog: log,
    async lastOp(did) {
      const live = (await log(did)).filter((e) => !e.nullified)
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
    async wellKnownDid(handle) {
      try {
        const res = await fetch(`https://${handle}/.well-known/atproto-did`, { signal: AbortSignal.timeout(10_000) })
        if (!res.ok) return null
        const body = (await res.text()).trim()
        return body.startsWith('did:') ? body : null
      } catch {
        return null
      }
    },
  }
}

export function postgresStore(): StorePort {
  return {
    async custodialAccounts() {
      const rows = await getDb().select({ did: custodialAccount.did, handle: custodialAccount.handle }).from(custodialAccount)
      return new Map(rows.map((r) => [r.did, r.handle]))
    },
    async schools() {
      const rows = await getDb().select({ did: school.did, label: school.label }).from(school)
      return new Map(rows.map((r) => [r.did, r.label]))
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

/** Every flag this script understands. Anything else is a typo, and a typo must not run. */
export const KNOWN_FLAGS = [
  'handle-domain',
  'service-endpoint',
  'pds',
  'pds-host',
  'plc',
  'accounts',
  'only',
  'limit',
  'school-label',
  'authority-label',
  'snapshot',
  'create-rehearsal-account',
  'allow-loopback-endpoint',
  'skip-external-verify',
  'apply',
  'dry-run',
] as const

export function unknownFlags(argv: string[], known: readonly string[] = KNOWN_FLAGS): string[] {
  return argv
    .filter((a) => a.startsWith('--') && a !== '--')
    .map((a) => a.replace(/^--/, '').split('=')[0]!)
    .filter((name) => !known.includes(name))
}

function flag(name: string, argv = process.argv): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
}

export type SnapshotFlagVerdict = { ok: true; dir: string | undefined } | { ok: false; reason: string }

/**
 * `--snapshot=<dir>`. Parsed separately from `flag()` on purpose: every flag here is
 * `=`-only (`flag()` has no notion of a space-separated `--name value`), so a bare
 * `--snapshot /tmp/x` parses as `--snapshot` with an EMPTY value — indistinguishable, to
 * `flag()`, from "not passed" — and used to be silently treated as "no snapshot
 * requested". A snapshot that silently was not written is a safety rail that silently did
 * not fire, so refuse loudly instead of guessing what the operator meant.
 */
export function snapshotFlag(argv: string[] = process.argv): SnapshotFlagVerdict {
  if (argv.includes('--snapshot')) {
    return { ok: false, reason: '--snapshot needs a value as --snapshot=<dir> (space-separated form is not supported)' }
  }
  return { ok: true, dir: flag('snapshot', argv) || undefined }
}

/**
 * Dev-only affordance for the rehearsal in the runbook: mint a throwaway account through
 * the ordinary signup path (admin invite code → `com.atproto.server.createAccount`) so the
 * real run has something of its own to move. Refuses against anything but a loopback PDS,
 * and needs `--apply` like every other thing here that writes.
 */
async function createRehearsalAccount(pdsUrl: string, adminPassword: string, prefix: string, domain: string): Promise<void> {
  const host = new URL(pdsUrl).hostname
  if (!isLoopbackHost(host)) throw new Error('--create-rehearsal-account is only allowed against a loopback PDS')
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

const USAGE = `usage: migrate-pds-hostname
  --handle-domain=<domain>        required, e.g. freeskool.directory
  --service-endpoint=<url>        required, e.g. https://pds.freeskool.directory
  --accounts=custodial|all        default custodial
  --only=<did,did>                restrict to these DIDs
  --limit=N                       plan at most N accounts
  --pds=<url>                     the PDS to talk to (default PDS_URL)
  --pds-host=<host>               what --service-endpoint's host must equal (default PDS_HOST)
  --plc=<url>                     default https://plc.directory
  --school-label=<label>          fallback when fs_school is empty (default boulder)
  --authority-label=<label>       default skills
  --snapshot=<dir>                write every planned account's PLC audit log here first
  --skip-external-verify          do not fetch https://<handle>/.well-known/atproto-did
  --allow-loopback-endpoint       dev only; both the endpoint and the PDS must be loopback
  --dry-run                       the default
  --apply                         actually write`

export async function main(): Promise<number> {
  const c = config()
  const bad = unknownFlags(process.argv.slice(2))
  if (bad.length > 0) {
    console.error(`unknown flag(s): ${bad.map((b) => `--${b}`).join(' ')}\n${USAGE}`)
    return 1
  }
  const apply = process.argv.includes('--apply')
  const dryRun = process.argv.includes('--dry-run')
  if (apply && dryRun) {
    console.error('--apply and --dry-run are contradictory; pass one')
    return 1
  }
  const handleDomain = (flag('handle-domain') || '').replace(/^\./, '')
  if (!handleDomain) {
    console.error(USAGE)
    return 1
  }
  const pdsUrl = flag('pds') || c.PDS_URL
  const adminPassword = c.PDS_ADMIN_PASSWORD
  if (!adminPassword) {
    console.error('PDS_ADMIN_PASSWORD is not set')
    return 1
  }

  const rehearsal = flag('create-rehearsal-account')
  if (rehearsal) {
    if (!apply) {
      console.error('--create-rehearsal-account creates a real account: pass --apply')
      return 1
    }
    await createRehearsalAccount(pdsUrl, adminPassword, rehearsal, handleDomain)
    return 0
  }

  // The key is required for a DRY RUN too: without it every account looks like
  // "rotated away from us", and a plan that cannot tell that apart from "we lost the key"
  // is worse than no plan.
  const keyHex = process.env.PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX ?? ''
  if (!keyHex) {
    console.error('PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX is not set; it is what signs the endpoint operation, and what tells a rotated-away account from a missing key')
    return 1
  }
  let key: RotationKey
  try {
    key = rotationKeyFromHex(keyHex)
  } catch (err) {
    console.error(`PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX is unusable: ${(err as Error).message}`)
    return 1
  }

  const rawEndpoint = flag('service-endpoint')
  if (!rawEndpoint) {
    console.error('--service-endpoint is required (there is deliberately no default: the default would be PDS_URL, whose own default is http://localhost:3000)')
    return 1
  }
  const pdsHost = flag('pds-host') || process.env.PDS_HOST || new URL(pdsUrl).host
  const verdict = checkServiceEndpoint(rawEndpoint, {
    pdsHost,
    allowLoopback: process.argv.includes('--allow-loopback-endpoint'),
  })
  if (!verdict.ok) {
    console.error(verdict.reason)
    return 1
  }

  const snapshot = snapshotFlag()
  if (!snapshot.ok) {
    console.error(snapshot.reason)
    return 1
  }
  let snapshotDir: string | undefined
  if (snapshot.dir) {
    snapshotDir = path.join(snapshot.dir, new Date().toISOString().replace(/[:.]/g, '-'))
    fs.mkdirSync(snapshotDir, { recursive: true })
  }

  const schools = await postgresStore().schools()
  if (schools.size === 0 && c.SCHOOL_DID) schools.set(c.SCHOOL_DID, flag('school-label') || 'boulder')

  const onlyRaw = flag('only')
  const limitRaw = flag('limit')
  const opts: RunOptions = {
    apply,
    handleDomain,
    serviceEndpoint: verdict.endpoint,
    schools,
    authorityDid: c.AUTHORITY_DID,
    authorityLabel: flag('authority-label') || 'skills',
    accounts: flag('accounts') === 'all' ? 'all' : 'custodial',
    only: onlyRaw ? new Set(onlyRaw.split(',').map((d) => d.trim()).filter(Boolean)) : undefined,
    limit: limitRaw ? Number(limitRaw) : undefined,
    key,
    skipExternalVerify: process.argv.includes('--skip-external-verify'),
    snapshotDir,
    onFailure: (did, reason) => console.error(`  ! ${shortDid(did)} ${reason}`),
  }

  let counts: MigrationCounts
  try {
    counts = await migratePdsHostname(opts, {
      plc: httpPlc(flag('plc') || 'https://plc.directory'),
      pds: httpPds(pdsUrl, adminPassword),
      store: postgresStore(),
    })
  } catch (err) {
    console.error((err as Error).message)
    return 1
  }

  const skipped = Object.entries(counts.skipped).filter(([, n]) => n > 0)
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} → ${handleDomain} @ ${verdict.endpoint} (accounts=${opts.accounts})`)
  console.log(`considered=${counts.considered} planned=${counts.planned}`)
  console.log(`  by kind: ${Object.entries(counts.byKind).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`)
  console.log(`  skipped: ${skipped.map(([k, n]) => `${k}=${n}`).join(' ') || 'none'}`)
  if (counts.collisions > 0) console.log(`  COLLISIONS: ${counts.collisions} — --apply will refuse until they are resolved`)
  if (snapshotDir) console.log(`  snapshot: ${snapshotDir}`)
  if (apply) {
    console.log(`endpoint-ops=${counts.endpointUpdated} handle-ops=${counts.handleUpdated} db-repaired=${counts.dbRepaired}`)
    console.log(`verified=${counts.verified} failed-verification=${counts.failedVerification} failed=${counts.failed}`)
  } else if (counts.failed > 0) {
    console.log(`unreadable=${counts.failed}`)
  }
  return counts.failed + counts.failedVerification + counts.collisions > 0 ? 2 : 0
}

if (isMain(import.meta.url)) {
  const code = await main()
  await closeDb()
  process.exit(code)
}
