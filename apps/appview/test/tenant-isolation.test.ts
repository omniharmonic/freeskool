/**
 * THE TENANT-ISOLATION SUITE (MS §11's "the one that matters").
 *
 * Two schools, three members — one in A alone, one in B alone, one in both — and a
 * ROUTE TABLE. For every route in the table the suite asks the same question twice, once
 * on each school's host, and asserts that the answer contains nothing that belongs to the
 * other school: not a DID, not an event URI, not a notification title, not a vouch.
 *
 * The point of the table is that adding a route is ONE LINE. A new list endpoint that
 * forgets its `school_did` filter fails here rather than in production, which is the only
 * way this invariant survives the next twenty routes (Task 11 finishes the table).
 *
 * WHY THE LEGACY SCHOOL IS A THIRD DID. `lib/school-scope.ts` widens the predicate to
 * include unstamped (`''`) rows for the legacy school alone. Making neither A nor B the
 * legacy school keeps both of them on the strict `=` path, so a passing assertion here
 * says something about tenancy rather than about the transition rule.
 *
 * R9/MS §10, encoded as expectations rather than prose:
 *   - `GET /api/members/:did` is 404 — never 403 — for a DID with no shared school,
 *     because a 403 confirms existence;
 *   - a steward of A gets 403 on B's steward surface, not a quieter kind of yes;
 *   - a class on A's calendar is 404 on B, so its roster cannot even be addressed.
 */
process.env.MULTI_SCHOOL = '1'
// Deliberately neither school — see the module doc.
process.env.SCHOOL_DID = 'did:plc:school-legacy'
process.env.SCHOOL_HANDLE = 'legacy.test'
process.env.AUTHORITY_DID = 'did:plc:taxonomy'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'tenant-isolation-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 31).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'tenant-isolation-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const SCHOOL_A = 'did:plc:school-a'
const SCHOOL_B = 'did:plc:school-b'
const HOST_A = 'a.test'
const HOST_B = 'b.test'

/**
 * No DID here may be a SUBSTRING of another: the leak assertion is a substring search
 * over the whole response body, and `…member-a` inside `…member-both` would fail every
 * route for a reason that has nothing to do with tenancy.
 */
const MEMBER_A = 'did:plc:tenant-alice'
const MEMBER_B = 'did:plc:tenant-bruno'
const MEMBER_BOTH = 'did:plc:tenant-mira'
const STEWARD_A = 'did:plc:tenant-quinn'
/** Author of the needs-board request: in neither school, so its at-uri names no secret. */
const ASKER = 'did:plc:tenant-asker'

const SKILL = 'at://did:plc:taxonomy/freeschool.draft.skill/welding'
const EVENT_A = `at://${MEMBER_A}/community.lexicon.calendar.event/ea`
const EVENT_B = `at://${MEMBER_B}/community.lexicon.calendar.event/eb`
const REQUEST_A = `at://${ASKER}/freeschool.draft.request/ra`

/** Strings that belong to exactly one school and must never cross. */
const SECRETS: Record<'a' | 'b', string[]> = {
  a: [MEMBER_A, EVENT_A, 'vouch-from-a', 'Notification from A', 'proposal-a'],
  b: [MEMBER_B, EVENT_B, 'vouch-from-b', 'Notification from B', 'proposal-b'],
}

/* ────────────────────────────── the fake index ────────────────────────────── */

const { skillRecords, eventRecords, requestRecords, eventConfigs } = vi.hoisted(() => ({
  skillRecords: [
    {
      uri: 'at://did:plc:taxonomy/freeschool.draft.skill/welding',
      did: 'did:plc:taxonomy',
      collection: 'freeschool.draft.skill',
      rkey: 'welding',
      cid: 'bafy',
      record: { id: 'welding', label: 'Welding' },
    },
  ],
  eventRecords: [] as Array<Record<string, unknown>>,
  requestRecords: [] as Array<Record<string, unknown>>,
  eventConfigs: [] as Array<{ uri: string; did: string; eventUri: string }>,
}))

vi.mock('../src/index/indexer.js', () => ({
  resetIndexer: () => {},
  getIndexer: async () => ({
    contrail: {
      async query(short: string) {
        if (short === 'skill') return { records: skillRecords }
        if (short === 'event') return { records: eventRecords }
        if (short === 'request') return { records: requestRecords }
        return { records: [] }
      },
    },
    db: {
      prepare(sqlText: string) {
        const short = /records_([A-Za-z0-9_]+)/.exec(sqlText)?.[1]
        return {
          bind(arg: string) {
            return {
              all: async () => {
                if (short !== 'eventConfig') return { results: [] }
                const rows = eventConfigs.filter((r) => r.eventUri === arg)
                return {
                  results: rows.map((r) => ({
                    uri: r.uri,
                    did: r.did,
                    rkey: r.uri.split('/').pop(),
                    cid: 'bafy',
                    record: JSON.stringify({ event: { uri: r.eventUri }, visibility: 'listed', tags: ['skillshare'] }),
                    time_us: 1,
                    indexed_at: 1,
                  })),
                }
              },
              first: async () => null,
            }
          },
        }
      },
    },
    async notify() {},
  }),
}))

// No network: the school record is simply absent, which `refreshPolicyCache` treats as
// "a school that has not written a policy yet" and caches as the defaults.
vi.mock('../src/lib/pds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pds.js')>()),
  getRecord: async () => null,
}))

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createApp } from '../src/http/app.js'
import { config } from '../src/config.js'
import { newSessionId, signSessionId } from '../src/lib/crypto.js'
import { resetSchoolContextCache } from '../src/http/school-context.js'
import {
  attestation,
  custodialAccount,
  invite,
  eventSchool,
  notificationFeed,
  requestRsvp,
  rsvp,
  school,
  schoolDomain,
  session,
  skillClaimIndex,
  skillProposal,
  steward,
} from '../src/db/schema.js'
import { joinSchool } from '../src/lib/membership.js'
import { rowId } from '../src/lib/ids.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

afterAll(async () => {
  if (available) await closeTestDb()
})

async function cookieFor(did: string): Promise<string> {
  const id = newSessionId()
  await testDb()
    .insert(session)
    .values({ id, did, kind: 'custodial', expiresAt: new Date(Date.now() + 86_400_000) })
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

const cookies: Record<string, string> = {}

beforeEach(async () => {
  if (!available) return
  await truncate(
    'fs_school',
    'fs_school_domain',
    'fs_membership',
    'fs_member',
    'fs_member_prefs',
    'fs_session',
    'fs_steward',
    'fs_attestation',
    'fs_skill_claim_index',
    'fs_skill_proposal',
    'fs_notification_feed',
    'fs_rsvp',
    'fs_request_rsvp',
    'fs_event_school',
    'fs_policy_cache',
    'fs_custodial_account',
    'fs_invite',
    'fs_app_meta',
  )
  resetSchoolContextCache()
  eventRecords.length = 0
  requestRecords.length = 0
  eventConfigs.length = 0

  const db = testDb()
  await db.insert(school).values([
    { did: SCHOOL_A, label: 'a', name: 'A Free School', handle: HOST_A },
    { did: SCHOOL_B, label: 'b', name: 'B Free School', handle: HOST_B },
  ])
  await db.insert(schoolDomain).values([
    { host: HOST_A, schoolDid: SCHOOL_A, kind: 'canonical' },
    { host: HOST_B, schoolDid: SCHOOL_B, kind: 'canonical' },
  ])

  /**
   * `hasProfile` and the `invite-or-vouch` member gate are what `deriveRole` runs on, so
   * every person here needs an identity (global) and admission evidence IN EACH SCHOOL
   * they belong to (per school) — otherwise everyone is a Visitor and the steward
   * assertions below would pass for the wrong reason.
   */
  for (const [did, handle] of [
    [MEMBER_A, 'alice.test'],
    [MEMBER_B, 'bruno.test'],
    [MEMBER_BOTH, 'mira.test'],
    [STEWARD_A, 'quinn.test'],
  ] as const) {
    await db.insert(custodialAccount).values({ did, handle, email: `${handle}@example.org`, keyVersion: 'v1' })
  }
  for (const [did, schoolDid] of [
    [MEMBER_A, SCHOOL_A],
    [MEMBER_B, SCHOOL_B],
    [MEMBER_BOTH, SCHOOL_A],
    [MEMBER_BOTH, SCHOOL_B],
    [STEWARD_A, SCHOOL_A],
    [STEWARD_A, SCHOOL_B],
  ] as const) {
    await db
      .insert(invite)
      .values({ code: rowId(), schoolDid, inviterDid: 'did:plc:tenant-founder', usedByDid: did, usedAt: new Date() })
  }

  await joinSchool(MEMBER_A, SCHOOL_A, 'custodial')
  await joinSchool(MEMBER_B, SCHOOL_B, 'custodial')
  await joinSchool(MEMBER_BOTH, SCHOOL_A, 'custodial')
  await joinSchool(MEMBER_BOTH, SCHOOL_B, 'custodial')
  // A steward of A, and an ordinary member of B — exactly the person MS §5's acceptance
  // criterion is about ("a Denver steward has no steward power on Boulder").
  await joinSchool(STEWARD_A, SCHOOL_A, 'custodial')
  await joinSchool(STEWARD_A, SCHOOL_B, 'custodial')
  await db.insert(steward).values({ did: STEWARD_A, schoolDid: SCHOOL_A })

  // The same member's own claim, GLOBAL by design (MS §2) — it is the LIST of who holds
  // it that must be answered within one school.
  await db.insert(skillClaimIndex).values([
    { did: MEMBER_A, skillUri: SKILL, level: 'teaching', visibility: 'public' },
    { did: MEMBER_B, skillUri: SKILL, level: 'teaching', visibility: 'public' },
    { did: MEMBER_BOTH, skillUri: SKILL, level: 'teaching', visibility: 'public' },
  ])

  // One vouch for MEMBER_BOTH in each school, from that school's own member.
  await db.insert(attestation).values([
    { id: 'vouch-from-a', attesterDid: MEMBER_A, subjectDid: MEMBER_BOTH, skillUri: SKILL, schoolDid: SCHOOL_A },
    { id: 'vouch-from-b', attesterDid: MEMBER_B, subjectDid: MEMBER_BOTH, skillUri: SKILL, schoolDid: SCHOOL_B },
  ])

  await db.insert(skillProposal).values([
    { id: 'proposal-a', skillUri: SKILL, schoolDid: SCHOOL_A, proposerDid: MEMBER_A, status: 'published' },
    { id: 'proposal-b', skillUri: SKILL, schoolDid: SCHOOL_B, proposerDid: MEMBER_B, status: 'published' },
  ])

  await db.insert(notificationFeed).values([
    { id: rowId(), did: MEMBER_BOTH, schoolDid: SCHOOL_A, category: 'event.reminder', title: 'Notification from A' },
    { id: rowId(), did: MEMBER_BOTH, schoolDid: SCHOOL_B, category: 'event.reminder', title: 'Notification from B' },
  ])

  // One class on each calendar, hosted by that school's own member.
  for (const [uri, host, schoolDid] of [
    [EVENT_A, MEMBER_A, SCHOOL_A],
    [EVENT_B, MEMBER_B, SCHOOL_B],
  ] as const) {
    eventRecords.push({
      uri,
      did: host,
      collection: 'community.lexicon.calendar.event',
      rkey: uri.split('/').pop(),
      cid: 'bafy',
      record: {
        name: `Class in ${schoolDid === SCHOOL_A ? 'A' : 'B'}`,
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    })
    eventConfigs.push({ uri: `${uri}-cfg`, did: host, eventUri: uri })
    await db.insert(eventSchool).values({ eventUri: uri, schoolDid })
  }
  // Someone from each school is coming to their own school's class.
  await db.insert(rsvp).values([
    { id: rowId(), eventUri: EVENT_A, did: MEMBER_A, schoolDid: SCHOOL_A, status: 'going' },
    { id: rowId(), eventUri: EVENT_B, did: MEMBER_B, schoolDid: SCHOOL_B, status: 'going' },
  ])

  requestRecords.push({
    uri: REQUEST_A,
    did: ASKER,
    collection: 'freeschool.draft.request',
    rkey: 'ra',
    cid: 'bafy',
    record: { title: 'Someone teach welding', status: 'open', threshold: 3, createdAt: new Date().toISOString() },
  })
  // Interest in the SAME request, registered separately in each school.
  await db.insert(requestRsvp).values([
    { requestUri: REQUEST_A, did: MEMBER_A, schoolDid: SCHOOL_A },
    { requestUri: REQUEST_A, did: MEMBER_B, schoolDid: SCHOOL_B },
  ])

  cookies.memberBoth = await cookieFor(MEMBER_BOTH)
  cookies.stewardA = await cookieFor(STEWARD_A)
})

/* ────────────────────────────── the route table ───────────────────────────── */

type Viewer = 'anon' | 'memberBoth' | 'stewardA'

interface RouteCase {
  name: string
  path: string
  viewer: Viewer
  /** Expected status per school; defaults to 200 on both. */
  expect?: { a?: number; b?: number }
  /** Extra per-school assertion on the parsed body, when a status is not enough. */
  check?: (body: unknown, on: 'a' | 'b') => void
}

const ROUTES: RouteCase[] = [
  { name: 'members directory', path: '/api/members', viewer: 'memberBoth' },
  {
    name: "one member's profile (404, never 403, across schools)",
    path: `/api/members/${encodeURIComponent(MEMBER_A)}`,
    viewer: 'memberBoth',
    expect: { a: 200, b: 404 },
  },
  { name: 'people on a skill page', path: `/api/skills/${encodeURIComponent(SKILL)}`, viewer: 'memberBoth' },
  { name: 'my vouches', path: '/api/me/attestations', viewer: 'memberBoth' },
  {
    name: 'the needs board',
    path: '/api/requests',
    viewer: 'memberBoth',
    check: (body, on) => {
      const items = (body as { requests?: Array<{ rsvpCount: number }> }).requests ?? []
      // One interested member in each school; a threshold must be met within one city.
      for (const r of items) expect(r.rsvpCount, `rsvpCount on ${on}`).toBe(1)
    },
  },
  { name: 'the public calendar', path: '/api/calendar', viewer: 'anon' },
  {
    name: "a class's roster",
    path: `/api/events/${encodeURIComponent(EVENT_A)}/rsvps`,
    viewer: 'stewardA',
    expect: { a: 200, b: 404 },
  },
  {
    name: "the other school's roster",
    path: `/api/events/${encodeURIComponent(EVENT_B)}/rsvps`,
    viewer: 'stewardA',
    // 404 on A (not our class) and 403 on B (not a steward there): neither says more.
    expect: { a: 404, b: 403 },
  },
  { name: 'the policy surface', path: '/api/admin/policy', viewer: 'stewardA', expect: { a: 200, b: 403 } },
  {
    name: 'the skill-proposal queue',
    path: '/api/admin/skills/proposals',
    viewer: 'stewardA',
    expect: { a: 200, b: 403 },
  },
  { name: 'my notifications', path: '/api/notifications', viewer: 'memberBoth' },
]

async function get(route: RouteCase, on: 'a' | 'b'): Promise<{ status: number; text: string }> {
  const host = on === 'a' ? HOST_A : HOST_B
  const headers: Record<string, string> = { Host: host }
  if (route.viewer !== 'anon') headers.Cookie = cookies[route.viewer]!
  const res = await createApp().request(`http://${host}${route.path}`, { headers })
  return { status: res.status, text: await res.text() }
}

describe('tenant isolation, route by route', () => {
  for (const route of ROUTES) {
    it(`${route.name}: nothing from the other school`, async () => {
      if (!available) return
      for (const on of ['a', 'b'] as const) {
        const other = on === 'a' ? 'b' : 'a'
        const { status, text } = await get(route, on)
        expect(status, `${route.path} on ${on}`).toBe(route.expect?.[on] ?? 200)
        for (const secret of SECRETS[other]) {
          expect(text, `${route.path} on ${on} leaked ${secret}`).not.toContain(secret)
        }
        if (route.check && status === 200) route.check(JSON.parse(text), on)
      }
    })
  }
})

describe('the tenancy the table depends on', () => {
  it('a host that names no school is 404 UnknownSchool, not the legacy school', async () => {
    if (!available) return
    const res = await createApp().request('http://nowhere.test/api/members', {
      headers: { Host: 'nowhere.test', Cookie: cookies.memberBoth! },
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('UnknownSchool')
  })

  it('X-Forwarded-Host wins over Host, because the edge is what the member typed', async () => {
    if (!available) return
    const res = await createApp().request(`http://${HOST_B}/api/members`, {
      headers: { Host: HOST_B, 'X-Forwarded-Host': HOST_A, Cookie: cookies.memberBoth! },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { members: Array<{ did: string }> }
    expect(body.members.map((m) => m.did).sort()).toEqual([MEMBER_A, MEMBER_BOTH, STEWARD_A].sort())
  })

  it('each school sees only its own members, and the member of both sees both rosters', async () => {
    if (!available) return
    for (const [host, expected] of [
      [HOST_A, [MEMBER_A, MEMBER_BOTH, STEWARD_A]],
      [HOST_B, [MEMBER_B, MEMBER_BOTH, STEWARD_A]],
    ] as const) {
      const res = await createApp().request(`http://${host}/api/members`, {
        headers: { Host: host, Cookie: cookies.memberBoth! },
      })
      const body = (await res.json()) as { members: Array<{ did: string }> }
      expect(body.members.map((m) => m.did).sort()).toEqual([...expected].sort())
    }
  })

  it('a vouch given in A is invisible in B, and vice versa', async () => {
    if (!available) return
    for (const [host, present, absent] of [
      [HOST_A, MEMBER_A, MEMBER_B],
      [HOST_B, MEMBER_B, MEMBER_A],
    ] as const) {
      const res = await createApp().request(`http://${host}/api/me/attestations`, {
        headers: { Host: host, Cookie: cookies.memberBoth! },
      })
      const body = (await res.json()) as { received: Array<{ attesterDid: string }> }
      expect(body.received.map((r) => r.attesterDid)).toEqual([present])
      expect(body.received.map((r) => r.attesterDid)).not.toContain(absent)
    }
  })
})
