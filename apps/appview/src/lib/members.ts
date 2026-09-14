/**
 * Members-only people directory (R9: the roster is never public — every caller into this
 * module is reached from a `requireViewer` route). Builds on Task 2/3's tables:
 *
 *   - `fs_member`             every DID that has ever signed in (see `http/session.ts`)
 *   - `fs_member_prefs`       `directoryListing` (default true) gates visibility
 *   - `fs_skill_claim_index`  a member's own claims, public AND school-visibility alike —
 *                             this is a members-only view, not a public one, so the
 *                             school-visibility claims are fair to show another member
 *   - `fs_attestation`        vouch counts, via `lib/attestations.ts`
 *
 * Profile fields (displayName/avatar/bio), handles, badges and skill labels are NOT
 * reimplemented here: they are the same lookups `http/routes/me.ts` and
 * `http/routes/knowledge.ts` already do, exported from there rather than copied.
 */
import { desc, eq, inArray } from 'drizzle-orm'
import { Role, roleLabel } from '@freeschool/shared'
import { getDb } from '../db/index.js'
import { member, memberPrefs, skillClaimIndex } from '../db/schema.js'
import { getIndexer } from '../index/indexer.js'
import { eventsInWindow, sidecarsForEvent } from '../index/queries.js'
import { resolveHostDids } from './events.js'
import { roleOf } from './roles.js'
import { vouchCountsFor, vouchCountsForMany, vouchCountsForSkill, viewerVouches } from './attestations.js'
import { isListed } from '../http/visibility.js'
import type { EventConfig, EventListing } from '../lexicons/coop.js'
import { badgesFor, handlesForDids, labelsForSkills, loadProfile, profilesFor, type Profile } from '../http/routes/me.js'
import { resources } from '../http/routes/knowledge.js'

export interface MemberSummary {
  did: string
  handle?: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  role: number
  roleLabel: string
  claimCount: number
  vouchCount: number
  lastSeenAt: string
}

export interface MemberProfile extends MemberSummary {
  claims: Array<{
    skillUri: string
    skillLabel: string
    level: string
    visibility: 'public' | 'school'
    vouchCount: number
    viewerVouched: boolean
  }>
  /** Same shape as `GET /api/me/badges`: `{ counts, role, badges }`. */
  badges: unknown
  hosting: Array<{ uri: string; name: string; startsAt: string }>
  resources: Array<{ id: string; title: string }>
}

function avatarUrlFor(did: string, profile: Profile): string | undefined {
  return profile.avatar ? `/api/members/${encodeURIComponent(did)}/avatar?v=${profile.avatar.revision}` : undefined
}

/** `directoryListing || did === viewerDid` — the one visibility rule for this whole module. */
export async function memberVisible(did: string, viewerDid: string): Promise<boolean> {
  if (did === viewerDid) return true
  const rows = await getDb()
    .select({ directoryListing: memberPrefs.directoryListing })
    .from(memberPrefs)
    .where(eq(memberPrefs.did, did))
    .limit(1)
  return rows[0]?.directoryListing ?? true
}

async function claimCountsFor(dids: string[]): Promise<Map<string, number>> {
  if (dids.length === 0) return new Map()
  const rows = await getDb()
    .select({ did: skillClaimIndex.did })
    .from(skillClaimIndex)
    .where(inArray(skillClaimIndex.did, dids))
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.did, (out.get(r.did) ?? 0) + 1)
  return out
}

/** `base64("<lastSeenAt-iso>|<did>")` — opaque, and only ever produced/consumed here. */
function encodeCursor(row: { lastSeenAt: Date; did: string }): string {
  return Buffer.from(`${row.lastSeenAt.toISOString()}|${row.did}`, 'utf8').toString('base64')
}

function decodeCursor(raw: string): { lastSeenAt: string; did: string } | null {
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8')
    const sep = decoded.indexOf('|')
    if (sep < 0) return null
    return { lastSeenAt: decoded.slice(0, sep), did: decoded.slice(sep + 1) }
  } catch {
    return null
  }
}

/** True when `row` comes strictly AFTER `cursor` in `lastSeenAt desc, did desc` order. */
function isAfterCursor(row: { lastSeenAt: Date; did: string }, cursor: { lastSeenAt: string; did: string }): boolean {
  const rowTs = row.lastSeenAt.toISOString()
  if (rowTs !== cursor.lastSeenAt) return rowTs < cursor.lastSeenAt
  return row.did < cursor.did
}

/**
 * The directory listing. `q` matches (a substring of, case-insensitive) `displayName`;
 * `skill` is an exact skill AT-URI. Paginated `lastSeenAt desc, did desc` with an opaque
 * cursor. Every candidate row is loaded once (this is a community-scale roster, not a
 * public firehose) and filtered/paginated in memory — simpler, and fast enough here, than
 * pushing a `displayName` substring match into SQL against a JSONB blob.
 */
export async function listMembers(opts: {
  q?: string
  skill?: string
  cursor?: string
  limit?: number
}): Promise<{ members: MemberSummary[]; cursor?: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100)
  const db = getDb()

  let skillDids: Set<string> | null = null
  if (opts.skill) {
    const rows = await db.select({ did: skillClaimIndex.did }).from(skillClaimIndex).where(eq(skillClaimIndex.skillUri, opts.skill))
    skillDids = new Set(rows.map((r) => r.did))
    if (skillDids.size === 0) return { members: [] }
  }

  const rows = await db
    .select({ did: member.did, lastSeenAt: member.lastSeenAt, directoryListing: memberPrefs.directoryListing })
    .from(member)
    .leftJoin(memberPrefs, eq(memberPrefs.did, member.did))
    .orderBy(desc(member.lastSeenAt), desc(member.did))

  let candidates = rows.filter((r) => r.directoryListing !== false && (!skillDids || skillDids.has(r.did)))

  if (opts.q) {
    const needle = opts.q.trim().toLowerCase()
    const profiles = await profilesFor(candidates.map((r) => r.did))
    candidates = candidates.filter((r) => (profiles.get(r.did)?.displayName ?? '').toLowerCase().includes(needle))
  }

  let start = 0
  if (opts.cursor) {
    const decoded = decodeCursor(opts.cursor)
    start = decoded ? candidates.findIndex((r) => isAfterCursor(r, decoded)) : candidates.length
    if (start < 0) start = candidates.length
  }

  const page = candidates.slice(start, start + limit)
  const nextCursor = start + limit < candidates.length ? encodeCursor(page[page.length - 1]!) : undefined

  const dids = page.map((r) => r.did)
  const [profiles, handles, claimCounts, vouchTotals, roles] = await Promise.all([
    profilesFor(dids),
    handlesForDids(dids),
    claimCountsFor(dids),
    vouchCountsForMany(dids),
    Promise.all(dids.map((did) => roleOf(did))),
  ])

  const members: MemberSummary[] = page.map((r, i) => {
    const profile = profiles.get(r.did) ?? {}
    const role = roles[i] ?? Role.Visitor
    return {
      did: r.did,
      ...(handles[r.did] ? { handle: handles[r.did] } : {}),
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(avatarUrlFor(r.did, profile) ? { avatarUrl: avatarUrlFor(r.did, profile) } : {}),
      ...(profile.bio ? { bio: profile.bio } : {}),
      role,
      roleLabel: roleLabel(role),
      claimCount: claimCounts.get(r.did) ?? 0,
      vouchCount: vouchTotals.get(r.did) ?? 0,
      lastSeenAt: r.lastSeenAt.toISOString(),
    }
  })

  return { members, ...(nextCursor ? { cursor: nextCursor } : {}) }
}

/**
 * Upcoming events hosted by this member, respecting the same `isListed` rule the public
 * calendar uses (school listing wins, else the host's own config) — an unlisted or
 * moderator-removed class must not show up here just because a fellow member opened this
 * profile. Simple by design: scans the forward window rather than being indexed by host,
 * which is the "keep it simple" call the brief allows — see the task report.
 */
async function hostingFor(did: string): Promise<Array<{ uri: string; name: string; startsAt: string }>> {
  const indexer = await getIndexer()
  const from = new Date().toISOString()
  const to = new Date(Date.now() + 180 * 86_400_000).toISOString()
  const events = await eventsInWindow(indexer, from, to, 500)
  const hostDids = await resolveHostDids(events)
  const mine = events.filter((e) => (hostDids.get(e.uri) ?? e.did) === did)

  const out: Array<{ uri: string; name: string; startsAt: string }> = []
  for (const e of mine) {
    const [listings, configs] = await Promise.all([
      sidecarsForEvent<EventListing>(indexer, 'eventListing', e.uri),
      sidecarsForEvent<EventConfig>(indexer, 'eventConfig', e.uri),
    ])
    if (!isListed({ listings: listings.map((l) => l.value), configs: configs.map((cfg) => cfg.value) })) continue
    const name = typeof e.value.name === 'string' ? e.value.name : undefined
    const startsAt = typeof e.value.startsAt === 'string' ? e.value.startsAt : undefined
    if (!name || !startsAt) continue
    out.push({ uri: e.uri, name, startsAt })
  }
  out.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  return out.slice(0, 20)
}

/** One member's directory profile, or `null` when not visible to this viewer / not a member. */
export async function memberProfile(did: string, viewerDid: string): Promise<MemberProfile | null> {
  if (!(await memberVisible(did, viewerDid))) return null

  const memberRows = await getDb().select().from(member).where(eq(member.did, did)).limit(1)
  const memberRow = memberRows[0]
  if (!memberRow) return null

  const claimRows = await getDb().select().from(skillClaimIndex).where(eq(skillClaimIndex.did, did))
  const indexer = await getIndexer()

  const [profile, role, vouchBySkill, viewerVouchedSet, badges, handles, hosting, allResources, labels] = await Promise.all([
    loadProfile(did),
    roleOf(did),
    vouchCountsFor(did),
    viewerVouches(viewerDid, did),
    badgesFor(did),
    handlesForDids([did]),
    hostingFor(did),
    resources(),
    labelsForSkills(claimRows.map((r) => r.skillUri), indexer),
  ])

  const claims = claimRows.map((r) => ({
    skillUri: r.skillUri,
    skillLabel: labels[r.skillUri] ?? 'a skill',
    level: r.level,
    visibility: r.visibility as 'public' | 'school',
    vouchCount: vouchBySkill.get(r.skillUri) ?? 0,
    viewerVouched: viewerVouchedSet.has(r.skillUri),
  }))

  return {
    did,
    ...(handles[did] ? { handle: handles[did] } : {}),
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    ...(avatarUrlFor(did, profile) ? { avatarUrl: avatarUrlFor(did, profile) } : {}),
    ...(profile.bio ? { bio: profile.bio } : {}),
    role,
    roleLabel: roleLabel(role),
    claimCount: claimRows.length,
    vouchCount: [...vouchBySkill.values()].reduce((sum, n) => sum + n, 0),
    lastSeenAt: memberRow.lastSeenAt.toISOString(),
    claims,
    badges,
    hosting,
    resources: allResources.filter((r) => r.authorDid === did).map((r) => ({ id: r.id, title: r.title })),
  }
}

/**
 * "People with this skill" for a skill page — visible members only (R9), capped at 50,
 * `count` is the full visible total (for "N people know this") even when the list itself
 * is capped. Only ever called once a viewer exists (`GET /api/skills/:id`'s `withViewer`
 * gate lives in `http/routes/skills.ts`).
 */
export async function peopleForSkill(
  skillUri: string,
  viewerDid: string,
): Promise<{ count: number; members: Array<{ did: string; handle?: string; displayName?: string; avatarUrl?: string; level: string; vouchCount: number }> }> {
  const claimRows = await getDb()
    .select({ did: skillClaimIndex.did, level: skillClaimIndex.level })
    .from(skillClaimIndex)
    .where(eq(skillClaimIndex.skillUri, skillUri))
  if (claimRows.length === 0) return { count: 0, members: [] }

  const dids = claimRows.map((r) => r.did)
  const prefRows = await getDb()
    .select({ did: memberPrefs.did, directoryListing: memberPrefs.directoryListing })
    .from(memberPrefs)
    .where(inArray(memberPrefs.did, dids))
  const hidden = new Set(prefRows.filter((r) => r.directoryListing === false).map((r) => r.did))

  const visible = claimRows.filter((r) => r.did === viewerDid || !hidden.has(r.did))
  const capped = visible.slice(0, 50)
  const cappedDids = capped.map((r) => r.did)

  const [profiles, handles, vouchCounts] = await Promise.all([
    profilesFor(cappedDids),
    handlesForDids(cappedDids),
    vouchCountsForSkill(skillUri, cappedDids),
  ])

  const members = capped.map((r) => {
    const profile = profiles.get(r.did) ?? {}
    return {
      did: r.did,
      ...(handles[r.did] ? { handle: handles[r.did] } : {}),
      ...(profile.displayName ? { displayName: profile.displayName } : {}),
      ...(avatarUrlFor(r.did, profile) ? { avatarUrl: avatarUrlFor(r.did, profile) } : {}),
      level: r.level,
      vouchCount: vouchCounts.get(r.did) ?? 0,
    }
  })

  return { count: visible.length, members }
}
