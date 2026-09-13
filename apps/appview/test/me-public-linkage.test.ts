process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'me-public-linkage-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'me-public-linkage-test-pepper'

/**
 * Task 7's second half: `PUT /api/me` used to hard-refuse (403 `PublicTogglesLocked`) an
 * OAuth-door viewer setting `publicListing: true` at all. It now asks for an explicit
 * `confirmPublicLinkage: true` instead (400 `PublicLinkageConfirmRequired` without it) —
 * and `POST /api/me/import-bsky-profile` is the on-demand re-import a member can trigger
 * themselves, independent of the one fired at sign-in.
 */
import type { Context } from 'hono'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'

const OAUTH_DID = 'did:plc:oauth-linkage-test'

const imported = vi.hoisted(() => ({
  fn: vi.fn().mockResolvedValue({ imported: true, fields: ['displayName'] }),
}))
vi.mock('../src/lib/bsky-profile.js', () => ({ importBlueskyProfile: imported.fn }))

const { createApp } = await import('../src/http/app.js')

let available = false
beforeAll(async () => {
  available = await pgAvailable()
})
beforeEach(async () => {
  if (available) await truncate('fs_app_meta', 'fs_session', 'fs_member')
  imported.fn.mockClear()
})
afterAll(async () => {
  if (available) await closeTestDb()
})

async function oauthCookie() {
  const id = await createSession({ header: () => {} } as unknown as Context, OAUTH_DID, 'oauth')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

it('refuses an OAuth-door publicListing:true without confirmPublicLinkage', async () => {
  if (!available) return console.warn(SKIP_MESSAGE)
  const app = createApp()
  const headers = { Cookie: await oauthCookie(), 'Content-Type': 'application/json' }
  const res = await app.request('/api/me', { method: 'PUT', headers, body: JSON.stringify({ publicListing: true }) })
  expect(res.status).toBe(400)
  const body = await res.json()
  expect(body.error).toBe('PublicLinkageConfirmRequired')
})

it('accepts an OAuth-door publicListing:true once confirmPublicLinkage is sent', async () => {
  if (!available) return console.warn(SKIP_MESSAGE)
  const app = createApp()
  const headers = { Cookie: await oauthCookie(), 'Content-Type': 'application/json' }
  const res = await app.request('/api/me', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ publicListing: true, confirmPublicLinkage: true }),
  })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.profile.publicListing).toBe(true)
})

it('does not require confirmPublicLinkage when publicListing is not being set', async () => {
  if (!available) return console.warn(SKIP_MESSAGE)
  const app = createApp()
  const headers = { Cookie: await oauthCookie(), 'Content-Type': 'application/json' }
  const res = await app.request('/api/me', { method: 'PUT', headers, body: JSON.stringify({ bio: 'Just a bio update' }) })
  expect(res.status).toBe(200)
})

it('POST /api/me/import-bsky-profile calls importBlueskyProfile with overwrite:true for the viewer and returns its result', async () => {
  if (!available) return console.warn(SKIP_MESSAGE)
  const app = createApp()
  const headers = { Cookie: await oauthCookie() }
  const res = await app.request('/api/me/import-bsky-profile', { method: 'POST', headers })
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body).toEqual({ imported: true, fields: ['displayName'] })
  expect(imported.fn).toHaveBeenCalledWith(OAUTH_DID, expect.objectContaining({ overwrite: true }))
})

it('POST /api/me/import-bsky-profile requires a session', async () => {
  if (!available) return console.warn(SKIP_MESSAGE)
  const app = createApp()
  const res = await app.request('/api/me/import-bsky-profile', { method: 'POST' })
  expect(res.status).toBe(401)
})
