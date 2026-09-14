/**
 * Deterministic ids and label comparison for member-proposed skills
 * (`POST /api/skills`, `http/routes/skills.ts`).
 *
 * `slugify(label)` is the proposed skill's `rkey`/`id` — the same shape
 * `packages/lexicons/scripts/seed-skills.mjs` gives every seeded row: lowercase,
 * ASCII, dash-separated, no leading/trailing dash, at most 60 characters.
 *
 * `normalizeLabel(label)` is the comparator behind the "a sibling already has this
 * label" collision check: case- and diacritic-insensitive, but — unlike `slugify` —
 * it keeps words apart with a single space rather than collapsing everything to
 * dashes, so it stays a distinct check from the slug collision (an existing seeded
 * skill's `id` is curated, not necessarily `slugify(label)`).
 */

const MAX_SLUG_LENGTH = 60

function stripDiacritics(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

export function slugify(label: string): string {
  const slug = stripDiacritics(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
  // Truncation can land mid dash-run; trim again so the cap never leaves a trailing dash.
  return slug.replace(/-+$/g, '')
}

export function normalizeLabel(label: string): string {
  return stripDiacritics(label).toLowerCase().trim().replace(/\s+/g, ' ')
}
