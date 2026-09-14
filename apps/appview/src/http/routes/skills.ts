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
import { z } from 'zod'
import { and, eq, gte } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { requireViewer, withViewer } from '../session.js'
import { config } from '../../config.js'
import { getDb } from '../../db/index.js'
import { skillProposal } from '../../db/schema.js'
import { rowId } from '../../lib/ids.js'
import { getIndexer } from '../../index/indexer.js'
import { listCollection, sidecarsForEvent } from '../../index/queries.js'
import { tiersFor, isSensitiveLabel, setTier, type SkillTierValue } from '../../lib/skill-tiers.js'
import { peopleForSkill } from '../../lib/members.js'
import { authorityClient } from '../../lib/authority.js'
import { normalizeLabel, slugify } from '../../lib/slug.js'

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

/**
 * When `AUTHORITY_DID` is configured, ignore every skill record written by any other
 * DID — how a dev index carrying two duplicate taxonomy authorities gets scoped down
 * to the one that matters. Empty (the default) is a no-op.
 */
function scopedToAuthority<T>(records: Array<{ did: string } & T>): Array<{ did: string } & T> {
  const authorityDid = config().AUTHORITY_DID
  return authorityDid ? records.filter((r) => r.did === authorityDid) : records
}

/**
 * Every taxonomy record the routes may use. The authority scope is applied IN the
 * query, not after it: `listCollection` caps at 1000 rows, and a dev index carrying a
 * second, stale authority (2 × 525 rows) would otherwise truncate the real one to
 * whatever fit under the cap. The post-filter stays as belt-and-braces.
 */
export async function skillRecords(indexer: Awaited<ReturnType<typeof getIndexer>>) {
  const authorityDid = config().AUTHORITY_DID
  const { records } = await listCollection<SkillRecord>(indexer, 'skill', {
    limit: 1000,
    ...(authorityDid ? { did: authorityDid } : {}),
  })
  return scopedToAuthority(records)
}

skills.get('/skills', async (c) => {
  // Production was hiding 306 of 525 seeded skills because this defaulted to
  // excluding `proposed` nodes; now they show by default and `?includeProposed=0`
  // restores the old, hidden behavior for anyone who wants it.
  const includeProposed = c.req.query('includeProposed') !== '0'
  const includeDeprecated = c.req.query('includeDeprecated') === '1'
  const indexer = await getIndexer()
  const records = await skillRecords(indexer)
  const nodes = records.filter((r) => {
    if (r.value.status === 'proposed') return includeProposed
    if (r.value.status === 'deprecated') return includeDeprecated
    return true
  })

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

// `withViewer` never rejects (public readers keep working); it only populates
// `c.var.viewer` when a session cookie is present, which is what gates `people` below.
// The global `withViewer` in `http/app.ts` already covers this in production — repeated
// here so the route behaves the same if this router is ever mounted/tested on its own.
skills.get('/skills/:id', withViewer, async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const indexer = await getIndexer()
  // Deliberately no status filter here (unlike `/skills`): a deprecated node must
  // still resolve directly so an existing claim against it keeps working.
  const records = await skillRecords(indexer)
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

  // Members directory (R9): who has this skill, ONLY for a signed-in viewer — an
  // anonymous reader of this otherwise-public endpoint must never see the roster.
  const people = c.var.viewer ? await peopleForSkill(uri, c.var.viewer.did) : undefined

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
    ...(people ? { people } : {}),
  })
})

const proposeBody = z.object({
  label: z.string().trim().min(2).max(80),
  description: z.string().trim().max(300).optional(),
  parentUri: z.string().startsWith('at://'),
})

/** 20 proposals per member per calendar day, counted by `fs_skill_proposal` rows —
 * generous enough for a real contributor, cheap enough to not need a token bucket. */
const MAX_PROPOSALS_PER_DAY = 20

function toSkillNode(r: { uri: string; value: SkillRecord }, tier: SkillTierValue): SkillNode {
  return {
    uri: r.uri,
    id: r.value.id,
    label: r.value.label,
    ...(r.value.description ? { description: r.value.description } : {}),
    status: r.value.status,
    tier,
    alsoUnder: (r.value.broader ?? []).slice(1),
    children: [],
  }
}

/**
 * R-6: a member's proposal publishes IMMEDIATELY as `status: 'proposed'` under the
 * taxonomy authority — no steward approval gates it into existence, only deprecate/move
 * afterwards (`http/routes/admin.ts`). Two collision checks, deliberately distinct:
 *
 *   - a SLUG collision: some existing record's `id` already equals `slugify(label)`;
 *   - a SIBLING label collision: a record under the SAME `parentUri` whose label is the
 *     same once case and diacritics are normalized away — this catches a duplicate a
 *     curated seed `id` would miss, since a seeded skill's `id` need not be
 *     `slugify(label)` at all.
 *
 * Either way the response is 409 with the colliding node in the SAME shape the tree
 * returns, so the web picker can jump straight to it instead of erroring blind.
 */
skills.post('/skills', requireViewer, async (c) => {
  const cfg = config()
  if (!cfg.AUTHORITY_DID || !cfg.AUTHORITY_HANDLE || !cfg.AUTHORITY_PASSWORD) {
    return c.json({ error: 'AuthorityUnavailable' }, 503)
  }

  const parsed = proposeBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'InvalidRequest', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400)
  }
  const { label, description, parentUri } = parsed.data
  const viewer = c.var.viewer!

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recent = await getDb()
    .select({ id: skillProposal.id })
    .from(skillProposal)
    .where(and(eq(skillProposal.proposerDid, viewer.did), gte(skillProposal.createdAt, since)))
  if (recent.length >= MAX_PROPOSALS_PER_DAY) {
    return c.json({ error: 'RateLimited', limit: MAX_PROPOSALS_PER_DAY }, 429)
  }

  const indexer = await getIndexer()
  const records = await skillRecords(indexer)
  const byUri = new Map(records.map((r) => [r.uri, r]))
  const parent = byUri.get(parentUri)
  if (!parent) return c.json({ error: 'ParentNotFound' }, 404)
  if (parent.value.status === 'deprecated') return c.json({ error: 'ParentDeprecated' }, 400)

  const id = slugify(label)
  const normalized = normalizeLabel(label)
  const collision =
    records.find((r) => r.value.id === id) ??
    records.find((r) => (r.value.broader ?? [])[0] === parentUri && normalizeLabel(r.value.label) === normalized)
  if (collision) {
    const tiers = await tiersFor([collision.value.id])
    return c.json({ error: 'SkillExists', existing: toSkillNode(collision, tiers[collision.value.id] ?? 'A') }, 409)
  }

  const createdAt = new Date().toISOString()
  const { uri } = await authorityClient().putSkillRecord({
    id,
    label,
    description,
    broader: [parentUri],
    status: 'proposed',
    createdAt,
  })

  await getDb()
    .insert(skillProposal)
    .values({ id: rowId(), skillUri: uri, proposerDid: viewer.did, status: 'published' })

  let tier: SkillTierValue = 'A'
  if (isSensitiveLabel(label)) {
    await setTier(id, 'B')
    tier = 'B'
  }

  // Read-your-writes: the tree the member sees next must already include this node.
  await indexer.notify(uri)

  return c.json({ uri, id, label, status: 'proposed', tier }, 201)
})
