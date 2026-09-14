/**
 * "Ask <name> to teach this" (UX audit journey finding 13).
 *
 * The thing this suite exists to pin is a NEGATIVE: the public
 * `freeschool.draft.request` record must be byte-for-byte what it would have been if
 * nobody had been asked. A record that named the person asked would be a public claim
 * about somebody else's time, written under the asker's identity, which is precisely what
 * R9 forbids. Everything about the ask lives app-side — one row in `fs_request_asked_of`
 * — and reaches exactly one person: the member asked, through their own notifications.
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

vi.mock('../src/index/indexer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/index/indexer.js')>('../src/index/indexer.js')
  return {
    ...actual,
    getIndexer: async () => ({
      contrail: { async query() { return { records: [] } } },
      db: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null }) }) },
      async notify() {},
    }),
  }
})

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createRequest, askedOfFor } from '../src/lib/requests.js'
import { saveProfile } from '../src/lib/profile.js'
import { notificationFeed, requestAskedOf } from '../src/db/schema.js'
import type { Viewer } from '../src/http/session.js'

const asker: Viewer = { did: ASKER, kind: 'custodial', sessionId: 's1' } as Viewer

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_app_meta', 'fs_request_asked_of', 'fs_notification_feed', 'fs_notification_sent', 'fs_notification_outbox')
  repo.clear()
  await saveProfile(ASKER, { displayName: 'Rosa Vance' }, SCHOOL)
})

afterAll(async () => {
  if (available) await closeTestDb()
})

async function feedFor(did: string) {
  return testDb().select().from(notificationFeed).where(eq(notificationFeed.did, did))
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
