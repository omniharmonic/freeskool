/**
 * contrail wiring: the Postgres adapter, the peer-registry-driven backfill, and the
 * transactional outbox consumer.
 *
 * What contrail gives us (verified against 0.23.0):
 *   `new Contrail({...config, db})` → `.init()` (schema) → `.discover()` (peer
 *   registry → `listReposByCollection`) → `.backfill()` / `.backfillAll()`
 *   (`com.atproto.repo.listRecords` against each repo's PDS) → `.notify(uri)`
 *   (fetch one record now) → `.query(short, opts)` → `.changes.claim/hydrate/ack`.
 *
 * What it does NOT give us: an ordered change stream over a PDS. `.ingest()` speaks
 * Bluesky Jetstream only. See src/sync/README.md.
 */
import { Contrail } from '@atmo-dev/contrail'
import { createPostgresDatabase } from '@atmo-dev/contrail/postgres'
import type { Database } from '@atmo-dev/contrail'
import { config } from '../config.js'
import { buildContrailConfig } from '../contrail.config.js'
import { getPool } from '../db/index.js'
import { activePeerHosts, seedPeersFromEnv } from './peers.js'
import { seedBackfillsFromListRepos } from './discovery-fallback.js'
import { quietLogger } from '../lib/logging.js'

export interface Indexer {
  contrail: Contrail
  db: Database
  /** Create contrail's schema. Idempotent. */
  init(): Promise<void>
  /** Discover repos from the peer registry, then backfill them. */
  backfillFromPeers(options?: { concurrency?: number }): Promise<{
    discovered: number
    backfilled: number
    seededByFallback: number
    identitiesPinned: number
  }>
  /** Pull one record from its PDS right now (post-write read-your-writes). */
  notify(uris: string | string[]): Promise<void>
  /** Rebuild the instance against the current peer set (peers changed). */
  reload(): Promise<Indexer>
}

let cached: Indexer | undefined

export async function createIndexer(options?: { peers?: string[] }): Promise<Indexer> {
  const c = config()
  await seedPeersFromEnv().catch(() => {
    /* first boot: the table may not exist yet; init() will create it */
  })
  const peers = options?.peers ?? (await activePeerHosts().catch(() => c.PEER_PDS_HOSTS))
  const db = createPostgresDatabase(getPool())
  const contrail = new Contrail({
    ...buildContrailConfig({
      namespace: c.CONTRAIL_NAMESPACE,
      peers: peers.length ? peers : c.PEER_PDS_HOSTS,
      liveIngest: c.CONTRAIL_LIVE_INGEST,
      orderedSourceEpoch: c.CONTRAIL_ORDERED_SOURCE_EPOCH,
      allowedPrivateHosts: c.ALLOWED_PRIVATE_PDS_HOSTS,
      logger: quietLogger,
    }),
    db,
  })

  const indexer: Indexer = {
    contrail,
    db,
    async init() {
      await contrail.init(db)
      // The outbox consumer must be registered before it can be claimed.
      await contrail.changes.register('notify', db).catch((err) => {
        quietLogger.warn('contrail change consumer registration deferred:', describe(err))
      })
    },
    async backfillFromPeers(opts) {
      // Peers that do not serve `listReposByCollection` get their repo list from
      // `listRepos` instead; see ./discovery-fallback.ts. This is a no-op for peers that
      // do serve it.
      const fallback = await seedBackfillsFromListRepos(db, contrail.config, peers.length ? peers : c.PEER_PDS_HOSTS)
      const res = await contrail.backfillAll({ concurrency: opts?.concurrency ?? 25 }, db)
      return {
        discovered: res.discovered,
        backfilled: res.backfilled,
        seededByFallback: fallback.seeded,
        identitiesPinned: fallback.identitiesPinned,
      }
    },
    async notify(uris) {
      await contrail.notify(uris, db)
    },
    async reload() {
      cached = undefined
      return createIndexer()
    },
  }
  return indexer
}

export async function getIndexer(): Promise<Indexer> {
  return (cached ??= await createIndexer())
}

export function resetIndexer(): void {
  cached = undefined
}

function describe(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
