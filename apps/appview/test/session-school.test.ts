/**
 * THE SESSION KNOWS WHICH SCHOOL (MS §3, federation Task 4).
 *
 * Two facts, and everything here is one of them:
 *
 *   1. Signing in ON A SCHOOL'S HOST records that school on the session row. That is what
 *      makes the APEX work — it serves no city of its own, so a member who signed in on
 *      `denver.freeskool.xyz` and then follows a link to `freeskool.xyz` must still be in
 *      Denver rather than in whichever school the apex happens to front.
 *   2. The HOST still wins whenever it names a school. The session is the fallback, never
 *      the authority: `boulder.freeskool.xyz` is Boulder for everybody, including a member
 *      whose session last said Denver.
 *
 * And the picker: `POST /api/auth/switch-school` moves fact 1 for a school the member
 * actually belongs to, and refuses otherwise. The refusal is a 403 rather than the 404
 * every per-school READ gives, because the picker only ever offers schools
 * `GET /api/auth/me` has already listed to this member — a refusal there confirms nothing
 * they did not already know.
 */
process.env.MULTI_SCHOOL = '1'
/** Deliberately neither school: `lib/school-scope.ts` widens only for the legacy one. */
process.env.SCHOOL_DID = 'did:plc:sess-legacy'
process.env.SCHOOL_HANDLE = 'legacy.test'
process.env.WEB_PUBLIC_URL ??= 'https://apex.test'
process.env.APPVIEW_PUBLIC_URL ??= 'https://apex.test'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'session-school-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 41).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'session-school-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// No network: an absent school record is "a school that has not written a policy yet",
// which `refreshPolicyCache` caches as the defaults.
vi.mock('../src/lib/pds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pds.js')>()),
  getRecord: async () => null,
}))

import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { config } from '../src/config.js'
import { auth } from '../src/http/routes/auth.js'
import { createSession, withViewer, type AppEnv } from '../src/http/session.js'
import { optionalSchool, resetSchoolContextCache, withSchool } from '../src/http/school-context.js'
import { joinSchool } from '../src/lib/membership.js'
import { custodialAccount, policyCache, school, schoolDomain, session } from '../src/db/schema.js'

const SCHOOL_A = 'did:plc:sess-school-a'
const SCHOOL_B = 'did:plc:sess-school-b'
const HOST_A = 'a.test'
const HOST_B = 'b.test'
/** Names no school in `fs_school_domain`: this is the apex, where the session decides. */
const APEX = 'apex.test'

const MEMBER = 'did:plc:sess-mira'

/**
 * The session layer, mounted the way `http/app.ts` mounts it, plus one door. The two real
 * doors (`GET /api/auth/verify` and `GET /oauth/callback`) both funnel into
 * `createSession` and nothing else about them is this suite's subject; `/oauth/callback`'s
 * own school resolution has a suite of its own (`oauth-state-host.test.ts`).
 */
function testApp() {
  const app = new Hono<AppEnv>()
  app.use('*', withViewer)
  app.use('*', withSchool)
  app.get('/test/sign-in', async (c) => {
    await createSession(c, c.req.query('did') ?? '', 'custodial')
    return c.json({ ok: true })
  })
  /** What `currentSchool(c)` would answer for this request. */
  app.get('/test/school', (c) => c.json({ did: optionalSchool(c)?.did ?? null }))
  app.route('/api/auth', auth)
  return app
}

/** The `fs_session=` pair out of a Set-Cookie header, ready to send back. */
function cookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? ''
  return raw.split(';')[0] ?? ''
}

async function currentSchoolDidOf(cookie: string): Promise<string | null> {
  const id = cookie.slice(cookie.indexOf('=') + 1).split('.')[0] ?? ''
  const rows = await testDb()
    .select({ did: session.currentSchoolDid })
    .from(session)
    .where(eq(session.id, decodeURIComponent(id)))
    .limit(1)
  return rows[0]?.did ?? null
}

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
  await truncate(
    'fs_school',
    'fs_school_domain',
    'fs_membership',
    'fs_member',
    'fs_member_prefs',
    'fs_session',
    'fs_policy_cache',
    'fs_custodial_account',
    'fs_invite',
  )
  resetSchoolContextCache()

  const db = testDb()
  await db.insert(school).values([
    { did: SCHOOL_A, label: 'aye', name: 'Aye Free School', handle: HOST_A },
    { did: SCHOOL_B, label: 'bee', name: 'Bee Free School', handle: HOST_B },
  ])
  await db.insert(schoolDomain).values([
    { host: HOST_A, schoolDid: SCHOOL_A, kind: 'canonical' },
    { host: HOST_B, schoolDid: SCHOOL_B, kind: 'canonical' },
  ])
  // Non-null `policy_uri` on purpose: `currentPolicyUri` refreshes when it is null, and a
  // refresh would write the defaults back over this.
  await db.insert(policyCache).values(
    [SCHOOL_A, SCHOOL_B].map((did) => ({
      schoolDid: did,
      policyUri: `at://${did}/freeschool.draft.policy/p1`,
      thresholds: { memberRequires: 'open' },
    })),
  )
  await db
    .insert(custodialAccount)
    .values({ did: MEMBER, handle: 'mira.test', email: 'mira@example.org', keyVersion: 'v1' })
})

describe('the school on the session', () => {
  it('records the school the request resolved, and joins it', async () => {
    if (!available) return
    const app = testApp()
    const res = await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`)
    expect(res.status).toBe(200)

    const cookie = cookieFrom(res)
    expect(await currentSchoolDidOf(cookie)).toBe(SCHOOL_A)

    // Signing in on a school's host IS joining it (MS §4) — `GET /me` is where that shows.
    const me = await app.request(`http://${HOST_A}/api/auth/me`, { headers: { cookie } })
    expect((await me.json()).schools).toEqual([
      { did: SCHOOL_A, label: 'aye', name: 'Aye Free School', host: HOST_A },
    ])
  })

  it('is what answers on the apex, which serves no school of its own', async () => {
    if (!available) return
    const app = testApp()
    const cookie = cookieFrom(await app.request(`http://${HOST_B}/test/sign-in?did=${MEMBER}`))

    const here = await app.request(`http://${APEX}/test/school`, { headers: { cookie } })
    expect((await here.json()).did).toBe(SCHOOL_B)
  })

  it('never outranks the host: a session that says B is still in A on A’s host', async () => {
    if (!available) return
    const app = testApp()
    const cookie = cookieFrom(await app.request(`http://${HOST_B}/test/sign-in?did=${MEMBER}`))

    const here = await app.request(`http://${HOST_A}/test/school`, { headers: { cookie } })
    expect((await here.json()).did).toBe(SCHOOL_A)
  })

  it('sets a host-only cookie unless SESSION_COOKIE_DOMAIN says otherwise', async () => {
    if (!available) return
    // The default is empty, which is what every single-school deployment and every test
    // has today. Production widens it to `.freeskool.xyz` so one sign-in is one identity
    // across every city; the value is read in `http/session.ts#cookieDomain`.
    expect(config().sessionCookieDomain).toBe('')
    const res = await testApp().request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`)
    expect(res.headers.get('set-cookie')?.toLowerCase()).not.toContain('domain=')
  })

  it('names the host’s school on GET /api/auth/me', async () => {
    if (!available) return
    const app = testApp()
    const cookie = cookieFrom(await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`))
    const body = await (await app.request(`http://${HOST_A}/api/auth/me`, { headers: { cookie } })).json()
    expect(body.school).toEqual({ did: SCHOOL_A, label: 'aye', name: 'Aye Free School' })
  })
})

describe('POST /api/auth/switch-school', () => {
  it('refuses a school the member has not joined, and leaves the session where it was', async () => {
    if (!available) return
    const app = testApp()
    const cookie = cookieFrom(await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`))

    const res = await app.request(`http://${HOST_A}/api/auth/switch-school`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ schoolDid: SCHOOL_B }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('NotAMember')
    expect(await currentSchoolDidOf(cookie)).toBe(SCHOOL_A)
  })

  it('refuses a DID that is no school at all', async () => {
    if (!available) return
    const app = testApp()
    const cookie = cookieFrom(await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`))
    const res = await app.request(`http://${HOST_A}/api/auth/switch-school`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ schoolDid: 'did:plc:not-a-school' }),
    })
    expect(res.status).toBe(403)
  })

  it('moves the session, hands back the host to navigate to, and the apex follows', async () => {
    if (!available) return
    const app = testApp()
    const cookie = cookieFrom(await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`))
    await joinSchool(MEMBER, SCHOOL_B, 'custodial')

    const res = await app.request(`http://${HOST_A}/api/auth/switch-school`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ schoolDid: SCHOOL_B }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      school: { did: SCHOOL_B, label: 'bee', name: 'Bee Free School' },
      host: HOST_B,
      // No `SESSION_COOKIE_DOMAIN` here, so the cookie does not travel to B and the PWA
      // is told so — `session-cookie-domain.test.ts` has the other half.
      sessionSpansHosts: false,
    })
    expect(await currentSchoolDidOf(cookie)).toBe(SCHOOL_B)

    const apex = await app.request(`http://${APEX}/test/school`, { headers: { cookie } })
    expect((await apex.json()).did).toBe(SCHOOL_B)
  })

  it('needs a session', async () => {
    if (!available) return
    const res = await testApp().request(`http://${HOST_A}/api/auth/switch-school`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schoolDid: SCHOOL_B }),
    })
    expect(res.status).toBe(401)
  })

  it('lists every school the member belongs to, each with the host it is served from', async () => {
    if (!available) return
    const app = testApp()
    const cookie = cookieFrom(await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`))
    await joinSchool(MEMBER, SCHOOL_B, 'custodial')

    const body = await (await app.request(`http://${HOST_A}/api/auth/me`, { headers: { cookie } })).json()
    expect(body.schools).toEqual([
      { did: SCHOOL_A, label: 'aye', name: 'Aye Free School', host: HOST_A },
      { did: SCHOOL_B, label: 'bee', name: 'Bee Free School', host: HOST_B },
    ])
  })
})
