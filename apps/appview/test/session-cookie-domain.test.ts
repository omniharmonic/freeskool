/**
 * THE COOKIE-DOMAIN CUTOVER (Task 4 report, concern 1; MS §3).
 *
 * `SESSION_COOKIE_DOMAIN` is empty until the day a second city exists. On that day every
 * browser already signed in is holding a HOST-ONLY `fs_session`, and nothing in a
 * `Cookie:` header says so — the browser keeps sending it, the app keeps honouring it,
 * and the member never gains the wider scope. The switcher then moves their session to
 * Denver and drops them on `denver.freeskool.xyz` signed out.
 *
 * Two answers, both pinned here:
 *
 *   1. `readViewer` MIGRATES on first sight — re-issues the same name with `Domain`,
 *      deletes the host-only one (a deletion is scoped too), marks the browser so it
 *      happens once, and never interrupts the session while doing it. That is why the
 *      cutover needs no forced sign-out.
 *   2. `POST /api/auth/switch-school` reports whether the cookie actually reaches the
 *      target host, so the PWA can explain itself when it does not.
 */
process.env.MULTI_SCHOOL = '1'
process.env.SESSION_COOKIE_DOMAIN = '.freeskool.test'
process.env.SCHOOL_DID = 'did:plc:cookie-legacy'
process.env.SCHOOL_HANDLE = 'legacy.test'
process.env.WEB_PUBLIC_URL ??= 'https://freeskool.test'
process.env.APPVIEW_PUBLIC_URL ??= 'https://freeskool.test'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'cookie-domain-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 43).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'cookie-domain-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/pds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pds.js')>()),
  getRecord: async () => null,
}))

import { Hono } from 'hono'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { config } from '../src/config.js'
import { auth } from '../src/http/routes/auth.js'
import { createSession, sessionSpansHost, withViewer, type AppEnv } from '../src/http/session.js'
import { resetSchoolContextCache, withSchool } from '../src/http/school-context.js'
import { joinSchool } from '../src/lib/membership.js'
import { custodialAccount, policyCache, school, schoolDomain } from '../src/db/schema.js'

const SCHOOL_A = 'did:plc:cookie-school-a'
const SCHOOL_B = 'did:plc:cookie-school-b'
const HOST_A = 'a.freeskool.test'
const HOST_B = 'b.freeskool.test'
const MEMBER = 'did:plc:cookie-mira'

function testApp() {
  const app = new Hono<AppEnv>()
  app.use('*', withViewer)
  app.use('*', withSchool)
  app.get('/test/sign-in', async (c) => {
    await createSession(c, c.req.query('did') ?? '', 'custodial')
    return c.json({ ok: true })
  })
  app.get('/test/who', (c) => c.json({ did: c.var.viewer?.did ?? null }))
  app.route('/api/auth', auth)
  return app
}

/** Every `Set-Cookie` on a response, as sent. */
function cookiesOf(res: Response): string[] {
  return res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? '']
}

/** The `name=value` pair of the named cookie, ready to send back in a `Cookie:` header. */
function pairFor(res: Response, name: string): string {
  const header = cookiesOf(res).find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`))
  return header?.split(';')[0] ?? ''
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

describe('a session cookie that spans every city', () => {
  it('writes the Domain, and a marker on the same scope, at sign-in', async () => {
    if (!available) return
    const res = await testApp().request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`)
    const cookies = cookiesOf(res)

    const session = cookies.find((c) => c.startsWith(`${config().SESSION_COOKIE}=`))!
    expect(session.toLowerCase()).toContain('domain=.freeskool.test')
    expect(cookies.some((c) => c.startsWith(`${config().SESSION_COOKIE}_d=1`))).toBe(true)
  })

  /**
   * THE CUTOVER ITSELF. This request is exactly what a browser signed in before the
   * config change sends: the session cookie and nothing else. It must stay signed in.
   */
  it('migrates a legacy host-only cookie on first sight, without signing anybody out', async () => {
    if (!available) return
    const app = testApp()
    const signIn = await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`)
    const legacy = pairFor(signIn, config().SESSION_COOKIE)

    // The browser from before the cutover: no marker, so the server cannot know the
    // cookie it is holding is host-only — and does not need to.
    const res = await app.request(`http://${HOST_A}/test/who`, { headers: { cookie: legacy } })
    expect((await res.json()).did).toBe(MEMBER)

    const cookies = cookiesOf(res)
    const reissued = cookies.find((c) => c.startsWith(`${legacy};`) || c.startsWith(`${legacy} ;`))
    expect(reissued, `re-issued the same value with a Domain: ${cookies.join(' | ')}`).toBeTruthy()
    expect(reissued!.toLowerCase()).toContain('domain=.freeskool.test')

    // …and the host-only one is expired. A deletion carries no Domain, which is the ONLY
    // way to remove a host-only cookie; without it the browser keeps both and RFC 6265
    // ordering hands the narrow one back forever.
    const deletion = cookies.find((c) => c.startsWith(`${config().SESSION_COOKIE}=;`))
    expect(deletion, `deleted the host-only cookie: ${cookies.join(' | ')}`).toBeTruthy()
    expect(deletion!.toLowerCase()).not.toContain('domain=')

    expect(cookies.some((c) => c.startsWith(`${config().SESSION_COOKIE}_d=1`))).toBe(true)
  })

  it('does it once: a browser carrying the marker is left alone', async () => {
    if (!available) return
    const app = testApp()
    const signIn = await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`)
    const cookie = `${pairFor(signIn, config().SESSION_COOKIE)}; ${pairFor(signIn, `${config().SESSION_COOKIE}_d`)}`

    const res = await app.request(`http://${HOST_A}/test/who`, { headers: { cookie } })
    expect((await res.json()).did).toBe(MEMBER)
    expect(cookiesOf(res).filter(Boolean)).toEqual([])
  })

  it('never re-issues a cookie that names no live session', async () => {
    if (!available) return
    const res = await testApp().request(`http://${HOST_A}/test/who`, {
      headers: { cookie: `${config().SESSION_COOKIE}=not-a-real-session.nope` },
    })
    expect((await res.json()).did).toBeNull()
    expect(cookiesOf(res).filter(Boolean)).toEqual([])
  })

  it('ends both scopes on sign-out', async () => {
    if (!available) return
    const app = testApp()
    const signIn = await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`)
    const cookie = `${pairFor(signIn, config().SESSION_COOKIE)}; ${pairFor(signIn, `${config().SESSION_COOKIE}_d`)}`

    const res = await app.request(`http://${HOST_A}/api/auth/logout`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(200)
    const deletions = cookiesOf(res).filter((c) => c.startsWith(`${config().SESSION_COOKIE}=;`))
    expect(deletions).toHaveLength(2)
    expect(deletions.some((c) => c.toLowerCase().includes('domain=.freeskool.test'))).toBe(true)
    expect(deletions.some((c) => !c.toLowerCase().includes('domain='))).toBe(true)
  })
})

describe('switch-school says whether the session travels', () => {
  it('true for a host under the cookie domain', async () => {
    if (!available) return
    const app = testApp()
    const signIn = await app.request(`http://${HOST_A}/test/sign-in?did=${MEMBER}`)
    const cookie = `${pairFor(signIn, config().SESSION_COOKIE)}; ${pairFor(signIn, `${config().SESSION_COOKIE}_d`)}`
    await joinSchool(MEMBER, SCHOOL_B, 'custodial')

    const res = await app.request(`http://${HOST_A}/api/auth/switch-school`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ schoolDid: SCHOOL_B }),
    })
    expect(await res.json()).toMatchObject({ host: HOST_B, sessionSpansHosts: true })
  })

  it('knows a host that is merely similar is not under the domain', () => {
    expect(sessionSpansHost('b.freeskool.test')).toBe(true)
    expect(sessionSpansHost('freeskool.test')).toBe(true)
    expect(sessionSpansHost('B.FREESKOOL.TEST:443')).toBe(true)
    // `notfreeskool.test` ends with the same letters and is a different registrable name.
    expect(sessionSpansHost('notfreeskool.test')).toBe(false)
    expect(sessionSpansHost('freeskool.test.evil.example')).toBe(false)
    expect(sessionSpansHost('')).toBe(false)
  })
})
