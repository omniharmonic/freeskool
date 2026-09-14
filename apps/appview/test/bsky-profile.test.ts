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

  it('skips an avatar URL that does not point at a Bluesky CDN host, but keeps text fields', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    let avatarFetched = false
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/xrpc/app.bsky.actor.getProfile')) {
        return new Response(
          JSON.stringify({ ...fixture, avatar: 'https://evil.example.com/steal-a-credential.png' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      avatarFetched = true
      throw new Error(`should never fetch a disallowed avatar host: ${url}`)
    }) as typeof fetch

    const result = await importBlueskyProfile(DID, { overwrite: false, fetchImpl })
    expect(avatarFetched).toBe(false)
    expect(result.imported).toBe(true)
    expect(result.fields.sort()).toEqual(['bio', 'displayName'])
    const profile = await loadProfile(DID)
    expect(profile.avatar).toBeUndefined()
  })

  it('rejects an avatar whose declared content-length exceeds the 5 MB cap, without reading the body', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    const fetchImpl = fetchImplWith()
    const gated = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.startsWith('https://cdn.bsky.app/')) {
        return new Response(Buffer.from(PNG_BASE64, 'base64'), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(6 * 1024 * 1024) },
        })
      }
      return fetchImpl(input)
    }) as typeof fetch

    const result = await importBlueskyProfile(DID, { overwrite: false, fetchImpl: gated })
    expect(result.fields).not.toContain('avatar')
    const profile = await loadProfile(DID)
    expect(profile.avatar).toBeUndefined()
  })

  it('aborts reading an avatar body that exceeds 5 MB even with no content-length header', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 10, 1)
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/xrpc/app.bsky.actor.getProfile')) {
        return new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (url.startsWith('https://cdn.bsky.app/')) {
        // Deliberately no content-length header — the streamed cap is the only guard.
        return new Response(oversized, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch

    const result = await importBlueskyProfile(DID, { overwrite: false, fetchImpl })
    expect(result.fields).not.toContain('avatar')
    const profile = await loadProfile(DID)
    expect(profile.avatar).toBeUndefined()
  })
})

describe('importBlueskyProfile races a concurrent PUT /api/me', () => {
  /** Mirrors `me.ts`'s `PUT /` upsert exactly, standing in for a concurrent member edit. */
  async function writeProfileLikePutApiMe(value: Record<string, unknown>): Promise<void> {
    const now = new Date()
    await testDb()
      .insert(appMeta)
      .values({ key: PROFILE_KEY(DID), value, updatedAt: now })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: now } })
  }

  function deferredGateFetch(body: unknown) {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/xrpc/app.bsky.actor.getProfile')) {
        await gate
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected fetch in test: ${url}`)
    }) as typeof fetch
    return { fetchImpl, release }
  }

  it('overwrite:false — a PUT that lands while the fetch is in flight wins; the import writes nothing', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    const { fetchImpl, release } = deferredGateFetch({ handle: 'race.test', displayName: 'From Bluesky' })

    const importPromise = importBlueskyProfile(DID, { overwrite: false, fetchImpl })
    // The import's network call is now blocked on `gate`. Simulate the member's own
    // `PUT /api/me` landing in that exact window.
    await writeProfileLikePutApiMe({ bio: 'Member edited this while the import was in flight' })
    release()
    const result = await importPromise

    expect(result).toEqual({ imported: false, fields: [] })
    const profile = await loadProfile(DID)
    expect(profile).toEqual({ bio: 'Member edited this while the import was in flight' })
  })

  it('overwrite:true — a PUT that lands while the fetch is in flight is preserved; only the resolved fields merge in', async () => {
    if (!available) return console.warn(SKIP_MESSAGE)
    const { fetchImpl, release } = deferredGateFetch({ handle: 'race.test', displayName: 'From Bluesky' })

    const importPromise = importBlueskyProfile(DID, { overwrite: true, fetchImpl })
    await writeProfileLikePutApiMe({ bio: 'Member edited this while the import was in flight' })
    release()
    const result = await importPromise

    expect(result.imported).toBe(true)
    expect(result.fields).toEqual(['displayName'])
    const profile = await loadProfile(DID)
    // The import's own field (displayName) landed, AND the concurrent edit (bio) survived
    // — proving the merge happened against the row's live value, not a stale in-process copy.
    expect(profile.displayName).toBe('From Bluesky')
    expect(profile.bio).toBe('Member edited this while the import was in flight')
  })
})
