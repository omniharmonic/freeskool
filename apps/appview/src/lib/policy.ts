/**
 * The school's policy thresholds, cached.
 *
 * Source of truth is the school's `freeschool.draft.policy` record (pointed at by
 * `freeschool.draft.school#policy`). We read it from the school's own repo — not from
 * the index — so a brand-new school works before the first backfill completes, then
 * cache the thresholds in `fs_policy_cache`. Missing fields fall back to
 * `defaultThresholds` from `@freeschool/shared` (Lex's defaults: hosting open on day one).
 */
import { eq } from 'drizzle-orm'
import { defaultThresholds, type Thresholds } from '@freeschool/shared'
import { getDb } from '../db/index.js'
import { policyCache } from '../db/schema.js'
import { config } from '../config.js'
import { getRecord } from './pds.js'
import { NSID } from '../lexicons/nsids.js'
import { log } from './logging.js'

const CACHE_TTL_MS = 60_000
const memo = new Map<string, { thresholds: Thresholds; policyUri: string | null; at: number }>()

export function mergeThresholds(partial: unknown): Thresholds {
  const t = (partial ?? {}) as Partial<Thresholds>
  return {
    memberRequires: t.memberRequires ?? defaultThresholds.memberRequires,
    hostMinAttended: numeric(t.hostMinAttended, defaultThresholds.hostMinAttended),
    facilitatorMinHosted: numeric(t.facilitatorMinHosted, defaultThresholds.facilitatorMinHosted),
    firstEventApproval: typeof t.firstEventApproval === 'boolean' ? t.firstEventApproval : defaultThresholds.firstEventApproval,
    feedbackK: numeric(t.feedbackK, defaultThresholds.feedbackK),
    destructiveActionStewards: numeric(t.destructiveActionStewards, defaultThresholds.destructiveActionStewards),
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
  let thresholds = defaultThresholds
  let policyUri: string | null = null
  try {
    const school = await getRecord(schoolDid, NSID.school, 'self')
    const uri = school?.value?.policy
    if (typeof uri === 'string') {
      policyUri = uri
      const rkey = uri.split('/').pop()
      if (rkey) {
        const policy = await getRecord(schoolDid, NSID.policy, rkey)
        thresholds = mergeThresholds(policy?.value?.thresholds)
      }
    }
  } catch (err) {
    log.warn('policy refresh failed; using defaults', { detail: String(err) })
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

export function clearPolicyMemo(): void {
  memo.clear()
}
