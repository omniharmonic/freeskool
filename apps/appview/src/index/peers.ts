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
import { eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { peer } from '../db/schema.js'
import { config } from '../config.js'
import { resolvePdsEndpoint } from '../lib/identity.js'

export type PeerSource = 'env' | 'school-record' | 'admin'

function normalizeHost(host: string): string {
  const u = new URL(host.includes('://') ? host : `https://${host}`)
  return `${u.protocol}//${u.host}`
}

export async function seedPeersFromEnv(): Promise<void> {
  const db = getDb()
  for (const host of config().PEER_PDS_HOSTS) {
    await db
      .insert(peer)
      .values({ host: normalizeHost(host), source: 'env' })
      .onConflictDoNothing()
  }
}

export async function addPeer(host: string, source: PeerSource, schoolDid?: string): Promise<void> {
  await getDb()
    .insert(peer)
    .values({ host: normalizeHost(host), source, schoolDid: schoolDid ?? null })
    .onConflictDoUpdate({
      target: peer.host,
      set: { source, schoolDid: schoolDid ?? null, disabledAt: null },
    })
}

export async function disablePeer(host: string): Promise<void> {
  await getDb()
    .update(peer)
    .set({ disabledAt: new Date() })
    .where(eq(peer.host, normalizeHost(host)))
}

export async function listPeers(): Promise<Array<{ host: string; source: string; schoolDid: string | null }>> {
  const rows = await getDb()
    .select({ host: peer.host, source: peer.source, schoolDid: peer.schoolDid })
    .from(peer)
    .where(isNull(peer.disabledAt))
  return rows
}

export async function activePeerHosts(): Promise<string[]> {
  return (await listPeers()).map((r) => r.host)
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
