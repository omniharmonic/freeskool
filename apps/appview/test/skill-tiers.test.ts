/**
 * Tier B marks a skill sensitive/high-risk enough that a public claim needs an explicit
 * confirmation (see `http/routes/me.ts`). The tier lives in `fs_skill_tier`, app-side —
 * never on the lexicon record — so this needs a real Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb } from './helpers/pg.js'
import { explicitTierBSlugs, seedSkillTiers, taxonomyTierBSlugs, tierOf } from '../src/lib/skill-tiers.js'
import { resolveSkillTier } from '../src/http/routes/me.js'
import { skillTier } from '../src/db/schema.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) {
    console.warn(SKIP_MESSAGE)
    return
  }
  // Point getDb() at the same pool the test harness migrated — skill-tiers.ts uses the
  // process-wide singleton, which in a real run is the same DATABASE_URL.
})

beforeEach(async () => {
  if (!available) return
  await testDb().delete(skillTier)
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('the explicit Tier B list', () => {
  it('is non-empty at module load — a JSON import, no readFileSync path to get wrong', () => {
    expect(explicitTierBSlugs().length).toBeGreaterThan(0)
  })

  it('names every sensitive skill the brief requires', () => {
    const slugs = explicitTierBSlugs()
    for (const s of [
      'know-your-rights',
      'street-medicine',
      'ice-raid-response',
      'digital-security',
      'legal-observing',
      'de-escalation',
      'jail-support',
      'squatting',
      'harm-reduction',
    ]) {
      expect(slugs).toContain(s)
    }
  })
})

describe('taxonomy-derived Tier B slugs', () => {
  it('matches organizing/skill-level nodes whose label names a sensitive topic', () => {
    const slugs = taxonomyTierBSlugs()
    expect(slugs).toContain('know-your-rights-with-police')
    expect(slugs).toContain('jail-support')
    expect(slugs).toContain('security-culture')
  })

  it('does not match a domain-level or unrelated node', () => {
    const slugs = taxonomyTierBSlugs()
    expect(slugs).not.toContain('practical-trades')
  })
})

describe('tierOf', () => {
  it('defaults an ordinary skill to Tier A', async () => {
    if (!available) return
    await seedSkillTiers()
    expect(await tierOf('bicycle-repair')).toBe('A')
  })

  it('returns Tier B for an explicitly seeded sensitive skill', async () => {
    if (!available) return
    await seedSkillTiers()
    expect(await tierOf('street-medicine')).toBe('B')
    expect(await tierOf('know-your-rights')).toBe('B')
  })

  it('returns Tier B for a taxonomy-derived sensitive skill', async () => {
    if (!available) return
    await seedSkillTiers()
    expect(await tierOf('know-your-rights-with-police')).toBe('B')
  })

  it('re-running the seed is idempotent', async () => {
    if (!available) return
    await seedSkillTiers()
    const before = (await testDb().select().from(skillTier)).length
    await seedSkillTiers()
    const after = (await testDb().select().from(skillTier)).length
    expect(after).toBe(before)
  })

  it('a fresh DB has Tier B rows after boot-seed (src/index.ts and create-school.ts both call seedSkillTiers)', async () => {
    if (!available) return
    await testDb().delete(skillTier) // simulate a brand-new database, nothing seeded yet
    await seedSkillTiers()
    const rows = await testDb().select().from(skillTier)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.skillId === 'street-medicine' && r.tier === 'B')).toBe(true)
  })
})

describe('resolveSkillTier (me.ts) fails CLOSED for an unresolvable skill', () => {
  it('treats an unresolvable skill (no slug) as Tier B, not Tier A', async () => {
    expect(await resolveSkillTier(undefined)).toBe('B')
  })

  it('still resolves a known, ordinary skill to Tier A', async () => {
    if (!available) return
    await seedSkillTiers()
    expect(await resolveSkillTier('bicycle-repair')).toBe('A')
  })

  it('still resolves a known sensitive skill to Tier B', async () => {
    if (!available) return
    await seedSkillTiers()
    expect(await resolveSkillTier('street-medicine')).toBe('B')
  })
})
