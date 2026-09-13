/**
 * Gap repair: re-read a peer's records with `com.atproto.repo.listRecords`.
 *
 * The trigger that matters is `#info OutdatedCursor`. A PDS keeps only
 * `PDS_REPO_BACKFILL_LIMIT_MS` (default 24 h) of replayable stream, so any outage
 * longer than that comes back with a leading `#info` and a silent hole where the
 * missed commits were. `@atproto/sync` drops that frame; we act on it.
 *
 * Why `listRecords` and not `getRepo`: R4 §"Rate limits" measured `getRepo` CARs at
 * up to 16 MB per repo against a 6000-points/5-min budget, while `listRecords` is
 * collection-scoped and has no per-route limit. A 50-repo registry repairs for the
 * cost of a few hundred paged reads instead of most of a gigabyte.
 *
 * Known limitation, called out in R4 §"Concrete changes" item 7: a `listRecords`
 * repair cannot see a record that was **deleted** during the gap, because it only
 * reports what is still there. Noticing those needs the Sync 1.1 record-state table
 * (did, collection, rkey, cid) to diff against, which is not in this step.
 */
import { backfillDid, type Identity } from '@freeschool/pds-follow'
import { listRepos } from '../index/discovery-fallback.js'
import type { IndexTarget, PeerRepairRequest, RepairQueue, SyncLogger } from './pds-change-source.js'
import { createIngestEvent } from '@atmo-dev/contrail'

export interface PeerRepairOptions {
  collections: string[]
  target: IndexTarget
  /** Stable short names per host, so log lines never carry a bare hostname list. */
  nameForHost: (host: string) => string
  logger: SyncLogger
  identity: Identity
  /** Hosts for which plain-HTTP / private-network identity resolution is allowed. */
  allowPrivateNetwork?: (host: string) => boolean
  /** Don't repeat a whole-host repair more often than this. */
  cooldownMs?: number
  /** Enumerate the repos on a host. `com.atproto.sync.listRepos` by default. */
  listReposForHost?: (host: string) => Promise<string[]>
}

/** Distinguishes repaired records from live-stream ones in contrail's source ordering. */
export const REPAIR_SOURCE_ID = 'pds-listrecords-repair'

/**
 * A serialized repair worker. `enqueue()` returns as soon as the request is
 * accepted; repairs then run one at a time so a gap on a busy registry cannot turn
 * into a thundering herd against every peer at once.
 */
export class PeerRepair implements RepairQueue {
  private readonly lastRunAt = new Map<string, number>()
  private chain: Promise<void> = Promise.resolve()
  private stopped = false

  constructor(private readonly options: PeerRepairOptions) {}

  async enqueue(request: PeerRepairRequest): Promise<void> {
    if (this.stopped) return
    const cooldown = this.options.cooldownMs ?? 5 * 60_000
    const key = `${request.host}|${request.did ?? '*'}`
    const last = this.lastRunAt.get(key)
    if (last !== undefined && Date.now() - last < cooldown) return
    this.lastRunAt.set(key, Date.now())
    this.options.logger.info('sync: peer repair enqueued', {
      peer: this.options.nameForHost(request.host),
      reason: request.reason,
      scope: request.did ? 'repo' : 'host',
    })
    this.chain = this.chain.then(() => this.run(request)).catch(() => {})
    // Deliberately not awaited by the caller's frame handler: a repair can take
    // minutes and the socket must keep draining.
    void this.chain
  }

  /** Wait for every queued repair to finish. Used by tests and by shutdown. */
  async drain(): Promise<void> {
    await this.chain.catch(() => {})
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.drain()
  }

  private async run(request: PeerRepairRequest): Promise<void> {
    if (this.stopped) return
    const peer = this.options.nameForHost(request.host)
    const listFn = this.options.listReposForHost ?? listRepos
    let dids: string[]
    try {
      dids = request.did ? [request.did] : await listFn(request.host)
    } catch (err) {
      this.options.logger.warn('sync: peer repair could not enumerate repos', { peer, detail: describe(err) })
      return
    }
    const allowPrivateNetwork = this.options.allowPrivateNetwork?.(request.host) ?? false
    let records = 0
    let failures = 0
    for (const did of dids) {
      if (this.stopped) return
      try {
        const result = await backfillDid(this.options.identity, did, this.options.collections, {
          method: 'listRecords',
          verify: false,
          pdsOverride: request.host,
          allowPrivateNetwork,
        })
        if (result.error) {
          // A PDS answers RepoDeactivated / RepoTakendown / RepoSuspended /
          // RepoNotFound as XRPC errors. Log the bounded status, never the message:
          // an XRPC error message can quote a URI.
          failures++
          this.options.logger.warn('sync: peer repair skipped a repo', {
            peer,
            status: result.status ?? 'error',
          })
          continue
        }
        const events = result.records.map((record) =>
          createIngestEvent({
            did: record.did,
            collection: record.collection,
            rkey: record.rkey,
            operation: 'update',
            cid: record.cid,
            value: record.record,
            timeUs: Date.now() * 1000,
            source: {
              id: REPAIR_SOURCE_ID,
              ...(record.rev ? { revision: record.rev } : {}),
            },
          }),
        )
        if (events.length > 0) {
          // A `listRecords` page IS the repo's current state for that collection, so
          // it legitimately supersedes whatever the stream told us before the gap.
          await this.options.target.ingest(events, { authoritative: true })
          records += events.length
        }
      } catch (err) {
        failures++
        this.options.logger.warn('sync: peer repair failed for one repo', { peer, detail: describe(err) })
      }
    }
    this.options.logger.info('sync: peer repair complete', { peer, repos: dids.length, records, failures })
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown'
}
