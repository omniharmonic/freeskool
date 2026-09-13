/**
 * Repo discovery for peers that do not serve `com.atproto.sync.listReposByCollection`.
 *
 * The brief assumed a PDS serves that method. The Bluesky reference PDS 0.5.34 does NOT:
 * the request falls through to its AppView proxy and comes back
 * `401 AuthMissing`. It does serve `com.atproto.sync.listRepos`, which enumerates every
 * repo on the host — less selective, but for a small community PDS it is strictly better
 * information, and a school's own PDS is exactly where its members live.
 *
 * So: for any peer that fails the `listReposByCollection` probe, we enumerate with
 * `listRepos` and seed contrail's `backfills` queue ourselves, in the same shape
 * contrail's own `insertDiscoveredDIDs` uses — `(did, collection, completed)` with
 * `ON CONFLICT DO NOTHING`. `contrail.backfill()` then fetches each repo's records with
 * `com.atproto.repo.listRecords` exactly as it would have. Nothing about the projection,
 * the cursors or the outbox changes; only where the DID list comes from.
 *
 * When a peer DOES serve `listReposByCollection`, contrail's own discovery runs and this
 * file does nothing.
 */
import { getCollectionNsids, type ContrailConfig, type Database } from '@atmo-dev/contrail'
import { log } from '../lib/logging.js'
import { probePeer } from './peers.js'

export interface FallbackDiscoveryResult {
  hosts: number
  /** Hosts that did serve listReposByCollection and were left to contrail. */
  nativeHosts: number
  dids: number
  seeded: number
  identitiesPinned: number
}

const PAGE_LIMIT = 1000
const MAX_PAGES = 50

export async function seedBackfillsFromListRepos(
  db: Database,
  config: ContrailConfig,
  hosts: string[],
): Promise<FallbackDiscoveryResult> {
  const collections = getCollectionNsids(config)
  const out: FallbackDiscoveryResult = { hosts: 0, nativeHosts: 0, dids: 0, seeded: 0, identitiesPinned: 0 }
  if (collections.length === 0) return out
  const trusted = new Set(config.networkOverrides?.additionalAllowedHosts?.map((h) => h.toLowerCase()) ?? [])

  for (const host of hosts) {
    const probe = await probePeer(host)
    if (probe.listReposByCollection) {
      out.nativeHosts++
      continue
    }
    if (!probe.listRepos) {
      log.warn('peer serves neither discovery method; skipping', { host: probe.host })
      continue
    }
    out.hosts++
    const dids = await listRepos(probe.host)
    out.dids += dids.length
    out.seeded += await insertBackfills(db, dids, collections)

    /**
     * For an EXPLICITLY TRUSTED host (one listed in `ALLOWED_PRIVATE_PDS_HOSTS` — a local
     * or private PDS the operator put there by hand), pin the identity rows too: the host
     * itself tells us the handle via `describeRepo`, and we already know the endpoint
     * because we just asked it. That skips contrail's per-DID Slingshot + PLC round trips,
     * which for a local PDS are two slow remote calls to learn something we are holding.
     *
     * Only for trusted hosts, deliberately: taking an arbitrary peer's word for "I host
     * this DID" would let it inject records attributed to someone else's repo. For any
     * other peer we seed the work queue and let contrail resolve the DID document itself.
     */
    if (isTrusted(probe.host, trusted)) {
      out.identitiesPinned += await pinIdentities(db, probe.host, dids)
    }
  }
  return out
}

function isTrusted(host: string, trusted: ReadonlySet<string>): boolean {
  try {
    return trusted.has(new URL(host).hostname.toLowerCase())
  } catch {
    return false
  }
}

async function pinIdentities(db: Database, host: string, dids: string[]): Promise<number> {
  let pinned = 0
  for (const did of dids) {
    const handle = await describeRepoHandle(host, did)
    if (!handle) continue
    await db
      .prepare(
        `INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(did) DO UPDATE SET handle = COALESCE(excluded.handle, identities.handle),
                                        pds = COALESCE(excluded.pds, identities.pds),
                                        resolved_at = excluded.resolved_at`,
      )
      .bind(did, handle, host, Date.now())
      .run()
    pinned++
  }
  return pinned
}

async function describeRepoHandle(host: string, did: string): Promise<string | null> {
  try {
    const url = new URL('/xrpc/com.atproto.repo.describeRepo', host)
    url.searchParams.set('repo', did)
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const body = (await res.json()) as { handle?: unknown }
    return typeof body.handle === 'string' ? body.handle : null
  } catch {
    return null
  }
}

export async function listRepos(host: string): Promise<string[]> {
  const dids: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/xrpc/com.atproto.sync.listRepos', host)
    url.searchParams.set('limit', String(PAGE_LIMIT))
    if (cursor) url.searchParams.set('cursor', cursor)
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) break
    const body = (await res.json()) as { repos?: Array<{ did?: unknown; active?: unknown }>; cursor?: unknown }
    for (const repo of body.repos ?? []) {
      // `active: false` is a deactivated or taken-down repo; there is nothing to read.
      if (typeof repo.did === 'string' && repo.did.startsWith('did:') && repo.active !== false) {
        dids.push(repo.did)
      }
    }
    if (typeof body.cursor !== 'string' || !body.cursor) break
    cursor = body.cursor
  }
  return dids
}

/** Exactly contrail's own `insertDiscoveredDIDs` shape, so the queue stays consistent. */
async function insertBackfills(db: Database, dids: string[], collections: string[]): Promise<number> {
  if (dids.length === 0) return 0
  let seeded = 0
  const CHUNK = 50
  for (const collection of collections) {
    for (let i = 0; i < dids.length; i += CHUNK) {
      const chunk = dids.slice(i, i + CHUNK)
      const placeholders = chunk.map(() => '(?, ?, 0)').join(', ')
      const bindings: string[] = []
      for (const did of chunk) bindings.push(did, collection)
      await db
        .prepare(`INSERT INTO backfills (did, collection, completed) VALUES ${placeholders} ON CONFLICT DO NOTHING`)
        .bind(...bindings)
        .run()
      seeded += chunk.length
    }
  }
  return seeded
}
