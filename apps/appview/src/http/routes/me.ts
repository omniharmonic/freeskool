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
 *   - an OAuth-door session can NEVER set `visibility: 'public'` in v1. There is no
 *     unlock endpoint — bringing an existing identity through the secondary door does
 *     not currently carry enough confirmation of intent to broadcast a public claim
 *     under it, and the session already has no path to get one (see `config().oauthUsable`
 *     and the README's secondary-door notes). 403 `PublicTogglesLocked`.
 *   - a Tier B (sensitive/high-risk) skill needs `confirmTierB: true` on the request
 *     body before a public claim for it is written, for any session. 400
 *     `TierBConfirmRequired`.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
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
import { appMeta, attendanceTally } from '../../db/schema.js'
import { getThresholds } from '../../lib/policy.js'
import { tierOf, type SkillTierValue } from '../../lib/skill-tiers.js'
import { config } from '../../config.js'
import { isPublicRoleOptIn, publishRoleClaim, setPublicRoleOptIn } from '../../lib/membership-claims.js'
import { badgeSentences, type VouchCount } from '../../lib/badges.js'

export const me = new Hono<AppEnv>()

me.use('*', requireViewer)

/** Exported for `http/routes/events.ts`'s roster `displayName` lookup (review I3). */
export const PROFILE_KEY = (did: string) => `profile:${did}`

export interface Profile {
  displayName?: string
  bio?: string
}

async function loadProfile(did: string): Promise<Profile> {
  const rows = await getDb().select().from(appMeta).where(eq(appMeta.key, PROFILE_KEY(did))).limit(1)
  return (rows[0]?.value as Profile | undefined) ?? {}
}

me.get('/', async (c) => {
  const did = c.var.viewer!.did
  const [role, evidence, thresholds, rsvps, profile] = await Promise.all([
    roleOf(did),
    evidenceFor(did),
    getThresholds(),
    myRsvps(did),
    loadProfile(did),
  ])
  return c.json({
    did,
    role,
    // Showing the evidence is deliberate: a derived role that cannot be explained to the
    // person it applies to is indistinguishable from an arbitrary one.
    evidence,
    thresholds,
    rsvps: rsvps.map((r) => ({ eventUri: r.eventUri, status: r.status, alsoPublicRecord: r.alsoPublicRecord })),
    profile,
  })
})

/**
 * App-side profile fields only. Deliberately `.strict()`: no field this endpoint does not
 * name can be written through it, which is what keeps it from ever becoming a real-name
 * prompt by accretion.
 */
const profileBody = z
  .object({
    displayName: z.string().trim().max(120).optional(),
    bio: z.string().trim().max(2000).optional(),
  })
  .strict()

me.put('/', async (c) => {
  const parsed = profileBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400)
  const viewer = c.var.viewer!
  const existing = await loadProfile(viewer.did)
  const profile: Profile = {
    ...existing,
    ...(parsed.data.displayName !== undefined ? { displayName: parsed.data.displayName } : {}),
    ...(parsed.data.bio !== undefined ? { bio: parsed.data.bio } : {}),
  }
  await getDb()
    .insert(appMeta)
    .values({ key: PROFILE_KEY(viewer.did), value: profile, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: profile, updatedAt: new Date() } })
  return c.json({ did: viewer.did, profile })
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

me.get('/badges', async (c) => {
  const did = c.var.viewer!.did
  const [role, tallyRows, vouches] = await Promise.all([roleOf(did), getDb().select().from(attendanceTally).where(eq(attendanceTally.did, did)).limit(1), vouchesReceived(did)])
  const hosted = tallyRows[0]?.hostedEvents ?? 0
  const attended = tallyRows[0]?.attendedConfirmed ?? 0
  const vouched = vouches.reduce((sum, v) => sum + v.count, 0)
  return c.json({
    counts: { hosted, attended, vouched },
    role,
    badges: badgeSentences({ hosted, attended }, vouches),
  })
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

/** Positive skillAttestations received, grouped by skill with a resolved label. */
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
  const out: VouchCount[] = []
  for (const [skillUri, count] of bySkill) {
    const skill = await getRecordByUri<{ label?: string }>(indexer, 'skill', skillUri)
    out.push({ label: skill?.value.label ?? 'a skill', count })
  }
  return out
}

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
): { ok: true } | { ok: false; status: 403 | 400; error: string; message: string } {
  if (claimTiers.length === 0) return { ok: true }
  if (sessionKind === 'oauth') {
    return {
      ok: false,
      status: 403,
      error: 'PublicTogglesLocked',
      message: 'sign-in-with-an-existing-account sessions cannot make a skill claim public in v1',
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
    const check = checkPublicClaims(viewer.kind, tiers, parsed.data.confirmTierB ?? false)
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
  await getDb()
    .insert(appMeta)
    .values({ key: APP_SIDE_CLAIMS_KEY(viewer.did), value: appSide, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: appSide, updatedAt: new Date() } })

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
