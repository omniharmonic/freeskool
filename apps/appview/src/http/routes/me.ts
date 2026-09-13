/**
 * `/api/me/*`
 *
 *   GET /                     my derived role, the evidence behind it, and my own RSVPs
 *   PUT /                     app-side profile fields (displayName, bio) — never a
 *                             real-name prompt
 *   PUT /skill-claims         write `freeschool.draft.skillClaim` records into MY OWN
 *                             repo, gated by the two rules below
 *   GET /visibility-defaults  what this session is allowed to make public, and why
 *   GET /badges               plain-language sentences derived from counts and role
 *   PUT /public-role          opt in/out of publishing MY derived role, if it ever
 *                             qualifies (see ../../lib/membership-claims.ts)
 *
 * `visibility` on a skill claim: 'public' writes the record to the repo (it is a public
 * claim about oneself, which is the point); 'school' keeps it app-side so it informs
 * matching and the request queue without broadcasting it. The protocol has no way to
 * express a private record in v1, so 'school' genuinely means "not written".
 *
 * AND CONSENT THAT ENDS MUST END THE RECORD (A6). `PUT /skill-claims` takes the member's
 * WHOLE set, so flipping a claim from 'public' to 'school' — or dropping it from the list
 * altogether — is a withdrawal of consent to publish it. The route therefore DELETES every
 * `freeschool.draft.skillClaim` in the member's repo that the incoming set no longer asks to
 * be public. Without that, the toggle was a lie: the UI said "school only" and the record
 * stayed readable by anyone, forever.
 *
 * TWO FORCED-OFF RULES on a public claim, both enforced by `checkPublicClaims` below
 * before anything is written:
 *   - an OAuth-door session needs `confirmPublicLinkage: true` on the request body before
 *     it can set `visibility: 'public'` at all (Task 7). There is no unlock endpoint;
 *     bringing an existing identity through the secondary door did not used to carry
 *     enough confirmation of intent to broadcast a public claim under it (the old hard
 *     403 `PublicTogglesLocked`), and now instead asks for it explicitly, once, on the
 *     request that needs it. 400 `PublicLinkageConfirmRequired`.
 *   - a Tier B (sensitive/high-risk) skill needs `confirmTierB: true` on the request
 *     body before a public claim for it is written, for any session. 400
 *     `TierBConfirmRequired`.
 */
import { normalizeImage, type StoredImage } from '../../lib/images.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, inArray } from 'drizzle-orm'
import type { AppEnv, SessionKind } from '../session.js'
import { requireViewer } from '../session.js'
import { evidenceFor, roleOf } from '../../lib/roles.js'
import { myRsvps } from '../../lib/rsvp.js'
import { actorAgent, NoActorCredentialError } from '../../lib/actor-agent.js'
import { NSID } from '../../lexicons/nsids.js'
import { tid } from '../../lib/ids.js'
import { getIndexer } from '../../index/indexer.js'
import { getRecordByUri, listCollection } from '../../index/queries.js'
import { getDb } from '../../db/index.js'
import { appMeta, attendanceTally, attestation, custodialAccount, memberPrefs, skillClaimIndex } from '../../db/schema.js'
import { getThresholds } from '../../lib/policy.js'
import { tierOf, type SkillTierValue } from '../../lib/skill-tiers.js'
import { config } from '../../config.js'
import { isPublicRoleOptIn, publishRoleClaim, setPublicRoleOptIn } from '../../lib/membership-claims.js'
import { badgeSentences, type VouchCount } from '../../lib/badges.js'
import { receivedWithAttesters, vouchCountsFor } from '../../lib/attestations.js'
import { importBlueskyProfile } from '../../lib/bsky-profile.js'

export const me = new Hono<AppEnv>()

me.use('*', requireViewer)

/** Exported for `http/routes/events.ts`'s roster `displayName` lookup (review I3). */
export const PROFILE_KEY = (did: string) => `profile:${did}`

export interface Profile {
  publicListing?: boolean
  avatar?: StoredImage
  displayName?: string
  bio?: string
}

/** Exported for `lib/attestations.ts`-adjacent enrichment below and for tests. */
export async function loadProfile(did: string): Promise<Profile> {
  const rows = await getDb().select().from(appMeta).where(eq(appMeta.key, PROFILE_KEY(did))).limit(1)
  return (rows[0]?.value as Profile | undefined) ?? {}
}

/**
 * `fs_member_prefs` row for the directory/onboarding flags — `directoryListing`
 * defaults true and `onboarded` false when the member has no row yet (see the column
 * comments on `memberPrefs` in `db/schema.ts`).
 */
async function loadDirectoryPrefs(did: string): Promise<{ directoryListing: boolean; onboarded: boolean }> {
  const rows = await getDb().select().from(memberPrefs).where(eq(memberPrefs.did, did)).limit(1)
  const row = rows[0]
  return { directoryListing: row?.directoryListing ?? true, onboarded: row?.onboardedAt != null }
}

me.get('/', async (c) => {
  const did = c.var.viewer!.did
  const [role, evidence, thresholds, rsvps, profile, directoryPrefs] = await Promise.all([
    roleOf(did),
    evidenceFor(did),
    getThresholds(),
    myRsvps(did),
    loadProfile(did),
    loadDirectoryPrefs(did),
  ])
  return c.json({
    did,
    role,
    // Showing the evidence is deliberate: a derived role that cannot be explained to the
    // person it applies to is indistinguishable from an arbitrary one.
    evidence,
    thresholds,
    rsvps: rsvps.map((r) => ({ eventUri: r.eventUri, status: r.status, alsoPublicRecord: r.alsoPublicRecord })),
    profile: visibleProfile(profile),
    ...directoryPrefs,
  })
})

/**
 * App-side profile fields only. Deliberately `.strict()`: no field this endpoint does not
 * name can be written through it, which is what keeps it from ever becoming a real-name
 * prompt by accretion.
 */
const profileBody = z
  .object({
    publicListing: z.boolean().optional(),
    avatar: z.object({ data: z.string().max(11_200_000), alt: z.string().max(300) }).nullable().optional(),
    displayName: z.string().trim().max(120).optional(),
    bio: z.string().trim().max(2000).optional(),
    // Members directory (R9-adjacent) opt-out — see `fs_member_prefs.directory_listing`'s
    // doc comment in db/schema.ts. Not part of `Profile`/`fs_app_meta`: it lives in
    // `fs_member_prefs`, the same row `publicRole`/`onboardedAt` already use.
    directoryListing: z.boolean().optional(),
    // Task 7: required alongside `publicListing: true` for an OAuth-door viewer — see the
    // file-header comment and `checkPublicClaims` below for the sibling rule on claims.
    confirmPublicLinkage: z.boolean().optional(),
  })
  .strict()

me.put('/', async (c) => {
  const parsed = profileBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400)
  const viewer = c.var.viewer!
  if (parsed.data.publicListing && viewer.kind === 'oauth' && !parsed.data.confirmPublicLinkage) {
    return c.json(
      {
        error: 'PublicLinkageConfirmRequired',
        message: 'publishing from an existing account links it to this school permanently; resend with confirmPublicLinkage: true',
      },
      400,
    )
  }
  const existing = await loadProfile(viewer.did)
  const profile: Profile = {
    ...existing,
    ...(parsed.data.publicListing !== undefined ? {publicListing: parsed.data.publicListing} : {}),
    ...(parsed.data.avatar !== undefined ? { avatar: parsed.data.avatar ? await normalizeImage(parsed.data.avatar, true) : undefined } : {}),
    ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
    ...(parsed.data.bio !== undefined ? { bio: parsed.data.bio } : {}),
  }
  await getDb()
    .insert(appMeta)
    .values({ key: PROFILE_KEY(viewer.did), value: profile, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: profile, updatedAt: new Date() } })
  if (parsed.data.directoryListing !== undefined) {
    const now = new Date()
    await getDb()
      .insert(memberPrefs)
      .values({ did: viewer.did, directoryListing: parsed.data.directoryListing, updatedAt: now })
      .onConflictDoUpdate({ target: memberPrefs.did, set: { directoryListing: parsed.data.directoryListing, updatedAt: now } })
  }
  return c.json({
    did: viewer.did,
    profile: visibleProfile(profile),
    ...(parsed.data.directoryListing !== undefined ? { directoryListing: parsed.data.directoryListing } : {}),
  })
})

function visibleProfile(profile: Profile) {
  const { avatar, ...fields } = profile
  return { ...fields, ...(avatar ? { avatarUrl: `/api/me/avatar?v=${avatar.revision}` } : {}) }
}

/**
 * On-demand re-import (Task 7). Unlike the fire-and-forget call on `/oauth/callback`
 * (`overwrite: false` — never clobbers a profile a member already touched), a member
 * asking for this explicitly means it: `overwrite: true` always re-pulls whatever
 * Bluesky currently has.
 */
me.post('/import-bsky-profile', async (c) => {
  const result = await importBlueskyProfile(c.var.viewer!.did, { overwrite: true })
  return c.json(result)
})

me.get('/avatar', async c => {
  const avatar = (await loadProfile(c.var.viewer!.did)).avatar
  if (!avatar) return c.json({ error: 'NotFound' }, 404)
  c.header('Content-Type', 'image/webp')
  c.header('Cache-Control', 'private, no-store')
  return c.body(new Uint8Array(Buffer.from(avatar.data, 'base64')))
})

me.get('/visibility-defaults', async (c) => {
  const viewer = c.var.viewer!
  return c.json({
    // True when THIS session cannot make anything public — the OAuth door, in v1, with
    // no unlock endpoint. Named for what it blocks, not how it is implemented.
    oauthDoor: viewer.kind === 'oauth',
    tierBConfirmRequired: true as const,
  })
})

/**
 * Counts, role and badge sentences for one member — exactly what `GET /api/me/badges`
 * returns. Exported so `lib/members.ts` can show the same thing on another member's
 * profile without a second implementation.
 */
export async function badgesFor(did: string) {
  const [role, tallyRows, vouches] = await Promise.all([roleOf(did), getDb().select().from(attendanceTally).where(eq(attendanceTally.did, did)).limit(1), vouchesReceived(did)])
  const hosted = tallyRows[0]?.hostedEvents ?? 0
  const attended = tallyRows[0]?.attendedConfirmed ?? 0
  const vouched = vouches.reduce((sum, v) => sum + v.count, 0)
  return {
    counts: { hosted, attended, vouched },
    role,
    badges: badgeSentences({ hosted, attended }, vouches),
  }
}

me.get('/badges', async (c) => {
  return c.json(await badgesFor(c.var.viewer!.did))
})

const publicRoleBody = z.object({ publicRole: z.boolean() }).strict()

me.put('/public-role', async (c) => {
  const parsed = publicRoleBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  await setPublicRoleOptIn(viewer.did, parsed.data.publicRole)
  // Re-derivation moment: opting in may immediately qualify if the role is already
  // Host+ and the policy already allows it — no need to wait for the next attendance
  // attestation. Best-effort; the opt-in itself always succeeds either way.
  if (parsed.data.publicRole && config().SCHOOL_DID) {
    const role = await roleOf(viewer.did)
    await publishRoleClaim(config().SCHOOL_DID as `did:${string}`, viewer.did as `did:${string}`, role).catch(() => undefined)
  }
  return c.json({ publicRole: parsed.data.publicRole })
})

me.get('/public-role', async (c) => {
  return c.json({ publicRole: await isPublicRoleOptIn(c.var.viewer!.did) })
})

/**
 * Positive skillAttestations received, grouped by skill with a resolved label — PLUS
 * app-side vouches (`fs_attestation`, this task's own vouching feature), merged into the
 * same by-skill counts before labels are resolved.
 */
async function vouchesReceived(did: string): Promise<VouchCount[]> {
  const indexer = await getIndexer()
  const { records } = await listCollection<{ skill?: string; direction?: string }>(indexer, 'skillAttestation', {
    filters: { subject: did },
    limit: 500,
  })
  const bySkill = new Map<string, number>()
  for (const r of records) {
    if (r.value.direction && r.value.direction !== 'positive') continue
    const skill = r.value.skill
    if (!skill) continue
    bySkill.set(skill, (bySkill.get(skill) ?? 0) + 1)
  }
  const appSideCounts = await vouchCountsFor(did)
  for (const [skillUri, count] of appSideCounts) {
    bySkill.set(skillUri, (bySkill.get(skillUri) ?? 0) + count)
  }
  const out: VouchCount[] = []
  for (const [skillUri, count] of bySkill) {
    const skill = await getRecordByUri<{ label?: string }>(indexer, 'skill', skillUri)
    out.push({ label: skill?.value.label ?? 'a skill', count })
  }
  return out
}

/**
 * Best-effort DID -> handle, scoped to a small batch of DIDs (same fallback order as
 * `http/routes/events.ts`'s roster helper: our own custodial members first, then
 * contrail's `identities` table for anyone else). Omitted entirely for a DID that
 * resolves nowhere, rather than falling back to the DID itself — a handle shown next to
 * someone else's name is cosmetic, never load-bearing. Exported for `lib/members.ts`
 * (the directory and member profile) so this is the one place the fallback order lives.
 */
export async function handlesForDids(dids: string[]): Promise<Record<string, string>> {
  if (dids.length === 0) return {}
  const out: Record<string, string> = {}
  const rows = await getDb()
    .select({ did: custodialAccount.did, handle: custodialAccount.handle })
    .from(custodialAccount)
    .where(inArray(custodialAccount.did, dids))
  for (const r of rows) out[r.did] = r.handle
  const remaining = dids.filter((d) => !out[d])
  if (remaining.length > 0) {
    try {
      const indexer = await getIndexer()
      for (const did of remaining) {
        const row = await indexer.db
          .prepare('SELECT handle FROM identities WHERE did = ? LIMIT 1')
          .bind(did)
          .first<{ handle: string | null }>()
        if (row?.handle) out[did] = row.handle
      }
    } catch {
      /* index not ready; handles are cosmetic, so just omit them */
    }
  }
  const stillRemaining = dids.filter((d) => !out[d])
  if (stillRemaining.length > 0) {
    // Last resort: a previously-resolved handle cached app-side (see the members
    // directory brief). Task 7's `lib/bsky-profile.ts#importBlueskyProfile` is the first
    // writer of this key, on every successful import (`{ handle, resolvedAt }`) — keep
    // this reader accepting that shape.
    const rows = await getDb()
      .select({ key: appMeta.key, value: appMeta.value })
      .from(appMeta)
      .where(inArray(appMeta.key, stillRemaining.map((d) => `handle:${d}`)))
    for (const r of rows) {
      const cached = r.value as { handle?: string } | string | undefined
      const handle = typeof cached === 'string' ? cached : cached?.handle
      if (handle) out[r.key.slice('handle:'.length)] = handle
    }
  }
  return out
}

/** Batched did -> full app-side profile lookup (avatar/bio/displayName/publicListing). */
export async function profilesFor(dids: string[]): Promise<Map<string, Profile>> {
  if (dids.length === 0) return new Map()
  const rows = await getDb()
    .select({ key: appMeta.key, value: appMeta.value })
    .from(appMeta)
    .where(inArray(appMeta.key, dids.map(PROFILE_KEY)))
  const out = new Map<string, Profile>()
  for (const r of rows) out.set(r.key.slice('profile:'.length), (r.value as Profile | undefined) ?? {})
  return out
}

/** Batched app-side `displayName` lookup, same shape as `events.ts`'s roster helper. */
async function displayNamesForAttesters(dids: string[]): Promise<Record<string, string>> {
  const profiles = await profilesFor(dids)
  const out: Record<string, string> = {}
  for (const [did, p] of profiles) if (p.displayName) out[did] = p.displayName
  return out
}

/** Batched skill-uri -> label lookup, for the received-vouches list and the directory. */
export async function labelsForSkills(skillUris: string[], indexer: Awaited<ReturnType<typeof getIndexer>>): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  await Promise.all(
    skillUris.map(async (uri) => {
      const skill = await getRecordByUri<{ label?: string }>(indexer, 'skill', uri)
      out[uri] = skill?.value.label ?? 'a skill'
    }),
  )
  return out
}

/**
 * `GET /api/me/attestations` — the vouches I've given, and the ones I've received (with
 * enough about each attester to show it: a handle and/or display name when we have one,
 * never anything else about them). App-side only, per R9.
 */
me.get('/attestations', async (c) => {
  const did = c.var.viewer!.did
  const indexer = await getIndexer()

  const givenRows = await getDb()
    .select({
      id: attestation.id,
      subjectDid: attestation.subjectDid,
      skillUri: attestation.skillUri,
      createdAt: attestation.createdAt,
    })
    .from(attestation)
    .where(eq(attestation.attesterDid, did))
    .orderBy(desc(attestation.createdAt))

  const received = await receivedWithAttesters(did)
  const attesterDids = [...new Set(received.map((r) => r.attesterDid))]
  const skillUris = [...new Set(received.map((r) => r.skillUri))]
  const [handles, displayNames, labels] = await Promise.all([
    handlesForDids(attesterDids),
    displayNamesForAttesters(attesterDids),
    labelsForSkills(skillUris, indexer),
  ])

  return c.json({
    given: givenRows.map((r) => ({
      id: r.id,
      subjectDid: r.subjectDid,
      skillUri: r.skillUri,
      createdAt: r.createdAt.toISOString(),
    })),
    received: received.map((r) => ({
      id: r.id,
      attesterDid: r.attesterDid,
      ...(handles[r.attesterDid] ? { attesterHandle: handles[r.attesterDid] } : {}),
      ...(displayNames[r.attesterDid] ? { attesterDisplayName: displayNames[r.attesterDid] } : {}),
      skillUri: r.skillUri,
      skillLabel: labels[r.skillUri] ?? 'a skill',
      createdAt: r.createdAt,
    })),
  })
})

const claimsBody = z.object({
  claims: z
    .array(
      z.object({
        skill: z.string().startsWith('at://'),
        level: z.enum(['learning', 'practicing', 'proficient', 'teaching']),
        note: z.string().max(2560).optional(),
        visibility: z.enum(['public', 'school']).default('public'),
      }),
    )
    .max(200),
  /** Required to publish a Tier B (sensitive/high-risk) skill claim publicly. */
  confirmTierB: z.boolean().optional(),
  /** Required for an OAuth-door session to publish ANY public claim — see `checkPublicClaims`. */
  confirmPublicLinkage: z.boolean().optional(),
})

const APP_SIDE_CLAIMS_KEY = (did: string) => `skill-claims:${did}`

/**
 * The two forced-off rules, as one pure decision — testable without a session, a
 * database, or an HTTP request. `claimTiers` is the tier of every claim in THIS request
 * that asks for `visibility: 'public'`.
 */
export function checkPublicClaims(
  sessionKind: SessionKind,
  claimTiers: SkillTierValue[],
  confirmTierB: boolean,
  confirmPublicLinkage = false,
): { ok: true } | { ok: false; status: 400; error: string; message: string } {
  if (claimTiers.length === 0) return { ok: true }
  if (sessionKind === 'oauth' && !confirmPublicLinkage) {
    return {
      ok: false,
      status: 400,
      error: 'PublicLinkageConfirmRequired',
      message: 'publishing from an existing account links it to this school permanently; resend with confirmPublicLinkage: true',
    }
  }
  if (claimTiers.includes('B') && !confirmTierB) {
    return {
      ok: false,
      status: 400,
      error: 'TierBConfirmRequired',
      message: 'this is a sensitive skill; resend with confirmTierB: true to publish it',
    }
  }
  return { ok: true }
}

/**
 * FAILS CLOSED: a skill we cannot resolve a slug for (not indexed yet, or missing its
 * `id`) is treated as Tier B for the public-visibility decision — we cannot verify it is
 * safe to default-public, so we do not. `tierOf` itself still defaults an unlisted but
 * RESOLVED skill to Tier A (most skills are ordinary); this is specifically about a
 * skill we cannot look up at all. Split from `tierOfSkillUri` so the decision is testable
 * without the indexer.
 */
export async function resolveSkillTier(skillId: string | undefined): Promise<SkillTierValue> {
  if (!skillId) return 'B'
  return tierOf(skillId)
}

/** The skill AT-URI's taxonomy slug (`value.id`), for a tier lookup — see `resolveSkillTier`. */
export async function tierOfSkillUri(skillUri: string): Promise<SkillTierValue> {
  const indexer = await getIndexer()
  const skill = await getRecordByUri<{ id?: string }>(indexer, 'skill', skillUri)
  return resolveSkillTier(skill?.value.id)
}

/** Cheap "is anything of mine published?", from the index. See `needsRepo` below. */
async function hasPublishedClaim(did: string): Promise<boolean> {
  try {
    const indexer = await getIndexer()
    const { records } = await listCollection(indexer, 'skillClaim', { did, limit: 1 })
    return records.length > 0
  } catch {
    // Index unavailable: assume there MIGHT be something to withdraw. Failing towards
    // "try to retract" is the right direction for a consent withdrawal.
    return true
  }
}

/**
 * R1: an index-based estimate of how many currently-public `skillClaim` records this
 * request could not retract, used ONLY when the repo write itself could not be attempted
 * (`NoActorCredentialError` — see `me.put('/skill-claims')` below). `keep` is the set of
 * rkeys this request wants to remain public; anything else counts as pending. A record
 * whose rkey cannot be parsed counts as pending too — the same fail-towards-caution
 * direction as `hasPublishedClaim`.
 */
async function countPendingRetractions(did: string, keep: Set<string>): Promise<number> {
  try {
    const indexer = await getIndexer()
    const { records } = await listCollection(indexer, 'skillClaim', { did, limit: 200 })
    return records.filter((r) => {
      const rkey = r.uri.split('/').pop()
      return !rkey || !keep.has(rkey)
    }).length
  } catch {
    return 0
  }
}

/**
 * One claim per skill, so re-stating a level updates the existing record rather than
 * accumulating duplicates — and so that a claim can be found again in order to DELETE it
 * (A6) without keeping an app-side uri index beside the repo.
 */
export function skillClaimRkey(skillUri: string): string {
  return (skillUri.split('/').pop() ?? tid()).slice(0, 15)
}

me.put('/skill-claims', async (c) => {
  const parsed = claimsBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  const now = new Date().toISOString()

  const toPublish = parsed.data.claims.filter((x) => x.visibility === 'public')
  if (toPublish.length > 0) {
    const tiers = await Promise.all(toPublish.map((claim) => tierOfSkillUri(claim.skill)))
    const check = checkPublicClaims(viewer.kind, tiers, parsed.data.confirmTierB ?? false, parsed.data.confirmPublicLinkage ?? false)
    if (!check.ok) return c.json({ error: check.error, message: check.message }, check.status)
  }

  const published: Array<{ uri: string; skill: string; level: string }> = []
  const retracted: string[] = []
  // The rkeys this request wants to EXIST publicly afterwards. Anything else in the repo
  // is consent that has been withdrawn.
  const keep = new Set(toPublish.map((claim) => skillClaimRkey(claim.skill)))

  /**
   * R1: PERSIST THE APP-SIDE CLAIM SET FIRST, BEFORE TOUCHING THE REPO.
   *
   * `needsRepo` below is true whenever anything is published OR anything might need
   * retracting — which is most saves. If the repo write then fails with a lapsed
   * credential (`NoActorCredentialError`), that must not cost a member their school-only
   * save: a member who only changed a 'school'-visibility claim, or who also has an
   * unrelated stale public claim sitting in their repo, should not lose their whole save
   * because of a credential problem that has nothing to do with what they just typed.
   * So the app-side set is written unconditionally, before the repo is ever touched.
   */
  const appSide: Array<{ skill: string; level: string; note?: string }> = []
  for (const claim of parsed.data.claims) {
    if (claim.visibility === 'school') {
      appSide.push({ skill: claim.skill, level: claim.level, ...(claim.note ? { note: claim.note } : {}) })
    }
  }
  const indexedAt = new Date()
  await getDb().transaction(async (tx) => {
    await tx
      .insert(appMeta)
      .values({ key: APP_SIDE_CLAIMS_KEY(viewer.did), value: appSide, updatedAt: indexedAt })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: appSide, updatedAt: indexedAt } })

    // `fs_skill_claim_index` is a query-only projection of the member's WHOLE claim set
    // (public and school), rebuilt wholesale here: delete-then-insert in the same
    // transaction as the app-side write, so the two never disagree about what was just
    // saved. See the table's doc comment in `db/schema.ts`.
    await tx.delete(skillClaimIndex).where(eq(skillClaimIndex.did, viewer.did))
    if (parsed.data.claims.length > 0) {
      await tx.insert(skillClaimIndex).values(
        parsed.data.claims.map((claim) => ({
          did: viewer.did,
          skillUri: claim.skill,
          level: claim.level,
          visibility: claim.visibility,
          updatedAt: indexedAt,
        })),
      )
    }
  })

  /**
   * Does this request need the member's own credential at all? Publishing obviously does;
   * so does a RETRACTION, and a retraction is only possible if something is published. The
   * index answers that cheaply, and answering it first is what keeps an app-side-only save
   * ('school' visibility, nothing public, nothing to withdraw) working for a session whose
   * OAuth authorization has lapsed — it writes no records either way.
   */
  const needsRepo = toPublish.length > 0 || (await hasPublishedClaim(viewer.did))

  if (needsRepo) try {
    const agent = await actorAgent(viewer)

    /**
     * A6. Read the member's OWN repo — `listRecords` on their own PDS through their own
     * session, not the index: the index is eventually consistent, and "we could not see it,
     * so we left it published" is the wrong way for a consent withdrawal to fail.
     *
     * Read BEFORE publishing, so the records written a few lines down are never candidates
     * for their own deletion.
     */
    const existing = await agent.com.atproto.repo
      .listRecords({ repo: viewer.did, collection: NSID.skillClaim, limit: 100 })
      .then((res) => res.data.records.map((r) => r.uri))
      .catch(() => [] as string[])

    for (const claim of toPublish) {
      const res = await agent.com.atproto.repo.putRecord({
        repo: viewer.did,
        collection: NSID.skillClaim,
        rkey: skillClaimRkey(claim.skill),
        record: {
          $type: NSID.skillClaim,
          skill: claim.skill,
          level: claim.level,
          ...(claim.note ? { note: claim.note } : {}),
          createdAt: now,
        } as Record<string, unknown>,
        validate: false,
      })
      published.push({ uri: res.data.uri, skill: claim.skill, level: claim.level })
    }

    for (const uri of existing) {
      const rkey = uri.split('/').pop()
      if (!rkey || keep.has(rkey)) continue
      await agent.com.atproto.repo
        .deleteRecord({ repo: viewer.did, collection: NSID.skillClaim, rkey })
        .then(() => retracted.push(uri))
        .catch(() => {
          /* best effort per record; the rest of the withdrawal still happens */
        })
    }

    if (published.length > 0 || retracted.length > 0) {
      const indexer = await getIndexer()
      // The DELETED uris need the notify too, not just the new ones: an authoritative
      // not-found from the PDS is what tells contrail to drop a record from the index.
      await indexer.notify([...published.map((p) => p.uri), ...retracted]).catch(() => {})
    }
  } catch (err) {
    if (err instanceof NoActorCredentialError) {
      // R1: the app-side claim set is already saved (above, before the repo was ever
      // touched) — this is not a failed save, it is a save that could not reach the PDS.
      // 200, not 401: a 401 here told the UI the whole PUT failed, which discarded the
      // school-only write that had, in fact, already happened.
      const pendingRetractions = await countPendingRetractions(viewer.did, keep)
      return c.json({ published, retracted, keptAppSide: appSide.length, reauthRequired: true, pendingRetractions })
    }
    throw err
  }

  return c.json({ published, retracted, keptAppSide: appSide.length })
})

me.get('/skill-claims', async (c) => {
  const viewer = c.var.viewer!
  const indexer = await getIndexer()
  const res = await indexer.contrail.query('skillClaim', { did: viewer.did, limit: 200 }, indexer.db)
  const rows = await getDb()
    .select()
    .from(appMeta)
    .where(and(eq(appMeta.key, APP_SIDE_CLAIMS_KEY(viewer.did))))
    .limit(1)
  return c.json({
    public: res.records.map((r) => ({ uri: r.uri, value: JSON.parse(r.record ?? '{}') })),
    school: rows[0]?.value ?? [],
  })
})
