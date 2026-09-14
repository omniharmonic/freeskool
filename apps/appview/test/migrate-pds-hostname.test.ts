/**
 * The neutral-hostname migration (`scripts/migrate-pds-hostname.ts`), against a fake PDS
 * and a fake plc.directory.
 *
 * What is worth asserting here is the PLANNING and the VERIFICATION — who moves, to which
 * handle, what is skipped and why, and that a second run is a no-op — because those are
 * the parts a real run cannot be asked twice about. The two writes themselves
 * (a self-signed PLC operation POSTed to the directory, then
 * `com.atproto.admin.updateAccountHandle`) were proven against the real dev PDS and the
 * real plc.directory in the rehearsal the runbook records; here the ports are fakes that
 * record what the script asked for, so the ORDER and the SHAPE of those asks are pinned.
 *
 * The rotation-key helpers are exercised for real: a private key really is imported,
 * a `did:key` really is derived, and an operation really is signed and verified — no
 * network, but no stubbing of the cryptography either, because a silently wrong signature
 * is exactly the failure that would only show up against production.
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool_test'
process.env.SESSION_SECRET ??= 'migrate-hostname-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 7).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'migrate-hostname-test-pepper'

import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { encode as cborEncode } from '@atproto/lex-cbor'
import {
  type AuditEntry,
  type CurrentState,
  type PdsPort,
  type PlanOptions,
  type PlcOperation,
  type PlcPort,
  type RunOptions,
  type StorePort,
  accountKind,
  buildUpdateOp,
  migratePdsHostname,
  normalizeOp,
  plannedHandle,
  rotationKeyFromHex,
  selected,
  verifyAccount,
  withEndpoint,
} from '../scripts/migrate-pds-hostname.js'

/** The dev PDS's rotation key. Throwaway; it signs nothing outside this file. */
const KEY_HEX = '0000000000000000000000000000000000000000000000000000000000000000'
const KEY = rotationKeyFromHex(KEY_HEX)

const SCHOOL = 'did:plc:school'
const AUTHORITY = 'did:plc:authority'
const MEMBER = 'did:plc:member'
const OWNED = 'did:plc:owned'

const OLD_ENDPOINT = 'https://pds.freeskool.xyz'
const NEW_ENDPOINT = 'https://pds.freeskool.directory'

const OPTS: PlanOptions = {
  handleDomain: 'freeskool.directory',
  serviceEndpoint: NEW_ENDPOINT,
  schoolDid: SCHOOL,
  authorityDid: AUTHORITY,
  schoolLabel: 'boulder',
  authorityLabel: 'skills',
  accounts: 'custodial',
}

const op = (over: Partial<PlcOperation> = {}): PlcOperation => ({
  type: 'plc_operation',
  rotationKeys: [KEY.didKey],
  verificationMethods: { atproto: 'did:key:zQ3shSigningKey' },
  alsoKnownAs: ['at://calmalder301.freeskool.xyz'],
  services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: OLD_ENDPOINT } },
  prev: null,
  sig: 'fake',
  ...over,
})

const stateOf = (o: PlcOperation): CurrentState => ({
  endpoint: o.services.atproto_pds?.endpoint,
  publishedHandle: o.alsoKnownAs[0]?.replace(/^at:\/\//, ''),
  rotationKeys: o.rotationKeys,
})

/* ─────────────────────────────── the rotation key ──────────────────────────────── */

describe('the PDS rotation key, held locally', () => {
  it('derives the same did:key the PDS publishes in rotationKeys', () => {
    // Taken verbatim from the dev PDS's own DID documents on plc.directory, which are
    // signed by this very key: if our SEC1 import or point compression were wrong, this
    // string would differ and every operation we signed would be rejected.
    expect(KEY.didKey).toBe('did:key:zQ3shjPcvoVJmzEY3cwB37RwfMzo2rPWSqT28EFuawPdM5V4y')
  })

  it('signs dag-cbor as 64 raw bytes, base64url, with a low S', () => {
    const sig = KEY.sign(cborEncode({ hello: 'world' }))
    const raw = Buffer.from(sig, 'base64url')
    expect(raw.length).toBe(64)
    const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
    expect(BigInt(`0x${raw.subarray(32).toString('hex')}`) <= n / 2n).toBe(true)
  })

  it('produces a signature that verifies against the derived public key', () => {
    const bytes = cborEncode({ type: 'plc_operation', prev: null })
    const sig = Buffer.from(KEY.sign(bytes), 'base64url')
    const pub = crypto.createPublicKey(
      crypto.createPrivateKey({
        key: (() => {
          const priv = Buffer.from(KEY_HEX, 'hex')
          const oid = Buffer.from('06052b8104000a', 'hex')
          const body = Buffer.concat([Buffer.from([0x02, 0x01, 0x01]), Buffer.from([0x04, 0x20]), priv, Buffer.from([0xa0, oid.length]), oid])
          return Buffer.concat([Buffer.from([0x30, body.length]), body])
        })(),
        format: 'der',
        type: 'sec1',
      }),
    )
    expect(crypto.verify('sha256', bytes, { key: pub, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true)
  })
})

/* ──────────────────────────────── operation shape ──────────────────────────────── */

describe('the endpoint operation', () => {
  it('carries everything else forward and chains on the last CID', () => {
    const last: AuditEntry = { cid: 'bafyLAST', operation: op() }
    const next = buildUpdateOp(last, KEY, withEndpoint(NEW_ENDPOINT))
    expect(next.prev).toBe('bafyLAST')
    expect(next.services.atproto_pds).toEqual({ type: 'AtprotoPersonalDataServer', endpoint: NEW_ENDPOINT })
    // The handle is NOT touched here: it is the PDS's `admin.updateAccountHandle` that
    // moves it, in the second step, so the identity event follows the final document.
    expect(next.alsoKnownAs).toEqual(['at://calmalder301.freeskool.xyz'])
    expect(next.rotationKeys).toEqual([KEY.didKey])
    expect(next.verificationMethods).toEqual({ atproto: 'did:key:zQ3shSigningKey' })
    expect(next.sig).toBeTypeOf('string')
  })

  it('lifts a legacy `create` genesis operation into the modern shape', () => {
    const legacy = {
      type: 'create' as const,
      signingKey: 'did:key:zQ3shSign',
      recoveryKey: 'did:key:zQ3shRecover',
      handle: 'old.freeskool.xyz',
      service: 'pds.freeskool.xyz',
      prev: null,
    }
    const n = normalizeOp(legacy)
    expect(n.type).toBe('plc_operation')
    expect(n.alsoKnownAs).toEqual(['at://old.freeskool.xyz'])
    expect(n.services.atproto_pds?.endpoint).toBe('https://pds.freeskool.xyz')
    expect(n.rotationKeys).toEqual(['did:key:zQ3shRecover', 'did:key:zQ3shSign'])
  })

  it('refuses an operation type it does not understand rather than guessing', () => {
    expect(() => normalizeOp({ type: 'plc_tombstone' } as never)).toThrow(/unsupported/)
  })
})

/* ───────────────────────────────────── planning ─────────────────────────────────── */

describe('planning the new handles (ruling 3)', () => {
  const custodial = new Set([MEMBER])
  it('gives the school and the authority their ruled labels, and members their own prefix', () => {
    expect(plannedHandle({ did: SCHOOL, handle: 'boulder.freeskool.xyz' }, 'school', OPTS)).toBe('boulder.freeskool.directory')
    expect(plannedHandle({ did: AUTHORITY, handle: 'taxonomy.freeskool.xyz' }, 'authority', OPTS)).toBe('skills.freeskool.directory')
    expect(plannedHandle({ did: MEMBER, handle: 'calmalder301.freeskool.xyz' }, 'custodial', OPTS)).toBe('calmalder301.freeskool.directory')
  })

  it('classifies by DID, not by the shape of the handle', () => {
    expect(accountKind(SCHOOL, OPTS, custodial)).toBe('school')
    expect(accountKind(AUTHORITY, OPTS, custodial)).toBe('authority')
    expect(accountKind(MEMBER, OPTS, custodial)).toBe('custodial')
    expect(accountKind(OWNED, OPTS, custodial)).toBe('other')
  })

  it('leaves a member who took ownership out of --accounts=custodial, and in of --accounts=all', () => {
    expect(selected(OWNED, 'other', { accounts: 'custodial' })).toBe(false)
    expect(selected(OWNED, 'other', { accounts: 'all' })).toBe(true)
    expect(selected(MEMBER, 'custodial', { accounts: 'custodial' })).toBe(true)
    expect(selected(MEMBER, 'custodial', { accounts: 'all', only: new Set([OWNED]) })).toBe(false)
  })

  it('never classifies an account as the school when SCHOOL_DID is unset', () => {
    // `config().SCHOOL_DID` defaults to the empty string; a `did` of '' cannot occur, but
    // an unset school must not accidentally swallow the first account it sees.
    expect(accountKind(MEMBER, { schoolDid: '', authorityDid: '' }, custodial)).toBe('custodial')
  })
})

/* ───────────────────────────── the run, against fakes ──────────────────────────── */

interface Fakes {
  plc: PlcPort
  pds: PdsPort
  store: StorePort
  submitted: PlcOperation[]
  handleCalls: Array<{ did: string; handle: string }>
  writes: Array<{ did: string; handle: string; cached: boolean }>
  order: string[]
}

function fakes(init: Record<string, { handle: string; op: PlcOperation }>): Fakes {
  const accounts = { ...init }
  const submitted: PlcOperation[] = []
  const handleCalls: Array<{ did: string; handle: string }> = []
  const writes: Array<{ did: string; handle: string; cached: boolean }> = []
  const order: string[] = []
  const plc: PlcPort = {
    async lastOp(did) {
      const a = accounts[did]
      if (!a) throw new Error('unknown did')
      return { cid: `bafy-${did}-${submitted.length}`, operation: a.op }
    },
    async submit(did, o) {
      order.push(`plc:${did}`)
      submitted.push(o)
      accounts[did] = { handle: accounts[did]!.handle, op: o }
    },
    async document(did) {
      const a = accounts[did]!
      return {
        alsoKnownAs: a.op.alsoKnownAs,
        service: [{ id: '#atproto_pds', serviceEndpoint: a.op.services.atproto_pds!.endpoint }],
      }
    },
  }
  const pds: PdsPort = {
    async listRepos() {
      return Object.keys(accounts)
    },
    async accountInfos(dids) {
      return dids.map((did) => ({ did, handle: accounts[did]!.handle }))
    },
    async updateAccountHandle(did, handle) {
      order.push(`pds:${did}`)
      handleCalls.push({ did, handle })
      const a = accounts[did]!
      // The real PDS signs a handle-only PLC op with the same rotation key.
      accounts[did] = { handle, op: { ...a.op, alsoKnownAs: [`at://${handle}`] } }
    },
    async resolveHandle(handle) {
      return Object.entries(accounts).find(([, a]) => a.handle === handle)?.[0] ?? null
    },
  }
  const store: StorePort = {
    async custodialDids() {
      return new Set([MEMBER])
    },
    async setCustodialHandle(did, handle) {
      const rows = did === MEMBER ? 1 : 0
      if (rows) writes.push({ did, handle, cached: false })
      return rows
    },
    async setCachedHandle(did, handle) {
      const row = writes.find((w) => w.did === did && w.handle === handle)
      if (row) row.cached = true
    },
  }
  return { plc, pds, store, submitted, handleCalls, writes, order }
}

const everyone = () => ({
  [SCHOOL]: { handle: 'boulder.freeskool.xyz', op: op({ alsoKnownAs: ['at://boulder.freeskool.xyz'] }) },
  [AUTHORITY]: { handle: 'taxonomy.freeskool.xyz', op: op({ alsoKnownAs: ['at://taxonomy.freeskool.xyz'] }) },
  [MEMBER]: { handle: 'calmalder301.freeskool.xyz', op: op() },
  [OWNED]: { handle: 'owner.example.com', op: op({ alsoKnownAs: ['at://owner.example.com'], rotationKeys: ['did:key:zQ3shSomeoneElse'] }) },
})

const run = (over: Partial<RunOptions>, f: Fakes) =>
  migratePdsHostname({ ...OPTS, apply: false, key: KEY, ...over }, { plc: f.plc, pds: f.pds, store: f.store })

describe('the run', () => {
  it('dry run counts and writes nothing', async () => {
    const f = fakes(everyone())
    const counts = await run({}, f)
    expect(counts.considered).toBe(4)
    expect(counts.planned).toBe(3)
    expect(counts.byKind).toMatchObject({ school: 1, authority: 1, custodial: 1, other: 0 })
    expect(counts.skipped['not-selected']).toBe(1)
    expect(f.submitted).toHaveLength(0)
    expect(f.handleCalls).toHaveLength(0)
  })

  it('applies the endpoint operation BEFORE the handle, per account', async () => {
    const f = fakes(everyone())
    const counts = await run({ apply: true }, f)
    expect(counts.endpointUpdated).toBe(3)
    expect(counts.handleUpdated).toBe(3)
    expect(counts.verified).toBe(3)
    expect(counts.failed + counts.failedVerification).toBe(0)
    // Endpoint first is not cosmetic: the handle call is what sequences the `#identity`
    // event, so it must be the LAST thing that happens to an account.
    expect(f.order).toEqual([`plc:${SCHOOL}`, `pds:${SCHOOL}`, `plc:${AUTHORITY}`, `pds:${AUTHORITY}`, `plc:${MEMBER}`, `pds:${MEMBER}`])
    expect(f.handleCalls.map((h) => h.handle).sort()).toEqual([
      'boulder.freeskool.directory',
      'calmalder301.freeskool.directory',
      'skills.freeskool.directory',
    ])
    expect(f.submitted.every((o) => o.services.atproto_pds?.endpoint === NEW_ENDPOINT)).toBe(true)
  })

  it('rewrites fs_custodial_account and the handle cache only for accounts we custody', async () => {
    const f = fakes(everyone())
    await run({ apply: true }, f)
    expect(f.writes).toEqual([{ did: MEMBER, handle: 'calmalder301.freeskool.directory', cached: true }])
  })

  it('is idempotent: a second run plans nothing and writes nothing', async () => {
    const f = fakes(everyone())
    await run({ apply: true }, f)
    const before = f.submitted.length
    const second = await run({ apply: true }, f)
    expect(second.planned).toBe(0)
    expect(second.skipped['already-migrated']).toBe(3)
    expect(f.submitted).toHaveLength(before)
  })

  it('is resumable: --limit does a prefix and the next run does the rest', async () => {
    const f = fakes(everyone())
    const first = await run({ apply: true, limit: 1 }, f)
    expect(first.planned).toBe(1)
    const second = await run({ apply: true }, f)
    expect(second.planned).toBe(2)
    expect(second.skipped['already-migrated']).toBe(1)
  })

  it('reports, and never forces, an account whose rotation keys are no longer ours', async () => {
    const f = fakes(everyone())
    const counts = await run({ apply: true, accounts: 'all' }, f)
    expect(counts.skipped['foreign-rotation-key']).toBe(1)
    expect(f.handleCalls.some((h) => h.did === OWNED)).toBe(false)
  })

  it('counts an unreadable PLC log as a failure instead of planning blind', async () => {
    const f = fakes(everyone())
    const broken: PlcPort = { ...f.plc, lastOp: async () => { throw new Error('plc down') } }
    const counts = await migratePdsHostname({ ...OPTS, apply: false, key: KEY }, { plc: broken, pds: f.pds, store: f.store })
    expect(counts.planned).toBe(0)
    expect(counts.failed).toBe(3)
  })

  it('counts a half-applied account as failed verification rather than done', async () => {
    const f = fakes(everyone())
    // A PDS that accepts the handle call but does not actually move the handle — the
    // shape of a partial failure the script must not report as success.
    const lying: PdsPort = { ...f.pds, updateAccountHandle: async () => {} }
    const counts = await migratePdsHostname(
      { ...OPTS, apply: true, key: KEY, only: new Set([MEMBER]), accounts: 'all' },
      { plc: f.plc, pds: lying, store: f.store },
    )
    expect(counts.endpointUpdated).toBe(1)
    expect(counts.verified).toBe(0)
    expect(counts.failedVerification).toBe(1)
  })

  it('refuses to apply without the rotation key', async () => {
    const f = fakes(everyone())
    await expect(run({ apply: true, key: undefined }, f)).rejects.toThrow(/PDS_PLC_ROTATION_KEY/)
  })
})

/* ─────────────────────────────────── verification ───────────────────────────────── */

describe('verification', () => {
  const entry = {
    did: MEMBER,
    kind: 'custodial' as const,
    currentHandle: 'calmalder301.freeskool.xyz',
    newHandle: 'calmalder301.freeskool.directory',
    needsEndpoint: true,
    needsHandle: true,
  }

  const port = (endpoint: string, aka: string[], resolves: string | null): { plc: PlcPort; pds: PdsPort } => ({
    plc: {
      lastOp: async () => ({ cid: 'x', operation: op() }),
      submit: async () => {},
      document: async () => ({ alsoKnownAs: aka, service: [{ id: '#atproto_pds', serviceEndpoint: endpoint }] }),
    },
    pds: {
      listRepos: async () => [],
      accountInfos: async () => [],
      updateAccountHandle: async () => {},
      resolveHandle: async () => resolves,
    },
  })

  it('passes only when the document AND the PDS both agree', async () => {
    const p = port(NEW_ENDPOINT, ['at://calmalder301.freeskool.directory'], MEMBER)
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toEqual({ ok: true, endpointOk: true, handleOk: true, resolvesOk: true })
  })

  it('fails when the endpoint is still the old one', async () => {
    const p = port(OLD_ENDPOINT, ['at://calmalder301.freeskool.directory'], MEMBER)
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toMatchObject({ ok: false, endpointOk: false })
  })

  it('fails when the handle resolves to somebody else', async () => {
    const p = port(NEW_ENDPOINT, ['at://calmalder301.freeskool.directory'], 'did:plc:someone-else')
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toMatchObject({ ok: false, resolvesOk: false })
  })
})

/* ─────────────────────────────────── output hygiene ─────────────────────────────── */

describe('R9: counts only', () => {
  it('the returned counts carry no DID, handle or email anywhere', async () => {
    const f = fakes(everyone())
    const counts = await run({ apply: true }, f)
    const serialized = JSON.stringify(counts)
    expect(serialized).not.toMatch(/did:plc:/)
    expect(serialized).not.toMatch(/freeskool/)
    expect(serialized).not.toMatch(/@/)
  })
})
