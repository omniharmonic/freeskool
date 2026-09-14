/**
 * Writing a member's WHOLE skill-claim set, factored out of `http/routes/me.ts`'s
 * `PUT /api/me/skill-claims` so the route and `scripts/seed-demo.ts` take the same path.
 * Behaviour is unchanged; only the HTTP shell (zod parse, status codes) stays in the route.
 *
 * `visibility` on a claim: 'public' writes the record to the member's own repo (it is a
 * public claim about oneself, which is the point); 'school' keeps it app-side so it
 * informs matching and the request queue without broadcasting it. The protocol has no way
 * to express a private record in v1, so 'school' genuinely means "not written".
 *
 * AND CONSENT THAT ENDS MUST END THE RECORD (A6). This takes the member's WHOLE set, so
 * flipping a claim from 'public' to 'school' — or dropping it from the list altogether —
 * is a withdrawal of consent to publish it, and every `freeschool.draft.skillClaim` in the
 * repo that the incoming set no longer asks to be public is DELETED.
 *
 * TWO FORCED-OFF RULES on a public claim, both enforced by `checkPublicClaims` before
 * anything is written:
 *   - an OAuth-door session needs `confirmPublicLinkage: true` (Task 7);
 *   - a Tier B (sensitive/high-risk) skill needs `confirmTierB: true`, for any session.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { appMeta, skillClaimIndex } from '../db/schema.js'
import type { SessionKind, Viewer } from '../http/session.js'
import { actorAgent, NoActorCredentialError } from './actor-agent.js'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { getIndexer } from '../index/indexer.js'
import { getRecordByUri, listCollection } from '../index/queries.js'
import { tierOf, type SkillTierValue } from './skill-tiers.js'

export const APP_SIDE_CLAIMS_KEY = (did: string) => `skill-claims:${did}`

export type ClaimLevel = 'learning' | 'practicing' | 'proficient' | 'teaching'

export interface SkillClaimInput {
  skill: string
  level: ClaimLevel
  note?: string
  visibility: 'public' | 'school'
}

export interface SetSkillClaimsInput {
  claims: SkillClaimInput[]
  confirmTierB?: boolean
  confirmPublicLinkage?: boolean
}

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

/**
 * One claim per skill, so re-stating a level updates the existing record rather than
 * accumulating duplicates — and so that a claim can be found again in order to DELETE it
 * (A6) without keeping an app-side uri index beside the repo.
 */
export function skillClaimRkey(skillUri: string): string {
  return (skillUri.split('/').pop() ?? tid()).slice(0, 15)
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
 * (`NoActorCredentialError`). `keep` is the set of rkeys this request wants to remain
 * public; anything else counts as pending. A record whose rkey cannot be parsed counts as
 * pending too — the same fail-towards-caution direction as `hasPublishedClaim`.
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

export type SetSkillClaimsResult =
  | {
      ok: true
      published: Array<{ uri: string; skill: string; level: string }>
      retracted: string[]
      keptAppSide: number
      reauthRequired?: true
      pendingRetractions?: number
    }
  | { ok: false; status: 400; error: string; message: string }

export async function setSkillClaims(viewer: Viewer, body: SetSkillClaimsInput): Promise<SetSkillClaimsResult> {
  const now = new Date().toISOString()

  const toPublish = body.claims.filter((x) => x.visibility === 'public')
  if (toPublish.length > 0) {
    const tiers = await Promise.all(toPublish.map((claim) => tierOfSkillUri(claim.skill)))
    const check = checkPublicClaims(viewer.kind, tiers, body.confirmTierB ?? false, body.confirmPublicLinkage ?? false)
    if (!check.ok) return check
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
   * save. So the app-side set is written unconditionally, before the repo is ever touched.
   */
  const appSide: Array<{ skill: string; level: string; note?: string }> = []
  for (const claim of body.claims) {
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
    if (body.claims.length > 0) {
      await tx.insert(skillClaimIndex).values(
        body.claims.map((claim) => ({
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

  if (needsRepo) {
    try {
      const agent = await actorAgent(viewer)

      /**
       * A6. Read the member's OWN repo — `listRecords` on their own PDS through their own
       * session, not the index: the index is eventually consistent, and "we could not see
       * it, so we left it published" is the wrong way for a consent withdrawal to fail.
       *
       * Read BEFORE publishing, so the records written a few lines down are never
       * candidates for their own deletion.
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
        const pendingRetractions = await countPendingRetractions(viewer.did, keep)
        return { ok: true, published, retracted, keptAppSide: appSide.length, reauthRequired: true, pendingRetractions }
      }
      throw err
    }
  }

  return { ok: true, published, retracted, keptAppSide: appSide.length }
}

/** `GET /api/me/skill-claims`'s app-side half — the 'school'-visibility claims. */
export async function loadAppSideClaims(did: string): Promise<unknown> {
  const rows = await getDb()
    .select()
    .from(appMeta)
    .where(and(eq(appMeta.key, APP_SIDE_CLAIMS_KEY(did))))
    .limit(1)
  return rows[0]?.value ?? []
}
