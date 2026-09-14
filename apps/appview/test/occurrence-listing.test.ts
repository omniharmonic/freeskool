/**
 * Interop gap 2 (P1). A materialized occurrence of a recurring class used to be listed
 * UNCONDITIONALLY and with no `tags` at all — bypassing `routeListing`'s tag gate — so a
 * tag-filtering peer (COhere) dropped every instance of every recurring class we run,
 * while listing occurrences of series that should never have routed.
 *
 * The rule an occurrence must obey is exactly the rule its template obeys: the tags on
 * the template's own `coop.lexicon.event.config`, matched against the school's routing
 * tags, and no listing at all for an unlisted/private series.
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'occurrence-listing-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 7).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'occurrence-listing-test-pepper'
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'
import { setSchoolActor } from '../src/lib/school-actor.js'

const HOST = 'did:plc:series-host'
const TEMPLATE = `at://${HOST}/community.lexicon.calendar.event/template`
const SERIES = `at://${HOST}/freeschool.draft.series/weekly`

/** What the template event's `coop.lexicon.event.config` says, per test. */
const config = vi.hoisted(() => ({
  tags: [] as string[],
  visibility: 'listed' as 'listed' | 'unlisted' | 'private',
}))

vi.mock('../src/lib/identity.js', async () => ({
  ...(await vi.importActual('../src/lib/identity.js')),
  resolvePdsEndpoint: async () => 'http://pds.test',
}))

// The template event, and the school record `schoolRoutingTags()` reads for its tags.
vi.mock('../src/lib/pds.js', async () => ({
  ...(await vi.importActual('../src/lib/pds.js')),
  getRecord: async (did: string, collection: string) =>
    collection === 'freeschool.draft.school'
      ? { uri: `at://${did}/${collection}/self`, cid: 'bafyschool', value: { tags: ['skillshare', 'free-school'] } }
      : {
          uri: TEMPLATE,
          cid: 'bafytemplate',
          value: {
            name: 'Bike repair, every Thursday',
            description: 'Bring a bike.',
            startsAt: '2026-09-17T18:00:00.000Z',
            endsAt: '2026-09-17T20:00:00.000Z',
            rsvpExpected: true,
          },
        },
}))

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({ backfillFromPeers: async () => {} }),
}))

vi.mock('../src/index/queries.js', async () => ({
  ...(await vi.importActual('../src/index/queries.js')),
  sidecarsForEvent: async (_indexer: unknown, short: string) =>
    short === 'eventConfig'
      ? [
          {
            uri: `at://${HOST}/coop.lexicon.event.config/one`,
            did: HOST,
            collection: 'coop.lexicon.event.config',
            rkey: 'one',
            cid: 'bafyconfig',
            value: { event: { uri: TEMPLATE, cid: 'bafytemplate' }, visibility: config.visibility, tags: config.tags },
          },
        ]
      : [],
}))

const { materializeSeries } = await import('../src/jobs/materialize-series.js')

interface Written {
  collection: string
  record: Record<string, unknown>
}

function fakePort(calls: Written[]): SchoolActorPort {
  return {
    async describeActor() {
      throw new Error('not used by this test')
    },
    async actAs() {
      throw new Error('not used by this test')
    },
    async putRecordAsSchool(i) {
      calls.push({ collection: i.collection, record: i.record as Record<string, unknown> })
      return {
        uri: `at://did:plc:school/${i.collection}/${i.rkey}`,
        cid: `bafy-${calls.length}`,
        auditId: `audit-${calls.length}`,
      }
    },
    async deleteRecordAsSchool() {
      throw new Error('not used by this test')
    },
    async authorize() {
      return { allowed: true, role: 40, reason: 'ok' }
    },
  }
}

const series = {
  firstEvent: { uri: TEMPLATE, cid: 'bafytemplate' },
  rrule: 'FREQ=WEEKLY;BYDAY=TH',
  freq: 'weekly',
  timezone: 'America/Denver',
  materializeAhead: 30,
}

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_series_occurrence', 'fs_app_meta', 'fs_event_extra', 'fs_feedback_window')
  config.tags = []
  config.visibility = 'listed'
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

async function run(calls: Written[]) {
  setSchoolActor(fakePort(calls))
  return materializeSeries(SERIES, HOST, series, new Date('2026-09-10T00:00:00.000Z'))
}

const listings = (calls: Written[]) => calls.filter((c) => c.collection === 'coop.lexicon.event.listing')
const occurrences = (calls: Written[]) => calls.filter((c) => c.collection === 'community.lexicon.calendar.event')

describe('materialized occurrences obey the same tag gate as a directly created class', () => {
  it('a series tagged [knitting] yields occurrence events but ZERO listings', async () => {
    if (!available) return
    config.tags = ['knitting']
    const calls: Written[] = []
    const res = await run(calls)
    expect(res.written).toBeGreaterThan(0)
    expect(occurrences(calls).length).toBe(res.written)
    expect(listings(calls)).toEqual([])
  })

  it('an untagged series yields occurrence events but ZERO listings — no silent default', async () => {
    if (!available) return
    const calls: Written[] = []
    const res = await run(calls)
    expect(res.written).toBeGreaterThan(0)
    expect(listings(calls)).toEqual([])
  })

  it('a series tagged [skillshare, bikes] lists every occurrence, carrying those tags', async () => {
    if (!available) return
    config.tags = ['skillshare', 'bikes']
    const calls: Written[] = []
    const res = await run(calls)
    const written = listings(calls)
    expect(written.length).toBe(res.written)
    for (const l of written) {
      expect(l.record.tags).toEqual(['skillshare', 'bikes'])
      expect(l.record.status).toBe('listed')
      expect((l.record.event as { uri: string; cid: string }).cid).toBeTruthy()
    }
  })

  it('an unlisted series is never listed, even when its tags route', async () => {
    if (!available) return
    config.tags = ['skillshare']
    config.visibility = 'unlisted'
    const calls: Written[] = []
    const res = await run(calls)
    expect(res.written).toBeGreaterThan(0)
    expect(listings(calls)).toEqual([])
  })
})
