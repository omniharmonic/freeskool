process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'bsky-profile-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 7).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'bsky-profile-test-pepper'

/**
 * Task 7: importing a Bluesky profile app-side on sign-in (and on demand). `fetchBskyProfile`
 * is a pure network call against the public, unauthenticated `getProfile` endpoint;
 * `importBlueskyProfile` is the DB-touching half — it must never clobber a profile the
 * member has already touched unless explicitly told to (`overwrite: true`), and it must
 * fail closed (never throw, never partially write) when the network is unavailable.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { appMeta } from '../src/db/schema.js'
import fixture from '../src/lib/__fixtures__/bsky-profile.json' with { type: 'json' }
import { fetchBskyProfile, importBlueskyProfile } from '../src/lib/bsky-profile.js'
import { loadProfile, PROFILE_KEY } from '../src/http/routes/me.js'

const DID = 'did:plc:member-under-test'
// A 1x1 transparent PNG — the same fixture image used by apps/web/e2e/mvp.spec.ts.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAoElEQVRoge2SQQkAQRDDaikyKmL92zgR9wgDhQhIQ8PraaIbsAHVK7IL9S7RDdiA6hXZhXqX6AZsQPWK7EK9S3QDNqB6RXah3iW6ARtQvSK7UO8S3YANqF6RXah3iW7ABlSvyC7Uu0Q3YAOqV2QX6l2iG7AB1SuyC/Uu0Q3YgOoV2YV6l+gGbED1iuxCvUt0AzagekV2od4lugEbUL3iHz6v8XDEtGAjnQAAAABJRU5ErkJggg=='

function fetchImplWith(opts: { profileStatus?: number; avatarStatus?: number; avatarContentType?: string } = {}) {
  const { profileStatus = 200, avatarStatus = 200, avatarContentType = 'image/png' } = opts
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/xrpc/app.bsky.actor.getProfile')) {
      if (profileStatus !== 200) return new Response(null, { status: profileStatus })
      return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url.startsWith('https://cdn.bsky.app/')) {
      if (avatarStatus !== 200) return new Response(null, { status: avatarStatus })
      return new Response(Buffer.from(PNG_BASE64, 'base64'), { status: 200, headers: { 'content-type': avatarContentType } })
    }
    throw new Error(`unexpected fetch in test: ${url}`)
  }) as typeof fetch
}

const throwingFetch = (async () => {
  throw new Error('simulated network failure')
}) as typeof fetch

let available = false
beforeAll(async () => {
  available = await pgAvailable()
})
beforeEach(async () => {
  if (available) await truncate('fs_app_meta')
})
afterAll(async () => {
  if (available) await closeTestDb()
})

describe('fetchBskyProfile', () => {
  it('returns the profile fields from a successful getProfile response', async () => {
    const profile = await fetchBskyProfile(DID, fetchImplWith())
    expect(profile).toEqual({
      handle: fixture.handle,
      displayName: fixture.displayName,
      description: fixture.description,
      avatar: fixture.avatar,
    })
  })

  it('returns null on a non-ok HTTP response', async () => {
    expect(await fetchBskyProfile(DID, fetchImplWith({ profileStatus: 404 }))).toBeNull()
  })

  it('returns null when the fetch throws (network failure)', async () => {
    expect(await fetchBskyProfile(DID, throwingFetch)).toBeNull()
  })
})

describe('importBlueskyProfile', () => {
  it('imports displayName, bio and avatar from the fixture into a fresh profile', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    const result = await importBlueskyProfile(DID, { overwrite: false, fetchImpl: fetchImplWith() })
    expect(result.imported).toBe(true)
    expect([...result.fields].sort()).toEqual(['avatar', 'bio', 'displayName'])

    const profile = await loadProfile(DID)
    expect(profile.displayName).toBe(fixture.displayName)
    expect(profile.bio).toBe(fixture.description)
    expect(profile.avatar?.data).toBeTruthy()
    // publicListing is never touched by an import — that stays an explicit, separate choice.
    expect(profile.publicListing).toBeUndefined()

    const cached = await testDb().select().from(appMeta).where(eq(appMeta.key, `handle:${DID}`)).limit(1)
    const cachedValue = cached[0]?.value as { handle?: string; resolvedAt?: string } | undefined
    expect(cachedValue?.handle).toBe(fixture.handle)
    expect(typeof cachedValue?.resolvedAt).toBe('string')
  })

  it('does not overwrite an existing member-managed profile when overwrite is false', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    await testDb()
      .insert(appMeta)
      .values({ key: PROFILE_KEY(DID), value: { bio: 'Written by the member' }, updatedAt: new Date() })
    const result = await importBlueskyProfile(DID, { overwrite: false, fetchImpl: fetchImplWith() })
    expect(result).toEqual({ imported: false, fields: [] })

    const profile = await loadProfile(DID)
    expect(profile.bio).toBe('Written by the member')
    expect(profile.displayName).toBeUndefined()
  })

  it('does overwrite an existing profile when overwrite is true (on-demand re-import)', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    await testDb()
      .insert(appMeta)
      .values({ key: PROFILE_KEY(DID), value: { bio: 'Stale bio', displayName: 'Stale name' }, updatedAt: new Date() })
    const result = await importBlueskyProfile(DID, { overwrite: true, fetchImpl: fetchImplWith() })
    expect(result.imported).toBe(true)

    const profile = await loadProfile(DID)
    expect(profile.bio).toBe(fixture.description)
    expect(profile.displayName).toBe(fixture.displayName)
  })

  it('returns { imported: false } and writes nothing when the network fails', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    const result = await importBlueskyProfile(DID, { overwrite: false, fetchImpl: throwingFetch })
    expect(result).toEqual({ imported: false, fields: [] })

    const profile = await loadProfile(DID)
    expect(profile).toEqual({})
    const cached = await testDb().select().from(appMeta).where(eq(appMeta.key, `handle:${DID}`)).limit(1)
    expect(cached).toHaveLength(0)
  })

  it('skips an avatar whose content-type is not an accepted image format, but keeps text fields', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    const result = await importBlueskyProfile(DID, {
      overwrite: false,
      fetchImpl: fetchImplWith({ avatarContentType: 'image/gif' }),
    })
    expect(result.imported).toBe(true)
    expect(result.fields).not.toContain('avatar')
    expect(result.fields.sort()).toEqual(['bio', 'displayName'])
    const profile = await loadProfile(DID)
    expect(profile.avatar).toBeUndefined()
  })
})
