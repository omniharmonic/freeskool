/**
 * The skill taxonomy, flattened and searchable.
 *
 * `GET /api/skills` returns the taxonomy as a nested tree (745 nodes in the
 * seed). Every screen that lets someone pick a skill wants the same thing out
 * of it: one flat list, each entry carrying enough context to be recognisable
 * on its own ("Crafts › Textiles › Mending"), plus a ranked type-ahead over
 * it. Three screens each kept their own `flattenSkills` copy before this —
 * this module is the single one.
 *
 * Matching is diacritic-insensitive on both sides: "cafe" finds "Café
 * culture", and "café" finds it too. Nothing here filters by `status`; a
 * deprecated node is still a real answer to "what did I pick last year", and
 * hiding it would silently change what the screens show.
 */
import type { SkillNode, SkillTier } from './types';

/** The separator the taxonomy breadcrumb uses everywhere in the app. */
export const SKILL_PATH_SEPARATOR = ' › ';

export interface FlatSkill {
  uri: string;
  label: string;
  /** Every ancestor label plus this one: "Crafts › Textiles › Mending". */
  path: string;
  /** The depth-1 ancestor's label — '' for a domain or a root-level skill. */
  area: string;
  /** The depth-0 ancestor's label — '' for a root-level skill. */
  domain: string;
  tier: SkillTier;
  status: string;
  description?: string;
  /** 0 for a domain, 1 for an area, 2+ for anything below. */
  depth: number;
  /** The depth-1 ancestor's uri, when there is one. */
  areaUri?: string;
  /** The depth-0 ancestor's uri, when there is one. */
  domainUri?: string;
}

/**
 * Depth-first, parents before children — so a picker's results read down the
 * taxonomy in the order a person would browse it. `alsoUnder` is deliberately
 * not traversed: a node appears once, under its canonical parent, or the same
 * skill would show up twice in one result list.
 */
export function flattenSkills(nodes: SkillNode[], trail: Array<{ uri: string; label: string }> = []): FlatSkill[] {
  const out: FlatSkill[] = [];
  for (const node of nodes) {
    const here = [...trail, { uri: node.uri, label: node.label }];
    out.push({
      uri: node.uri,
      label: node.label,
      path: here.map((step) => step.label).join(SKILL_PATH_SEPARATOR),
      domain: trail[0]?.label ?? '',
      area: trail[1]?.label ?? '',
      domainUri: trail[0]?.uri,
      areaUri: trail[1]?.uri,
      depth: trail.length,
      tier: node.tier,
      status: node.status,
      ...(node.description ? { description: node.description } : {}),
    });
    out.push(...flattenSkills(node.children, here));
  }
  return out;
}

/** "Crafts › Textiles" — the two levels above a skill, for a secondary line. */
export function skillContext(skill: FlatSkill): string {
  return [skill.domain, skill.area].filter(Boolean).join(SKILL_PATH_SEPARATOR);
}

const COMBINING_MARKS = /[̀-ͯ]/g;

/** Case-folded and diacritic-stripped, so "café" and "cafe" are one key. */
export function normalizeForSearch(value: string): string {
  return value.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().trim();
}

/**
 * Ranked type-ahead. A label prefix beats a label substring beats a match that
 * only turns up in the breadcrumb path or the description — so typing "mend"
 * puts "Mending" above a sourdough note that happens to mention mending a
 * starter. Ties break on the shorter label first (the more general node), then
 * on taxonomy order, so results never shuffle between keystrokes.
 */
export function searchSkills(skills: FlatSkill[], query: string, limit = 12): FlatSkill[] {
  const needle = normalizeForSearch(query);
  if (!needle) return [];

  const hits: Array<{ skill: FlatSkill; rank: number; order: number }> = [];
  skills.forEach((skill, order) => {
    const label = normalizeForSearch(skill.label);
    let rank = -1;
    if (label.startsWith(needle)) rank = 0;
    else if (label.includes(needle)) rank = 1;
    else if (
      normalizeForSearch(skill.path).includes(needle) ||
      (skill.description ? normalizeForSearch(skill.description).includes(needle) : false)
    )
      rank = 2;
    if (rank >= 0) hits.push({ skill, rank, order });
  });

  hits.sort((a, b) => a.rank - b.rank || a.skill.label.length - b.skill.label.length || a.order - b.order);
  return hits.slice(0, limit).map((hit) => hit.skill);
}

/** The nodes a new skill may be proposed under: domains and areas only. */
export function parentOptions(skills: FlatSkill[]): FlatSkill[] {
  return skills.filter((skill) => skill.depth <= 1);
}

/**
 * Where a proposal made from `skill` should land by default — the area it
 * sits in, or the node itself when it is already a domain or an area.
 */
export function proposeParentFor(skill: FlatSkill): string {
  if (skill.depth <= 1) return skill.uri;
  return skill.areaUri ?? skill.domainUri ?? skill.uri;
}
