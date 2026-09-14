/**
 * The app-side member profile (`fs_app_meta`, key `profile:<did>`) plus the one
 * `fs_member_prefs` flag that travels with it on the same save.
 *
 * Factored out of `http/routes/me.ts`'s `PUT /api/me` so that anything which needs to
 * write a profile — the route, `scripts/seed-demo.ts` — goes through ONE implementation.
 * `PROFILE_KEY`, `Profile` and `loadProfile` live here now too and are re-exported from
 * `routes/me.ts`, which is where every existing importer still reaches for them.
 *
 * Deliberately NOT a real-name prompt by accretion: the field list here is the whole
 * field list, exactly as the route's `.strict()` zod schema is.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { appMeta, memberPrefs } from '../db/schema.js'
import { normalizeImage, type ImageInput, type StoredImage } from './images.js'

export const PROFILE_KEY = (did: string) => `profile:${did}`

export interface Profile {
  publicListing?: boolean
  avatar?: StoredImage
  displayName?: string
  bio?: string
}

export async function loadProfile(did: string): Promise<Profile> {
  const rows = await getDb().select().from(appMeta).where(eq(appMeta.key, PROFILE_KEY(did))).limit(1)
  return (rows[0]?.value as Profile | undefined) ?? {}
}

/**
 * `fs_member_prefs` row for the directory/onboarding flags — `directoryListing`
 * defaults true and `onboarded` false when the member has no row yet (see the column
 * comments on `memberPrefs` in `db/schema.ts`).
 */
export async function loadDirectoryPrefs(did: string): Promise<{ directoryListing: boolean; onboarded: boolean }> {
  const rows = await getDb().select().from(memberPrefs).where(eq(memberPrefs.did, did)).limit(1)
  const row = rows[0]
  return { directoryListing: row?.directoryListing ?? true, onboarded: row?.onboardedAt != null }
}

/**
 * Every field is OPTIONAL and "absent means leave alone"; `avatar: null` is the explicit
 * "remove it". The avatar is re-encoded through `normalizeImage` (EXIF/GPS/filename are
 * never retained — R9), so callers hand over raw `{ data, alt }` and never a `StoredImage`.
 */
export interface SaveProfileFields {
  publicListing?: boolean
  avatar?: ImageInput | null
  displayName?: string
  bio?: string
  directoryListing?: boolean
}

/** The merged profile as it now stands, so a caller can render it without re-reading. */
export async function saveProfile(did: string, fields: SaveProfileFields): Promise<Profile> {
  const existing = await loadProfile(did)
  const profile: Profile = {
    ...existing,
    ...(fields.publicListing !== undefined ? { publicListing: fields.publicListing } : {}),
    ...(fields.avatar !== undefined
      ? { avatar: fields.avatar ? await normalizeImage(fields.avatar, true) : undefined }
      : {}),
    ...(fields.displayName !== undefined ? { displayName: fields.displayName } : {}),
    ...(fields.bio !== undefined ? { bio: fields.bio } : {}),
  }
  const now = new Date()
  await getDb()
    .insert(appMeta)
    .values({ key: PROFILE_KEY(did), value: profile, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: profile, updatedAt: now } })

  if (fields.directoryListing !== undefined) {
    await getDb()
      .insert(memberPrefs)
      .values({ did, directoryListing: fields.directoryListing, updatedAt: now })
      .onConflictDoUpdate({ target: memberPrefs.did, set: { directoryListing: fields.directoryListing, updatedAt: now } })
  }
  return profile
}
