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
 *
 * `visibility` on a skill claim: 'public' writes the record to the repo (it is a public
 * claim about oneself, which is the point); 'school' keeps it app-side so it informs
 * matching and the request queue without broadcasting it. The protocol has no way to
 * express a private record in v1, so 'school' genuinely means "not written".
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
import { badgeSentences, type VouchCount } from '../../lib/badges.js'

export const me = new Hono<AppEnv>()

me.use('*', requireViewer)

const PROFILE_KEY = (did: string) => `profile:${did}`

interface Profile {
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
  const appSide: Array<{ skill: string; level: string; note?: string }> = []

  if (toPublish.length > 0) {
    try {
      const agent = await actorAgent(viewer)
      for (const claim of toPublish) {
        const res = await agent.com.atproto.repo.putRecord({
          repo: viewer.did,
          collection: NSID.skillClaim,
          // Deterministic-ish: one claim per skill, so re-stating a level updates rather
          // than accumulating. The rkey is derived from the skill's rkey.
          rkey: (claim.skill.split('/').pop() ?? tid()).slice(0, 15),
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
      const indexer = await getIndexer()
      await indexer.notify(published.map((p) => p.uri)).catch(() => {})
    } catch (err) {
      if (err instanceof NoActorCredentialError) return c.json({ error: 'ReauthRequired' }, 401)
      throw err
    }
  }

  for (const claim of parsed.data.claims) {
    if (claim.visibility === 'school') {
      appSide.push({ skill: claim.skill, level: claim.level, ...(claim.note ? { note: claim.note } : {}) })
    }
  }
  await getDb()
    .insert(appMeta)
    .values({ key: APP_SIDE_CLAIMS_KEY(viewer.did), value: appSide, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: appSide, updatedAt: new Date() } })

  return c.json({ published, keptAppSide: appSide.length })
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
