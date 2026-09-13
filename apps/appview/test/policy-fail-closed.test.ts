/**
 * A2. The policy thresholds gate who may join, who may host, and how many stewards a
 * destructive action needs. An unreachable school PDS must therefore never RELAX any of
 * them — which is exactly what the old code did: it caught the read error, kept
 * `defaultThresholds` (`memberRequires: 'none'`, `hostMinAttended: 0`), and then WROTE
 * those over whatever `fs_policy_cache` held.
 *
 * Two cases, both pinned here:
 *   1. a cached strict policy survives a thrown read, row and memo untouched;
 *   2. a first-ever read failure yields `STRICT_THRESHOLDS` and writes no cache row, so
 *      the first successful read still wins rather than being shadowed by a guess.
 *
 * `lib/pds.ts#getRecord` is mocked to throw — that is what a DNS failure, a refused
 * connection or a 5xx-then-parse-error looks like from here. Everything else (the cache
 * table, the memo) is the real thing against a real Postgres.
 */
process.env.SCHOOL_DID = 'did:plc:policy-fail-closed-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'policy-fail-closed-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 11).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'policy-fail-closed-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { defaultThresholds } from '@freeschool/shared'

const SCHOOL = 'did:plc:policy-fail-closed-school'

/** Flipped per test; `getRecord`'s stub reads it at call time. */
let pdsMode: 'throw' | 'policy' | 'school-only' | 'no-policy-yet' = 'throw'

vi.mock('../src/lib/pds.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/pds.js')>('../src/lib/pds.js')
  return {
    ...actual,
    async getRecord(_repo: string, collection: string, rkey: string) {
      if (pdsMode === 'throw') throw new Error('connect ECONNREFUSED 127.0.0.1:3000')
      if (collection === 'freeschool.draft.school') {
        if (pdsMode === 'no-policy-yet') return { uri: `at://${SCHOOL}/freeschool.draft.school/self`, value: {} }
        return { uri: `at://${SCHOOL}/freeschool.draft.school/self`, value: { policy: `at://${SCHOOL}/freeschool.draft.policy/p1` } }
      }
      if (pdsMode === 'school-only') return null
      if (collection === 'freeschool.draft.policy' && rkey === 'p1') {
        return { uri: `at://${SCHOOL}/freeschool.draft.policy/p1`, value: { thresholds: { memberRequires: 'none', hostMinAttended: 0, feedbackK: 4 } } }
      }
      return null
    },
  }
})

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { policyCache } from '../src/db/schema.js'
import { clearPolicyMemo, getThresholds, refreshPolicyCache, STRICT_THRESHOLDS } from '../src/lib/policy.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_policy_cache')
  clearPolicyMemo()
  pdsMode = 'throw'
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('A2: the policy cache fails closed', () => {
  it('keeps a cached strict policy through a thrown read — row and memo untouched', async () => {
    if (!available) return
    const cachedAt = new Date('2026-01-01T00:00:00Z')
    await testDb().insert(policyCache).values({
      schoolDid: SCHOOL,
      policyUri: `at://${SCHOOL}/freeschool.draft.policy/strict`,
      thresholds: { memberRequires: 'attended-one', hostMinAttended: 3, destructiveActionStewards: 3, feedbackK: 5 },
      fetchedAt: cachedAt,
    })

    const result = await refreshPolicyCache(SCHOOL)
    expect(result.thresholds.memberRequires).toBe('attended-one')
    expect(result.thresholds.hostMinAttended).toBe(3)
    expect(result.thresholds.destructiveActionStewards).toBe(3)
    expect(result.policyUri).toBe(`at://${SCHOOL}/freeschool.draft.policy/strict`)

    // The ROW is byte-for-byte what it was, `fetched_at` included: a failed refresh is not
    // a refresh, so the cached policy must not start looking newer than it is.
    const rows = await testDb().select().from(policyCache).where(eq(policyCache.schoolDid, SCHOOL))
    expect(rows.length).toBe(1)
    expect(rows[0]!.fetchedAt?.toISOString()).toBe(cachedAt.toISOString())
    expect(rows[0]!.policyUri).toBe(`at://${SCHOOL}/freeschool.draft.policy/strict`)
    expect((rows[0]!.thresholds as { hostMinAttended: number }).hostMinAttended).toBe(3)
  })

  it('falls back to STRICT_THRESHOLDS on a first read failure, and caches nothing', async () => {
    if (!available) return
    const result = await refreshPolicyCache(SCHOOL)
    expect(result.thresholds).toEqual(STRICT_THRESHOLDS)
    expect(result.thresholds.memberRequires).toBe('invite-or-vouch')
    expect(result.thresholds.hostMinAttended).toBe(1)
    expect(result.thresholds.destructiveActionStewards).toBe(2)
    // NOT the permissive defaults the old code would have installed.
    expect(result.thresholds.memberRequires).not.toBe(defaultThresholds.memberRequires)

    const rows = await testDb().select().from(policyCache).where(eq(policyCache.schoolDid, SCHOOL))
    expect(rows.length).toBe(0)
  })

  it('does not let the strict fallback shadow the first policy it can actually read', async () => {
    if (!available) return
    expect((await getThresholds(SCHOOL)).memberRequires).toBe('invite-or-vouch')

    pdsMode = 'policy'
    clearPolicyMemo()
    const refreshed = await refreshPolicyCache(SCHOOL)
    expect(refreshed.thresholds.memberRequires).toBe('none')
    expect(refreshed.thresholds.feedbackK).toBe(4)
    const rows = await testDb().select().from(policyCache).where(eq(policyCache.schoolDid, SCHOOL))
    expect(rows.length).toBe(1)
  })

  it('treats a policy the school record POINTS AT but cannot fetch as a read failure, not an absent policy', async () => {
    if (!available) return
    // The school record resolves; the policy it names 404s. Reading that as "no policy
    // yet" is the subtle version of the same bug — it relaxes every threshold AND caches
    // the relaxation.
    pdsMode = 'school-only'
    const result = await refreshPolicyCache(SCHOOL)
    expect(result.thresholds).toEqual(STRICT_THRESHOLDS)
    expect(await testDb().select().from(policyCache).where(eq(policyCache.schoolDid, SCHOOL))).toHaveLength(0)
  })

  it('still caches the permissive defaults for a school that has genuinely written no policy', async () => {
    if (!available) return
    // Distinct from the case above: NO pointer at all is the documented day-one state
    // ("hosting open on day one"), and is a real answer rather than a failed read.
    pdsMode = 'no-policy-yet'
    const result = await refreshPolicyCache(SCHOOL)
    expect(result.thresholds).toEqual(defaultThresholds)
    expect(await testDb().select().from(policyCache).where(eq(policyCache.schoolDid, SCHOOL))).toHaveLength(1)
  })
})
