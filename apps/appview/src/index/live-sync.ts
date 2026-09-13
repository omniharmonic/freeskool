/**
 * Registration: build a `PdsChangeSource` from the peer registry and run it.
 *
 * This is the only place that knows how the abstract pieces in `src/sync/` are
 * satisfied in production:
 *
 *   `IndexTarget`   → contrail's `ingestRecords` (the single admission path every
 *                     source uses — Jetstream, PDS backfill and us alike, so the
 *                     source-ordering guard dedupes us against the 15-minute
 *                     backfill for free)
 *   `PeerStateStore`→ `AppMetaPeerState`, our own `fs_app_meta` table
 *   `RepairQueue`   → `PeerRepair`, a serialized `listRecords` re-read
 *
 * The 15-minute `backfillFromPeers` job stays exactly as it was: live sync is the
 * fast path, never the only path. If a socket is down, or the process was off for
 * longer than a peer's stream retention, the periodic backfill still closes the gap.
 */
import { getCollectionNsids, ingestRecords, recordTimeUs, type IngestEvent } from '@atmo-dev/contrail'
import { Identity } from '@freeschool/pds-follow'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { log } from '../lib/logging.js'
import { AppMetaPeerState } from '../sync/peer-state.js'
import { PeerRepair } from '../sync/repair.js'
import { PdsChangeSource, type IndexTarget, type PeerHostRef } from '../sync/pds-change-source.js'
import { listPeers } from './peers.js'
import type { Indexer } from './indexer.js'

export interface LiveSync {
  source: PdsChangeSource
  stop(): Promise<void>
}

/** `freeschool-appview/<version> (+<public url>)`, so peer operators can contact us. */
export function peerUserAgent(version: string, publicUrl: string): string {
  return `freeschool-appview/${version} (+${publicUrl})`
}

/**
 * A short, stable, log-safe name for a peer host.
 *
 * R9 forbids DIDs in logs; a hostname is not a DID, but the peer registry is also
 * not public, so we log the leading label only (`pds.example.org` → `pds`) and fall
 * back to the full hostname when that would be empty.
 */
export function peerName(host: string): string {
  try {
    const hostname = new URL(host).hostname
    // An IP literal has no meaningful leading label; `127` would be useless in a log.
    if (/^\d|^\[/.test(hostname)) return hostname
    return hostname.split('.')[0] || hostname
  } catch {
    return 'peer'
  }
}

/** contrail's `ingestRecords`, behind the source's narrow seam. */
export function contrailTarget(indexer: Indexer): IndexTarget {
  return {
    async ingest(events: IngestEvent[], options) {
      const result = await ingestRecords(indexer.db, events, indexer.contrail.config, {
        phase: 'live',
        ...(options?.authoritative ? { authoritativeSourceObservation: true } : {}),
      })
      return { accepted: result.accepted.length }
    },
  }
}

/**
 * Start one `subscribeRepos` socket per active peer host.
 *
 * Returns `undefined` when there is nothing to follow, so the caller does not have
 * to special-case an empty registry.
 */
export async function startPeerLiveSync(indexer: Indexer): Promise<LiveSync | undefined> {
  const c = config()
  const registry = await listPeers().catch(() => [])
  const hosts: PeerHostRef[] = (registry.length > 0 ? registry.map((r) => r.host) : c.PEER_PDS_HOSTS).map((host) => {
    const privateHost = isPrivateHost(host, c.ALLOWED_PRIVATE_PDS_HOSTS)
    return {
      host,
      name: peerName(host),
      // A local/private PDS mints DIDs a public PLC may not have yet, so commit
      // signature verification would reject its whole stream. Public peers are
      // always verified.
      unauthenticatedCommits: privateHost,
      allowPrivateNetwork: privateHost,
    }
  })
  if (hosts.length === 0) return undefined

  const userAgent = peerUserAgent(APPVIEW_VERSION, c.APPVIEW_PUBLIC_URL)
  const collections = getCollectionNsids(indexer.contrail.config)
  const target = contrailTarget(indexer)
  const identity = new Identity('https://plc.directory')
  const byHost = new Map(hosts.map((h) => [h.host, h]))
  const repair = new PeerRepair({
    collections,
    target,
    nameForHost: (host) => byHost.get(host)?.name ?? peerName(host),
    logger: log,
    identity,
    allowPrivateNetwork: (host) => byHost.get(host)?.allowPrivateNetwork ?? false,
  })

  const source = new PdsChangeSource({
    hosts,
    // The epoch pins a cursor map to one peer set. Adding a peer must be a visible
    // continuity break, not a silent gap, so the peer count is part of it.
    epoch: `${c.CONTRAIL_ORDERED_SOURCE_EPOCH}-peers-${hosts.length}`,
    collections,
    userAgent,
    state: new AppMetaPeerState(getDb()),
    target,
    repair,
    logger: log,
    recordTimeUs: (record, collection, fallbackUs) =>
      recordTimeUs(record, collection, indexer.contrail.config, fallbackUs),
  })

  await source.start()
  log.info('sync: peer live sync started', { hosts: hosts.length, collections: collections.length })
  return {
    source,
    async stop() {
      await source.stop()
      await repair.stop()
    },
  }
}

/**
 * Mirrors `package.json`'s `version`. Kept as a literal rather than a JSON import so
 * the built `dist/` tree does not need the manifest beside it;
 * `test/pds-change-source.test.ts` asserts the two have not drifted.
 */
export const APPVIEW_VERSION = '0.0.1'

function isPrivateHost(host: string, allowed: string[]): boolean {
  try {
    const hostname = new URL(host).hostname.toLowerCase()
    return allowed.some((a) => a.toLowerCase() === hostname)
  } catch {
    return false
  }
}
