/**
 * A8 and A5, the two things that made the attendance sheet wrong.
 *
 * A8 — WHO IS THE HOST OF AN OCCURRENCE? Materialized occurrences of a series are written
 * by the SCHOOL (settled: the host should not have to be online for next month's class to
 * appear), so taking "the host" to be the record's author made every occurrence after the
 * first one un-hostable. Its real host could not take attendance on it, could not see its
 * roster, and read back as `viewerRelation: 'public'` on their own class, while the school
 * — which is nobody — was treated as the host. `lib/events.ts#resolveHostDid` maps an
 * occurrence back to its series author through `fs_series_occurrence`.
 *
 * A5 — RE-SAVING THE SHEET. The upsert was idempotent; the tally bump was not, so a host
 * who saved, noticed one more name and saved again gave everybody a second attended-class
 * credit. `fs_attendance` collapses to counts after 90 days, so the tally is the only
 * surviving evidence and the inflation was permanent.
 *
 * `getIndexer` is mocked — contrail's own indexing is not what is under test — so the
 * occurrence and the first event resolve. Everything else (sessions, `fs_attendance`,
 * `fs_attendance_tally`, `fs_series_occurrence`, `fs_rsvp`) is real, against a real Postgres.
 */
process.env.SCHOOL_DID = 'did:plc:occ-host-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'occ-host-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 13).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'occ-host-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'

const SCHOOL = 'did:plc:occ-host-school'
const HOST = 'did:plc:occ-host-series-author'
const STRANGER = 'did:plc:occ-host-stranger'
const ATTENDEE = 'did:plc:occ-host-attendee'

const SERIES_URI = `at://${HOST}/freeschool.draft.series/weekly1`
/** Occurrence 1 IS the template event, in the host's own repo. */
const FIRST_EVENT_URI = `at://${HOST}/community.lexicon.calendar.event/week1`
/** Occurrence 2 onwards are the SCHOOL's records. */
const OCCURRENCE_URI = `at://${SCHOOL}/community.lexicon.calendar.event/week2`

const eventRecord = (name: string) => ({
  $type: 'community.lexicon.calendar.event',
  name,
  createdAt: '2026-09-01T00:00:00Z',
  startsAt: '2026-09-10T18:00:00Z',
  endsAt: '2026-09-10T20:00:00Z',
  mode: 'community.lexicon.calendar.event#inperson',
  status: 'community.lexicon.calendar.event#scheduled',
})

const INDEXED = [
  { uri: FIRST_EVENT_URI, did: HOST, collection: 'community.lexicon.calendar.event', rkey: 'week1', cid: 'bafy1', record: eventRecord('Bike repair, week 1') },
  { uri: OCCURRENCE_URI, did: SCHOOL, collection: 'community.lexicon.calendar.event', rkey: 'week2', cid: 'bafy2', record: eventRecord('Bike repair, week 2') },
]

/** One `listed` listing and one `listed` config per event, so the events are visible. */
function sidecarRows(short: string | undefined, eventUri: string) {
  const ref = { uri: eventUri, cid: 'bafy' }
  if (short === 'eventListing') {
    return [{ uri: `at://${SCHOOL}/coop.lexicon.event.listing/l-${eventUri.slice(-5)}`, did: SCHOOL, rkey: 'l1', cid: 'bafyl', record: { event: ref, school: SCHOOL, status: 'listed', createdAt: '2026-09-02T00:00:00Z' }, time_us: 1, indexed_at: 1 }]
  }
  if (short === 'eventConfig') {
    return [{ uri: `at://${HOST}/coop.lexicon.event.config/c1`, did: HOST, rkey: 'c1', cid: 'bafyc', record: { event: ref, visibility: 'listed', neighborhood: 'North Boulder', school: SCHOOL }, time_us: 1, indexed_at: 1 }]
  }
  return []
}

function fakeIndexer() {
  return {
    contrail: {
      async query(short: string, opts: { did?: string }) {
        if (short !== 'event') return { records: [] }
        return { records: INDEXED.filter((e) => e.did === opts.did) }
      },
    },
    db: {
      prepare(sql: string) {
        const short = /records_([A-Za-z0-9_]+)/.exec(sql)?.[1]
        return {
          bind(arg: string) {
            return { all: async () => ({ results: sidecarRows(short, arg) }), first: async () => null }
          },
        }
      },
    },
    async notify() {},
  }
}

vi.mock('../src/index/indexer.js', async () => {
  const actual = await vi.importActual<typeof import('../src/index/indexer.js')>('../src/index/indexer.js')
  return { ...actual, getIndexer: async () => fakeIndexer() }
})

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { attendance, attendanceTally, custodialAccount, rsvp as rsvpTable, seriesOccurrence } from '../src/db/schema.js'
import { resolveHostDid, resolveHostDids } from '../src/lib/events.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_attendance', 'fs_attendance_tally', 'fs_series_occurrence', 'fs_rsvp', 'fs_session', 'fs_custodial_account', 'fs_member')
  // The materializer's own ledger row — this is the only link from a school-authored
  // occurrence back to the person whose series it is.
  await testDb().insert(seriesOccurrence).values({
    seriesUri: SERIES_URI,
    occurrenceRkey: 'week2',
    originalStartsAt: new Date('2026-09-10T18:00:00Z'),
    eventUri: OCCURRENCE_URI,
    sequence: 2,
  })
  await testDb()
    .insert(custodialAccount)
    .values({ did: HOST, handle: 'occ-host.test', email: 'occ-host@example.org', keyVersion: 'v1' })
})

afterAll(async () => {
  if (available) await closeTestDb()
})

function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function cookieFor(did: string): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

const enc = (uri: string) => encodeURIComponent(uri)

describe('A8: resolveHostDid', () => {
  it('maps a school-authored occurrence back to its series author', async () => {
    if (!available) return
    expect(await resolveHostDid(OCCURRENCE_URI, SCHOOL)).toBe(HOST)
  })

  it('leaves an ordinary event’s author alone', async () => {
    if (!available) return
    expect(await resolveHostDid(FIRST_EVENT_URI, HOST)).toBe(HOST)
  })

  it('resolves a whole page in one query, and answers for every uri asked about', async () => {
    if (!available) return
    const map = await resolveHostDids([
      { uri: OCCURRENCE_URI, did: SCHOOL },
      { uri: FIRST_EVENT_URI, did: HOST },
    ])
    expect(map.get(OCCURRENCE_URI)).toBe(HOST)
    expect(map.get(FIRST_EVENT_URI)).toBe(HOST)
  })
})

describe('A8: the host of a weekly series, on occurrence 2', () => {
  it('may POST attendance', async () => {
    if (!available) return
    const app = createApp()
    const res = await app.request(`/api/events/${enc(OCCURRENCE_URI)}/attendance`, {
      method: 'POST',
      headers: { Cookie: await cookieFor(HOST), 'content-type': 'application/json' },
      body: JSON.stringify({ attendees: [{ did: ATTENDEE, participated: true }] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, recorded: 1 })
    const rows = await testDb().select().from(attendance).where(eq(attendance.eventUri, OCCURRENCE_URI))
    expect(rows.length).toBe(1)
    expect(rows[0]?.attestedByDid).toBe(HOST)
  })

  it('may GET the roster', async () => {
    if (!available) return
    const now = new Date()
    await testDb()
      .insert(rsvpTable)
      .values({ id: 'occ-r1', eventUri: OCCURRENCE_URI, did: ATTENDEE, status: 'going', createdAt: now, updatedAt: now })
    const app = createApp()
    const res = await app.request(`/api/events/${enc(OCCURRENCE_URI)}/rsvps`, { headers: { Cookie: await cookieFor(HOST) } })
    expect(res.status).toBe(200)
    expect(((await res.json()) as unknown[]).length).toBe(1)
  })

  it('sees viewerRelation "host" and the raw visibility enum on their own occurrence', async () => {
    if (!available) return
    const app = createApp()
    const res = await app.request(`/api/events/${enc(OCCURRENCE_URI)}`, { headers: { Cookie: await cookieFor(HOST) } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { viewerRelation: string; visibility?: string; hostDid?: string; locationRedacted: boolean }
    expect(body.viewerRelation).toBe('host')
    expect(body.visibility).toBe('listed')
    expect(body.hostDid).toBe(HOST)
    expect(body.locationRedacted).toBe(false)
  })

  it('may GET the attendance counts', async () => {
    if (!available) return
    const app = createApp()
    const res = await app.request(`/api/events/${enc(OCCURRENCE_URI)}/attendance`, { headers: { Cookie: await cookieFor(HOST) } })
    expect(res.status).toBe(200)
  })
})

describe('A8: a stranger still cannot', () => {
  it('is 403 on attendance, 403 on the roster, and sees neither relation nor raw visibility', async () => {
    if (!available) return
    const app = createApp()
    const cookie = await cookieFor(STRANGER)

    const post = await app.request(`/api/events/${enc(OCCURRENCE_URI)}/attendance`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ attendees: [{ did: ATTENDEE, participated: true }] }),
    })
    expect(post.status).toBe(403)

    const roster = await app.request(`/api/events/${enc(OCCURRENCE_URI)}/rsvps`, { headers: { Cookie: cookie } })
    expect(roster.status).toBe(403)

    const counts = await app.request(`/api/events/${enc(OCCURRENCE_URI)}/attendance`, { headers: { Cookie: cookie } })
    expect(counts.status).toBe(403)

    const get = await app.request(`/api/events/${enc(OCCURRENCE_URI)}`, { headers: { Cookie: cookie } })
    expect(get.status).toBe(200)
    const body = (await get.json()) as Record<string, unknown>
    expect(body.viewerRelation).toBe('public')
    expect('visibility' in body).toBe(false)
    expect('hostDid' in body).toBe(false)
    expect(body.locationRedacted).toBe(true)
  })

  it('is 403 even when the stranger is the SCHOOL — the school authored the record but hosts nothing', async () => {
    if (!available) return
    const app = createApp()
    const res = await app.request(`/api/events/${enc(OCCURRENCE_URI)}/attendance`, {
      method: 'POST',
      headers: { Cookie: await cookieFor(SCHOOL), 'content-type': 'application/json' },
      body: JSON.stringify({ attendees: [{ did: ATTENDEE, participated: true }] }),
    })
    expect(res.status).toBe(403)
  })
})

describe('A5: re-saving the attendance sheet', () => {
  const save = async (cookie: string, attendees: Array<{ did: string; participated?: boolean }>) =>
    createApp().request(`/api/events/${enc(OCCURRENCE_URI)}/attendance`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ attendees }),
    })

  const tallyOf = async (did: string) => {
    const rows = await testDb().select().from(attendanceTally).where(eq(attendanceTally.did, did))
    return rows[0]?.attendedConfirmed ?? 0
  }

  it('leaves the tally exactly where it was the second time', async () => {
    if (!available) return
    const cookie = await cookieFor(HOST)
    const roster = [{ did: ATTENDEE }, { did: 'did:plc:occ-host-attendee-2' }]

    const first = await save(cookie, roster)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ recorded: 2, tallyChanged: 2 })
    expect(await tallyOf(ATTENDEE)).toBe(1)

    const second = await save(cookie, roster)
    expect(second.status).toBe(200)
    // The sheet still says two people took part; nothing MOVED.
    expect(await second.json()).toMatchObject({ recorded: 2, tallyChanged: 0 })
    expect(await tallyOf(ATTENDEE)).toBe(1)
    expect(await tallyOf('did:plc:occ-host-attendee-2')).toBe(1)

    // …and a third save with one name ADDED credits only the new name.
    const third = await save(cookie, [...roster, { did: 'did:plc:occ-host-attendee-3' }])
    expect(await third.json()).toMatchObject({ recorded: 3, tallyChanged: 1 })
    expect(await tallyOf(ATTENDEE)).toBe(1)
    expect(await tallyOf('did:plc:occ-host-attendee-3')).toBe(1)
  })

  it('takes the credit back when the host un-ticks somebody, and never goes below zero', async () => {
    if (!available) return
    const cookie = await cookieFor(HOST)
    await save(cookie, [{ did: ATTENDEE, participated: true }])
    expect(await tallyOf(ATTENDEE)).toBe(1)

    const off = await save(cookie, [{ did: ATTENDEE, participated: false }])
    expect(await off.json()).toMatchObject({ recorded: 0, tallyChanged: -1 })
    expect(await tallyOf(ATTENDEE)).toBe(0)

    // Un-ticking twice is not minus two.
    await save(cookie, [{ did: ATTENDEE, participated: false }])
    expect(await tallyOf(ATTENDEE)).toBe(0)

    // Re-ticking credits once more, not twice.
    await save(cookie, [{ did: ATTENDEE, participated: true }])
    expect(await tallyOf(ATTENDEE)).toBe(1)
  })
})
