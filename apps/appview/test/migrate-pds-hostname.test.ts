/**
 * The neutral-hostname migration (`scripts/migrate-pds-hostname.ts`), against a fake PDS
 * and a fake plc.directory.
 *
 * What is worth asserting here is the PLANNING, the GUARDS and the VERIFICATION — who
 * moves, to which handle, what is refused and why, and that a second run repairs rather
 * than repeats — because those are the parts a real run cannot be asked twice about. The
 * two writes themselves (a self-signed PLC operation POSTed to the directory, then
 * `com.atproto.admin.updateAccountHandle`) were proven against the real dev PDS and the
 * real plc.directory in the rehearsal the runbook records; here the ports are fakes that
 * record what the script asked for, so the ORDER and the SHAPE of those asks are pinned.
 *
 * The rotation-key helpers are exercised for real: a key really is imported, a `did:key`
 * really is derived, and an operation really is signed and verified — no network, but no
 * stubbing of the cryptography either, because a silently wrong signature is exactly the
 * failure that would only show up against production.
 *
 * NO LIVE KEY MATERIAL LIVES IN THIS FILE. The key under test is generated fresh in
 * `beforeAll`; the one test that pins our `did:key` derivation against a key the real PDS
 * has published reads both halves from the environment and skips when they are absent.
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool_test'
process.env.SESSION_SECRET ??= 'migrate-hostname-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 7).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'migrate-hostname-test-pepper'

import crypto from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { encode as cborEncode } from '@atproto/lex-cbor'
import {
  type AuditEntry,
  type CurrentState,
  type PdsPort,
  type PlanEntry,
  type PlanOptions,
  type PlcOperation,
  type PlcPort,
  type RotationKey,
  type RunOptions,
  type StorePort,
  accountKind,
  buildUpdateOp,
  checkServiceEndpoint,
  markCollisions,
  migratePdsHostname,
  normalizeEndpoint,
  normalizeOp,
  plannedHandle,
  rotationKeyFromHex,
  sec1Der,
  selected,
  shortDid,
  snapshotFlag,
  targetHandleUniverse,
  unknownFlags,
  verifyAccount,
  withEndpoint,
} from '../scripts/migrate-pds-hostname.js'

/* ───────────────────── a throwaway key, generated here, never committed ─────────── */

/**
 * A fresh secp256k1 key per run. Node gives SEC1 DER as
 * `30 LL 02 01 01 04 20 <32 bytes> …`; the scalar is those 32 bytes. Asserted rather than
 * searched for, so a change in Node's encoding fails loudly instead of silently handing
 * us the wrong bytes.
 */
function freshKeyHex(): string {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const der = Buffer.from(privateKey.export({ format: 'der', type: 'sec1' }) as Buffer)
  expect([...der.subarray(0, 2)]).toEqual([0x30, der.length - 2])
  expect([...der.subarray(2, 7)]).toEqual([0x02, 0x01, 0x01, 0x04, 0x20])
  return der.subarray(7, 39).toString('hex')
}

let KEY_HEX: string
let KEY: RotationKey
beforeAll(() => {
  KEY_HEX = freshKeyHex()
  KEY = rotationKeyFromHex(KEY_HEX)
})

const SCHOOL = 'did:plc:boulderschool000000000'
const DENVER = 'did:plc:denverschool0000000000'
const AUTHORITY = 'did:plc:authority00000000000'
const MEMBER = 'did:plc:member000000000000000'
const OWNED = 'did:plc:owned0000000000000000'

const OLD_ENDPOINT = 'https://pds.freeskool.xyz'
const NEW_ENDPOINT = 'https://pds.freeskool.directory'

const SCHOOLS = new Map([
  [SCHOOL, 'boulder'],
  [DENVER, 'denver'],
])

const OPTS = (): PlanOptions => ({
  handleDomain: 'freeskool.directory',
  serviceEndpoint: NEW_ENDPOINT,
  schools: SCHOOLS,
  authorityDid: AUTHORITY,
  authorityLabel: 'skills',
  accounts: 'custodial',
})

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

/* ─────────────────────────────── the rotation key ──────────────────────────────── */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** An independent decoder, so the did:key assertion is not the encoder marking its own work. */
function base58Decode(s: string): Buffer {
  let n = 0n
  for (const ch of s) {
    const i = BASE58.indexOf(ch)
    if (i < 0) throw new Error(`not base58btc: ${ch}`)
    n = n * 58n + BigInt(i)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  const body = Buffer.from(hex, 'hex')
  let zeros = 0
  for (const ch of s) {
    if (ch !== '1') break
    zeros += 1
  }
  return Buffer.concat([Buffer.alloc(zeros), body])
}

describe('the rotation key, held locally', () => {
  it('signs dag-cbor as 64 raw bytes, base64url, with a low S, verifiable by the public key', () => {
    const bytes = cborEncode({ type: 'plc_operation', prev: null })
    const sig = Buffer.from(KEY.sign(bytes), 'base64url')
    expect(sig.length).toBe(64)
    const n = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141')
    expect(BigInt(`0x${sig.subarray(32).toString('hex')}`) <= n / 2n).toBe(true)
    const pub = crypto.createPublicKey(crypto.createPrivateKey({ key: sec1Der(KEY_HEX), format: 'der', type: 'sec1' }))
    expect(crypto.verify('sha256', bytes, { key: pub, dsaEncoding: 'ieee-p1363' }, sig)).toBe(true)
  })

  it('derives a did:key that decodes back to the multicodec secp256k1 point', () => {
    // Every secp256k1 did:key starts `zQ3s`; inside is 0xe7 0x01 then the 33-byte
    // compressed point, whose X must be the public key's X. Decoded here with a decoder
    // written independently of the encoder under test.
    expect(KEY.didKey.startsWith('did:key:zQ3s')).toBe(true)
    const decoded = base58Decode(KEY.didKey.replace('did:key:z', ''))
    expect([...decoded.subarray(0, 2)]).toEqual([0xe7, 0x01])
    expect(decoded.length).toBe(35)
    const compressed = decoded.subarray(2)
    expect([0x02, 0x03]).toContain(compressed[0])
    const spki = crypto
      .createPublicKey(crypto.createPrivateKey({ key: sec1Der(KEY_HEX), format: 'der', type: 'sec1' }))
      .export({ format: 'der', type: 'spki' }) as Buffer
    const point = spki.subarray(spki.length - 65)
    expect(compressed.subarray(1).toString('hex')).toBe(point.subarray(1, 33).toString('hex'))
    expect(compressed[0]).toBe((point[64]! & 1) === 0 ? 0x02 : 0x03)
  })

  it('rejects a key that is not 32 bytes', () => {
    expect(() => rotationKeyFromHex('abcd')).toThrow(/32 bytes/)
  })

  /**
   * The cross-check that matters most — our derivation against a did:key a REAL PDS has
   * published in real DID documents — needs real key material, which does not belong in a
   * tracked file. Set both variables to run it (the dev values live in the gitignored
   * `infra/pds.env`); it skips otherwise.
   */
  const devHex = process.env.DEV_PDS_ROTATION_KEY_HEX
  const devDidKey = process.env.DEV_PDS_ROTATION_DID_KEY
  it.skipIf(!devHex || !devDidKey)('matches the did:key a real PDS publishes in rotationKeys', () => {
    expect(rotationKeyFromHex(devHex!).didKey).toBe(devDidKey)
  })
})

/* ──────────────────────────────── operation shape ──────────────────────────────── */

describe('the endpoint operation', () => {
  it('carries everything else forward and chains on the last CID', () => {
    // Deliberately not the minimal fixture: two rotation keys, two alsoKnownAs entries and
    // a service that is not the PDS. Every one of them must survive untouched, because
    // `createUpdateOp` REPLACES the document — anything we fail to carry forward is
    // silently deleted from a permanent public record.
    const rich = op({
      rotationKeys: [KEY.didKey, 'did:key:zQ3shRecoveryKeyOfTheirOwn'],
      alsoKnownAs: ['at://calmalder301.freeskool.xyz', 'at://calmalder.example.com'],
      services: {
        atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: OLD_ENDPOINT },
        atproto_labeler: { type: 'AtprotoLabeler', endpoint: 'https://labeler.example.com' },
      },
    })
    const next = buildUpdateOp({ cid: 'bafyLAST', operation: rich }, KEY, withEndpoint(NEW_ENDPOINT))
    expect(next.prev).toBe('bafyLAST')
    expect(next.services.atproto_pds).toEqual({ type: 'AtprotoPersonalDataServer', endpoint: NEW_ENDPOINT })
    expect(next.services.atproto_labeler).toEqual({ type: 'AtprotoLabeler', endpoint: 'https://labeler.example.com' })
    expect(next.rotationKeys).toEqual([KEY.didKey, 'did:key:zQ3shRecoveryKeyOfTheirOwn'])
    // The handle is NOT touched here: it is the PDS's `admin.updateAccountHandle` that
    // moves it, in the second step, so the identity event follows the final document.
    expect(next.alsoKnownAs).toEqual(['at://calmalder301.freeskool.xyz', 'at://calmalder.example.com'])
    expect(next.verificationMethods).toEqual({ atproto: 'did:key:zQ3shSigningKey' })
    expect(next.sig).toBeTypeOf('string')
  })

  it('normalizes a trailing slash, so "already migrated" is not a punctuation question', () => {
    expect(normalizeEndpoint('https://pds.freeskool.directory/')).toBe(NEW_ENDPOINT)
    expect(normalizeEndpoint('pds.freeskool.directory//')).toBe(NEW_ENDPOINT)
    const next = buildUpdateOp({ cid: 'c', operation: op() }, KEY, withEndpoint(`${NEW_ENDPOINT}/`))
    expect(next.services.atproto_pds!.endpoint).toBe(NEW_ENDPOINT)
  })

  it('lifts a legacy `create` genesis operation into the modern shape', () => {
    const n = normalizeOp({
      type: 'create',
      signingKey: 'did:key:zQ3shSign',
      recoveryKey: 'did:key:zQ3shRecover',
      handle: 'old.freeskool.xyz',
      service: 'pds.freeskool.xyz',
      prev: null,
    })
    expect(n.type).toBe('plc_operation')
    expect(n.alsoKnownAs).toEqual(['at://old.freeskool.xyz'])
    expect(n.services.atproto_pds?.endpoint).toBe('https://pds.freeskool.xyz')
    expect(n.rotationKeys).toEqual(['did:key:zQ3shRecover', 'did:key:zQ3shSign'])
  })

  it('refuses an operation type it does not understand rather than guessing', () => {
    expect(() => normalizeOp({ type: 'plc_tombstone' } as never)).toThrow(/unsupported/)
  })
})

/* ──────────────────────── the endpoint guard (blocking review #3) ───────────────── */

describe('--service-endpoint is checked before anything is signed', () => {
  const at = (pdsHost: string, allowLoopback = false) => ({ pdsHost, allowLoopback })

  it('accepts the real thing', () => {
    expect(checkServiceEndpoint(NEW_ENDPOINT, at('pds.freeskool.directory'))).toEqual({ ok: true, endpoint: NEW_ENDPOINT })
    expect(checkServiceEndpoint(`${NEW_ENDPOINT}/`, at('pds.freeskool.directory'))).toEqual({ ok: true, endpoint: NEW_ENDPOINT })
  })

  it('refuses the failure this guard exists for: a loopback endpoint on a production run', () => {
    // `config().PDS_URL` defaults to http://localhost:3000. One unset variable used to be
    // all that stood between an --apply and a permanent loopback endpoint in every DID doc.
    expect(checkServiceEndpoint('http://localhost:3000', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://127.0.0.1', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://10.0.0.5', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://192.168.1.9', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://172.20.3.4', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
  })

  it('refuses http, reserved TLDs, IP literals, paths and a host that is not the PDS', () => {
    expect(checkServiceEndpoint('http://pds.freeskool.directory', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://pds.freeskool.test', at('pds.freeskool.test'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://93.184.216.34', at('93.184.216.34'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://pds.freeskool.directory/xrpc', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://pds.freeskool.directory?a=1', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
    expect(checkServiceEndpoint('https://pds.elsewhere.org', at('pds.freeskool.directory'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('does not match'),
    })
    expect(checkServiceEndpoint('not a url', at('pds.freeskool.directory'))).toMatchObject({ ok: false })
  })

  it('opens the loopback escape only when BOTH ends are loopback', () => {
    expect(checkServiceEndpoint('http://127.0.0.1:3000', at('localhost:3000', true))).toEqual({
      ok: true,
      endpoint: 'http://127.0.0.1:3000',
    })
    // A production PDS with a loopback endpoint is the exact accident to prevent…
    expect(checkServiceEndpoint('http://127.0.0.1:3000', at('pds.freeskool.directory', true))).toMatchObject({ ok: false })
    // …and so is the flag being passed where the endpoint is public anyway.
    expect(checkServiceEndpoint(NEW_ENDPOINT, at('localhost:3000', true))).toMatchObject({ ok: false })
  })
})

/* ─────────────────────────────────── flag parsing ───────────────────────────────── */

describe('flags', () => {
  it('rejects a typo instead of silently doing the default thing', () => {
    expect(unknownFlags(['--handle-domain=x', '--apply'])).toEqual([])
    expect(unknownFlags(['--handle-domian=x'])).toEqual(['handle-domian'])
    expect(unknownFlags(['--service-endpoint=https://x', '--dryrun'])).toEqual(['dryrun'])
    expect(unknownFlags(['--', '--dry-run'])).toEqual([])
  })

  it('truncates a DID to a hint rather than a name', () => {
    expect(shortDid('did:plc:tgb57hgxmgcxmyeihwj5ker4')).toBe('did:plc:tgb5…')
  })
})

describe('--snapshot: `=`-form works, space-separated is refused loudly', () => {
  it('accepts --snapshot=<dir>', () => {
    const v = snapshotFlag(['--handle-domain=x', '--snapshot=/tmp/snap', '--apply'])
    expect(v).toEqual({ ok: true, dir: '/tmp/snap' })
  })

  it('is a no-op, not an error, when --snapshot is absent entirely', () => {
    const v = snapshotFlag(['--handle-domain=x', '--apply'])
    expect(v).toEqual({ ok: true, dir: undefined })
  })

  it('refuses a bare, space-separated --snapshot /tmp/x rather than silently writing no snapshot', () => {
    const v = snapshotFlag(['--handle-domain=x', '--snapshot', '/tmp/snap', '--apply'])
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toMatch(/--snapshot needs a value/)
  })
})

/* ───────────────────────────────────── planning ─────────────────────────────────── */

describe('planning the new handles (ruling 3)', () => {
  const custodial = new Set([MEMBER])

  it('gives each school ITS OWN label, the authority the ruled one, and members their prefix', () => {
    const o = OPTS()
    expect(plannedHandle({ did: SCHOOL, handle: 'boulder.freeskool.xyz' }, 'school', o)).toBe('boulder.freeskool.directory')
    // The second school is the case a config-only school label gets wrong: Denver's actor
    // must become denver.<domain>, never <whatever its handle prefix was>.<domain>.
    expect(plannedHandle({ did: DENVER, handle: 'denverfreeskool.freeskool.xyz' }, 'school', o)).toBe('denver.freeskool.directory')
    expect(plannedHandle({ did: AUTHORITY, handle: 'skills.freeskool.xyz' }, 'authority', o)).toBe('skills.freeskool.directory')
    expect(plannedHandle({ did: MEMBER, handle: 'calmalder301.freeskool.xyz' }, 'custodial', o)).toBe('calmalder301.freeskool.directory')
  })

  it('refuses a school with no label rather than inventing one from its handle', () => {
    const o = { ...OPTS(), schools: new Map<string, string>() }
    expect(() => plannedHandle({ did: SCHOOL, handle: 'boulder.freeskool.xyz' }, 'school', o)).toThrow(/no label/)
  })

  it('classifies by DID, not by the shape of the handle', () => {
    const o = OPTS()
    expect(accountKind(SCHOOL, o, custodial)).toBe('school')
    expect(accountKind(DENVER, o, custodial)).toBe('school')
    expect(accountKind(AUTHORITY, o, custodial)).toBe('authority')
    expect(accountKind(MEMBER, o, custodial)).toBe('custodial')
    expect(accountKind(OWNED, o, custodial)).toBe('other')
  })

  it('leaves a member who took ownership out of --accounts=custodial, and in of --accounts=all', () => {
    expect(selected(OWNED, 'other', { accounts: 'custodial' })).toBe(false)
    expect(selected(OWNED, 'other', { accounts: 'all' })).toBe(true)
    expect(selected(MEMBER, 'custodial', { accounts: 'custodial' })).toBe(true)
    expect(selected(MEMBER, 'custodial', { accounts: 'all', only: new Set([OWNED]) })).toBe(false)
  })
})

describe('collisions, caught before anything is signed', () => {
  const entry = (did: string, newHandle: string, kind: PlanEntry['kind'] = 'custodial'): PlanEntry => ({
    did,
    kind,
    currentHandle: 'x.freeskool.xyz',
    newHandle,
    needsEndpoint: true,
    needsHandle: true,
    needsDb: false,
  })
  const reserved = new Set(['boulder', 'denver', 'skills', 'www', 'admin'])

  it('flags two accounts that would land on one handle', () => {
    const out = markCollisions([entry('did:a', 'cal.freeskool.directory'), entry('did:b', 'cal.freeskool.directory')], reserved)
    expect(out.every((e) => e.skip === 'handle-taken')).toBe(true)
    expect(out.every((e) => !e.needsEndpoint && !e.needsHandle)).toBe(true)
  })

  it('flags a member whose prefix is a reserved label, but not the school or authority using theirs', () => {
    const out = markCollisions(
      [
        entry('did:m', 'boulder.freeskool.directory'),
        entry(SCHOOL, 'boulder2.freeskool.directory', 'school'),
        entry(AUTHORITY, 'skills.freeskool.directory', 'authority'),
      ],
      reserved,
    )
    expect(out[0]!.skip).toBe('handle-taken')
    expect(out[1]!.skip).toBeUndefined()
    expect(out[2]!.skip).toBeUndefined()
  })

  it('leaves an ordinary plan alone', () => {
    const out = markCollisions([entry('did:a', 'cal.freeskool.directory'), entry('did:b', 'mara.freeskool.directory')], reserved)
    expect(out.every((e) => e.skip === undefined)).toBe(true)
  })

  it('flags a plan entry that collides with an account OUTSIDE the plan (the universe)', () => {
    // `did:outside` is not itself being migrated this run — it is not even present in
    // `plan` — but it already occupies (or would occupy) the exact handle `did:a` is
    // headed for, and that has to refuse the run just as loudly as an in-plan duplicate.
    const universe = new Map([['did:outside', 'cal.freeskool.directory']])
    const out = markCollisions([entry('did:a', 'cal.freeskool.directory')], reserved, universe)
    expect(out[0]!.skip).toBe('handle-taken')
  })

  it('a DID present in both the plan and the universe is not double-counted against itself', () => {
    // `universe` is built from EVERY account on the PDS, which includes every account
    // that also made it into `plan` — so the same DID appears on both sides. That must
    // not look like two different accounts wanting the same handle.
    const universe = new Map([
      ['did:a', 'cal.freeskool.directory'],
      ['did:b', 'mara.freeskool.directory'],
    ])
    const out = markCollisions(
      [entry('did:a', 'cal.freeskool.directory'), entry('did:b', 'mara.freeskool.directory')],
      reserved,
      universe,
    )
    expect(out.every((e) => e.skip === undefined)).toBe(true)
  })
})

describe('the collision universe: every account on the PDS, not just the plan', () => {
  it('computes the handle a skipped or --limit-excluded account would land on too', () => {
    const universe = targetHandleUniverse(
      [
        { did: SCHOOL, handle: 'boulder.freeskool.xyz' },
        { did: AUTHORITY, handle: 'skills.freeskool.xyz' },
        { did: MEMBER, handle: 'calmalder301.freeskool.xyz' },
        { did: OWNED, handle: 'owner.example.com' },
      ],
      OPTS(),
      new Set([MEMBER]),
    )
    expect(universe.get(SCHOOL)).toBe('boulder.freeskool.directory')
    expect(universe.get(AUTHORITY)).toBe('skills.freeskool.directory')
    expect(universe.get(MEMBER)).toBe('calmalder301.freeskool.directory')
    // OWNED is "other" kind here, excluded from custodial and never selected for THIS
    // run — but its hypothetical target is still computed, which is the whole point.
    expect(universe.get(OWNED)).toBe('owner.freeskool.directory')
  })

  it('drops an account whose prefix cannot be derived rather than throwing', () => {
    const universe = targetHandleUniverse([{ did: 'did:empty', handle: '' }], OPTS(), new Set())
    expect(universe.has('did:empty')).toBe(false)
  })
})

/* ───────────────────────────── the run, against fakes ──────────────────────────── */

interface Fakes {
  plc: PlcPort
  pds: PdsPort
  store: StorePort
  accounts: Record<string, { handle: string; op: PlcOperation }>
  db: Map<string, string>
  cache: Map<string, string>
  submitted: PlcOperation[]
  handleCalls: Array<{ did: string; handle: string }>
  order: string[]
  failures: Array<{ did: string; reason: string }>
}

function fakes(init: Record<string, { handle: string; op: PlcOperation }>, db?: Map<string, string>): Fakes {
  const accounts = { ...init }
  const submitted: PlcOperation[] = []
  const handleCalls: Array<{ did: string; handle: string }> = []
  const order: string[] = []
  const failures: Array<{ did: string; reason: string }> = []
  const rows = db ?? new Map([[MEMBER, 'calmalder301.freeskool.xyz']])
  const cache = new Map<string, string>()
  let heads = 0
  const plc: PlcPort = {
    async lastOp(did) {
      const a = accounts[did]
      if (!a) throw new Error('unknown did')
      return { cid: `bafy-${did}-${heads}`, operation: a.op }
    },
    async auditLog(did) {
      return [{ cid: `bafy-${did}-${heads}`, operation: accounts[did]!.op }]
    },
    async submit(did, o) {
      order.push(`plc:${did}`)
      // The real directory rejects an operation whose `prev` is not the current head.
      if (o.prev !== `bafy-${did}-${heads}`) throw new Error('InvalidRequest: prev is not the head')
      submitted.push(o)
      heads += 1
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
      // The real PDS signs a handle-only PLC op with the same rotation key, which moves
      // the head — which is exactly what can staleness-trap a concurrent endpoint op.
      heads += 1
      accounts[did] = { handle, op: { ...a.op, alsoKnownAs: [`at://${handle}`] } }
    },
    async resolveHandle(handle) {
      return Object.entries(accounts).find(([, a]) => a.handle === handle)?.[0] ?? null
    },
    async wellKnownDid(handle) {
      return Object.entries(accounts).find(([, a]) => a.handle === handle)?.[0] ?? null
    },
  }
  const store: StorePort = {
    async custodialAccounts() {
      return new Map(rows)
    },
    async schools() {
      return SCHOOLS
    },
    async setCustodialHandle(did, handle) {
      if (!rows.has(did)) return 0
      rows.set(did, handle)
      return 1
    },
    async setCachedHandle(did, handle) {
      cache.set(did, handle)
    },
  }
  return { plc, pds, store, accounts, db: rows, cache, submitted, handleCalls, order, failures }
}

type AccountFixtures = Record<string, { handle: string; op: PlcOperation }>

const everyone = (): AccountFixtures => ({
  [SCHOOL]: { handle: 'boulder.freeskool.xyz', op: op({ alsoKnownAs: ['at://boulder.freeskool.xyz'] }) },
  [AUTHORITY]: { handle: 'skills.freeskool.xyz', op: op({ alsoKnownAs: ['at://skills.freeskool.xyz'] }) },
  [MEMBER]: { handle: 'calmalder301.freeskool.xyz', op: op() },
  [OWNED]: { handle: 'owner.example.com', op: op({ alsoKnownAs: ['at://owner.example.com'], rotationKeys: ['did:key:zQ3shSomeoneElse'] }) },
})

const run = (over: Partial<RunOptions>, f: Fakes) =>
  migratePdsHostname(
    { ...OPTS(), apply: false, key: KEY, onFailure: (did, reason) => f.failures.push({ did, reason }), ...over },
    { plc: f.plc, pds: f.pds, store: f.store },
  )

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
    expect(f.db.get(MEMBER)).toBe('calmalder301.freeskool.directory')
    expect(f.cache.get(MEMBER)).toBe('calmalder301.freeskool.directory')
    expect(f.cache.has(SCHOOL)).toBe(false)
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

  it('is resumable: --limit does a prefix, the next run does the rest, and `considered` never shrinks', async () => {
    const f = fakes(everyone())
    const first = await run({ apply: true, limit: 1 }, f)
    expect(first.planned).toBe(1)
    // The denominator is "accounts on this PDS", not "accounts this batch looked at".
    expect(first.considered).toBe(4)
    const second = await run({ apply: true }, f)
    expect(second.planned).toBe(2)
    expect(second.skipped['already-migrated']).toBe(1)
  })

  it('repairs a row left behind when a previous run died between the PLC write and the DB', async () => {
    const f = fakes(everyone())
    await run({ apply: true }, f)
    // The identity is right; the app's copy is not — the shape of a crash in between.
    f.db.set(MEMBER, 'calmalder301.freeskool.xyz')
    f.cache.delete(MEMBER)
    const repair = await run({ apply: true }, f)
    expect(repair.planned).toBe(1)
    expect(repair.dbRepaired).toBe(1)
    expect(repair.endpointUpdated).toBe(0)
    expect(repair.handleUpdated).toBe(0)
    expect(f.db.get(MEMBER)).toBe('calmalder301.freeskool.directory')
    expect(f.cache.get(MEMBER)).toBe('calmalder301.freeskool.directory')
  })

  it('retries once when the PLC head moved under it, and gives up on a second failure', async () => {
    const f = fakes(everyone())
    let calls = 0
    const racing: PlcPort = {
      ...f.plc,
      async lastOp(did) {
        const entry = await f.plc.lastOp(did)
        // Hand out a stale head the FIRST time only, so the first submit is rejected and
        // the refetch succeeds — exactly the concurrent-write case.
        return calls++ === 0 ? { ...entry, cid: 'bafy-stale' } : entry
      },
    }
    const counts = await migratePdsHostname(
      { ...OPTS(), apply: true, key: KEY, only: new Set([MEMBER]), accounts: 'all', onFailure: (d, r) => f.failures.push({ did: d, reason: r }) },
      { plc: racing, pds: f.pds, store: f.store },
    )
    expect(counts.endpointUpdated).toBe(1)
    expect(counts.failed).toBe(0)

    const g = fakes(everyone())
    const alwaysStale: PlcPort = { ...g.plc, lastOp: async (did) => ({ ...(await g.plc.lastOp(did)), cid: 'bafy-always-stale' }) }
    const bad = await migratePdsHostname(
      { ...OPTS(), apply: true, key: KEY, only: new Set([MEMBER]), accounts: 'all', onFailure: (d, r) => g.failures.push({ did: d, reason: r }) },
      { plc: alwaysStale, pds: g.pds, store: g.store },
    )
    expect(bad.failed).toBe(1)
    expect(bad.endpointUpdated).toBe(0)
  })

  it('reports, and never forces, an account whose rotation keys are no longer ours', async () => {
    const f = fakes(everyone())
    const counts = await run({ apply: true, accounts: 'all' }, f)
    expect(counts.skipped['foreign-rotation-key']).toBe(1)
    expect(f.handleCalls.some((h) => h.did === OWNED)).toBe(false)
  })

  it('refuses to apply while a collision stands', async () => {
    const accounts = everyone()
    accounts['did:plc:collider000000000000'] = { handle: 'boulder.freeskool.xyz', op: op({ alsoKnownAs: ['at://boulder.freeskool.xyz'] }) }
    const f = fakes(accounts, new Map([[MEMBER, 'calmalder301.freeskool.xyz'], ['did:plc:collider000000000000', 'boulder.freeskool.xyz']]))
    const dry = await run({}, f)
    // BOTH ends of the duplicate are flagged, not just the newcomer: the run is refused
    // as a whole, and saying "the school is fine, the member is not" would invite somebody
    // to move the school anyway and discover the clash halfway through the batch.
    expect(dry.collisions).toBe(2)
    await expect(run({ apply: true }, f)).rejects.toThrow(/refusing to apply/)
    expect(f.submitted).toHaveLength(0)
  })

  it('refuses to apply over a collision with an account outside the plan (skipped, not-selected)', async () => {
    const accounts = everyone()
    // A member who took ownership and, on their own PDS, already squats the exact handle
    // our custodial MEMBER is headed for. `--accounts=custodial` (the default) means this
    // account is never selected and never even has its PLC log read — the old collision
    // check only ever looked WITHIN `plan`, so it never saw this account at all.
    accounts['did:plc:squatter0000000000000'] = {
      handle: 'calmalder301.freeskool.directory',
      op: op({ alsoKnownAs: ['at://calmalder301.freeskool.directory'], rotationKeys: ['did:key:zQ3shSomeoneElseToo'] }),
    }
    const f = fakes(accounts)
    const dry = await run({}, f)
    expect(dry.collisions).toBe(1)
    expect(dry.planned).toBe(2) // school + authority; the member was pulled out by the collision
    await expect(run({ apply: true }, f)).rejects.toThrow(/refusing to apply/)
    expect(f.submitted).toHaveLength(0)
    expect(f.handleCalls).toHaveLength(0)
  })

  it('refuses to apply over a collision with an account --limit cut off, on the very first limited run', async () => {
    const accounts = everyone()
    // Added AFTER `school`/`authority`/`member`/`owned` in iteration order, so with
    // `limit: 1` it never makes it into THIS batch's plan — but it is still on the PDS,
    // still custodial, and still headed for the school's exact target handle.
    accounts['did:plc:laterboulder00000000'] = { handle: 'boulder.freeskool.io', op: op({ alsoKnownAs: ['at://boulder.freeskool.io'] }) }
    const rows = new Map([[MEMBER, 'calmalder301.freeskool.xyz'], ['did:plc:laterboulder00000000', 'boulder.freeskool.io']])
    const f = fakes(accounts, rows)
    const limited = await run({ limit: 1 }, f)
    // The school (the only entry `limit: 1` let into the plan) is the one flagged: the
    // colliding account itself never entered `plan` at all, only the universe.
    expect(limited.collisions).toBe(1)
    expect(limited.planned).toBe(0)
    await expect(run({ apply: true, limit: 1 }, f)).rejects.toThrow(/refusing to apply/)
    expect(f.submitted).toHaveLength(0)
  })

  it('counts an unreadable PLC log as a failure, and names it on the failure channel', async () => {
    const f = fakes(everyone())
    const broken: PlcPort = { ...f.plc, lastOp: async () => { throw new Error('plc down') } }
    const counts = await migratePdsHostname(
      { ...OPTS(), apply: false, key: KEY, onFailure: (did, reason) => f.failures.push({ did, reason }) },
      { plc: broken, pds: f.pds, store: f.store },
    )
    expect(counts.planned).toBe(0)
    expect(counts.failed).toBe(3)
    expect(f.failures).toHaveLength(3)
    expect(f.failures[0]!.reason).toMatch(/plc down/)
  })

  it('counts a half-applied account as failed verification rather than done', async () => {
    const f = fakes(everyone())
    // A PDS that accepts the handle call but does not actually move the handle — the
    // shape of a partial failure the script must not report as success.
    const lying: PdsPort = { ...f.pds, updateAccountHandle: async () => {} }
    const counts = await migratePdsHostname(
      { ...OPTS(), apply: true, key: KEY, only: new Set([MEMBER]), accounts: 'all', onFailure: (d, r) => f.failures.push({ did: d, reason: r }) },
      { plc: f.plc, pds: lying, store: f.store },
    )
    expect(counts.endpointUpdated).toBe(1)
    expect(counts.verified).toBe(0)
    expect(counts.failedVerification).toBe(1)
    expect(f.failures.at(-1)!.reason).toMatch(/verification failed/)
  })
})

/* ─────────────────────────────────── verification ───────────────────────────────── */

describe('verification', () => {
  const entry: PlanEntry = {
    did: MEMBER,
    kind: 'custodial',
    currentHandle: 'calmalder301.freeskool.xyz',
    newHandle: 'calmalder301.freeskool.directory',
    needsEndpoint: true,
    needsHandle: true,
    needsDb: false,
  }

  const port = (o: {
    endpoint: string
    aka: string[]
    resolves: Record<string, string | null>
    wellKnown?: string | null
  }): { plc: PlcPort; pds: PdsPort } => ({
    plc: {
      lastOp: async () => ({ cid: 'x', operation: op() }),
      auditLog: async () => [],
      submit: async () => {},
      document: async () => ({ alsoKnownAs: o.aka, service: [{ id: '#atproto_pds', serviceEndpoint: o.endpoint }] }),
    },
    pds: {
      listRepos: async () => [],
      accountInfos: async () => [],
      updateAccountHandle: async () => {},
      resolveHandle: async (h) => o.resolves[h] ?? null,
      wellKnownDid: async () => (o.wellKnown === undefined ? MEMBER : o.wellKnown),
    },
  })

  const good = {
    endpoint: NEW_ENDPOINT,
    aka: ['at://calmalder301.freeskool.directory'],
    resolves: { 'calmalder301.freeskool.directory': MEMBER },
  }

  it('passes when the document, the PDS and the public well-known all agree', async () => {
    const p = port(good)
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toEqual({
      ok: true,
      endpointOk: true,
      handleOk: true,
      resolvesOk: true,
      externalOk: true,
      oldHandleOk: true,
    })
  })

  it('fails when the endpoint is still the old one', async () => {
    const p = port({ ...good, endpoint: OLD_ENDPOINT })
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toMatchObject({ ok: false, endpointOk: false })
  })

  it('fails when the handle resolves to somebody else', async () => {
    const p = port({ ...good, resolves: { 'calmalder301.freeskool.directory': 'did:plc:someone-else' } })
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toMatchObject({ ok: false, resolvesOk: false })
  })

  it('fails when the public name does not serve /.well-known/atproto-did — DNS or TLS, not PLC', async () => {
    // Our own PDS happily says yes; the outside world cannot reach the name. That is the
    // failure `resolveHandle` alone cannot see, which is why the external fetch exists.
    const p = port({ ...good, wellKnown: null })
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toMatchObject({ ok: false, externalOk: false })
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT, { skipExternal: true })).toMatchObject({ ok: true, externalOk: true })
  })

  it('fails when the OLD handle has been taken over by a different DID', async () => {
    const p = port({ ...good, resolves: { 'calmalder301.freeskool.directory': MEMBER, 'calmalder301.freeskool.xyz': 'did:plc:squatter' } })
    expect(await verifyAccount(entry, p.plc, p.pds, NEW_ENDPOINT)).toMatchObject({ ok: false, oldHandleOk: false })
  })

  it('accepts an old handle that still points at us (the overlap window) or is gone', async () => {
    const stillUs = port({ ...good, resolves: { 'calmalder301.freeskool.directory': MEMBER, 'calmalder301.freeskool.xyz': MEMBER } })
    expect(await verifyAccount(entry, stillUs.plc, stillUs.pds, NEW_ENDPOINT)).toMatchObject({ ok: true, oldHandleOk: true })
    const gone = port(good)
    expect(await verifyAccount(entry, gone.plc, gone.pds, NEW_ENDPOINT)).toMatchObject({ ok: true, oldHandleOk: true })
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

  it('the failure channel carries a truncated DID and never a handle or an email', async () => {
    const f = fakes(everyone())
    const broken: PlcPort = { ...f.plc, lastOp: async () => { throw new Error('plc down') } }
    await migratePdsHostname(
      { ...OPTS(), apply: false, key: KEY, onFailure: (did, reason) => f.failures.push({ did: shortDid(did), reason }) },
      { plc: broken, pds: f.pds, store: f.store },
    )
    for (const line of f.failures.map((x) => `${x.did} ${x.reason}`)) {
      expect(line).toMatch(/…$|… /)
      expect(line).not.toMatch(/freeskool/)
      expect(line).not.toMatch(/@/)
    }
  })
})

/** Kept so the CurrentState type is exercised by name, not only structurally. */
const _state: CurrentState = { endpoint: NEW_ENDPOINT, publishedHandle: 'x.freeskool.directory', rotationKeys: [] }
void _state
void ({} as AuditEntry)
