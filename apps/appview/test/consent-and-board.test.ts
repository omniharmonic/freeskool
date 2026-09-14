/**
 * Three places where the app said one thing and the protocol did another.
 *
 * A6 — a public skill claim is a RECORD, and turning the toggle back to "school only" has to
 * delete it. It did not: the UI said private, the record stayed readable by anyone, forever.
 * `PUT /api/me/skill-claims` takes the member's whole set, so anything no longer asked to be
 * public is a withdrawal of consent and is deleted from their repo.
 *
 * A7 — the needs board is public, and must stay public, but it must not ENUMERATE MEMBERS.
 * `askedBy` is omitted unless the viewer is the asker or a steward.
 *
 * #14 / #15 — the feedback summary of an unlisted class is not public either, and the host's
 * "feedback arrived" notification fires once per event, when the summary unlocks, rather than
 * once per ballot (which leaked how many people had answered, and exactly when).
 */
process.env.SCHOOL_DID = 'did:plc:consent-board-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'consent-board-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 19).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'consent-board-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'

const SCHOOL = 'did:plc:consent-board-school'
const MEMBER = 'did:plc:consent-board-member'
const ASKER = 'did:plc:consent-board-asker'
const STEWARD_DID = 'did:plc:consent-board-steward'
const HOST = 'did:plc:consent-board-host'
const ATTENDEE = 'did:plc:consent-board-attendee'

const SKILL_A = 'at://did:plc:taxonomy/freeschool.draft.skill/bicycle-repair'
const SKILL_B = 'at://did:plc:taxonomy/freeschool.draft.skill/sourdough'

const EVENT_URI = `at://${HOST}/community.lexicon.calendar.event/feedback-me`
const REQUEST_URI = `at://${ASKER}/freeschool.draft.request/req1`

/** The member's repo, as a map — so a delete is observable. Shared with the fake agent. */
const { repo } = vi.hoisted(() => ({ repo: new Map<string, Record<string, unknown>>() }))
/** Flipped per test: whether the event has a live school listing, and (R1) whether the
 * viewer's repo credential has lapsed. */
const { state } = vi.hoisted(() => ({ state: { listed: true, credentialLapsed: false } }))

vi.mock('../src/lib/actor-agent.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/actor-agent.js')>('../src/lib/actor-agent.js')
  return {
    ...actual,
    async actorAgent(viewer: { did: string }) {
      if (state.credentialLapsed) throw new actual.NoActorCredentialError(viewer.did)
      return {
        com: {
          atproto: {
            repo: {
              async listRecords(i: { repo: string; collection: string }) {
                const prefix = `${i.repo}/${i.collection}/`
                return {
                  data: {
                    records: [...repo.keys()]
                      .filter((k) => k.startsWith(prefix))
                      .map((k) => ({ uri: `at://${k}`, cid: 'bafy', value: repo.get(k) })),
                  },
                }
              },
              async putRecord(i: { repo: string; collection: string; rkey: string; record: Record<string, unknown> }) {
                const key = `${i.repo}/${i.collection}/${i.rkey}`
                repo.set(key, i.record)
                return { data: { uri: `at://${key}`, cid: 'bafy' } }
              },
              async deleteRecord(i: { repo: string; collection: string; rkey: string }) {
                repo.delete(`${i.repo}/${i.collection}/${i.rkey}`)
                return { data: {} }
              },
            },
          },
        },
        // `viewer` is unused beyond keeping the signature honest.
        did: viewer.did,
      } as never
    },
  }
})

function fakeIndexer() {
  const eventRecord = {
    $type: 'community.lexicon.calendar.event',
    name: 'Sourdough',
    createdAt: '2026-09-01T00:00:00Z',
    startsAt: '2026-09-10T18:00:00Z',
    endsAt: '2026-09-10T20:00:00Z',
  }
  return {
    contrail: {
      async query(short: string, opts: { did?: string; filters?: Record<string, unknown> }) {
        if (short === 'event' && opts.did === HOST) {
          return { records: [{ uri: EVENT_URI, did: HOST, collection: 'community.lexicon.calendar.event', rkey: 'feedback-me', cid: 'bafye', record: eventRecord }] }
        }
        if (short === 'request') {
          return {
            records: [
              { uri: REQUEST_URI, did: ASKER, collection: 'freeschool.draft.request', rkey: 'req1', cid: 'bafyr', record: { title: 'Teach me to weld', status: 'open', createdAt: '2026-09-01T00:00:00Z' } },
            ],
          }
        }
        if (short === 'skillClaim') {
          const prefix = `${opts.did}/freeschool.draft.skillClaim/`
          return {
            records: [...repo.keys()]
              .filter((k) => k.startsWith(prefix))
              .map((k) => ({ uri: `at://${k}`, did: opts.did!, collection: 'freeschool.draft.skillClaim', rkey: k.split('/').pop()!, cid: 'bafy', record: repo.get(k) })),
          }
        }
        if (short === 'skill') {
          // Tier lookups: a resolvable taxonomy skill, so it is Tier A rather than
          // fail-closed Tier B (which would need `confirmTierB`).
          return { records: [
            { uri: SKILL_A, did: 'did:plc:taxonomy', collection: 'freeschool.draft.skill', rkey: 'bicycle-repair', cid: 'bafys', record: { id: 'bicycle-repair', label: 'Bicycle repair' } },
            { uri: SKILL_B, did: 'did:plc:taxonomy', collection: 'freeschool.draft.skill', rkey: 'sourdough', cid: 'bafys', record: { id: 'sourdough', label: 'Sourdough' } },
          ] }
        }
        return { records: [] }
      },
    },
    db: {
      prepare(sql: string) {
        const short = /records_([A-Za-z0-9_]+)/.exec(sql)?.[1]
        return {
          bind(arg: string) {
            const ref = { uri: arg, cid: 'bafy' }
            if (short === 'eventListing' && state.listed) {
              return { all: async () => ({ results: [{ uri: `at://${SCHOOL}/coop.lexicon.event.listing/l1`, did: SCHOOL, rkey: 'l1', cid: 'bafyl', record: { event: ref, school: SCHOOL, status: 'listed', createdAt: '2026-09-02T00:00:00Z' }, time_us: 1, indexed_at: 1 }] }), first: async () => null }
            }
            return { all: async () => ({ results: [] }), first: async () => null }
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
import { setDirectoryListing } from '../src/lib/membership.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { attendance, custodialAccount, memberPrefs, notificationFeed, skillClaimIndex, steward } from '../src/db/schema.js'
import { openFeedbackWindow } from '../src/lib/feedback.js'
import { rowId } from '../src/lib/ids.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate(
    'fs_app_meta',
    'fs_attendance',
    'fs_feedback',
    'fs_feedback_ballot',
    'fs_feedback_window',
    'fs_custodial_account',
    'fs_session',
    'fs_member',
    'fs_steward',
    'fs_notification_feed',
    'fs_notification_sent',
    'fs_notification_outbox',
    'fs_skill_tier',
    'fs_skill_claim_index',
    'fs_member_prefs',
  )
  repo.clear()
  state.listed = true
  state.credentialLapsed = false
  await testDb().insert(custodialAccount).values([
    { did: MEMBER, handle: 'cb-member.test', email: 'm@example.org', keyVersion: 'v1' },
    { did: STEWARD_DID, handle: 'cb-steward.test', email: 's@example.org', keyVersion: 'v1' },
    { did: ASKER, handle: 'cb-asker.test', email: 'a@example.org', keyVersion: 'v1' },
  ])
  await testDb().insert(steward).values({ did: STEWARD_DID, schoolDid: SCHOOL })
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

const claimKeys = () => [...repo.keys()].filter((k) => k.includes('skillClaim'))

async function putClaims(cookie: string, claims: unknown[]): Promise<Response> {
  return createApp().request('/api/me/skill-claims', {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ claims }),
  })
}

describe('A6: a public skill claim is retracted when consent ends', () => {
  it('publish → flip to school → the record is gone', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)

    const published = await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'public' }])
    expect(published.status).toBe(200)
    expect((await published.json()) as { published: unknown[] }).toMatchObject({ published: [{ skill: SKILL_A }] })
    expect(claimKeys().length).toBe(1)

    const flipped = await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'school' }])
    expect(flipped.status).toBe(200)
    const body = (await flipped.json()) as { published: unknown[]; retracted: string[]; keptAppSide: number }
    expect(body.published).toEqual([])
    expect(body.retracted.length).toBe(1)
    expect(body.keptAppSide).toBe(1)
    // THE RECORD IS GONE from the repo, not merely absent from the response.
    expect(claimKeys()).toEqual([])
  })

  it('retracts a claim DROPPED from the set entirely, and leaves the others alone', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    await putClaims(cookie, [
      { skill: SKILL_A, level: 'teaching', visibility: 'public' },
      { skill: SKILL_B, level: 'practicing', visibility: 'public' },
    ])
    expect(claimKeys().length).toBe(2)

    const res = await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'public' }])
    expect(res.status).toBe(200)
    expect(((await res.json()) as { retracted: string[] }).retracted.length).toBe(1)
    expect(claimKeys().length).toBe(1)
    expect(claimKeys()[0]).toContain('bicycle-repair')
  })

  it('re-stating the same public set changes nothing', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    const claims = [{ skill: SKILL_A, level: 'teaching', visibility: 'public' }]
    await putClaims(cookie, claims)
    const again = await putClaims(cookie, claims)
    expect(((await again.json()) as { retracted: string[] }).retracted).toEqual([])
    expect(claimKeys().length).toBe(1)
  })

  it('an empty set withdraws everything', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'public' }])
    const res = await putClaims(cookie, [])
    expect(res.status).toBe(200)
    expect(claimKeys()).toEqual([])
  })
})

describe('R1: a lapsed repo credential does not cost the school-only save', () => {
  it('persists the app-side claim first and returns 200 with reauthRequired, not 401', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    state.credentialLapsed = true

    // A mixed save: the public claim is what makes `needsRepo` true (and is what the
    // lapsed credential blocks); the school claim is the app-side save that must survive
    // regardless. A pure school-only request with nothing ever published needs no repo
    // access at all (see `needsRepo` in `me.ts`), so would not exercise this path.
    const res = await putClaims(cookie, [
      { skill: SKILL_A, level: 'teaching', visibility: 'public' },
      { skill: SKILL_B, level: 'practicing', visibility: 'school' },
    ])
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reauthRequired?: boolean; keptAppSide: number; published: unknown[] }
    expect(body.reauthRequired).toBe(true)
    expect(body.keptAppSide).toBe(1)
    expect(body.published).toEqual([])
    expect(claimKeys()).toEqual([]) // the public claim never reached the repo

    // The save genuinely happened — not merely echoed in the PUT response — because a
    // follow-up GET (which never touches the repo) sees it too.
    const get = await createApp().request('/api/me/skill-claims', { headers: { Cookie: cookie } })
    const getBody = (await get.json()) as { school: Array<{ skill: string; level: string }> }
    expect(getBody.school).toEqual([{ skill: SKILL_B, level: 'practicing' }])
  })

  it('reports pendingRetractions for a public claim that could not be withdrawn', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'public' }])
    expect(claimKeys().length).toBe(1)

    state.credentialLapsed = true
    const res = await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'school' }])
    expect(res.status).toBe(200)
    const body = (await res.json()) as { reauthRequired?: boolean; pendingRetractions?: number; keptAppSide: number }
    expect(body.reauthRequired).toBe(true)
    expect(body.pendingRetractions).toBe(1)
    expect(body.keptAppSide).toBe(1)
    // The record is untouched — the repo was never reached.
    expect(claimKeys().length).toBe(1)
  })
})

describe('A7: the needs board does not enumerate members', () => {
  it('omits askedBy for an unauthenticated viewer', async () => {
    if (!available) return
    const res = await createApp().request('/api/requests')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { requests: Array<Record<string, unknown>> }
    expect(body.requests.length).toBe(1)
    expect(body.requests[0]!.title).toBe('Teach me to weld')
    expect('askedBy' in body.requests[0]!).toBe(false)
    // The at-uri necessarily still carries the asker's DID in its authority segment — it is
    // the record's address, and every follow-up call takes it. See the route's module doc:
    // what A7 closes is the field literally named "who asked", not the URI.
    expect(body.requests[0]!.uri).toBe(REQUEST_URI)
  })

  it('omits askedBy for a signed-in member who is neither the asker nor a steward', async () => {
    if (!available) return
    const res = await createApp().request('/api/requests', { headers: { Cookie: await cookieFor(MEMBER) } })
    const body = (await res.json()) as { requests: Array<Record<string, unknown>> }
    expect('askedBy' in body.requests[0]!).toBe(false)
  })

  it('shows askedBy to the asker themselves', async () => {
    if (!available) return
    const res = await createApp().request('/api/requests', { headers: { Cookie: await cookieFor(ASKER) } })
    const body = (await res.json()) as { requests: Array<Record<string, unknown>> }
    expect(body.requests[0]!.askedBy).toBe(ASKER)
  })

  it('shows askedBy to a steward, who needs it to moderate', async () => {
    if (!available) return
    const res = await createApp().request('/api/requests', { headers: { Cookie: await cookieFor(STEWARD_DID) } })
    const body = (await res.json()) as { requests: Array<Record<string, unknown>> }
    expect(body.requests[0]!.askedBy).toBe(ASKER)
  })
})

describe('#14: the feedback summary of an unlisted class is not public', () => {
  it('404s for a public viewer when the event is not listed, and still answers the host', async () => {
    if (!available) return
    state.listed = false
    const app = createApp()
    expect((await app.request(`/api/events/${encodeURIComponent(EVENT_URI)}/feedback-summary`)).status).toBe(404)
    // Same guard as GET /api/events/:id.
    expect((await app.request(`/api/events/${encodeURIComponent(EVENT_URI)}`)).status).toBe(404)
    // The host can still see their own.
    const asHost = await app.request(`/api/events/${encodeURIComponent(EVENT_URI)}/feedback-summary`, {
      headers: { Cookie: await cookieFor(HOST) },
    })
    expect(asHost.status).toBe(200)
  })

  it('is public for a listed class', async () => {
    if (!available) return
    expect((await createApp().request(`/api/events/${encodeURIComponent(EVENT_URI)}/feedback-summary`)).status).toBe(200)
  })
})

describe('#15: the host is told once per event, when the summary unlocks', () => {
  const ballots = ['did:plc:cb-b1', 'did:plc:cb-b2', 'did:plc:cb-b3']

  async function leaveFeedback(did: string): Promise<Response> {
    return createApp().request('/api/feedback', {
      method: 'POST',
      headers: { Cookie: await cookieFor(did), 'content-type': 'application/json' },
      body: JSON.stringify({ eventUri: EVENT_URI, direction: 'positive' }),
    })
  }

  it('stays silent until k ballots, then notifies exactly once', async () => {
    if (!available) return
    await openFeedbackWindow(EVENT_URI, new Date(Date.now() - 1000).toISOString())
    for (const did of [...ballots, ATTENDEE]) {
      await testDb()
        .insert(attendance)
        .values({ id: rowId(), eventUri: EVENT_URI, attendeeDid: did, attestedByDid: HOST, participated: true })
    }

    const feed = async () => testDb().select().from(notificationFeed).where(eq(notificationFeed.did, HOST))

    // feedbackK defaults to 3. The first two ballots say nothing at all.
    expect((await leaveFeedback(ballots[0]!)).status).toBe(201)
    expect(await feed()).toHaveLength(0)
    expect((await leaveFeedback(ballots[1]!)).status).toBe(201)
    expect(await feed()).toHaveLength(0)

    // The third unlocks the numeric summary — and the host hears about it.
    expect((await leaveFeedback(ballots[2]!)).status).toBe(201)
    const notified = await feed()
    expect(notified).toHaveLength(1)
    expect(notified[0]?.category).toBe('feedback.received')

    // A fourth ballot is silent: one notification per EVENT, so the host never learns the
    // running count or the timing of individual answers.
    expect((await leaveFeedback(ATTENDEE)).status).toBe(201)
    expect(await feed()).toHaveLength(1)
  })
})

describe('Task 2: fs_skill_claim_index is rebuilt wholesale on every save', () => {
  const indexRows = async (did: string) =>
    testDb().select().from(skillClaimIndex).where(eq(skillClaimIndex.did, did))

  it('a save with two claims leaves exactly those two rows, with the right visibility', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    const res = await putClaims(cookie, [
      { skill: SKILL_A, level: 'teaching', visibility: 'public' },
      { skill: SKILL_B, level: 'practicing', visibility: 'school' },
    ])
    expect(res.status).toBe(200)

    const rows = await indexRows(MEMBER)
    expect(rows.length).toBe(2)
    const bySkill = new Map(rows.map((r) => [r.skillUri, r]))
    expect(bySkill.get(SKILL_A)).toMatchObject({ level: 'teaching', visibility: 'public' })
    expect(bySkill.get(SKILL_B)).toMatchObject({ level: 'practicing', visibility: 'school' })
  })

  it('a second save with one claim leaves exactly one row', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    await putClaims(cookie, [
      { skill: SKILL_A, level: 'teaching', visibility: 'public' },
      { skill: SKILL_B, level: 'practicing', visibility: 'school' },
    ])
    expect((await indexRows(MEMBER)).length).toBe(2)

    await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'public' }])
    const rows = await indexRows(MEMBER)
    expect(rows.length).toBe(1)
    expect(rows[0]?.skillUri).toBe(SKILL_A)
  })

  it('an empty save clears the index for that member', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    await putClaims(cookie, [{ skill: SKILL_A, level: 'teaching', visibility: 'public' }])
    expect((await indexRows(MEMBER)).length).toBe(1)

    await putClaims(cookie, [])
    expect((await indexRows(MEMBER)).length).toBe(0)
  })

  it("does not touch another member's index rows", async () => {
    if (!available) return
    await putClaims(await cookieFor(ASKER), [{ skill: SKILL_A, level: 'learning', visibility: 'school' }])
    await putClaims(await cookieFor(MEMBER), [{ skill: SKILL_B, level: 'teaching', visibility: 'public' }])
    expect((await indexRows(ASKER)).length).toBe(1)
    expect((await indexRows(MEMBER)).length).toBe(1)
  })
})

describe('Task 2: GET /api/me reports directoryListing and onboarded', () => {
  it('defaults directoryListing to true and onboarded to false when there is no prefs row', async () => {
    if (!available) return
    const res = await createApp().request('/api/me', { headers: { Cookie: await cookieFor(MEMBER) } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { directoryListing: boolean; onboarded: boolean }
    expect(body.directoryListing).toBe(true)
    expect(body.onboarded).toBe(false)
  })

  it('reflects an opt-out and an onboarded member from the prefs row', async () => {
    if (!available) return
    await testDb()
      .insert(memberPrefs)
      .values({ did: MEMBER, directoryListing: false, onboardedAt: new Date() })
    // `directoryListing` is per-school now and lives on `fs_membership`; `onboarded` is
    // still the global `fs_member_prefs` fact. `PUT /api/me` writes both (MS §9 E), and
    // so does the backfill — this fixture does the same rather than only half of it.
    await setDirectoryListing(MEMBER, config().SCHOOL_DID, false)
    const res = await createApp().request('/api/me', { headers: { Cookie: await cookieFor(MEMBER) } })
    const body = (await res.json()) as { directoryListing: boolean; onboarded: boolean }
    expect(body.directoryListing).toBe(false)
    expect(body.onboarded).toBe(true)
  })

  it('sets X-Robots-Tag: noindex, nofollow on both the 200 and the 401', async () => {
    if (!available) return
    const ok = await createApp().request('/api/me', { headers: { Cookie: await cookieFor(MEMBER) } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')

    const anon = await createApp().request('/api/me')
    expect(anon.status).toBe(401)
    expect(anon.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })
})
