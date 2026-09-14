/**
 * The peer registry. contrail's `relays` option is, for us, "the list of PDS hosts to
 * ask which repos carry our collections" — see `fetchPage()` in contrail's backfill:
 * it only ever calls `GET /xrpc/com.atproto.sync.listReposByCollection` on each entry,
 * which is a PDS-serveable method. There is no relay protocol involved.
 *
 * Sources, in order of precedence:
 *   1. `PEER_PDS_HOSTS` env (seeded into `fs_peer` with source='env')
 *   2. the school's `freeschool.draft.school` record `peers: did[]` — each peer DID is
 *      resolved to its PDS endpoint and added with source='school-record'
 *   3. `PUT /api/admin/peers` (source='admin')
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { peer } from '../db/schema.js'
import { config } from '../config.js'
import { resolvePdsEndpoint } from '../lib/identity.js'
import { legacySchoolDid } from '../lib/schools.js'
import { schoolScope } from '../lib/school-scope.js'

export type PeerSource = 'env' | 'school-record' | 'admin'

function normalizeHost(host: string): string {
  const u = new URL(host.includes('://') ? host : `https://${host}`)
  return `${u.protocol}//${u.host}`
}

/**
 * `PEER_PDS_HOSTS` seeds the LEGACY school's peer list: it is one env var and there is
 * more than one school (MS Appendix B — "seeds `fs_peer` for the default school;
 * per-school after that").
 */
export async function seedPeersFromEnv(): Promise<void> {
  const db = getDb()
  for (const host of config().PEER_PDS_HOSTS) {
    await db
      .insert(peer)
      .values({ host: normalizeHost(host), source: 'env', schoolDid: legacySchoolDid() })
      .onConflictDoNothing()
  }
}

export async function addPeer(host: string, source: PeerSource, schoolDid = legacySchoolDid()): Promise<void> {
  await getDb()
    .insert(peer)
    .values({ host: normalizeHost(host), source, schoolDid })
    .onConflictDoUpdate({
      target: [peer.schoolDid, peer.host],
      set: { source, disabledAt: null },
    })
}

export async function disablePeer(host: string, schoolDid = legacySchoolDid()): Promise<void> {
  await getDb()
    .update(peer)
    .set({ disabledAt: new Date() })
    .where(and(eq(peer.host, normalizeHost(host)), schoolScope(peer.schoolDid, schoolDid)))
}

/** ONE school's peers — what `GET/PUT /api/admin/peers` shows a steward. */
export async function listPeers(schoolDid = legacySchoolDid()): Promise<Array<{ host: string; source: string; schoolDid: string }>> {
  const rows = await getDb()
    .select({ host: peer.host, source: peer.source, schoolDid: peer.schoolDid })
    .from(peer)
    .where(and(isNull(peer.disabledAt), schoolScope(peer.schoolDid, schoolDid)))
  return rows
}

/**
 * EVERY school's peers, deduplicated. contrail's index is global — a repo belongs to a
 * DID, not to a school (MS §4, "Contrail: one index, many schools") — so the thing we
 * hand contrail as `relays` is the UNION, and the per-school view is computed at read
 * time. This is the one peer query that deliberately ignores the school column.
 */
export async function allPeers(): Promise<Array<{ host: string; source: string; schoolDid: string }>> {
  return getDb()
    .select({ host: peer.host, source: peer.source, schoolDid: peer.schoolDid })
    .from(peer)
    .where(isNull(peer.disabledAt))
}

export async function activePeerHosts(): Promise<string[]> {
  return [...new Set((await allPeers()).map((r) => r.host))]
}

/**
 * Walk the school record's `peers` DIDs, resolve each to a PDS endpoint and register
 * it. Called after every refresh of the school record (outbox consumer + boot).
 */
export async function syncPeersFromSchoolRecord(peersDids: string[], schoolDid: string): Promise<string[]> {
  const added: string[] = []
  for (const did of peersDids) {
    const endpoint = await resolvePdsEndpoint(did)
    if (!endpoint) continue
    await addPeer(endpoint, 'school-record', schoolDid)
    added.push(endpoint)
  }
  return added
}

/** Whether a host actually serves the discovery method contrail needs. */
export async function probePeer(host: string): Promise<{ host: string; listReposByCollection: boolean; listRepos: boolean }> {
  const base = normalizeHost(host)
  const probe = async (path: string) => {
    try {
      const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }
  return {
    host: base,
    listReposByCollection: await probe(
      '/xrpc/com.atproto.sync.listReposByCollection?collection=community.lexicon.calendar.event&limit=1',
    ),
    listRepos: await probe('/xrpc/com.atproto.sync.listRepos?limit=1'),
  }
}

export async function peersNeedingFallbackDiscovery(): Promise<string[]> {
  const out: string[] = []
  for (const host of await activePeerHosts()) {
    const p = await probePeer(host)
    if (!p.listReposByCollection && p.listRepos) out.push(p.host)
  }
  return out
}
