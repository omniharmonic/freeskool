process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'oauth-callback-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 11).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'oauth-callback-test-pepper'

/**
 * `GET /oauth/callback` must fire the Bluesky profile import right after `createSession`,
 * WITHOUT awaiting it on the request path — a slow or unreachable public.api.bsky.app must
 * never delay the redirect back into the PWA. This pins both: the call happens with
 * `overwrite: false`, and the callback still redirects even if the import rejects.
 */
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'

const OAUTH_DID = 'did:plc:oauth-callback-test'

const imported = vi.hoisted(() => ({ fn: vi.fn() }))
vi.mock('../src/lib/bsky-profile.js', () => ({ importBlueskyProfile: imported.fn }))
vi.mock('../src/http/oauth.js', async () => ({
  ...(await vi.importActual<typeof import('../src/http/oauth.js')>('../src/http/oauth.js')),
  oauthClient: async () => ({ callback: async () => ({ session: { did: OAUTH_DID } }) }),
}))

const { createApp } = await import('../src/http/app.js')

let available = false
beforeAll(async () => {
  available = await pgAvailable()
})
beforeEach(async () => {
  if (available) await truncate('fs_session', 'fs_member')
  imported.fn.mockReset()
})
afterAll(async () => {
  if (available) await closeTestDb()
})

it('imports the Bluesky profile (fire-and-forget, overwrite:false) and still redirects on success', async () => {
  if (!available) return console.warn(SKIP_MESSAGE)
  imported.fn.mockResolvedValue({ imported: true, fields: ['displayName'] })
  const app = createApp()
  const res = await app.request('/oauth/callback?state=x&code=y', { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toContain('signed-in=1')
  await vi.waitFor(() => expect(imported.fn).toHaveBeenCalledWith(OAUTH_DID, expect.objectContaining({ overwrite: false })))
})

it('still redirects to signed-in even when the import rejects (fire-and-forget)', async () => {
  if (!available) return console.warn(SKIP_MESSAGE)
  imported.fn.mockRejectedValue(new Error('bsky unreachable'))
  const app = createApp()
  const res = await app.request('/oauth/callback?state=x&code=y', { redirect: 'manual' })
  expect(res.status).toBe(302)
  expect(res.headers.get('location')).toContain('signed-in=1')
})
