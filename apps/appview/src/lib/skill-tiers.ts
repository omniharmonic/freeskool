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
import { eq, inArray } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { skillTier } from '../db/schema.js'
// A native JSON import, not `fs.readFileSync` + `JSON.parse`: tsc's `resolveJsonModule`
// type-checks this as the array it is, and (per `package.json`'s `build` script) the file
// is copied next to the compiled output so a `dist/` deployment finds it at the same
// relative path a dev run does — see the `build` script's copy step.
import seedData from './skill-tiers.seed.json' with { type: 'json' }

export type SkillTierValue = 'A' | 'B'

const here = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_TAXONOMY_PATH = path.resolve(here, '../../../../infra/seed/skills/skills-seed.jsonl')

/** Matches a label that itself names a sensitive/high-risk topic. */
export const SENSITIVE_LABEL_RE = /police|ICE|legal|medic|security|encrypt|doxx|squat|prison|jail|raid/i

/** Does this label itself name a sensitive/high-risk topic? Used by `POST /api/skills`
 * (`http/routes/skills.ts`) to set a member-proposed skill to Tier B immediately, rather
 * than waiting on a steward to notice and re-tier it by hand. */
export function isSensitiveLabel(label: string): boolean {
  return SENSITIVE_LABEL_RE.test(label)
}

/** Upsert one skill's tier — the same shape `seedSkillTiers` writes, for a single id. */
export async function setTier(skillId: string, tier: SkillTierValue, reason = 'member proposal: sensitive label'): Promise<void> {
  await getDb()
    .insert(skillTier)
    .values({ skillId, tier, reason, updatedAt: new Date() })
    .onConflictDoUpdate({ target: skillTier.skillId, set: { tier, reason, updatedAt: new Date() } })
}

export async function tierOf(skillId: string): Promise<SkillTierValue> {
  const rows = await getDb().select({ tier: skillTier.tier }).from(skillTier).where(eq(skillTier.skillId, skillId)).limit(1)
  return rows[0]?.tier === 'B' ? 'B' : 'A'
}

/**
 * Batched `tierOf`, for the taxonomy endpoints (`http/routes/skills.ts`), which return
 * hundreds of nodes at once — one query for the whole set rather than one per skill.
 * Defaults every id not in `fs_skill_tier` to `'A'`, same as `tierOf`.
 */
export async function tiersFor(skillIds: string[]): Promise<Record<string, SkillTierValue>> {
  const out: Record<string, SkillTierValue> = {}
  for (const id of skillIds) out[id] = 'A'
  if (skillIds.length === 0) return out
  const rows = await getDb()
    .select({ skillId: skillTier.skillId, tier: skillTier.tier })
    .from(skillTier)
    .where(inArray(skillTier.skillId, skillIds))
  for (const r of rows) if (r.tier === 'B') out[r.skillId] = 'B'
  return out
}

/** The curated Tier B list, named in the task brief verbatim. */
export function explicitTierBSlugs(): string[] {
  if (!Array.isArray(seedData)) return []
  return (seedData as unknown[]).filter((x): x is string => typeof x === 'string')
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
