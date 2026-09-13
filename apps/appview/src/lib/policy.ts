/**
 * The school's policy thresholds, cached.
 *
 * Source of truth is the school's `freeschool.draft.policy` record (pointed at by
 * `freeschool.draft.school#policy`). We read it from the school's own repo — not from
 * the index — so a brand-new school works before the first backfill completes, then
 * cache the thresholds in `fs_policy_cache`. Missing FIELDS of a policy we did read fall
 * back to `defaultThresholds` from `@freeschool/shared` (Lex's defaults: hosting open on
 * day one).
 *
 * A FAILED READ IS NOT A MISSING FIELD (A2). These thresholds gate who may join, who may
 * host, and how many stewards a destructive action needs — so an unreachable school PDS
 * must never be allowed to relax any of them:
 *
 *   - if `fs_policy_cache` already holds a row, it is left EXACTLY as it is (and so is the
 *     memo): the last policy we genuinely read stays in force until we can read again;
 *   - if there is no cache row yet, `STRICT_THRESHOLDS` applies — invite-or-vouch to join,
 *     one attended class to host, two stewards for anything destructive — and is
 *     deliberately NOT persisted as the cache, so the first successful read still wins
 *     rather than being shadowed by a guess.
 *
 * The failure is logged with no identifiers and never thrown: a school that cannot be read
 * should run tight, not stop.
 */
import { eq } from 'drizzle-orm'
import { defaultThresholds, type Thresholds } from '@freeschool/shared'
import { getDb } from '../db/index.js'
import { policyCache } from '../db/schema.js'
import { config } from '../config.js'
import { getRecord } from './pds.js'
import { NSID } from '../lexicons/nsids.js'
import { describeError, log } from './logging.js'

const CACHE_TTL_MS = 60_000
const memo = new Map<string, { thresholds: Thresholds; policyUri: string | null; at: number }>()

/**
 * The fail-closed fallback used ONLY when the school's policy has never been read
 * successfully on this deployment. Every value is the most restrictive one the policy
 * schema allows us to pick without inventing a number: joining needs an invite or a vouch
 * (`memberRequires`'s strictest usable gate — `attended-one` is not stricter so much as
 * differently shaped, and would lock out a brand-new school entirely), hosting needs one
 * attended class, and a destructive action needs two stewards. Never written to
 * `fs_policy_cache`.
 */
export const STRICT_THRESHOLDS: Thresholds = {
  ...defaultThresholds,
  memberRequires: 'invite-or-vouch',
  hostMinAttended: 1,
  destructiveActionStewards: 2,
}

export function mergeThresholds(partial: unknown): Thresholds {
  const t = (partial ?? {}) as Partial<Thresholds>
  return {
    memberRequires: t.memberRequires ?? defaultThresholds.memberRequires,
    hostMinAttended: numeric(t.hostMinAttended, defaultThresholds.hostMinAttended),
    facilitatorMinHosted: numeric(t.facilitatorMinHosted, defaultThresholds.facilitatorMinHosted),
    firstEventApproval: typeof t.firstEventApproval === 'boolean' ? t.firstEventApproval : defaultThresholds.firstEventApproval,
    feedbackK: numeric(t.feedbackK, defaultThresholds.feedbackK),
    destructiveActionStewards: numeric(t.destructiveActionStewards, defaultThresholds.destructiveActionStewards),
    publishRoles: typeof t.publishRoles === 'boolean' ? t.publishRoles : (defaultThresholds.publishRoles ?? false),
  }
}

function numeric(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

export async function getThresholds(schoolDid = config().SCHOOL_DID): Promise<Thresholds> {
  if (!schoolDid) return defaultThresholds
  const hit = memo.get(schoolDid)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.thresholds
  const row = await getDb()
    .select()
    .from(policyCache)
    .where(eq(policyCache.schoolDid, schoolDid))
    .limit(1)
  if (row[0]) {
    const thresholds = mergeThresholds(row[0].thresholds)
    memo.set(schoolDid, { thresholds, policyUri: row[0].policyUri, at: Date.now() })
    return thresholds
  }
  return (await refreshPolicyCache(schoolDid)).thresholds
}

export async function currentPolicyUri(schoolDid = config().SCHOOL_DID): Promise<string | null> {
  if (!schoolDid) return null
  const row = await getDb().select().from(policyCache).where(eq(policyCache.schoolDid, schoolDid)).limit(1)
  return row[0]?.policyUri ?? (await refreshPolicyCache(schoolDid)).policyUri
}

export async function refreshPolicyCache(
  schoolDid = config().SCHOOL_DID,
): Promise<{ thresholds: Thresholds; policyUri: string | null }> {
  if (!schoolDid) return { thresholds: defaultThresholds, policyUri: null }

  let thresholds: Thresholds
  let policyUri: string | null = null
  try {
    const school = await getRecord(schoolDid, NSID.school, 'self')
    const uri = school?.value?.policy
    if (typeof uri === 'string') {
      policyUri = uri
      const rkey = uri.split('/').pop()
      if (!rkey) throw new PolicyUnreadableError('the school record\u2019s policy pointer has no rkey')
      const policy = await getRecord(schoolDid, NSID.policy, rkey)
      // A school record that POINTS at a policy we cannot fetch is a read failure, not an
      // absent policy — treating it as absent is how a 404 on the policy record would
      // silently relax every threshold to the permissive defaults.
      if (!policy) throw new PolicyUnreadableError('the policy the school record points at could not be read')
      thresholds = mergeThresholds(policy.value?.thresholds)
    } else {
      // No pointer at all: a school that has not written a policy yet. That IS the
      // documented "hosting open on day one" state, and it is cacheable.
      thresholds = defaultThresholds
    }
  } catch (err) {
    return failClosed(schoolDid, err)
  }

  await getDb()
    .insert(policyCache)
    .values({ schoolDid, policyUri, thresholds, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: policyCache.schoolDid,
      set: { policyUri, thresholds, fetchedAt: new Date() },
    })
  memo.set(schoolDid, { thresholds, policyUri, at: Date.now() })
  return { thresholds, policyUri }
}

/** Raised internally when the policy exists but could not be read — see `refreshPolicyCache`. */
class PolicyUnreadableError extends Error {}

/**
 * A2. The school's PDS could not be read. Keep whatever we last genuinely read; fall back
 * to `STRICT_THRESHOLDS` only when there is nothing to keep, and do not cache that guess.
 */
async function failClosed(
  schoolDid: string,
  err: unknown,
): Promise<{ thresholds: Thresholds; policyUri: string | null }> {
  let cached: Array<{ policyUri: string | null; thresholds: unknown }> = []
  try {
    cached = await getDb()
      .select({ policyUri: policyCache.policyUri, thresholds: policyCache.thresholds })
      .from(policyCache)
      .where(eq(policyCache.schoolDid, schoolDid))
      .limit(1)
  } catch (dbErr) {
    log.warn('policy refresh failed AND the policy cache is unreadable; running strict', {
      detail: describeError(dbErr),
    })
    return { thresholds: STRICT_THRESHOLDS, policyUri: null }
  }

  const row = cached[0]
  if (row) {
    // The row AND the memo are left untouched on purpose: the cached policy keeps its own
    // `fetched_at`, so a later successful refresh is still visibly newer.
    log.warn('policy refresh failed; keeping the cached policy', { detail: describeError(err) })
    return { thresholds: mergeThresholds(row.thresholds), policyUri: row.policyUri }
  }
  log.warn('policy refresh failed with no cached policy; running strict thresholds', {
    detail: describeError(err),
  })
  return { thresholds: STRICT_THRESHOLDS, policyUri: null }
}

export function clearPolicyMemo(): void {
  memo.clear()
}
