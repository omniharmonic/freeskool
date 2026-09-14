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
import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { AppEnv, SessionKind } from '../session.js'
import { requireViewer } from '../session.js'
import { evidenceFor, roleOf } from '../../lib/roles.js'
import { myRsvps } from '../../lib/rsvp.js'
import { getIndexer } from '../../index/indexer.js'
import { getRecordByUri, listCollection } from '../../index/queries.js'
import { getDb } from '../../db/index.js'
import { appMeta, attendanceTally, attestation, custodialAccount, memberPrefs } from '../../db/schema.js'
import { getThresholds } from '../../lib/policy.js'
import { config } from '../../config.js'
import {
  loadDirectoryPrefs,
  loadProfile,
  PROFILE_KEY,
  saveProfile,
  type Profile,
} from '../../lib/profile.js'
import {
  checkPublicClaims,
  loadAppSideClaims,
  resolveSkillTier,
  setSkillClaims,
  skillClaimRkey,
  tierOfSkillUri,
} from '../../lib/skill-claims.js'
import { setChosenHandle, isHandleTaken } from '../../lib/handle-change.js'
import { isPublicRoleOptIn, publishRoleClaim, setPublicRoleOptIn } from '../../lib/membership-claims.js'
import { badgeSentences, type VouchCount } from '../../lib/badges.js'
import { receivedWithAttesters, vouchCountsFor } from '../../lib/attestations.js'
import { importBlueskyProfile } from '../../lib/bsky-profile.js'
import { isValidChosenHandle, normalizeHandlePrefix } from '../../lib/handles.js'
import { PdsError } from '../../lib/pds.js'

export const me = new Hono<AppEnv>()

// Header first, gate second: even the 401 for an anonymous caller must say noindex.
me.use('*', async (c, next) => {
  c.header('X-Robots-Tag', 'noindex, nofollow')
  await next()
})
me.use('*', requireViewer)

/**
 * The profile itself now lives in `lib/profile.ts` (so `scripts/seed-demo.ts` writes one
 * the same way this route does). Re-exported here because `lib/bsky-profile.ts`,
 * `lib/members.ts` and the test suites all reach for them at this path.
 */
export { PROFILE_KEY, loadProfile, type Profile }

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
  const { confirmPublicLinkage: _confirm, ...fields } = parsed.data
  const profile = await saveProfile(viewer.did, fields)
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
 * Task 6: choosing a handle. Benjamin (founder), signing up through the email door,
 * could never claim a handle of his own choosing — this is the server side of the fix,
 * consumed by the `/welcome` screen (Task 11).
 *
 * `handle:<did>` in `fs_app_meta` is the same best-effort cache `lib/bsky-profile.ts`'s
 * `cacheHandle` writes and `handlesForDids` above reads as its last resort — kept in the
 * same shape (`{ handle, resolvedAt }`) so either writer can update it. `fs_custodial_account`
 * is still the primary source `handlesForDids` checks first, and is updated unconditionally
 * on a successful change.
 */
me.get('/handle/check', async (c) => {
  const prefix = normalizeHandlePrefix(c.req.query('handle') ?? '')
  const format = isValidChosenHandle(prefix)
  if (!format.ok) return c.json({ available: false, reason: format.reason })
  const fullHandle = `${prefix}.${config().handleDomain}`
  try {
    if (await isHandleTaken(fullHandle)) return c.json({ available: false, reason: 'taken' })
    return c.json({ available: true })
  } catch (err) {
    // Review round 1 (blocking): a PDS outage must never read as "available" — only a
    // genuine not-found answer does (see `lib/pds.ts#resolveHandle`).
    if (err instanceof PdsError) return c.json({ error: 'PdsUnavailable' }, 502)
    throw err
  }
})

const handleBody = z.object({ handle: z.string() }).strict()

me.put('/handle', async (c) => {
  const parsed = handleBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const result = await setChosenHandle(c.var.viewer!, parsed.data.handle)
  if (!result.ok) {
    return c.json(
      { error: result.error, ...(result.reason ? { reason: result.reason } : {}), ...(result.message ? { message: result.message } : {}) },
      result.status,
    )
  }
  return c.json({ handle: result.handle })
})

/**
 * Sets `fs_member_prefs.onboardedAt` once, idempotently (Task 6 — `/welcome`'s finishing
 * step). `coalesce` keeps the FIRST timestamp rather than sliding it forward on a repeat
 * call: "onboarded" is a fact about when it first happened, not a heartbeat.
 */
me.post('/onboarded', async (c) => {
  const did = c.var.viewer!.did
  const now = new Date()
  await getDb()
    .insert(memberPrefs)
    .values({ did, onboardedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: memberPrefs.did,
      set: { onboardedAt: sql`coalesce(${memberPrefs.onboardedAt}, ${now})`, updatedAt: now },
    })
  return c.json({ onboarded: true })
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

/**
 * Batched app-side `displayName` lookup. Exported so `http/routes/events.ts`'s roster
 * (review finding 2) reaches for this one implementation instead of keeping its own copy.
 */
export async function displayNamesForDids(dids: string[]): Promise<Record<string, string>> {
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
    displayNamesForDids(attesterDids),
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

/**
 * The claim-writing core (the A6 retraction, the app-side set, `fs_skill_claim_index`)
 * lives in `lib/skill-claims.ts` so `scripts/seed-demo.ts` writes claims the same way a
 * member does. Re-exported here because `test/me-visibility.test.ts` and
 * `test/skill-tiers.test.ts` import them at this path.
 */
export { checkPublicClaims, resolveSkillTier, tierOfSkillUri, skillClaimRkey }

me.put('/skill-claims', async (c) => {
  const parsed = claimsBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const result = await setSkillClaims(c.var.viewer!, parsed.data)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status)
  const { ok: _ok, ...body } = result
  return c.json(body)
})

me.get('/skill-claims', async (c) => {
  const viewer = c.var.viewer!
  const indexer = await getIndexer()
  const res = await indexer.contrail.query('skillClaim', { did: viewer.did, limit: 200 }, indexer.db)
  return c.json({
    public: res.records.map((r) => ({ uri: r.uri, value: JSON.parse(r.record ?? '{}') })),
    school: await loadAppSideClaims(viewer.did),
  })
})
