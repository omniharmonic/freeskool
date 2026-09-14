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
import { sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { appMeta } from '../db/schema.js'
import { normalizeImage } from './images.js'
import { PROFILE_KEY, type Profile } from '../http/routes/me.js'
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
// The only hosts the public `getProfile` response's `avatar` URL can legitimately point
// at — Bluesky's own image CDN. Anything else (a compromised/spoofed response, or a
// future API change) is refused before a single byte is fetched.
const ALLOWED_AVATAR_HOSTS = ['bsky.app', 'bsky.network']

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

/** `https:` and a host that is, or is a subdomain of, one of `ALLOWED_AVATAR_HOSTS`. */
function isAllowedAvatarUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return ALLOWED_AVATAR_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/**
 * Reads a response body up to `capBytes`, aborting the moment the running total would
 * exceed it — a hostile or misbehaving server cannot make this buffer more than the cap
 * in memory even without an honest `content-length`. Returns `undefined` (never throws)
 * on any read error or if the cap is exceeded.
 */
async function readCapped(body: ReadableStream<Uint8Array> | null, capBytes: number): Promise<Buffer | undefined> {
  if (!body) return undefined
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > capBytes) {
        await reader.cancel().catch(() => {})
        return undefined
      }
      chunks.push(value)
    }
  } catch {
    return undefined
  }
  return Buffer.concat(chunks)
}

/**
 * Downloads one avatar (max 5 MB, `image/*`, and only from Bluesky's own CDN hosts) and
 * re-encodes it through `normalizeImage` (WebP, metadata stripped — R9). Returns
 * `undefined` — never throws — for anything that is not a small, recognizable image from
 * an expected host: a stale/unexpected CDN URL is not worth failing the whole import over.
 */
async function downloadAvatar(url: string, fetchImpl: typeof fetch): Promise<Profile['avatar'] | undefined> {
  if (!isAllowedAvatarUrl(url)) return undefined
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return undefined
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!ACCEPTED_AVATAR_TYPES.has(mime)) return undefined
    // Reject on a declared size before reading anything...
    const declaredLength = Number(res.headers.get('content-length') ?? '')
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AVATAR_BYTES) return undefined
    // ...and cap the actual bytes read regardless, for a response with no (or a lying)
    // content-length.
    const buf = await readCapped(res.body, MAX_AVATAR_BYTES)
    if (!buf || buf.byteLength === 0) return undefined
    return await normalizeImage({ data: `data:${mime};base64,${buf.toString('base64')}`, alt: '' }, true)
  } catch {
    return undefined
  }
}

/**
 * Fetches the public Bluesky profile and stores its app-side subset.
 *
 * Both branches below write ATOMICALLY, in one statement, against whatever the
 * `fs_app_meta` row for this member currently is — there is no read-then-write window
 * (no `loadProfile` before the fetch, no re-check after it) where a concurrent
 * `PUT /api/me` from the member's own session could be silently clobbered by this import,
 * even though the network round-trip to Bluesky in between can take a while.
 *
 * `overwrite: false` (the sign-in call site): the row's ABSENCE is the "no app-side
 * profile yet" condition. `onConflictDoNothing` means that if a row exists at all by the
 * time this write reaches Postgres — including one written by a `PUT /api/me` that landed
 * while the Bluesky fetch was in flight — nothing is written and the import reports
 * itself skipped. An import is a courtesy default, never something that clobbers what a
 * member already touched.
 *
 * `overwrite: true` (the on-demand `POST /api/me/import-bsky-profile`) is a member
 * deliberately asking to re-pull their Bluesky profile. It merges IN POSTGRES
 * (`value || <updates>::jsonb`) against the row's current value, so a concurrent
 * `PUT /api/me` editing some OTHER field (say `bio`, while this import is only updating
 * `displayName`) is preserved rather than overwritten by a stale in-process copy.
 *
 * The handle cache is written whenever the profile fetch itself succeeds, regardless of
 * the overwrite decision — it is a separate, harmless lookup aid, not part of the profile
 * a member controls, and always safe to overwrite with the freshest known handle.
 */
export async function importBlueskyProfile(
  did: string,
  opts: { overwrite: boolean; fetchImpl?: typeof fetch },
): Promise<{ imported: boolean; fields: string[] }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const bsky = await fetchBskyProfile(did, fetchImpl)
  if (!bsky) return { imported: false, fields: [] }

  await cacheHandle(did, bsky.handle).catch(() => log.warn('bsky handle cache write failed'))

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

  const now = new Date()
  const db = getDb()

  if (!opts.overwrite) {
    const inserted = await db
      .insert(appMeta)
      .values({ key: PROFILE_KEY(did), value: updates, updatedAt: now })
      .onConflictDoNothing({ target: appMeta.key })
      .returning({ key: appMeta.key })
    if (inserted.length === 0) return { imported: false, fields: [] }
    return { imported: true, fields }
  }

  await db
    .insert(appMeta)
    .values({ key: PROFILE_KEY(did), value: updates, updatedAt: now })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: sql`${appMeta.value} || ${JSON.stringify(updates)}::jsonb`, updatedAt: now },
    })

  return { imported: true, fields }
}
