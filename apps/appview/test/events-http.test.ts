/**
 * HTTP-level coverage for two review-round-1 fixes that the lower-level suites in
 * `event-extras.test.ts` and `take-ownership.test.ts` cannot reach on their own:
 *
 *   I5  `GET /api/events/:id/rsvps` (the roster) through the REAL `createApp()`, with
 *       real session cookies — unauthenticated 401, a non-host/non-steward member 403
 *       (and no roster rows in that response), the host 200 with the documented shape.
 *   I2  `DELETE /api/rsvp` promoting a waitlisted member now notifies them
 *       (`rsvp.promoted`) — verified as a real `fs_notification_feed` row, not a spy.
 *
 * Both need `loadEvent` (`http/routes/events.ts`) to resolve an event, which normally
 * means a real indexed record via contrail — infrastructure owned by other
 * concurrently-working agents (`src/sync`, `src/index`) in this shared working tree, per
 * this task's dispatch. So `getIndexer` is mocked here (as the reviewer specified) to
 * hand `loadEvent` one fixed event, WITHOUT touching contrail's own schema or code at
 * all: everything else (sessions, roles, `fs_rsvp`, `fs_custodial_account`,
 * `fs_app_meta`, notifications) is the real thing against a real Postgres.
 */
process.env.SCHOOL_DID = 'did:plc:events-http-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'events-http-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 5).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'events-http-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'

const HOST_DID = 'did:plc:events-http-host'
const EVENT_RKEY = 'events-http-test-event'
const EVENT_URI = `at://${HOST_DID}/community.lexicon.calendar.event/${EVENT_RKEY}`

/**
 * Mutable so each test can swap in the event it needs; `getIndexer`'s closure below
 * reads it at CALL time (well after this module's synchronous top-level code, including
 * this assignment, has already run), so plain `let` + later reassignment is safe.
 */
let eventRecord: Record<string, unknown> = {
  $type: 'community.lexicon.calendar.event',
  name: 'Events-HTTP test class',
  createdAt: new Date().toISOString(),
  startsAt: new Date().toISOString(),
  mode: 'community.lexicon.calendar.event#inperson',
  status: 'community.lexicon.calendar.event#scheduled',
}

let fixtureListed = false

function fakeIndexer() {
  return {
    contrail: {
      async query(short: string, opts: { did?: string }) {
        if (short === 'event' && opts.did === HOST_DID) {
          return {
            records: [
              { uri: EVENT_URI, did: HOST_DID, collection: 'community.lexicon.calendar.event', rkey: EVENT_RKEY, cid: 'bafyevent', record: eventRecord },
            ],
          }
        }
        return { records: [] }
      },
    },
    db: {
      prepare(query: string) {
        return {
          bind() {
            return {
              all: async () => ({ results: fixtureListed && query.includes('FROM records_eventConfig') ? [{ uri: 'at://'+HOST_DID+'/coop.lexicon.event.config/test', did: HOST_DID, collection: 'coop.lexicon.event.config', rkey: 'test', cid: 'cid', record: { visibility: 'listed', neighborhood: 'North Boulder' } }] : [] }),
              first: async () => null,
            }
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
import { custodialAccount, appMeta, rsvp as rsvpTable, notificationFeed } from '../src/db/schema.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_rsvp', 'fs_custodial_account', 'fs_app_meta', 'fs_event_extra', 'fs_session', 'fs_member', 'fs_notification_feed', 'fs_notification_sent', 'fs_notification_outbox')
  fixtureListed = false
  eventRecord = {
    $type: 'community.lexicon.calendar.event',
    name: 'Events-HTTP test class',
    createdAt: new Date().toISOString(),
    startsAt: new Date().toISOString(),
    mode: 'community.lexicon.calendar.event#inperson',
    status: 'community.lexicon.calendar.event#scheduled',
  }
})

afterAll(async () => {
  if (available) await closeTestDb()
})

/** `setCookie` only ever calls `c.header(...)` on this — see `test/handoff.test.ts`. */
function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function cookieFor(did: string): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

describe('I5: GET /api/events/:id/rsvps (the roster)', () => {
  it('is 401 for an unauthenticated request', async () => {
    if (!available) return
    const app = createApp()
    const res = await app.request(`/api/events/${encodeURIComponent(EVENT_URI)}/rsvps`)
    expect(res.status).toBe(401)
  })

  it('is 403 for a signed-in member who is neither the host nor a steward, with no roster rows in the body', async () => {
    if (!available) return
    const cookie = await cookieFor('did:plc:events-http-ordinary-member')
    const app = createApp()
    const res = await app.request(`/api/events/${encodeURIComponent(EVENT_URI)}/rsvps`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(403)
    const body = await res.text()
    expect(body).not.toContain('"did"')
    expect(body).not.toContain('did:plc:')
  })

  it('is 200 for the host, with the {did, handle, displayName?, status, createdAt} shape', async () => {
    if (!available) return
    const withHandle = 'did:plc:events-http-rsvp-with-handle'
    const withDisplayName = 'did:plc:events-http-rsvp-with-name'
    const bare = 'did:plc:events-http-rsvp-bare'

    await testDb().insert(custodialAccount).values({ did: withHandle, handle: 'withhandle.test', email: 'a@example.org', keyVersion: 'v1' })
    await testDb().insert(custodialAccount).values({ did: withDisplayName, handle: 'withname.test', email: 'b@example.org', keyVersion: 'v1' })
    await testDb().insert(appMeta).values({ key: `profile:${withDisplayName}`, value: { displayName: 'Alex' } })

    const now = new Date()
    await testDb().insert(rsvpTable).values([
      { id: 'rh-1', eventUri: EVENT_URI, did: withHandle, status: 'going', createdAt: now, updatedAt: now },
      { id: 'rh-2', eventUri: EVENT_URI, did: withDisplayName, status: 'going', createdAt: now, updatedAt: now },
      { id: 'rh-3', eventUri: EVENT_URI, did: bare, status: 'waitlisted', createdAt: now, updatedAt: now },
    ])

    const cookie = await cookieFor(HOST_DID)
    const app = createApp()
    const res = await app.request(`/api/events/${encodeURIComponent(EVENT_URI)}/rsvps`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const roster = (await res.json()) as Array<{ did: string; handle: string; displayName?: string; status: string; createdAt: string }>
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(roster.length).toBe(3)

    const byDid = new Map(roster.map((r) => [r.did, r]))
    expect(byDid.get(withHandle)?.handle).toBe('withhandle.test')
    expect(byDid.get(withHandle)?.displayName).toBeUndefined()
    expect(byDid.get(withDisplayName)?.displayName).toBe('Alex')
    expect(byDid.get(bare)?.handle).toBe(bare) // no custodial row, no index hit — falls back to the DID
    expect(byDid.get(bare)?.status).toBe('waitlisted')
    for (const r of roster) expect(new Date(r.createdAt).getTime()).not.toBeNaN()
  })
})

describe('I2: a promoted waitlisted member is notified', () => {
  it('DELETE /api/rsvp on a going RSVP promotes the earliest waitlisted row and writes an rsvp.promoted feed notification for them', async () => {
    if (!available) return
    const goingDid = 'did:plc:events-http-going'
    const waitlistedDid = 'did:plc:events-http-waitlisted'
    const now = new Date()
    await testDb().insert(rsvpTable).values([
      { id: 'rp-1', eventUri: EVENT_URI, did: goingDid, status: 'going', createdAt: now, updatedAt: now },
      { id: 'rp-2', eventUri: EVENT_URI, did: waitlistedDid, status: 'waitlisted', createdAt: now, updatedAt: now },
    ])

    const cookie = await cookieFor(goingDid)
    const app = createApp()
    const res = await app.request(`/api/rsvp?eventUri=${encodeURIComponent(EVENT_URI)}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)

    const promotedRow = await testDb().select().from(rsvpTable).where(eq(rsvpTable.did, waitlistedDid))
    expect(promotedRow[0]?.status).toBe('going')

    const feed = await testDb().select().from(notificationFeed).where(eq(notificationFeed.did, waitlistedDid))
    expect(feed.length).toBe(1)
    expect(feed[0]?.category).toBe('rsvp.promoted')
    expect(feed[0]?.title).toContain('Events-HTTP test class')
  })
})

describe('image privacy', () => {
  it('serves an unlisted class cover only to an authorized viewer', async () => {
    if (!available) return
    const { savePresentation } = await import('../src/lib/event-presentation.js')
    await savePresentation(EVENT_URI, { cover: { data: Buffer.from('test-image').toString('base64'), alt: 'A garden', revision: 'one' }, venueNeeded: true })
    const app = createApp()
    const path = `/api/events/${encodeURIComponent(EVENT_URI)}/image`
    expect((await app.request(path)).status).toBe(404)
    const cookie = await cookieFor(HOST_DID)
    const image = await app.request(path, { headers: { Cookie: cookie } })
    expect(image.status).toBe(200)
    expect(image.headers.get('Content-Type')).toBe('image/webp')
    expect(image.headers.get('Cache-Control')).toBe('private, no-store')
    const detail = await app.request(`/api/events/${encodeURIComponent(EVENT_URI)}`, { headers: { Cookie: cookie } })
    const body = await detail.json()
    expect(body.cover.alt).toBe('A garden')
    expect(body.venueNeeded).toBe(true)
    expect(JSON.stringify(body)).not.toContain('dGVzdC1pbWFnZQ==')
  })
  it('saves a normalized avatar but never exposes its raw data in profile JSON or to strangers', async () => {
    if (!available) return
    const sharp = (await import('sharp')).default
    const photo = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#335544' } }).png().toBuffer()
    const app = createApp()
    const cookie = await cookieFor(HOST_DID)
    const saved = await app.request('/api/me', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: { data: `data:image/png;base64,${photo.toString('base64')}`, alt: 'My avatar' } }) })
    expect(saved.status).toBe(200)
    const body = await saved.json()
    expect(body.profile.avatarUrl).toMatch(/^\/api\/me\/avatar\?v=/)
    expect(body.profile.avatar).toBeUndefined()
    expect((await app.request('/api/me/avatar')).status).toBe(401)
    const another = await cookieFor('did:plc:another-viewer')
    expect((await app.request('/api/me/avatar', { headers: { Cookie: another } })).status).toBe(404)
    expect((await app.request('/api/me/avatar', { headers: { Cookie: cookie } })).status).toBe(200)
    await app.request('/api/me', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ avatar: null }) })
    expect((await app.request('/api/me/avatar', { headers: { Cookie: cookie } })).status).toBe(404)
  })
})


describe('public class overview', () => {
  /**
   * INTEROP GAP 5, as ruled in task 19c: what the API serves an anonymous viewer is the
   * host's PUBLIC OVERVIEW, which since 19c is what the record's own `description` field
   * holds. The fixture below is the exact shape of the old bug — the class form labelled
   * two fields "shown after RSVP" and then wrote them into a world-readable record — and
   * this test is now the assertion that it cannot come back: the entry code lives in
   * `fs_event_extra`, never in the record, never in an anonymous response, and shows up
   * only once the viewer has RSVP'd.
   */
  it('serves the public overview to a stranger, and never the attendee notes, link or exact location', async () => {
    if (!available) return
    fixtureListed = true
    // Post-19c: the record carries the PUBLIC text, and nothing else of ours.
    eventRecord.description = 'Learn to grow mushrooms'
    eventRecord.locations = [{ street: '123 Secret Lane' }]
    const { savePresentation } = await import('../src/lib/event-presentation.js')
    const { setEventExtra } = await import('../src/lib/event-extra.js')
    await savePresentation(EVENT_URI, { publicOverview: { description: 'Learn to grow mushrooms', audience: 'Beginners', accessibility: 'Seating available' } })
    await setEventExtra(EVENT_URI, {
      materials: [],
      attendeeNotes: 'Private entry code 1234',
      meetingLink: 'https://example.com/private-meeting',
    })

    const res = await createApp().request(`/api/events/${encodeURIComponent(EVENT_URI)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.publicOverview).toEqual({ description: 'Learn to grow mushrooms', audience: 'Beginners', accessibility: 'Seating available' })
    expect(body.description).toBe('Learn to grow mushrooms')
    expect(body.locationRedacted).toBe(true)
    // The whole point of 19c: neither of these is public, on the record or off it.
    expect(body.attendeeNotes).toBeUndefined()
    expect(body.meetingLink).toBeUndefined()
    expect(body.uris).toBeUndefined()
    expect(body.locations).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('Private entry code 1234')
    expect(JSON.stringify(body)).not.toContain('private-meeting')
    expect(JSON.stringify(body)).not.toContain('Secret Lane')

    // ...and a member who has RSVP'd gets both, through the same gate as the address.
    const viewerDid = 'did:plc:events-http-rsvpd'
    const cookie = await cookieFor(viewerDid)
    await testDb().insert(rsvpTable).values({ id: 'r19c-1', eventUri: EVENT_URI, did: viewerDid, status: 'going' })
    const seen = await (await createApp().request(`/api/events/${encodeURIComponent(EVENT_URI)}`, { headers: { Cookie: cookie } })).json()
    expect(seen.viewerRelation).toBe('rsvp')
    expect(seen.attendeeNotes).toBe('Private entry code 1234')
    expect(seen.meetingLink).toBe('https://example.com/private-meeting')
    expect(seen.description).toBe('Learn to grow mushrooms')

    fixtureListed = false
    expect((await createApp().request(`/api/events/${encodeURIComponent(EVENT_URI)}`)).status).toBe(404)
  })

  it('the .ics carries the public overview and never the attendee notes or the link', async () => {
    if (!available) return
    fixtureListed = true
    eventRecord.description = 'Learn to grow mushrooms'
    const { savePresentation } = await import('../src/lib/event-presentation.js')
    const { setEventExtra } = await import('../src/lib/event-extra.js')
    await savePresentation(EVENT_URI, { publicOverview: { description: 'Learn to grow mushrooms' } })
    await setEventExtra(EVENT_URI, { materials: [], attendeeNotes: 'Private entry code 1234', meetingLink: 'https://example.com/private-meeting' })

    const res = await createApp().request(`/api/events/${encodeURIComponent(EVENT_URI)}.ics`)
    expect(res.status).toBe(200)
    const body = await res.text()
    // An .ics file gets forwarded and re-shared; only the public text may travel in one.
    expect(body).toContain('Learn to grow mushrooms')
    expect(body).not.toContain('Private entry code 1234')
    expect(body).not.toContain('private-meeting')
    fixtureListed = false
  })

  it('a legacy record\u2019s leftover `uris` are withheld from a stranger too (pre-19c classes)', async () => {
    if (!available) return
    fixtureListed = true
    eventRecord.description = 'Learn to grow mushrooms'
    eventRecord.uris = [{ uri: 'https://example.com/private-meeting' }]
    const { savePresentation } = await import('../src/lib/event-presentation.js')
    await savePresentation(EVENT_URI, { publicOverview: { description: 'Learn to grow mushrooms' } })
    const body = await (await createApp().request(`/api/events/${encodeURIComponent(EVENT_URI)}`)).json()
    expect(body.uris).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('private-meeting')
    fixtureListed = false
  })
})
