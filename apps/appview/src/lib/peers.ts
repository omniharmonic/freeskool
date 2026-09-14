/**
 * FEDERATION: the peer list as a RECORD, and the peer schools we can actually see.
 *
 * `index/peers.ts` is the TABLE — `fs_peer`, one row per (school, PDS host), which is
 * what contrail is handed as `relays` and what the live-sync sockets follow. This module
 * is the half that faces the network:
 *
 *   - `publishPeerState()` writes the school's own `freeschool.draft.school` record with
 *     `peers` (DIDs) and `tags`, THROUGH the school's actor port, read-modify-write so
 *     every other field of the record survives (ruling 9, interop gap 4b). The record is
 *     the source of truth a peer reads; `fs_peer` is only ever our local following list.
 *   - `peerSchools()` reads the school records we have INDEXED from our peer hosts —
 *     "who else is out there", answered from public records and nothing else.
 *   - `peerHostSet()` / `reloadIndexerForPeers()` keep contrail's `relays` equal to the
 *     UNION of every school's peer rows, because the index is global (MS §4) even though
 *     the registry is per school.
 *
 * WHY DIDs AND NOT HOSTS IN THE RECORD. `freeschool.draft.school#peers` is
 * `items: { format: did }`: a peer is a SCHOOL, not a machine, and a school that moves
 * PDS keeps its DID. `syncPeersFromSchoolRecord()` closes the loop in the other
 * direction — a DID we read from a peer's record is resolved to its endpoint and
 * followed — which is what makes federation transitive.
 *
 * NO COUNTS, EVER (ruling 7). A peer school is a name, a region, a front door and the
 * tags it routes on. How many members or classes it has is not a public record, and this
 * module is the one place where the temptation to aggregate across schools would appear.
 */
import { getIndexer, type Indexer } from '../index/indexer.js'
import { indexerPeerHosts, listPeers } from '../index/peers.js'
import { listCollection } from '../index/queries.js'
import { normalizePeerHost } from '../sync/cursor-map.js'
import { NSID } from '../lexicons/nsids.js'
import { readRecord } from './pds.js'
import { actorFor, asDid } from './school-actors.js'
import { canonicalHostFor, listSchools, type School } from './schools.js'
import { getDb } from '../db/index.js'
import { schoolDomain } from '../db/schema.js'
import { describeError, log } from './logging.js'
import type { Did } from '@freeschool/school-actor'

/** The record shape, as far as this module cares. Everything else rides through unread. */
export interface SchoolRecord {
  $type?: string
  name?: string
  description?: string
  region?: string
  policy?: string
  handleDomain?: string
  website?: string
  peers?: unknown
  tags?: unknown
  createdAt?: string
  [k: string]: unknown
}

/**
 * One peer school, as its own public record describes it. NO counts — see the module doc.
 * `host` is where a person can visit it: the host WE serve it from when it is co-hosted
 * here, else the hostname of the `website` it published, else absent.
 */
export interface PeerSchool {
  did: string
  name: string
  city: string | null
  host?: string
  tags: string[]
  peers: string[]
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

/* ───────────────────────────── the host set contrail follows ──────────────────────── */

/**
 * Every host this AppView should be following — the union across EVERY school, defined
 * once in `index/peers.ts#indexerPeerHosts` so this and `createIndexer` can never
 * disagree about what "the current peer set" is. Re-exported here because this is the
 * module the HTTP layer talks to.
 */
export async function peerHostSet(): Promise<string[]> {
  return indexerPeerHosts()
}

function sameHosts(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i])
}

/**
 * Rebuild the indexer when — and only when — the host set actually changed. contrail's
 * `relays` are fixed at construction, so a peer added through the admin route is invisible
 * to discovery until the instance is replaced; rebuilding on every peer write regardless
 * would throw away a warm instance for an edit that changed nothing (a steward re-adding a
 * host that is already there).
 */
export async function reloadIndexerForPeers(): Promise<boolean> {
  const want = await peerHostSet()
  try {
    const indexer = await getIndexer()
    const have = [...new Set((indexer.contrail.config.relays ?? []).map(normalizePeerHost))].sort()
    if (sameHosts(want, have)) return false
    await indexer.reload()
    return true
  } catch (err) {
    log.warn('could not reload the indexer for the new peer set', { detail: describeError(err) })
    return false
  }
}

/* ─────────────────────────────── who is out there ─────────────────────────────────── */

/** `identities.pds` for a set of DIDs — how we know which host a repo came from. */
async function pdsHostByDid(indexer: Indexer, dids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const did of dids) {
    try {
      const row = await indexer.db
        .prepare('SELECT pds FROM identities WHERE did = ? LIMIT 1')
        .bind(did)
        .first<{ pds: string | null }>()
      if (row?.pds) out.set(did, normalizePeerHost(row.pds))
    } catch {
      // The index may not be initialized (a unit suite with a fake db): an unknown host
      // is handled by the caller, which falls back to the local school row.
      return out
    }
  }
  return out
}

export interface PeerLookupDeps {
  indexer?: Indexer
  /** Override the peer hosts (tests, and the admin route's not-yet-written host set). */
  hosts?: string[]
  /** The `fs_school` rows, when the caller already has them. */
  localSchools?: School[]
}

interface IndexedSchool {
  did: string
  record: SchoolRecord
  /** The PDS host we indexed it from, when we know it. */
  host?: string
}

/** Every indexed `freeschool.draft.school` record, with the host its repo lives on. */
async function indexedSchools(deps: PeerLookupDeps): Promise<IndexedSchool[]> {
  const indexer = deps.indexer ?? (await getIndexer())
  const { records } = await listCollection<SchoolRecord>(indexer, 'school', { limit: 200 })
  const byDid = await pdsHostByDid(indexer, [...new Set(records.map((r) => r.did))])
  const local = deps.localSchools ?? (await listSchools().catch(() => [] as School[]))
  const localByDid = new Map(local.map((s) => [s.did, s]))
  return records.map((r) => {
    // A school we host ourselves is on OUR PDS whether or not contrail resolved its
    // identity row yet — the `fs_school` row is better evidence than a missing lookup.
    const host = byDid.get(r.did) ?? hostOf(localByDid.get(r.did)?.pdsUrl)
    return { did: r.did, record: r.value, ...(host ? { host } : {}) }
  })
}

function hostOf(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  try {
    return normalizePeerHost(url)
  } catch {
    return undefined
  }
}

/**
 * The peer schools of ONE school: every indexed school record whose repo lives on a host
 * in that school's peer list, minus the school itself. Public records only.
 */
export async function peerSchools(schoolDid: string, deps: PeerLookupDeps = {}): Promise<PeerSchool[]> {
  const hosts = new Set(deps.hosts ? deps.hosts.map(normalizePeerHost) : await peerHostsFor(schoolDid))
  if (hosts.size === 0) return []
  const local = deps.localSchools ?? (await listSchools().catch(() => [] as School[]))
  const domains = await getDb()
    .select()
    .from(schoolDomain)
    .catch(() => [])
  const localByDid = new Map(local.map((s) => [s.did, s]))

  const out: PeerSchool[] = []
  for (const s of await indexedSchools({ ...deps, localSchools: local })) {
    if (s.did === schoolDid) continue
    if (!s.host || !hosts.has(s.host)) continue
    const row = localByDid.get(s.did)
    const region = typeof s.record.region === 'string' && s.record.region ? s.record.region : null
    const host = frontDoor(row, domains, s.record)
    out.push({
      did: s.did,
      name: typeof s.record.name === 'string' && s.record.name ? s.record.name : (row?.name ?? ''),
      city: row?.city ?? region,
      ...(host ? { host } : {}),
      tags: stringArray(s.record.tags),
      peers: stringArray(s.record.peers),
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Where a person goes to see this school: our own host for it, else its published site. */
function frontDoor(
  row: School | undefined,
  domains: Array<typeof schoolDomain.$inferSelect>,
  record: SchoolRecord,
): string | undefined {
  if (row) {
    const host = canonicalHostFor(row, domains)
    if (host) return host
  }
  if (typeof record.website === 'string' && record.website) {
    try {
      return new URL(record.website).host
    } catch {
      return undefined
    }
  }
  return undefined
}

/** ONE school's active peer hosts, normalized. */
export async function peerHostsFor(schoolDid: string): Promise<string[]> {
  const rows = await listPeers(schoolDid).catch(() => [])
  const out = new Set<string>()
  for (const r of rows) {
    try {
      out.add(normalizePeerHost(r.host))
    } catch {
      /* ignore a malformed row */
    }
  }
  return [...out]
}

/* ─────────────────────────── publishing the peer list ─────────────────────────────── */

export interface PublishPeerStateInput {
  schoolDid: string
  callerDid: string
  /** The host set this school will be following AFTER this edit (normalized or not). */
  hosts: string[]
  /** Peer school DIDs the steward named explicitly in this edit. */
  addDids?: string[]
  /** Peer school DIDs to drop, whatever the index believes. */
  removeDids?: string[]
  /** The routing tags to publish. Omit to keep whatever the record already says. */
  tags?: string[]
  /** Test seam: the indexer used to discover peer school DIDs on those hosts. */
  deps?: PeerLookupDeps
  /** The school row, for the name a record has to carry when there is none yet. */
  school?: School
}

export interface PublishedPeerState {
  peers: string[]
  tags: string[]
  uri?: string
  cid?: string
  auditId?: string
  /** The record could not be READ (not: does not exist). Display-only — see below. */
  unreadable?: boolean
}

/**
 * What the school record currently says, for DISPLAY (`GET /api/admin/peers`).
 *
 * A read failure is reported as `unreadable` rather than thrown: a steward opening the
 * peers screen while the PDS is having a bad minute should see "we could not read it",
 * not a 500 — and, unlike the write path below, nothing is decided from this answer.
 */
export async function publishedPeerState(schoolDid: string): Promise<PublishedPeerState> {
  try {
    const record = await readSchoolRecord(schoolDid)
    return {
      peers: stringArray(record?.peers),
      tags: stringArray(record?.tags),
      ...(record ? { uri: `at://${schoolDid}/${NSID.school}/self` } : {}),
    }
  } catch (err) {
    log.warn('could not read the school record for the peers screen', { detail: describeError(err) })
    return { peers: [], tags: [], unreadable: true }
  }
}

/**
 * The school's own record, or `null` when the repo genuinely has none.
 *
 * THROWS on a read we did not get (`RecordReadError`, a network failure). The difference
 * is the whole point: `publishPeerState` synthesizes a record when there is none, and
 * synthesizing one because the PDS was briefly unreachable would overwrite the real
 * record's `policy` pointer, `handleDomain`, `description` and `website` — and a school
 * record with no `policy` makes `refreshPolicyCache` fall back to the permissive default
 * thresholds. A failed read must stop the write, not guess at it.
 */
async function readSchoolRecord(schoolDid: string): Promise<SchoolRecord | null> {
  const res = await readRecord(schoolDid, NSID.school, 'self')
  return res.found ? (res.value as SchoolRecord) : null
}

/**
 * Re-publish `peers` and `tags` in the school's own record, as the school.
 *
 * WHAT IS PUBLISHED. The existing `peers` array, plus every DID the steward named, plus
 * every peer school we can SEE on the school's (new) host set — minus the DIDs whose host
 * we know and which is no longer followed, and minus anything explicitly removed. Keeping
 * the existing array is what makes repeated edits monotone: a peer that has not been
 * indexed yet (or whose host we cannot attribute) is never silently dropped by an
 * unrelated edit.
 *
 * READ-MODIFY-WRITE. Every other field of the record — `policy`, `handleDomain`,
 * `description`, `website`, `createdAt` — is carried across verbatim. This is the same
 * discipline `PUT /api/admin/policy` uses on the same record, and the reason the two can
 * never clobber each other's field.
 *
 * THROWS on a failed write — and on a failed READ, which is the same rule seen from the
 * other end: the caller writes the table only afterwards, so a PDS that refuses (or that
 * we could not reach to read) leaves `fs_peer` exactly as it was and the actor is never
 * called. A record is synthesized ONLY when the repo really has none (`RecordNotFound`).
 */
export async function publishPeerState(input: PublishPeerStateInput): Promise<PublishedPeerState> {
  const hosts = new Set(
    input.hosts.flatMap((h) => {
      try {
        return [normalizePeerHost(h)]
      } catch {
        return []
      }
    }),
  )
  const existing = await readSchoolRecord(input.schoolDid)

  const discovered = await indexedSchools(input.deps ?? {})
  const hostByDid = new Map(discovered.filter((s) => s.host).map((s) => [s.did, s.host!]))

  const peers = new Set<string>(stringArray(existing?.peers))
  for (const did of input.addDids ?? []) peers.add(did)
  for (const s of discovered) {
    if (s.did === input.schoolDid) continue
    if (s.host && hosts.has(s.host)) peers.add(s.did)
  }
  for (const did of input.removeDids ?? []) peers.delete(did)
  for (const did of [...peers]) {
    if (did === input.schoolDid) peers.delete(did)
    // A DID whose host we know and no longer follow is no longer a peer. One whose host
    // we cannot attribute is left alone — silence is not evidence of a broken affiliation.
    const host = hostByDid.get(did)
    if (host && !hosts.has(host)) peers.delete(did)
  }

  const tags = input.tags ?? stringArray(existing?.tags)
  const published = [...peers].sort()

  const record: SchoolRecord = {
    ...(existing ?? {
      name: input.school?.name || 'Free School',
      ...(input.school?.city ? { region: input.school.city } : {}),
      createdAt: new Date().toISOString(),
    }),
    $type: NSID.school,
    peers: published,
    tags,
  }

  const res = await (
    await actorFor(input.schoolDid)
  ).putRecordAsSchool({
    schoolDid: asDid(input.schoolDid),
    callerDid: input.callerDid as Did,
    scope: NSID.school,
    action: 'set-peers',
    collection: NSID.school,
    rkey: 'self',
    record: record as Record<string, unknown>,
    audit: {
      reason: `publish the peer list (${published.length} peer${published.length === 1 ? '' : 's'}) and routing tags`,
    },
  })
  return { peers: published, tags, uri: res.uri, cid: res.cid, auditId: res.auditId }
}
