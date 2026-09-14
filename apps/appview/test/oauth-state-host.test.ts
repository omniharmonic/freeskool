/**
 * THE OAUTH DANCE HAPPENS ON ONE ORIGIN, AND HAS TO COME BACK TO THE RIGHT CITY.
 *
 * A confidential client's `client_id` IS its metadata URL and its `redirect_uri` sits on
 * the same origin, so there is exactly one OAuth client for the whole network and the
 * callback always lands on the apex (MS §3). The callback therefore cannot learn the
 * member's school from its own Host header. It learns it from the OAuth `state`, which
 * `GET /api/auth/oauth/start` filled in with the host the member pressed the button on.
 *
 * What this suite pins:
 *   - the start route puts the requesting host into the state;
 *   - the callback opens the session for THAT school, not for the apex it is standing on;
 *   - it redirects back to that school's host;
 *   - a state naming a host this deployment does not serve lands on the apex, because a
 *     redirect target that is not checked against `fs_school_domain` is an open redirect
 *     on the very response that sets the session cookie.
 */
process.env.MULTI_SCHOOL = '1'
process.env.SCHOOL_DID = 'did:plc:oauth-host-legacy'
process.env.SCHOOL_HANDLE = 'legacy.test'
process.env.WEB_PUBLIC_URL = 'https://apex.test'
process.env.APPVIEW_PUBLIC_URL = 'https://apex.test'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'oauth-state-host-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 43).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'oauth-state-host-pepper'

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'

const MEMBER = 'did:plc:oauth-host-mira'
const SCHOOL_DENVER = 'did:plc:oauth-host-denver'
const HOST_DENVER = 'denver.test'
/**
 * A second school, so the apex resolves to NO school. With one school on the deployment
 * `resolveSchool` deliberately falls back to it (Task 3: a deployment that flipped the
 * flag before it had a second city), and every assertion here about "not Denver" would
 * pass or fail for that reason rather than for the state's.
 */
const SCHOOL_BOULDER = 'did:plc:oauth-host-boulder'
const HOST_BOULDER = 'boulder.test'

/** What the last `authorize()` was asked to carry, and what the next `callback()` returns. */
const dance = vi.hoisted(() => ({
  authorizeOptions: undefined as Record<string, unknown> | undefined,
  callbackState: null as string | null,
}))

vi.mock('../src/lib/bsky-profile.js', () => ({ importBlueskyProfile: async () => ({ imported: false }) }))
vi.mock('../src/http/oauth.js', async (importOriginal) => ({
  // The origin helpers under test are the REAL ones; only the network-facing client is faked.
  ...(await importOriginal<typeof import('../src/http/oauth.js')>()),
  oauthClient: async () => ({
    authorize: async (_handle: string, options: Record<string, unknown>) => {
      dance.authorizeOptions = options
      return new URL('https://pds.test/authorize?request_uri=x')
    },
    callback: async () => ({ session: { did: MEMBER }, state: dance.callbackState }),
  }),
}))

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createApp } from '../src/http/app.js'
import { resetSchoolContextCache } from '../src/http/school-context.js'
import { school, schoolDomain, session } from '../src/db/schema.js'

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
  await truncate('fs_school', 'fs_school_domain', 'fs_membership', 'fs_member', 'fs_session')
  resetSchoolContextCache()
  dance.authorizeOptions = undefined
  dance.callbackState = null
  await testDb()
    .insert(school)
    .values([
      { did: SCHOOL_DENVER, label: 'denver', name: 'Denver Free School', handle: HOST_DENVER },
      { did: SCHOOL_BOULDER, label: 'boulder', name: 'Boulder Free School', handle: HOST_BOULDER },
    ])
  await testDb()
    .insert(schoolDomain)
    .values([
      { host: HOST_DENVER, schoolDid: SCHOOL_DENVER, kind: 'canonical' },
      { host: HOST_BOULDER, schoolDid: SCHOOL_BOULDER, kind: 'canonical' },
    ])
})

/** The `current_school_did` of the one session this suite ever creates. */
async function sessionSchool(): Promise<string | null> {
  const rows = await testDb().select({ did: session.currentSchoolDid }).from(session).where(eq(session.did, MEMBER))
  return rows[0]?.did ?? null
}

it('carries the requesting host in the OAuth state', async () => {
  if (!available) return
  const res = await createApp().request(
    `http://${HOST_DENVER}/api/auth/oauth/start?confirm=1&handle=someone.bsky.social`,
    { redirect: 'manual' },
  )
  expect(res.status).toBe(302)
  expect(dance.authorizeOptions?.state).toBe(HOST_DENVER)
})

it('opens the session for the school in the state and sends the member back to its host', async () => {
  if (!available) return
  dance.callbackState = HOST_DENVER
  // The callback is reached on the APEX, always: it is the one registered redirect_uri.
  const res = await createApp().request('https://apex.test/oauth/callback?state=s&code=c', { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe(`https://${HOST_DENVER}/?signed-in=1`)
  expect(await sessionSchool()).toBe(SCHOOL_DENVER)
})

it('lands on the apex when the state names a host this deployment does not serve', async () => {
  if (!available) return
  dance.callbackState = 'evil.example'
  const res = await createApp().request('https://apex.test/oauth/callback?state=s&code=c', { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toBe('https://apex.test/?signed-in=1')
  // Not Denver, and not `evil.example` either: an unvouched host is simply not a school.
  expect(await sessionSchool()).not.toBe(SCHOOL_DENVER)
})

it('lands on the apex when there is no state at all', async () => {
  if (!available) return
  dance.callbackState = null
  const res = await createApp().request('https://apex.test/oauth/callback?state=s&code=c', { redirect: 'manual' })
  expect(res.headers.get('location')).toBe('https://apex.test/?signed-in=1')
})

it('never reflects a state that is not a bare hostname', async () => {
  if (!available) return
  for (const hostile of ['https://evil.example/', `${HOST_DENVER}/../evil`, `evil.example#${HOST_DENVER}`, '']) {
    dance.callbackState = hostile
    const res = await createApp().request('https://apex.test/oauth/callback?state=s&code=c', { redirect: 'manual' })
    expect(res.headers.get('location')).toBe('https://apex.test/?signed-in=1')
  }
})
