/**
 * Tier B marks a skill as sensitive/high-risk enough (security culture, legal support,
 * street medicine, ...) that a PUBLIC claim of it needs an explicit confirmation, and an
 * OAuth-door session can never make one at all (see http/routes/me.ts). The tier is an
 * APP-SIDE fact, not a lexicon field — the protocol does not distinguish skills by risk,
 * and we do not want to encode "this topic is dangerous" into a public taxonomy record.
 *
 * Two sources feed `fs_skill_tier`:
 *   - the explicit list in ./skill-tiers.seed.json — named in the brief verbatim;
 *   - a regex match over `infra/seed/skills/skills-seed.jsonl`, for organizing/skill-level
 *     taxonomy nodes whose label itself names a sensitive topic.
 * `seedSkillTiers()` unions both and upserts. `tierOf()` defaults to 'A' for anything not
 * in the table — most skills (bicycle repair, knitting, ...) are ordinary.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { skillTier } from '../db/schema.js'

export type SkillTierValue = 'A' | 'B'

const here = path.dirname(fileURLToPath(import.meta.url))
const SEED_PATH = path.resolve(here, './skill-tiers.seed.json')
const DEFAULT_TAXONOMY_PATH = path.resolve(here, '../../../../infra/seed/skills/skills-seed.jsonl')

/** Matches a label that itself names a sensitive/high-risk topic. */
const SENSITIVE_LABEL_RE = /police|ICE|legal|medic|security|encrypt|doxx|squat|prison|jail|raid/i

export async function tierOf(skillId: string): Promise<SkillTierValue> {
  const rows = await getDb().select({ tier: skillTier.tier }).from(skillTier).where(eq(skillTier.skillId, skillId)).limit(1)
  return rows[0]?.tier === 'B' ? 'B' : 'A'
}

/** The curated Tier B list, named in the task brief verbatim. */
export function explicitTierBSlugs(): string[] {
  const raw = fs.readFileSync(SEED_PATH, 'utf8')
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.filter((x): x is string => typeof x === 'string')
}

interface TaxonomyRow {
  id?: string
  label?: string
  _provenance?: { domain?: string; level?: string }
}

/** Organizing/skill-level taxonomy nodes whose label names a sensitive topic. */
export function taxonomyTierBSlugs(taxonomyPath = DEFAULT_TAXONOMY_PATH): string[] {
  if (!fs.existsSync(taxonomyPath)) return []
  const lines = fs.readFileSync(taxonomyPath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  const out: string[] = []
  for (const line of lines) {
    let row: TaxonomyRow
    try {
      row = JSON.parse(line) as TaxonomyRow
    } catch {
      continue
    }
    if (
      row._provenance?.domain === 'organizing' &&
      row._provenance?.level === 'skill' &&
      typeof row.label === 'string' &&
      SENSITIVE_LABEL_RE.test(row.label) &&
      typeof row.id === 'string'
    ) {
      out.push(row.id)
    }
  }
  return out
}

export async function seedSkillTiers(taxonomyPath = DEFAULT_TAXONOMY_PATH): Promise<{ seeded: number }> {
  const slugs = new Set([...explicitTierBSlugs(), ...taxonomyTierBSlugs(taxonomyPath)])
  const db = getDb()
  for (const skillId of slugs) {
    await db
      .insert(skillTier)
      .values({ skillId, tier: 'B', reason: 'seeded: sensitive/high-risk skill', updatedAt: new Date() })
      .onConflictDoUpdate({
        target: skillTier.skillId,
        set: { tier: 'B', reason: 'seeded: sensitive/high-risk skill', updatedAt: new Date() },
      })
  }
  return { seeded: slugs.size }
}
