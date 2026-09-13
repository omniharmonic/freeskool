/**
 * Bluesky profile import (Task 7).
 *
 * The secondary sign-in door brings an existing Bluesky account into Free School with an
 * OAuth grant and nothing else: no display name, no bio, no avatar, no way to tell the
 * member's session apart from a stranger's in the UI. This fetches the account's already-
 * public profile (`app.bsky.actor.getProfile` on the public, unauthenticated AppView — no
 * session, no scope, nothing this member has not already made public themselves by having
 * a Bluesky account) and stores the app-side subset `PUT /api/me` already understands
 * (`displayName`, `bio`, `avatar`), the same way that endpoint would.
 *
 * Two call sites (`http/routes/oauth.ts`'s `/oauth/callback`, `overwrite: false`; and
 * `http/routes/me.ts`'s `POST /import-bsky-profile`, `overwrite: true`) share this one
 * function so "what counts as an import" is decided in exactly one place.
 *
 * Deliberately never writes `publicListing`: importing a profile is not the same as
 * opting into a PUBLIC one — that stays the separate, explicit `confirmPublicLinkage`
 * choice in `../http/routes/me.ts`.
 *
 * FAILS CLOSED AND SILENT: any network problem (timeout, DNS, 4xx/5xx, malformed body)
 * returns `null`/`{ imported: false, fields: [] }` rather than throwing. The sign-in
 * callback calls this without awaiting it specifically so a slow or unreachable
 * public.api.bsky.app can never delay getting the member into the app.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { appMeta } from '../db/schema.js'
import { normalizeImage } from './images.js'
import { loadProfile, PROFILE_KEY, type Profile } from '../http/routes/me.js'
import { log } from './logging.js'

export interface BskyProfile {
  handle: string
  displayName?: string
  description?: string
  avatar?: string // url
}

const BSKY_PUBLIC_API = 'https://public.api.bsky.app'
const MAX_AVATAR_BYTES = 5 * 1024 * 1024
const ACCEPTED_AVATAR_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

/**
 * One unauthenticated read against the public Bluesky AppView. Never throws: a timeout
 * (`AbortSignal.timeout`), a non-2xx response, or a body that does not even have a
 * `handle` string all come back as `null`, indistinguishable from "no profile to import".
 */
export async function fetchBskyProfile(did: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<BskyProfile | null> {
  try {
    const res = await fetchImpl(`${BSKY_PUBLIC_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = (await res.json()) as Record<string, unknown>
    if (typeof body.handle !== 'string' || !body.handle) return null
    return {
      handle: body.handle,
      ...(typeof body.displayName === 'string' && body.displayName ? { displayName: body.displayName } : {}),
      ...(typeof body.description === 'string' && body.description ? { description: body.description } : {}),
      ...(typeof body.avatar === 'string' && body.avatar ? { avatar: body.avatar } : {}),
    }
  } catch {
    return null
  }
}

const HANDLE_KEY = (did: string) => `handle:${did}`

/**
 * Best-effort handle cache `../http/routes/me.ts`'s `handlesForDids` already reads (its
 * last-resort fallback). Shape matches what that function expects: `{ handle, resolvedAt }`,
 * not a bare string.
 */
async function cacheHandle(did: string, handle: string): Promise<void> {
  const value = { handle, resolvedAt: new Date().toISOString() }
  await getDb()
    .insert(appMeta)
    .values({ key: HANDLE_KEY(did), value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } })
}

/**
 * Downloads one avatar (max 5 MB, `image/*`) and re-encodes it through `normalizeImage`
 * (WebP, metadata stripped — R9). Returns `undefined` — never throws — for anything that
 * is not a small, recognizable image: a stale CDN URL is not worth failing the whole
 * import over.
 */
async function downloadAvatar(url: string, fetchImpl: typeof fetch): Promise<Profile['avatar'] | undefined> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return undefined
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!ACCEPTED_AVATAR_TYPES.has(mime)) return undefined
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0 || buf.byteLength > MAX_AVATAR_BYTES) return undefined
    return await normalizeImage({ data: `data:${mime};base64,${buf.toString('base64')}`, alt: '' }, true)
  } catch {
    return undefined
  }
}

/**
 * Fetches the public Bluesky profile and stores its app-side subset.
 *
 * `overwrite: false` (the sign-in call site) leaves an existing, member-managed profile
 * alone entirely — an import is a courtesy default, never something that clobbers what a
 * member already typed in, so "any field already set" is enough to skip. `overwrite: true`
 * (the on-demand `POST /api/me/import-bsky-profile`) is a member deliberately asking to
 * re-pull their Bluesky profile, so it always writes whatever Bluesky returns.
 *
 * The handle cache is written whenever the profile fetch itself succeeds, regardless of
 * the overwrite decision — it is a separate, harmless lookup aid, not part of the profile
 * a member controls.
 */
export async function importBlueskyProfile(
  did: string,
  opts: { overwrite: boolean; fetchImpl?: typeof fetch },
): Promise<{ imported: boolean; fields: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const bsky = await fetchBskyProfile(did, fetchImpl)
  if (!bsky) return { imported: false, fields: [] }

  await cacheHandle(did, bsky.handle).catch(() => log.warn('bsky handle cache write failed'))

  const existing = await loadProfile(did)
  if (!opts.overwrite && Object.keys(existing).length > 0) return { imported: false, fields: [] }

  const fields: string[] = []
  const updates: Partial<Profile> = {}
  if (bsky.displayName) {
    updates.displayName = bsky.displayName
    fields.push('displayName')
  }
  if (bsky.description) {
    updates.bio = bsky.description
    fields.push('bio')
  }
  if (bsky.avatar) {
    const avatar = await downloadAvatar(bsky.avatar, fetchImpl)
    if (avatar) {
      updates.avatar = avatar
      fields.push('avatar')
    }
  }
  if (fields.length === 0) return { imported: false, fields: [] }

  const profile: Profile = { ...existing, ...updates }
  const now = new Date()
  await getDb()
    .insert(appMeta)
    .values({ key: PROFILE_KEY(did), value: profile, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: profile, updatedAt: now } })

  return { imported: true, fields }
}
