/**
 * INBOUND FEDERATION: a peer's calendar is not our calendar (MS §7, ruling 7).
 *
 * Following a peer school's PDS means we index everything public in every repo on it —
 * including that school's own `coop.lexicon.event.listing` records, which are its
 * curation of its own city's classes. `isListed` cannot tell whose listing it is reading,
 * so before `listingsOfSchool` two things went wrong in opposite directions:
 *
 *   - a peer's `listed` record put a class nobody here teaches on OUR calendar (the
 *     "listing loop" hazard MS §7 names: inclusion must be authorship plus our own tag
 *     routing, never the presence of a peer's listing);
 *   - a peer's `removed` record took one of OUR classes OFF our calendar — moderation by
 *     a school that has no standing here.
 *
 * Both are asserted below, against the real `/api/calendar` route with a faked index.
 */
process.env.SCHOOL_DID = 'did:plc:peer-cal-school'
process.env.SCHOOL_HANDLE = 'boulder.test'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'peer-calendar-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 37).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'peer-calendar-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'

const SCHOOL = 'did:plc:peer-cal-school'
const PEER_SCHOOL = 'did:plc:peer-cal-denver'
const OUR_HOST = 'did:plc:peer-cal-ours'
const THEIR_HOST = 'did:plc:peer-cal-theirs'

const OUR_CLASS = `at://${OUR_HOST}/community.lexicon.calendar.event/ours`
const THEIR_CLASS = `at://${THEIR_HOST}/community.lexicon.calendar.event/theirs`

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const fixture = vi.hoisted(() => ({
  events: [] as Array<Record<string, unknown>>,
  /** uri → the sidecar records the index holds, each with the repo that wrote it. */
  listings: {} as Record<string, Array<{ did: string; value: Record<string, unknown> }>>,
  configs: {} as Record<string, Array<{ did: string; value: Record<string, unknown> }>>,
}))

vi.mock('../src/index/indexer.js', () => ({ getIndexer: async () => ({}), resetIndexer: () => {} }))

vi.mock('../src/index/queries.js', async () => ({
  ...(await vi.importActual('../src/index/queries.js')),
  eventsInWindow: async () => fixture.events,
  sidecarsForEvent: async (_indexer: unknown, short: string, uri: string) => {
    const bundle = (short === 'eventListing' ? fixture.listings : fixture.configs)[uri] ?? []
    return bundle.map((row, i) => ({
      uri: `at://${row.did}/${short}/${i}`,
      did: row.did,
      collection: short,
      rkey: String(i),
      cid: 'bafysidecar',
      value: row.value,
    }))
  },
}))

const { createApp } = await import('../src/http/app.js')
const { member } = await import('../src/db/schema.js')

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

afterAll(async () => {
  if (available) await closeTestDb()
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_member', 'fs_custodial_account', 'fs_steward', 'fs_event_school', 'fs_series_occurrence', 'fs_app_meta')
  // Only OUR host is one of ours. The peer school's host is a stranger to this school.
  await testDb().insert(member).values({ did: OUR_HOST, door: 'custodial' })

  fixture.events = [
    {
      uri: OUR_CLASS,
      did: OUR_HOST,
      collection: 'community.lexicon.calendar.event',
      rkey: 'ours',
      cid: 'bafyours',
      value: { name: 'Bike repair, drop in', startsAt: soon(2), endsAt: soon(2.1) },
    },
    {
      uri: THEIR_CLASS,
      did: THEIR_HOST,
      collection: 'community.lexicon.calendar.event',
      rkey: 'theirs',
      cid: 'bafytheirs',
      value: { name: 'Denver: mutual aid 101', startsAt: soon(3), endsAt: soon(3.1) },
    },
  ]
  fixture.listings = {}
  fixture.configs = {
    [OUR_CLASS]: [{ did: OUR_HOST, value: { event: { uri: OUR_CLASS, cid: 'bafyours' }, visibility: 'listed' } }],
    [THEIR_CLASS]: [{ did: THEIR_HOST, value: { event: { uri: THEIR_CLASS, cid: 'bafytheirs' }, visibility: 'listed' } }],
  }
})

async function calendarNames(): Promise<string[]> {
  const res = await createApp().request('/api/calendar')
  expect(res.status).toBe(200)
  const body = (await res.json()) as { events: Array<{ name?: string }> }
  return body.events.map((e) => e.name ?? '')
}

describe('a peer school\'s listing is about a peer school\'s calendar', () => {
  it('does not put a peer school\'s class on our calendar', async () => {
    if (!available) return
    // Denver curates its own city's class, in Denver's repo. We index it because we
    // follow Denver's PDS — and it changes nothing here.
    fixture.listings[THEIR_CLASS] = [
      {
        did: PEER_SCHOOL,
        value: {
          event: { uri: THEIR_CLASS, cid: 'bafytheirs' },
          school: PEER_SCHOOL,
          status: 'listed',
          tags: ['mutual-aid'],
          createdAt: '2026-09-01T00:00:00Z',
        },
      },
    ]

    const names = await calendarNames()
    expect(names).toContain('Bike repair, drop in')
    expect(names).not.toContain('Denver: mutual aid 101')
  })

  it('DOES show a class hosted elsewhere once OUR school curates it', async () => {
    if (!available) return
    fixture.listings[THEIR_CLASS] = [
      {
        did: PEER_SCHOOL,
        value: { event: { uri: THEIR_CLASS, cid: 'bafytheirs' }, school: PEER_SCHOOL, status: 'listed', createdAt: '2026-09-01T00:00:00Z' },
      },
      {
        did: SCHOOL,
        value: { event: { uri: THEIR_CLASS, cid: 'bafytheirs' }, school: SCHOOL, status: 'listed', createdAt: '2026-09-02T00:00:00Z' },
      },
    ]

    expect(await calendarNames()).toContain('Denver: mutual aid 101')
  })

  it('lets no peer school remove one of OUR classes from our calendar', async () => {
    if (!available) return
    fixture.listings[OUR_CLASS] = [
      {
        did: PEER_SCHOOL,
        value: { event: { uri: OUR_CLASS, cid: 'bafyours' }, school: PEER_SCHOOL, status: 'removed', createdAt: '2026-09-03T00:00:00Z' },
      },
    ]

    expect(await calendarNames()).toContain('Bike repair, drop in')
  })

  it('still honours OUR OWN school\'s removal', async () => {
    if (!available) return
    fixture.listings[OUR_CLASS] = [
      {
        did: SCHOOL,
        value: { event: { uri: OUR_CLASS, cid: 'bafyours' }, school: SCHOOL, status: 'removed', createdAt: '2026-09-03T00:00:00Z' },
      },
    ]

    expect(await calendarNames()).not.toContain('Bike repair, drop in')
  })
})
