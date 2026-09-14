/**
 * FEDERATION (design §2 ruling 9, MS §7, interop gap 4b): the peer list is a RECORD.
 *
 * `PUT /api/admin/peers` has two effects and only one of them is federation: it updates
 * `fs_peer` (which hosts WE follow) and it re-publishes the school's own
 * `freeschool.draft.school` record with `peers` (peer school DIDs) and `tags` (what this
 * school routes listings on). The record is the only half another city can read, so it is
 * the half these tests are about:
 *
 *   - the exact record the school actor is asked to write, including every field of the
 *     old record carried through untouched (read-modify-write, as `PUT /policy` does);
 *   - the ORDER: the actor first, the table second, so a PDS that refuses leaves
 *     `fs_peer` exactly as it was and the steward is told nothing happened;
 *   - `peerSchools()` / `GET /api/schools/nearby`: the school records we have INDEXED
 *     from our peer hosts, and NOTHING from a host we do not follow (ruling 7 — no
 *     counts, and nothing about a school we have no public record from).
 *
 * The PDS, the index and the school's session are all faked: a unit suite must never mint
 * a DID or write to the dev PDS (CLAUDE.md).
 */
process.env.SCHOOL_DID = 'did:plc:fed-school'
process.env.SCHOOL_HANDLE = 'boulder.test'
process.env.PEER_PDS_HOSTS = 'http://localhost:3000'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'federation-peers-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 23).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'federation-peers-test-pepper'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'

const SCHOOL = 'did:plc:fed-school'
const STEWARD = 'did:plc:fed-steward'
const DENVER = 'did:plc:peer-denver'
const FARAWAY = 'did:plc:peer-faraway'
const DENVER_PDS = 'https://pds.denver.example'
const FARAWAY_PDS = 'https://pds.faraway.example'

/** The school's own repo, as far as `getRecord` is concerned. */
const { repo, indexed, identities } = vi.hoisted(() => ({
  repo: new Map<string, Record<string, unknown>>(),
  indexed: [] as Array<{ did: string; record: Record<string, unknown> }>,
  identities: new Map<string, string>(),
}))

/**
 * The school's PDS. `readFails` is the review's blocking case: a read we did not GET
 * (a 503, a dead socket) must never be taken for "this school has no record".
 */
const readFails = { on: false }

vi.mock('../src/lib/pds.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/pds.js')>()
  return {
    ...actual,
    async getRecord(repoDid: string, collection: string, rkey: string) {
      const value = repo.get(`${repoDid}/${collection}/${rkey}`)
      return value ? { uri: `at://${repoDid}/${collection}/${rkey}`, value } : null
    },
    async readRecord(repoDid: string, collection: string, rkey: string) {
      if (readFails.on) throw new actual.RecordReadError(503, 'UpstreamFailure', 'the PDS is unreachable')
      const value = repo.get(`${repoDid}/${collection}/${rkey}`)
      return value ? { found: true, uri: `at://${repoDid}/${collection}/${rkey}`, value } : { found: false }
    },
  }
})

/** No PLC, no network: the DIDs we know about resolve, everything else does not. */
vi.mock('../src/lib/identity.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/identity.js')>()),
  async resolvePdsEndpoint(did: string) {
    return ({ [DENVER]: DENVER_PDS, [FARAWAY]: FARAWAY_PDS } as Record<string, string>)[did] ?? null
  },
}))

const reloads = { count: 0 }

vi.mock('../src/index/indexer.js', () => {
  const indexer = {
    contrail: {
      config: { relays: ['http://localhost:3000'] },
      async query(short: string) {
        if (short !== 'school') return { records: [] }
        return {
          records: indexed.map((s) => ({
            uri: `at://${s.did}/freeschool.draft.school/self`,
            did: s.did,
            collection: 'freeschool.draft.school',
            rkey: 'self',
            cid: 'bafyschool',
            record: s.record,
            time_us: 1,
            indexed_at: 1,
          })),
        }
      },
    },
    db: {
      prepare(sqlText: string) {
        return {
          bind(did: string) {
            return {
              async first() {
                if (sqlText.includes('SELECT pds')) {
                  const pds = identities.get(did)
                  return pds ? { pds } : null
                }
                return null
              },
              async all() {
                return { results: [] }
              },
            }
          },
        }
      },
    },
    async notify() {},
    async reload() {
      reloads.count++
      return indexer
    },
  }
  return { getIndexer: async () => indexer, resetIndexer: () => {}, createIndexer: async () => indexer }
})

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { config } from '../src/config.js'
import { signSessionId } from '../src/lib/crypto.js'
import { custodialAccount, peer, steward } from '../src/db/schema.js'
import { setSchoolActor } from '../src/lib/school-actor.js'
import { peerSchools } from '../src/lib/peers.js'
import { indexerPeerHosts } from '../src/index/peers.js'
import { resetSchoolContextCache } from '../src/http/school-context.js'

interface Written {
  schoolDid: string
  collection: string
  rkey: string
  action: string
  reason: string
  record: Record<string, unknown>
}

/** A port that records what the school was asked to write — or refuses, for the order test. */
function fakePort(written: Written[], refuse = false): SchoolActorPort {
  return {
    async describeActor(i: { schoolDid: Did }) {
      return { schoolDid: i.schoolDid, pdsEndpoint: 'http://pds.test', custody: 'app-owned' as const, online: true }
    },
    async authorize() {
      return { allowed: true as const, role: 30, reason: 'ok' }
    },
    async putRecordAsSchool(i: {
      schoolDid: Did
      collection: string
      rkey: string
      action: string
      record: Record<string, unknown>
      audit: { reason: string }
    }) {
      if (refuse) throw new Error('the PDS refused this write')
      written.push({
        schoolDid: i.schoolDid,
        collection: i.collection,
        rkey: i.rkey,
        action: i.action,
        reason: i.audit.reason,
        record: i.record,
      })
      repo.set(`${i.schoolDid}/${i.collection}/${i.rkey}`, i.record)
      return { uri: `at://${i.schoolDid}/${i.collection}/${i.rkey}`, cid: 'bafypeers', auditId: 'audit' }
    },
    async deleteRecordAsSchool() {
      return { auditId: 'audit' }
    },
  } as unknown as SchoolActorPort
}

function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function stewardCookie(): Promise<string> {
  const id = await createSession(fakeContext(), STEWARD, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

async function putPeers(body: unknown): Promise<Response> {
  return createApp().request('/api/admin/peers', {
    method: 'PUT',
    headers: { Cookie: await stewardCookie(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_peer', 'fs_steward', 'fs_session', 'fs_custodial_account', 'fs_member', 'fs_audit', 'fs_policy_cache')
  resetSchoolContextCache()
  reloads.count = 0
  readFails.on = false

  repo.clear()
  repo.set(`${SCHOOL}/freeschool.draft.school/self`, {
    $type: 'freeschool.draft.school',
    name: 'Boulder Free School',
    description: 'A free, open skill-sharing school.',
    region: 'Boulder, Colorado',
    policy: `at://${SCHOOL}/freeschool.draft.policy/p1`,
    handleDomain: 'freeskool.directory',
    peers: [],
    tags: ['skillshare', 'free-school'],
    createdAt: '2026-01-01T00:00:00Z',
  })
  repo.set(`${SCHOOL}/freeschool.draft.policy/p1`, {
    $type: 'freeschool.draft.policy',
    title: 'how this works',
    version: '1',
    thresholds: {},
  })

  indexed.length = 0
  indexed.push(
    {
      did: DENVER,
      record: {
        $type: 'freeschool.draft.school',
        name: 'Denver Free School',
        region: 'Denver, Colorado',
        website: 'https://denver.example',
        tags: ['skillshare', 'mutual-aid'],
        peers: [SCHOOL],
        createdAt: '2026-02-01T00:00:00Z',
      },
    },
    {
      did: FARAWAY,
      record: {
        $type: 'freeschool.draft.school',
        name: 'Faraway Free School',
        region: 'Somewhere else',
        tags: ['skillshare'],
        peers: [],
        createdAt: '2026-02-01T00:00:00Z',
      },
    },
  )
  identities.clear()
  identities.set(DENVER, DENVER_PDS)
  identities.set(FARAWAY, FARAWAY_PDS)

  await testDb().insert(steward).values({ did: STEWARD, schoolDid: SCHOOL })
  await testDb()
    .insert(custodialAccount)
    .values({ did: STEWARD, handle: 'fed-steward.test', email: 'fed@example.org', keyVersion: 'v1' })
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('PUT /api/admin/peers publishes the peer list in the school record', () => {
  it('writes peers and tags through the school actor, carrying every other field across', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))

    const res = await putPeers({ add: [DENVER_PDS], tags: ['skillshare', 'Free-School', 'mutual-aid'] })
    expect(res.status).toBe(200)

    expect(written).toHaveLength(1)
    const w = written[0]!
    expect(w.collection).toBe('freeschool.draft.school')
    expect(w.rkey).toBe('self')
    expect(w.action).toBe('set-peers')
    expect(w.reason).toMatch(/peer/i)
    // THE EXACT RECORD. Denver is a peer because its school record is indexed from the
    // host just added; Faraway is on a host we do not follow, so it is not.
    expect(w.record).toEqual({
      $type: 'freeschool.draft.school',
      name: 'Boulder Free School',
      description: 'A free, open skill-sharing school.',
      region: 'Boulder, Colorado',
      policy: `at://${SCHOOL}/freeschool.draft.policy/p1`,
      handleDomain: 'freeskool.directory',
      createdAt: '2026-01-01T00:00:00Z',
      peers: [DENVER],
      tags: ['skillshare', 'free-school', 'mutual-aid'],
    })

    const body = (await res.json()) as { peers: Array<{ host: string }>; published: { peers: string[]; tags: string[] } }
    expect(body.published.peers).toEqual([DENVER])
    expect(body.peers.map((p) => p.host)).toEqual([DENVER_PDS])
    // The peer set changed, so contrail's `relays` are rebuilt.
    expect(reloads.count).toBe(1)
  })

  it('accepts a peer named by DID, resolving it to the host we then follow', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))

    const res = await putPeers({ add: [DENVER] })
    expect(res.status).toBe(200)
    expect(written[0]!.record.peers).toEqual([DENVER])
    // Tags were not named in the body, so the published ones are left exactly as they were.
    expect(written[0]!.record.tags).toEqual(['skillshare', 'free-school'])
    const rows = await testDb().select().from(peer)
    expect(rows.map((r) => r.host)).toEqual([DENVER_PDS])
  })

  it('leaves fs_peer UNCHANGED when the school actor refuses the record (record first, table second)', async () => {
    if (!available) return
    setSchoolActor(fakePort([], true))

    const res = await putPeers({ add: [DENVER_PDS] })
    expect(res.status).toBe(502)

    expect(await testDb().select().from(peer)).toHaveLength(0)
    // …and the published record still says what it said before.
    expect(repo.get(`${SCHOOL}/freeschool.draft.school/self`)?.peers).toEqual([])
    expect(reloads.count).toBe(0)
  })

  it('drops a peer from the published record when its host is removed', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))

    expect((await putPeers({ add: [DENVER_PDS] })).status).toBe(200)
    expect((await putPeers({ remove: [DENVER_PDS] })).status).toBe(200)

    expect(written[1]!.record.peers).toEqual([])
    const rows = await testDb().select().from(peer)
    expect(rows[0]?.disabledAt).toBeTruthy()
  })

  it('GET /api/admin/peers returns the published state beside the table', async () => {
    if (!available) return
    setSchoolActor(fakePort([]))
    await putPeers({ add: [DENVER_PDS] })

    const res = await createApp().request('/api/admin/peers', { headers: { Cookie: await stewardCookie() } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      peers: Array<{ host: string; source: string }>
      published: { peers: string[]; tags: string[]; uri?: string }
    }
    expect(body.peers).toEqual([expect.objectContaining({ host: DENVER_PDS, source: 'admin' })])
    expect(body.published).toMatchObject({
      peers: [DENVER],
      tags: ['skillshare', 'free-school'],
      uri: `at://${SCHOOL}/freeschool.draft.school/self`,
    })
  })
})

describe('a failed READ of the school record never becomes a rewritten school record', () => {
  it('does not call the actor, and leaves fs_peer untouched, when the record cannot be read', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))
    readFails.on = true

    const res = await putPeers({ add: [DENVER_PDS] })
    expect(res.status).toBe(502)
    // THE POINT: not one write. A synthesized record would have dropped `policy`, and a
    // school record with no policy pointer reads as the permissive default thresholds.
    expect(written).toHaveLength(0)
    expect(await testDb().select().from(peer)).toHaveLength(0)
    expect(repo.get(`${SCHOOL}/freeschool.draft.school/self`)?.policy).toBe(`at://${SCHOOL}/freeschool.draft.policy/p1`)
  })

  it('DOES write a fresh record when the repo genuinely has none', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))
    repo.delete(`${SCHOOL}/freeschool.draft.school/self`)

    const res = await putPeers({ add: [DENVER_PDS], tags: ['skillshare'] })
    expect(res.status).toBe(200)
    expect(written).toHaveLength(1)
    expect(written[0]!.record).toMatchObject({
      $type: 'freeschool.draft.school',
      peers: [DENVER],
      tags: ['skillshare'],
    })
    expect(written[0]!.record.createdAt).toEqual(expect.any(String))
  })

  it('drops a peer whose host is spelled with a trailing slash', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))

    expect((await putPeers({ add: [DENVER_PDS] })).status).toBe(200)
    expect((await putPeers({ remove: [`${DENVER_PDS}/`] })).status).toBe(200)

    expect(written[1]!.record.peers).toEqual([])
    const rows = await testDb().select().from(peer)
    expect(rows[0]?.disabledAt).toBeTruthy()
  })
})

describe('only a steward of THIS school may edit the peer list', () => {
  it('403s an ordinary member', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))
    await testDb().delete(steward)

    const res = await putPeers({ add: [DENVER_PDS] })
    expect(res.status).toBe(403)
    expect(written).toHaveLength(0)
    expect(await testDb().select().from(peer)).toHaveLength(0)
  })

  it('403s a steward of ANOTHER school', async () => {
    if (!available) return
    const written: Written[] = []
    setSchoolActor(fakePort(written))
    await testDb().delete(steward)
    await testDb().insert(steward).values({ did: STEWARD, schoolDid: 'did:plc:some-other-school' })

    const res = await putPeers({ add: [DENVER_PDS] })
    expect(res.status).toBe(403)
    expect(written).toHaveLength(0)
    expect(await testDb().select().from(peer)).toHaveLength(0)
  })
})

describe('the PEER_PDS_HOSTS seed applies only to a registry that was never written', () => {
  it('falls back to the env seed when there is no row at all', async () => {
    if (!available) return
    expect(await indexerPeerHosts()).toEqual(['http://localhost:3000'])
  })

  it('follows NOTHING when every row is disabled — a steward emptied it on purpose', async () => {
    if (!available) return
    await testDb()
      .insert(peer)
      .values({ host: DENVER_PDS, source: 'admin', schoolDid: SCHOOL, disabledAt: new Date() })
    expect(await indexerPeerHosts()).toEqual([])
  })
})

describe('peer discovery: the school records we have indexed from our peer hosts', () => {
  it('peerSchools() returns a peer on a followed host and nothing from a host we do not follow', async () => {
    if (!available) return
    await testDb().insert(peer).values({ host: DENVER_PDS, source: 'admin', schoolDid: SCHOOL })

    const peers = await peerSchools(SCHOOL)
    expect(peers).toEqual([
      {
        did: DENVER,
        name: 'Denver Free School',
        city: 'Denver, Colorado',
        host: 'denver.example',
        tags: ['skillshare', 'mutual-aid'],
        peers: [SCHOOL],
      },
    ])
  })

  it('GET /api/schools/nearby is public, names no counts, and never names our own school', async () => {
    if (!available) return
    await testDb().insert(peer).values([
      { host: DENVER_PDS, source: 'admin', schoolDid: SCHOOL },
      // Our own PDS is a peer of ours; our own school record must still not be "nearby".
      { host: 'http://localhost:3000', source: 'env', schoolDid: SCHOOL },
    ])
    indexed.push({
      did: SCHOOL,
      record: { $type: 'freeschool.draft.school', name: 'Boulder Free School', createdAt: '2026-01-01T00:00:00Z' },
    })
    identities.set(SCHOOL, 'http://localhost:3000')

    const res = await createApp().request('/api/schools/nearby')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schools: Array<Record<string, unknown>> }
    expect(body.schools.map((s) => s.did)).toEqual([DENVER])
    // Ruling 7: a name, a region, a front door and the tags. Never a count of anything.
    expect(Object.keys(body.schools[0]!).sort()).toEqual(['city', 'did', 'host', 'name', 'peers', 'tags'])
    expect(JSON.stringify(body)).not.toContain(FARAWAY)
  })
})
