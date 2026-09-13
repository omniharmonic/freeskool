/**
 * `scripts/backfill-skill-claims.ts` — fills `fs_skill_claim_index` from the
 * `skill-claims:<did>` blobs that already existed in `fs_app_meta` before the index did.
 * Idempotent (delete-then-insert per did, scoped to `visibility: 'school'`), and never
 * touches a `visibility: 'public'` row (it has no way to know about those — see the
 * script's doc comment).
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { appMeta, skillClaimIndex } from '../src/db/schema.js'
import { backfillSkillClaims } from '../scripts/backfill-skill-claims.js'

const DID_A = 'did:plc:backfill-member-a'
const DID_B = 'did:plc:backfill-member-b'
const SKILL_A = 'at://did:plc:taxonomy/freeschool.draft.skill/bicycle-repair'
const SKILL_B = 'at://did:plc:taxonomy/freeschool.draft.skill/sourdough'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_app_meta', 'fs_skill_claim_index')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('backfillSkillClaims', () => {
  it('upserts an index row per claim in each skill-claims:<did> blob', async () => {
    if (!available) return
    await testDb()
      .insert(appMeta)
      .values([
        { key: `skill-claims:${DID_A}`, value: [{ skill: SKILL_A, level: 'teaching' }] },
        { key: `skill-claims:${DID_B}`, value: [{ skill: SKILL_B, level: 'learning', note: 'just starting' }] },
        { key: 'some-unrelated-key', value: { anything: true } },
      ])

    const { members, rows } = await backfillSkillClaims()
    expect(members).toBe(2)
    expect(rows).toBe(2)

    const indexed = await testDb().select().from(skillClaimIndex).where(eq(skillClaimIndex.did, DID_A))
    expect(indexed).toEqual([
      expect.objectContaining({ did: DID_A, skillUri: SKILL_A, level: 'teaching', visibility: 'school' }),
    ])
  })

  it('is idempotent: running it twice leaves the same rows, not duplicates', async () => {
    if (!available) return
    await testDb().insert(appMeta).values({ key: `skill-claims:${DID_A}`, value: [{ skill: SKILL_A, level: 'teaching' }] })

    await backfillSkillClaims()
    await backfillSkillClaims()

    const rows = await testDb().select().from(skillClaimIndex).where(eq(skillClaimIndex.did, DID_A))
    expect(rows.length).toBe(1)
  })

  it('reflects a shrunk blob: a claim dropped from the array disappears from the index', async () => {
    if (!available) return
    await testDb()
      .insert(appMeta)
      .values({
        key: `skill-claims:${DID_A}`,
        value: [
          { skill: SKILL_A, level: 'teaching' },
          { skill: SKILL_B, level: 'learning' },
        ],
      })
    await backfillSkillClaims()
    expect((await testDb().select().from(skillClaimIndex).where(eq(skillClaimIndex.did, DID_A))).length).toBe(2)

    await testDb()
      .update(appMeta)
      .set({ value: [{ skill: SKILL_A, level: 'teaching' }] })
      .where(eq(appMeta.key, `skill-claims:${DID_A}`))
    await backfillSkillClaims()

    const rows = await testDb().select().from(skillClaimIndex).where(eq(skillClaimIndex.did, DID_A))
    expect(rows.length).toBe(1)
    expect(rows[0]?.skillUri).toBe(SKILL_A)
  })

  it('never touches an existing public-visibility row for the same did', async () => {
    if (!available) return
    await testDb()
      .insert(skillClaimIndex)
      .values({ did: DID_A, skillUri: SKILL_B, level: 'proficient', visibility: 'public' })
    await testDb().insert(appMeta).values({ key: `skill-claims:${DID_A}`, value: [{ skill: SKILL_A, level: 'teaching' }] })

    await backfillSkillClaims()

    const rows = await testDb().select().from(skillClaimIndex).where(eq(skillClaimIndex.did, DID_A))
    expect(rows.length).toBe(2)
    const bySkill = new Map(rows.map((r) => [r.skillUri, r.visibility]))
    expect(bySkill.get(SKILL_B)).toBe('public')
    expect(bySkill.get(SKILL_A)).toBe('school')
  })
})
