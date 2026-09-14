/**
 * "Ask <name> to teach this" (UX audit journey finding 13).
 *
 * The thing this suite exists to pin is a NEGATIVE: the public
 * `freeschool.draft.request` record must be byte-for-byte what it would have been if
 * nobody had been asked. A record that named the person asked would be a public claim
 * about somebody else's time, written under the asker's identity, which is precisely what
 * R9 forbids. Everything about the ask lives app-side — one row in `fs_request_asked_of`
 * — and reaches exactly one person: the member asked, through their own notifications.
 *
 * The second half is the three limits on asking (Task 10 report, concern 3): the ask
 * MERGES into an open request for the same skill addressed to the same person, the person
 * hears about it at most once a week per skill, and one member gets ten asks a day.
 */
process.env.SCHOOL_DID = 'did:plc:asked-of-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'asked-of-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 19).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'asked-of-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

const SCHOOL = 'did:plc:asked-of-school'
const OTHER_SCHOOL = 'did:plc:asked-of-denver'
const ASKER = 'did:plc:asked-of-rosa'
const TEACHER = 'did:plc:asked-of-wren'

/** The asker's repo, as a map: what was actually written, and nothing else. */
const { repo } = vi.hoisted(() => ({ repo: new Map<string, Record<string, unknown>>() }))

vi.mock('../src/lib/actor-agent.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/actor-agent.js')>('../src/lib/actor-agent.js')
  return {
    ...actual,
    async actorAgent(viewer: { did: string }) {
      return {
        com: {
          atproto: {
            repo: {
              async putRecord(i: { repo: string; collection: string; rkey: string; record: Record<string, unknown> }) {
                const key = `${i.repo}/${i.collection}/${i.rkey}`
                repo.set(key, i.record)
                return { data: { uri: `at://${key}`, cid: 'bafy' } }
              },
            },
          },
        },
        did: viewer.did,
      } as never
    },
  }
})

/**
 * The index, in memory. `createRequest` reads it to find the open request an ask should
 * merge into, so a stub that always answers "nothing" would make the merge untestable —
 * and would have let a merge that never fires pass as a merge that works. Filters are
 * honoured for the same reason: a CLOSED request must not swallow a new ask.
 */
const { indexed } = vi.hoisted(() => ({
  indexed: [] as Array<{ uri: string; did: string; cid: string; record: Record<string, unknown> }>,
}))

vi.mock('../src/index/indexer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/index/indexer.js')>('../src/index/indexer.js')
  return {
    ...actual,
    getIndexer: async () => ({
      contrail: {
        async query(_short: string, options: { filters?: Record<string, unknown> } = {}) {
          const filters = Object.entries(options.filters ?? {})
          return {
            records: indexed
              .filter((row) => filters.every(([key, want]) => row.record[key] === want))
              .map((row) => ({ ...row, collection: 'freeschool.draft.request', rkey: row.uri.split('/').pop()! })),
          }
        },
      },
      db: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null }) }) },
      async notify() {},
    }),
  }
})

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { Hono } from 'hono'
import { createRequest, askedOfFor, MAX_ASKS_PER_DAY, TooManyAsksError } from '../src/lib/requests.js'
import { requests as requestRoutes } from '../src/http/routes/requests.js'
import type { AppEnv } from '../src/http/session.js'
import type { School } from '../src/lib/schools.js'
import { countInterested } from '../src/lib/request-rsvp.js'
import { saveProfile } from '../src/lib/profile.js'
import { notificationFeed, requestAskedOf } from '../src/db/schema.js'
import type { Viewer } from '../src/http/session.js'

const asker: Viewer = { did: ASKER, kind: 'custodial', sessionId: 's1' } as Viewer
/** A second member asking for the same thing — the whole point of merging. */
const other: Viewer = { did: 'did:plc:asked-of-tam', kind: 'custodial', sessionId: 's2' } as Viewer
const SKILL = 'at://did:plc:taxonomy/freeschool.draft.skill/bicycle-mechanics'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate(
    'fs_app_meta',
    'fs_request_asked_of',
    'fs_request_rsvp',
    'fs_notification_feed',
    'fs_notification_sent',
    'fs_notification_outbox',
  )
  repo.clear()
  indexed.length = 0
  await saveProfile(ASKER, { displayName: 'Rosa Vance' }, SCHOOL)
})

afterAll(async () => {
  if (available) await closeTestDb()
})

async function feedFor(did: string) {
  return testDb().select().from(notificationFeed).where(eq(notificationFeed.did, did))
}

/**
 * Ask, and put the result in the index the way a real `indexer.notify` would. Nothing
 * merges into a request the index has never heard of, so a suite that skipped this step
 * would be testing an index that is always empty.
 */
async function ask(viewer: Viewer, input: { title: string; skill?: string; askedOf?: string }, school = SCHOOL) {
  const result = await createRequest(viewer, input, { schoolDid: school })
  if (!result.merged) {
    indexed.push({
      uri: result.uri,
      did: viewer.did,
      cid: result.cid,
      record: { ...input, askedOf: undefined, status: 'open' },
    })
  }
  return result
}

describe('asking a particular member to teach something', () => {
  it('never names the asked member on the public record', async () => {
    if (!available) return
    await createRequest(asker, { title: 'Bicycle mechanics', askedOf: TEACHER }, { schoolDid: SCHOOL })

    expect(repo.size).toBe(1)
    const record = [...repo.values()][0]!
    expect(JSON.stringify(record)).not.toContain(TEACHER)
    expect(record).not.toHaveProperty('askedOf')
    // …and is otherwise the ordinary request it always was.
    expect(record).toMatchObject({ $type: 'freeschool.draft.request', title: 'Bicycle mechanics', status: 'open' })
  })

  it('keeps who was asked app-side, stamped with the school it happened in', async () => {
    if (!available) return
    const { uri } = await createRequest(asker, { title: 'Bicycle mechanics', askedOf: TEACHER }, { schoolDid: SCHOOL })

    const rows = await testDb().select().from(requestAskedOf).where(eq(requestAskedOf.requestUri, uri))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ askedOfDid: TEACHER, schoolDid: SCHOOL })
    expect(await askedOfFor(uri)).toBe(TEACHER)
  })

  it('tells the member asked, by name, what they were asked to teach', async () => {
    if (!available) return
    await createRequest(asker, { title: 'Bicycle mechanics', askedOf: TEACHER }, { schoolDid: SCHOOL })

    const feed = await feedFor(TEACHER)
    expect(feed).toHaveLength(1)
    expect(feed[0]!.title).toBe('Rosa Vance asked if you would teach Bicycle mechanics')
    expect(feed[0]!.category).toBe('request.asked-of')
    expect(feed[0]!.schoolDid).toBe(SCHOOL)
    // The asker hears nothing: they already know.
    expect(await feedFor(ASKER)).toHaveLength(0)
  })

  it('says "someone at this school" rather than a raw DID when there is no name on file', async () => {
    if (!available) return
    await truncate('fs_app_meta')
    await createRequest(asker, { title: 'Sourdough', askedOf: TEACHER }, { schoolDid: SCHOOL })

    const feed = await feedFor(TEACHER)
    expect(feed[0]!.title).toBe('Someone at this school asked if you would teach Sourdough')
    expect(feed[0]!.title).not.toContain('did:')
  })

  it('does nothing extra for an ordinary request, or for asking yourself', async () => {
    if (!available) return
    await createRequest(asker, { title: 'Nobody in particular' }, { schoolDid: SCHOOL })
    await createRequest(asker, { title: 'Asking myself', askedOf: ASKER }, { schoolDid: SCHOOL })

    expect(await testDb().select().from(requestAskedOf)).toHaveLength(0)
    expect(await feedFor(ASKER)).toHaveLength(0)
  })

  it('stamps the school the ask happened in, not the deployment default', async () => {
    if (!available) return
    const { uri } = await createRequest(asker, { title: 'Welding', askedOf: TEACHER }, { schoolDid: OTHER_SCHOOL })

    const rows = await testDb().select().from(requestAskedOf).where(eq(requestAskedOf.requestUri, uri))
    expect(rows[0]!.schoolDid).toBe(OTHER_SCHOOL)
    expect((await feedFor(TEACHER))[0]!.schoolDid).toBe(OTHER_SCHOOL)
  })
})

/**
 * ONE NEED, ONE ROW ON THE BOARD (Task 10 report, concern 3).
 *
 * Before this, twenty members asking Wren to teach bicycle mechanics produced twenty
 * public requests and twenty notifications. The board became noise and the person asked
 * got a pile-on for having a skill on their profile.
 */
describe('a second ask for the same skill and the same person', () => {
  it('joins the open request instead of writing another, and says so', async () => {
    if (!available) return
    const first = await ask(asker, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    expect(first.merged).toBeUndefined()

    const second = await ask(other, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })

    expect(second.merged).toBe(true)
    expect(second.uri).toBe(first.uri)
    // One record written, by the first asker, and none by the second.
    expect(repo.size).toBe(1)
    // The second asker is counted where it matters: interest on the request that exists.
    expect(await countInterested(first.uri, SCHOOL)).toBe(1)
    expect(await testDb().select().from(requestAskedOf)).toHaveLength(1)
  })

  it('tells the member asked once, not once per asker', async () => {
    if (!available) return
    await ask(asker, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    await ask(other, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    await ask(other, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })

    expect(await feedFor(TEACHER)).toHaveLength(1)
  })

  it('still writes its own request for a DIFFERENT skill, and tells them about that one', async () => {
    if (!available) return
    await ask(asker, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    const welding = await ask(other, { title: 'Welding', skill: `${SKILL}-welding`, askedOf: TEACHER })

    expect(welding.merged).toBeUndefined()
    expect(repo.size).toBe(2)
    expect((await feedFor(TEACHER)).map((row) => row.title)).toEqual([
      'Rosa Vance asked if you would teach Bicycle mechanics',
      'Someone at this school asked if you would teach Welding',
    ])
  })

  it('does not merge across schools: a Denver ask is not a Boulder request', async () => {
    if (!available) return
    const boulder = await ask(asker, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    const denver = await ask(other, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER }, OTHER_SCHOOL)

    expect(denver.merged).toBeUndefined()
    expect(denver.uri).not.toBe(boulder.uri)
  })

  it('does not merge into a request that is no longer open', async () => {
    if (!available) return
    const first = await ask(asker, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    indexed.find((row) => row.uri === first.uri)!.record.status = 'claimed'

    const second = await ask(other, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    expect(second.merged).toBeUndefined()
  })

  it('never merges an ask that names no skill — two typings of a word are not one need', async () => {
    if (!available) return
    await ask(asker, { title: 'Sourdough', askedOf: TEACHER })
    const second = await ask(other, { title: 'Sourdough', askedOf: TEACHER })

    expect(second.merged).toBeUndefined()
    expect(repo.size).toBe(2)
  })
})

describe('how many asks one member gets in a day', () => {
  it(`refuses the ask past ${MAX_ASKS_PER_DAY}, and writes nothing at all`, async () => {
    if (!available) return
    for (let i = 0; i < MAX_ASKS_PER_DAY; i += 1) {
      await ask(asker, { title: `Thing ${i}`, skill: `${SKILL}-${i}`, askedOf: TEACHER })
    }
    expect(repo.size).toBe(MAX_ASKS_PER_DAY)

    await expect(
      ask(asker, { title: 'One too many', skill: `${SKILL}-over`, askedOf: TEACHER }),
    ).rejects.toBeInstanceOf(TooManyAsksError)

    // Not even the public request: a request nobody meant is still litter on the board.
    expect(repo.size).toBe(MAX_ASKS_PER_DAY)
    expect(await testDb().select().from(requestAskedOf)).toHaveLength(MAX_ASKS_PER_DAY)
  })

  it('counts the asker’s own asks only, and leaves plain requests alone', async () => {
    if (!available) return
    for (let i = 0; i < MAX_ASKS_PER_DAY; i += 1) {
      await ask(asker, { title: `Thing ${i}`, skill: `${SKILL}-${i}`, askedOf: TEACHER })
    }

    // Somebody else asking is unaffected…
    await expect(
      ask(other, { title: 'Theirs', skill: `${SKILL}-theirs`, askedOf: TEACHER }),
    ).resolves.not.toHaveProperty('merged')
    // …and so is the asker posting an ordinary needs-board request.
    await expect(ask(asker, { title: 'Just a request' })).resolves.toHaveProperty('uri')
  })
})

/**
 * The route's half of it: which status code the PWA sees. 201 means "your request is on
 * the board", 200 + `merged` means "you joined one that was already there", and 429 means
 * the member has asked for enough today. Mounted with the viewer and the school set
 * directly — the session and tenancy middleware have suites of their own.
 */
describe('POST /api/requests', () => {
  function appAs(viewer: Viewer) {
    const app = new Hono<AppEnv>()
    app.use('*', async (c, next) => {
      c.set('viewer', viewer)
      c.set('school', { did: SCHOOL, label: 'boulder', name: 'Boulder Free School' } as School)
      await next()
    })
    app.route('/api', requestRoutes)
    return app
  }

  async function post(viewer: Viewer, body: Record<string, unknown>) {
    return appAs(viewer).request('http://school.test/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('201 for a new ask, 200 and merged for one that joins an open request', async () => {
    if (!available) return
    const created = await post(asker, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    expect(created.status).toBe(201)
    const first = await created.json()
    indexed.push({
      uri: first.uri,
      did: ASKER,
      cid: first.cid,
      record: { title: 'Bicycle mechanics', skill: SKILL, status: 'open' },
    })

    const merged = await post(other, { title: 'Bicycle mechanics', skill: SKILL, askedOf: TEACHER })
    expect(merged.status).toBe(200)
    expect(await merged.json()).toMatchObject({ uri: first.uri, merged: true })
  })

  it('429 TooManyAsks once the member has asked for enough today', async () => {
    if (!available) return
    for (let i = 0; i < MAX_ASKS_PER_DAY; i += 1) {
      await ask(asker, { title: `Thing ${i}`, skill: `${SKILL}-${i}`, askedOf: TEACHER })
    }
    const res = await post(asker, { title: 'One too many', skill: `${SKILL}-over`, askedOf: TEACHER })
    expect(res.status).toBe(429)
    expect((await res.json()).error).toBe('TooManyAsks')
  })
})
