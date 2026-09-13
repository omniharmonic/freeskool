/**
 * `/api/skills` — the taxonomy, as a tree.
 *
 *   GET /skills                 the whole tree (roots + children), built from `broader`
 *   GET /skills/:id             one node, its ancestors, its children, and the classes
 *                               that teach it
 *   PUT /api/me/skill-claims    see ./me.ts — writes `freeschool.draft.skillClaim` into
 *                               the member's own repo with a `visibility` choice
 *
 * `freeschool.draft.skill` uses `broader: string[]` (AT-URIs), so the taxonomy is a DAG,
 * not a tree. We present it as a tree by taking each node's FIRST `broader` as its
 * display parent and exposing the rest as `alsoUnder`; a cycle is broken by depth limit
 * rather than by trusting the data.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import { getIndexer } from '../../index/indexer.js'
import { listCollection, sidecarsForEvent } from '../../index/queries.js'
import { tiersFor, type SkillTierValue } from '../../lib/skill-tiers.js'

export const skills = new Hono<AppEnv>()

interface SkillRecord {
  id: string
  label: string
  description?: string
  broader?: string[]
  prerequisites?: string[]
  status: 'canonical' | 'proposed' | 'deprecated'
  replacedBy?: string
}

export interface SkillNode {
  uri: string
  id: string
  label: string
  description?: string
  status: string
  /** 'A' (ordinary) | 'B' (sensitive/high-risk) — see `lib/skill-tiers.ts`. */
  tier: SkillTierValue
  alsoUnder: string[]
  children: SkillNode[]
}

const MAX_DEPTH = 12

skills.get('/skills', async (c) => {
  const includeProposed = c.req.query('includeProposed') === '1'
  const indexer = await getIndexer()
  const { records } = await listCollection<SkillRecord>(indexer, 'skill', { limit: 1000 })
  const nodes = records.filter((r) => includeProposed || r.value.status !== 'proposed')

  const tiers = await tiersFor(nodes.map((n) => n.value.id))

  const byUri = new Map(nodes.map((n) => [n.uri, n]))
  const childrenOf = new Map<string, string[]>()
  const roots: string[] = []
  for (const n of nodes) {
    const broader = (n.value.broader ?? []).filter((b) => byUri.has(b))
    if (broader.length === 0) {
      roots.push(n.uri)
      continue
    }
    const parent = broader[0]!
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), n.uri])
  }

  const build = (uri: string, depth: number, seen: Set<string>): SkillNode | null => {
    const n = byUri.get(uri)
    if (!n || depth > MAX_DEPTH || seen.has(uri)) return null
    const next = new Set(seen).add(uri)
    return {
      uri: n.uri,
      id: n.value.id,
      label: n.value.label,
      ...(n.value.description ? { description: n.value.description } : {}),
      status: n.value.status,
      tier: tiers[n.value.id] ?? 'A',
      alsoUnder: (n.value.broader ?? []).slice(1),
      children: (childrenOf.get(uri) ?? [])
        .map((child) => build(child, depth + 1, next))
        .filter((x): x is SkillNode => x !== null)
        .sort((a, b) => a.label.localeCompare(b.label)),
    }
  }

  return c.json({
    skills: roots
      .map((uri) => build(uri, 0, new Set()))
      .filter((x): x is SkillNode => x !== null)
      .sort((a, b) => a.label.localeCompare(b.label)),
  })
})

skills.get('/skills/:id', async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const indexer = await getIndexer()
  const { records } = await listCollection<SkillRecord>(indexer, 'skill', { limit: 1000 })
  const byUri = new Map(records.map((r) => [r.uri, r]))
  const self = byUri.get(uri)
  if (!self) return c.json({ error: 'NotFound' }, 404)

  const ancestors: Array<{ uri: string; id: string; label: string }> = []
  let cursor = self
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parentUri = cursor.value.broader?.[0]
    if (!parentUri) break
    const parent = byUri.get(parentUri)
    if (!parent) break
    ancestors.unshift({ uri: parent.uri, id: parent.value.id, label: parent.value.label })
    cursor = parent
  }

  const childRecords = records.filter((r) => (r.value.broader ?? []).includes(uri))

  // Classes that teach this skill, via the skillLevel sidecar's `skill` field.
  const levels = await sidecarsForEvent<{ event: { uri: string }; level: number }>(
    indexer,
    'skillLevel',
    uri,
    'skill',
  )

  // One batched lookup for self + every ancestor + every child, never one query each.
  const tiers = await tiersFor([self.value.id, ...ancestors.map((a) => a.id), ...childRecords.map((r) => r.value.id)])

  return c.json({
    uri: self.uri,
    id: self.value.id,
    label: self.value.label,
    description: self.value.description,
    status: self.value.status,
    tier: tiers[self.value.id] ?? 'A',
    replacedBy: self.value.replacedBy,
    prerequisites: self.value.prerequisites ?? [],
    ancestors: ancestors.map((a) => ({ uri: a.uri, label: a.label, tier: tiers[a.id] ?? 'A' })),
    children: childRecords.map((r) => ({
      uri: r.uri,
      label: r.value.label,
      status: r.value.status,
      tier: tiers[r.value.id] ?? 'A',
    })),
    taughtIn: levels.map((l) => ({ event: l.value.event?.uri, level: l.value.level })),
  })
})
