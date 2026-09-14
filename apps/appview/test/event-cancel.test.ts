/**
 * UX audit finding 5: a host had no way to cancel a class anywhere, although the edit
 * screen's own copy tells them "to reshape a series, cancel it and post a new one".
 *
 * What this suite pins down, because each one is a rule that could silently rot:
 *
 *   - cancelling writes `status: …#cancelled` ON THE HOST'S OWN RECORD and keeps the
 *     record — never a delete, because someone who RSVP'd must still find the class and
 *     learn that it is off;
 *   - the REASON is app-side (`fs_event_extra.cancel_reason`) and appears in NO record;
 *   - the school's curation listing is withdrawn through the same `remove-listing` the
 *     moderation path uses, not a second private door;
 *   - `scope: 'following'` ends the series in the host's own `freeschool.draft.series`
 *     (an `until` plus `exdates`) AND stamps the occurrences already materialized from
 *     that date on — which are the SCHOOL'S records (A8), so they go back through
 *     `SchoolActorPort`;
 *   - everyone who RSVP'd is notified, once;
 *   - nobody but the host can do any of it.
 *
 * Contrail's index and the two credentials (the host's, the school's) are mocked; the
 * routes, sessions, `fs_event_extra`, `fs_rsvp`, `fs_series_occurrence` and the
 * notification tables are all real against a real Postgres.
 */
process.env.SCHOOL_DID = 'did:plc:cancel-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'event-cancel-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'event-cancel-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import type { SchoolActorPort } from '@freeschool/school-actor'

const SCHOOL = 'did:plc:cancel-school'
const HOST = 'did:plc:cancel-host'
const OTHER = 'did:plc:cancel-bystander'
const RSVPD = 'did:plc:cancel-rsvpd'

const EVENT = `at://${HOST}/community.lexicon.calendar.event/class1`
const SERIES = `at://${HOST}/freeschool.draft.series/weekly`
const OCC2 = `at://${SCHOOL}/community.lexicon.calendar.event/occ2`
const OCC3 = `at://${SCHOOL}/community.lexicon.calendar.event/occ3`

/** dtstart: Thursday 2026-09-17, 18:00 Denver. */
const WEEK1 = '2026-09-17T18:00:00.000Z'
const WEEK2 = '2026-09-24T18:00:00.000Z'
const WEEK3 = '2026-10-01T18:00:00.000Z'

interface Indexed {
  uri: string
  did: string
  collection: string
  rkey: string
  cid: string
  value: Record<string, unknown>
}

/** The whole "index", mutable so a write is visible to the next read in the same test. */
const store = vi.hoisted(() => new Map<string, unknown>())
/** Every `putRecord` the HOST's own credential made. */
const hostWrites = vi.hoisted(() => [] as Array<{ collection: string; rkey: string; record: Record<string, unknown> }>)
/** Every `putRecordAsSchool` the school actor made. */
const schoolWrites = vi.hoisted(
  () => [] as Array<{ collection: string; action: string; record: Record<string, unknown> }>,
)
/** Which events the school currently lists (drives `isListedByUs`). */
const listed = vi.hoisted(() => new Set<string>())

function record(uri: string): Indexed | undefined {
  return store.get(uri) as Indexed | undefined
}

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({ notify: async () => {}, backfillFromPeers: async () => {} }),
}))

vi.mock('../src/index/queries.js', async () => ({
  ...(await vi.importActual('../src/index/queries.js')),
  getRecordByUri: async (_indexer: unknown, _short: string, uri: string) => store.get(uri) ?? null,
  sidecarsForEvent: async (_indexer: unknown, short: string, uri: string) => {
    if (short === 'eventListing') {
      return listed.has(uri)
        ? [
            {
              uri: `at://${SCHOOL}/coop.lexicon.event.listing/for-${encodeURIComponent(uri)}`,
              did: SCHOOL,
              collection: 'coop.lexicon.event.listing',
              rkey: 'x',
              cid: 'bafylisting',
              value: { event: { uri, cid: 'bafyevent' }, school: SCHOOL, status: 'listed', createdAt: WEEK1 },
            },
          ]
        : []
    }
    // The series sidecar is found through its `firstEvent.uri`, which is the template.
    if (short === 'series' && uri === EVENT) {
      const row = record(SERIES)
      return row ? [row] : []
    }
    return []
  },
}))

vi.mock('../src/lib/actor-agent.js', async () => ({
  ...(await vi.importActual('../src/lib/actor-agent.js')),
  actorAgent: async () => ({
    com: {
      atproto: {
        repo: {
          putRecord: async (i: { repo: string; collection: string; rkey: string; record: Record<string, unknown> }) => {
            hostWrites.push({ collection: i.collection, rkey: i.rkey, record: i.record })
            const uri = `at://${i.repo}/${i.collection}/${i.rkey}`
            store.set(uri, {
              uri,
              did: i.repo,
              collection: i.collection,
              rkey: i.rkey,
              cid: `bafy-host-${hostWrites.length}`,
              value: i.record,
            })
            return { data: { uri, cid: `bafy-host-${hostWrites.length}` } }
          },
        },
      },
    },
  }),
}))

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { setSchoolActor } from '../src/lib/school-actor.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { getEventExtra } from '../src/lib/event-extra.js'
import { notificationFeed, rsvp as rsvpTable, seriesOccurrence } from '../src/db/schema.js'

/** Set true to make the steward-gated `remove-listing` fail, as it does for a plain host. */
let listingRemovalDenied = false

function fakePort(): SchoolActorPort {
  return {
    async describeActor() {
      throw new Error('not used by this test')
    },
    async actAs() {
      throw new Error('not used by this test')
    },
    async putRecordAsSchool(i) {
      if (i.action === 'remove-listing' && listingRemovalDenied) throw new Error('requires role >= 40')
      schoolWrites.push({ collection: i.collection, action: i.action, record: i.record as Record<string, unknown> })
      const uri = `at://${SCHOOL}/${i.collection}/${i.rkey}`
      store.set(uri, {
        uri,
        did: SCHOOL,
        collection: i.collection,
        rkey: i.rkey,
        cid: `bafy-school-${schoolWrites.length}`,
        value: i.record as Record<string, unknown>,
      })
      if (i.collection === 'coop.lexicon.event.listing') {
        const target = (i.record as { event: { uri: string }; status?: string }).event.uri
        if ((i.record as { status?: string }).status === 'removed') listed.delete(target)
        else listed.add(target)
      }
      return { uri: uri as `at://${string}`, cid: `bafy-school-${schoolWrites.length}`, auditId: 'audit' }
    },
    async deleteRecordAsSchool() {
      throw new Error('not used by this test')
    },
    async authorize() {
      return { allowed: true, role: 40, reason: 'ok' }
    },
  }
}

function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function cookieFor(did: string): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

async function cancel(did: string, uri: string, body: Record<string, unknown> = {}) {
  const cookie = await cookieFor(did)
  return createApp().request(`/api/events/${encodeURIComponent(uri)}/cancel`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function eventRecord(uri: string, did: string, rkey: string, startsAt: string, name: string): Indexed {
  return {
    uri,
    did,
    collection: 'community.lexicon.calendar.event',
    rkey,
    cid: `bafy-${rkey}`,
    value: {
      $type: 'community.lexicon.calendar.event',
      name,
      description: 'Bring a bike.',
      createdAt: WEEK1,
      startsAt,
      mode: 'community.lexicon.calendar.event#inperson',
      status: 'community.lexicon.calendar.event#scheduled',
    },
  }
}

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate(
    'fs_event_extra',
    'fs_rsvp',
    'fs_session',
    'fs_series_occurrence',
    'fs_attendance_tally',
    'fs_notification_feed',
    'fs_notification_sent',
    'fs_notification_outbox',
  )
  store.clear()
  hostWrites.length = 0
  schoolWrites.length = 0
  listed.clear()
  listingRemovalDenied = false

  store.set(EVENT, eventRecord(EVENT, HOST, 'class1', WEEK1, 'Bike repair'))
  store.set(OCC2, eventRecord(OCC2, SCHOOL, 'occ2', WEEK2, 'Bike repair'))
  store.set(OCC3, eventRecord(OCC3, SCHOOL, 'occ3', WEEK3, 'Bike repair'))
  store.set(SERIES, {
    uri: SERIES,
    did: HOST,
    collection: 'freeschool.draft.series',
    rkey: 'weekly',
    cid: 'bafyseries',
    value: {
      $type: 'freeschool.draft.series',
      firstEvent: { uri: EVENT, cid: 'bafy-class1' },
      rrule: 'FREQ=WEEKLY;BYDAY=TH',
      freq: 'weekly',
      interval: 1,
      timezone: 'America/Denver',
      materializeAhead: 60,
      createdAt: WEEK1,
    },
  })
  setSchoolActor(fakePort())
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

const cancelledEvents = () =>
  hostWrites.filter(
    (w) => w.collection === 'community.lexicon.calendar.event' && w.record.status === 'community.lexicon.calendar.event#cancelled',
  )

describe('POST /api/events/:id/cancel — one date', () => {
  it('stamps #cancelled on the HOST\'s own record and keeps everything else about it', async () => {
    if (!available) return
    const res = await cancel(HOST, EVENT, { reason: 'Snowed out.' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; scope: string; alsoCancelled: string[] }
    expect(body.status).toBe('community.lexicon.calendar.event#cancelled')
    expect(body.scope).toBe('this')
    expect(body.alsoCancelled).toEqual([])

    expect(cancelledEvents().length).toBe(1)
    const written = cancelledEvents()[0]!.record
    expect(written.name).toBe('Bike repair')
    expect(written.startsAt).toBe(WEEK1)
    // Never a delete: the record is still there, with its description intact.
    expect(written.description).toBe('Bring a bike.')
  })

  it('keeps the reason app-side — in fs_event_extra, and in NO record anywhere', async () => {
    if (!available) return
    await cancel(HOST, EVENT, { reason: 'The host has the flu.' })

    expect((await getEventExtra(EVENT)).cancelReason).toBe('The host has the flu.')
    const everyRecord = JSON.stringify([...hostWrites, ...schoolWrites])
    expect(everyRecord).not.toContain('flu')
  })

  it('withdraws the school listing through the same remove-listing moderation uses', async () => {
    if (!available) return
    listed.add(EVENT)
    const res = await cancel(HOST, EVENT, {})
    expect(((await res.json()) as { unlisted?: boolean }).unlisted).toBe(true)

    const removals = schoolWrites.filter((w) => w.action === 'remove-listing')
    expect(removals.length).toBe(1)
    expect(removals[0]!.record.status).toBe('removed')
    expect(removals[0]!.record.school).toBe(SCHOOL)
  })

  it('still cancels the class when withdrawing the listing needs a steward, and says so', async () => {
    if (!available) return
    listed.add(EVENT)
    listingRemovalDenied = true
    const res = await cancel(HOST, EVENT, {})
    expect(res.status).toBe(200)
    expect(((await res.json()) as { unlisted?: boolean }).unlisted).toBe(false)
    expect(cancelledEvents().length).toBe(1)
  })

  it('reports no listing decision at all for a class the school never listed', async () => {
    if (!available) return
    const res = await cancel(HOST, EVENT, {})
    expect(((await res.json()) as { unlisted?: boolean }).unlisted).toBeUndefined()
    expect(schoolWrites.filter((w) => w.action === 'remove-listing')).toEqual([])
  })

  it('tells everyone who RSVP\'d, once', async () => {
    if (!available) return
    const now = new Date()
    await testDb()
      .insert(rsvpTable)
      .values([{ id: 'c-1', eventUri: EVENT, did: RSVPD, status: 'going', createdAt: now, updatedAt: now }])

    const res = await cancel(HOST, EVENT, { reason: 'Snowed out.' })
    expect(((await res.json()) as { notified: number }).notified).toBe(1)
    const feed = await testDb().select().from(notificationFeed).where(eq(notificationFeed.did, RSVPD))
    expect(feed.length).toBe(1)
    expect(feed[0]!.category).toBe('event.cancelled')
    expect(feed[0]!.body).toBe('Snowed out.')

    // Cancelling again must not notify a second time.
    const again = await cancel(HOST, EVENT, {})
    expect(((await again.json()) as { notified: number }).notified).toBe(0)
  })

  it('is 403 for anyone who is not the host, and writes nothing', async () => {
    if (!available) return
    const res = await cancel(OTHER, EVENT, { reason: 'not mine to cancel' })
    expect(res.status).toBe(403)
    expect(hostWrites).toEqual([])
    expect(schoolWrites).toEqual([])
    expect((await getEventExtra(EVENT)).cancelReason).toBeUndefined()
  })

  it('is 401 with nobody signed in', async () => {
    if (!available) return
    const res = await createApp().request(`/api/events/${encodeURIComponent(EVENT)}/cancel`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('refuses scope: following on a class that is not part of a series', async () => {
    if (!available) return
    const solo = `at://${HOST}/community.lexicon.calendar.event/solo`
    store.set(solo, eventRecord(solo, HOST, 'solo', WEEK1, 'One-off'))
    const res = await cancel(HOST, solo, { scope: 'following' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('NotRecurring')
  })
})

describe('POST /api/events/:id/cancel — this date and every one after it', () => {
  beforeEach(async () => {
    if (!available) return
    await testDb()
      .insert(seriesOccurrence)
      .values([
        { seriesUri: SERIES, occurrenceRkey: 'occ2', originalStartsAt: new Date(WEEK2), eventUri: OCC2, sequence: 2 },
        { seriesUri: SERIES, occurrenceRkey: 'occ3', originalStartsAt: new Date(WEEK3), eventUri: OCC3, sequence: 3 },
      ])
  })

  it('ends the series in the host\'s own sidecar: an `until` at the cancelled date, plus exdates', async () => {
    if (!available) return
    const res = await cancel(HOST, OCC2, { scope: 'following', reason: 'Shop closed for the winter.' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { exdatesAdded: number; alsoCancelled: string[] }
    expect(body.exdatesAdded).toBeGreaterThan(0)

    const seriesWrite = hostWrites.find((w) => w.collection === 'freeschool.draft.series')
    expect(seriesWrite).toBeDefined()
    expect(seriesWrite!.rkey).toBe('weekly')
    expect(seriesWrite!.record.until).toBe(new Date(WEEK2).toISOString())
    const exdates = seriesWrite!.record.exdates as string[]
    expect(exdates).toContain('2026-09-24T18:00:00Z')
    expect(exdates).toContain('2026-10-01T18:00:00Z')
    // The dates BEFORE the cancelled one are untouched — the series ran until then.
    expect(exdates).not.toContain('2026-09-17T18:00:00Z')
    // The reason never reaches the series record either.
    expect(JSON.stringify(seriesWrite!.record)).not.toContain('winter')
  })

  it('cancels the occurrences already materialized from that date on — as the SCHOOL, whose records they are', async () => {
    if (!available) return
    const res = await cancel(HOST, OCC2, { scope: 'following' })
    const body = (await res.json()) as { alsoCancelled: string[] }
    expect(body.alsoCancelled).toEqual([OCC3])

    const cancelledAsSchool = schoolWrites.filter(
      (w) =>
        w.collection === 'community.lexicon.calendar.event' &&
        w.record.status === 'community.lexicon.calendar.event#cancelled',
    )
    // The occurrence the host cancelled, and the one after it. Both the school's records.
    expect(cancelledAsSchool.length).toBe(2)
    // Never forked into the host's own repo (that was `OccurrenceNotEditableError`'s bug).
    expect(hostWrites.filter((w) => w.collection === 'community.lexicon.calendar.event')).toEqual([])
  })

  it('leaves the earlier dates of the series alone', async () => {
    if (!available) return
    await cancel(HOST, OCC2, { scope: 'following' })
    expect(record(EVENT)!.value.status).toBe('community.lexicon.calendar.event#scheduled')
  })

  it('scope: this on one occurrence touches neither the series nor the later dates', async () => {
    if (!available) return
    const res = await cancel(HOST, OCC2, {})
    expect(((await res.json()) as { alsoCancelled: string[] }).alsoCancelled).toEqual([])
    expect(hostWrites.find((w) => w.collection === 'freeschool.draft.series')).toBeUndefined()
    expect(record(OCC3)!.value.status).toBe('community.lexicon.calendar.event#scheduled')
  })
})

describe('a cancelled class stops counting', () => {
  it('refuses attendance for it — nobody came to a class that did not happen', async () => {
    if (!available) return
    await cancel(HOST, EVENT, {})
    const cookie = await cookieFor(HOST)
    const res = await createApp().request(`/api/events/${encodeURIComponent(EVENT)}/attendance`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendees: [{ did: RSVPD, participated: true, role: 'attendee' }] }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('EventCancelled')
  })

  it('projects the cancelled status and the reason on the detail API, and STATUS:CANCELLED in the .ics', async () => {
    if (!available) return
    listed.add(EVENT)
    await cancel(HOST, EVENT, { reason: 'Snowed out.' })

    const detail = await createApp().request(`/api/events/${encodeURIComponent(EVENT)}`)
    // The listing was withdrawn, so a stranger no longer sees it at all — but the host does.
    const cookie = await cookieFor(HOST)
    const asHost = await createApp().request(`/api/events/${encodeURIComponent(EVENT)}`, { headers: { Cookie: cookie } })
    expect(asHost.status).toBe(200)
    const body = (await asHost.json()) as { status: string; cancelledReason?: string }
    expect(body.status).toBe('community.lexicon.calendar.event#cancelled')
    expect(body.cancelledReason).toBe('Snowed out.')
    expect(detail.status).toBe(404)

    const ics = await createApp().request(`/api/events/${encodeURIComponent(EVENT)}.ics`, { headers: { Cookie: cookie } })
    expect(await ics.text()).toContain('STATUS:CANCELLED')
  })
})
