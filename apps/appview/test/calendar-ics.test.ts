/**
 * Interop gap 12 (P3, ruled in). `GET /api/calendar.ics` — the cheapest possible interop
 * win: a neighbourhood group that will never speak ATProto (or install a PWA) can
 * subscribe to the Boulder calendar in whatever calendar app they already use.
 *
 * It is the JSON calendar in RFC 5545 clothing: same window, same inclusion rule, same
 * public projection. Which means: no unlisted or moderated-away class, the neighborhood
 * and never the street, and no ATTENDEE lines ever — who is coming is app-side (R9).
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'calendar-ics-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 11).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'calendar-ics-test-pepper'

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'

const SCHOOL = 'did:plc:school'
const HOST = 'did:plc:ics-host'
const LISTED = `at://${HOST}/community.lexicon.calendar.event/listed-one`
const REMOVED = `at://${HOST}/community.lexicon.calendar.event/removed-one`
const UNLISTED = `at://${HOST}/community.lexicon.calendar.event/unlisted-one`

const soon = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

const fixture = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>>, sidecars: {} as Record<string, { listings: unknown[]; configs: unknown[] }> }))

vi.mock('../src/index/indexer.js', () => ({ getIndexer: async () => ({}) }))

vi.mock('../src/index/queries.js', async () => ({
  ...(await vi.importActual('../src/index/queries.js')),
  eventsInWindow: async () => fixture.events,
  sidecarsForEvent: async (_indexer: unknown, short: string, uri: string) => {
    const bundle = fixture.sidecars[uri] ?? { listings: [], configs: [] }
    const values = short === 'eventListing' ? bundle.listings : bundle.configs
    return (values as Array<Record<string, unknown>>).map((value, i) => ({
      uri: `at://${SCHOOL}/${short}/${i}`,
      did: SCHOOL,
      collection: short,
      rkey: String(i),
      cid: 'bafysidecar',
      value,
    }))
  },
}))

const { createApp } = await import('../src/http/app.js')

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_app_meta', 'fs_member', 'fs_custodial_account', 'fs_steward', 'fs_series_occurrence')
  const address = {
    $type: 'community.lexicon.location.address',
    name: "Dana's kitchen",
    street: '1412 Juniper Ave',
    locality: 'Boulder',
    region: 'CO',
  }
  fixture.events = [
    {
      uri: LISTED,
      did: HOST,
      collection: 'community.lexicon.calendar.event',
      rkey: 'listed-one',
      cid: 'bafylisted',
      value: {
        name: 'Bike repair, drop in',
        description: 'Bring a bike; tools provided.',
        startsAt: soon(3),
        endsAt: soon(3.1),
        status: 'community.lexicon.calendar.event#scheduled',
        locations: [address],
      },
    },
    {
      uri: REMOVED,
      did: HOST,
      collection: 'community.lexicon.calendar.event',
      rkey: 'removed-one',
      cid: 'bafyremoved',
      value: { name: 'A class a steward removed', startsAt: soon(4), locations: [address] },
    },
    {
      uri: UNLISTED,
      did: HOST,
      collection: 'community.lexicon.calendar.event',
      rkey: 'unlisted-one',
      cid: 'bafyunlisted',
      value: { name: 'An unlisted class', startsAt: soon(5), locations: [address] },
    },
  ]
  fixture.sidecars = {
    [LISTED]: {
      listings: [{ event: { uri: LISTED, cid: 'bafylisted' }, school: SCHOOL, status: 'listed', tags: ['skillshare'], createdAt: '2026-09-01T00:00:00Z' }],
      configs: [{ event: { uri: LISTED, cid: 'bafylisted' }, school: SCHOOL, visibility: 'listed', neighborhood: 'North Boulder', tags: ['skillshare'] }],
    },
    [REMOVED]: {
      listings: [{ event: { uri: REMOVED, cid: 'bafyremoved' }, school: SCHOOL, status: 'removed', createdAt: '2026-09-02T00:00:00Z' }],
      configs: [{ event: { uri: REMOVED, cid: 'bafyremoved' }, school: SCHOOL, visibility: 'listed' }],
    },
    [UNLISTED]: {
      listings: [],
      configs: [{ event: { uri: UNLISTED, cid: 'bafyunlisted' }, school: SCHOOL, visibility: 'unlisted' }],
    },
  }
})

afterAll(async () => {
  if (available) await closeTestDb()
})

/** Unfold RFC 5545 continuation lines, then split into VEVENT blocks. */
function parseIcs(body: string) {
  const unfolded: string[] = []
  for (const line of body.split('\r\n')) {
    if (line.startsWith(' ') && unfolded.length) unfolded[unfolded.length - 1] += line.slice(1)
    else unfolded.push(line)
  }
  const events: Array<Record<string, string>> = []
  let current: Record<string, string> | null = null
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') current = {}
    else if (line === 'END:VEVENT') {
      if (current) events.push(current)
      current = null
    } else if (current) {
      const at = line.indexOf(':')
      // RFC 5545 3.3.11 text un-escaping, so the assertions read as human text.
      if (at > 0) current[line.slice(0, at)] = line.slice(at + 1).replace(/\\([;,\\])/g, '$1').replace(/\\n/g, '\n')
    }
  }
  return { lines: unfolded, events }
}

it('serves a public iCalendar feed of listed classes, cacheable, with no street and no attendees', async () => {
  if (!available) return
  const res = await createApp().request('/api/calendar.ics')
  expect(res.status).toBe(200)
  expect(res.headers.get('Content-Type')).toContain('text/calendar')
  expect(res.headers.get('Cache-Control')).toBe('public, max-age=300')

  const body = await res.text()
  const { lines, events } = parseIcs(body)
  expect(lines[0]).toBe('BEGIN:VCALENDAR')
  expect(lines).toContain('VERSION:2.0')
  expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true)

  // Exactly the listed class: the moderated one and the unlisted one are both absent.
  expect(events).toHaveLength(1)
  const vevent = events[0]!
  expect(vevent.UID).toBe(LISTED)
  expect(vevent.SUMMARY).toBe('Bike repair, drop in')
  expect(vevent.DESCRIPTION).toContain('Bring a bike')
  expect(vevent.STATUS).toBe('CONFIRMED')
  expect(vevent.DTSTART).toMatch(/^\d{8}T\d{6}Z$/)
  // The neighborhood, never the street (R9) — same projection as the JSON calendar.
  expect(vevent.LOCATION).toBe('North Boulder')
  expect(body).not.toContain('Juniper')
  expect(body).not.toContain("Dana's kitchen")
  expect(body).not.toContain('ATTENDEE')
  expect(body).not.toContain('A class a steward removed')
  expect(body).not.toContain('An unlisted class')
})

it('answers an empty but valid calendar when nothing is listed', async () => {
  if (!available) return
  fixture.events = []
  const res = await createApp().request('/api/calendar.ics')
  expect(res.status).toBe(200)
  const { events } = parseIcs(await res.text())
  expect(events).toEqual([])
})
