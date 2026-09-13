/**
 * Gap repair: re-read a peer's records with `com.atproto.repo.listRecords`.
 *
 * The trigger that matters is `#info OutdatedCursor`. A PDS keeps only
 * `PDS_REPO_BACKFILL_LIMIT_MS` (default 24 h) of replayable stream, so any outage
 * longer than that comes back with a leading `#info` and a silent hole where the
 * missed commits were. `@atproto/sync` drops that frame; we act on it. The other
 * triggers are `#account desynchronized`, a `#sync` whose `rev` is ahead of ours, and
 * an event the live source could not index after every retry.
 *
 * Why `listRecords` and not `getRepo`: R4 §"Rate limits" measured `getRepo` CARs at
 * up to 16 MB per repo against a 6000-points/5-min budget, while `listRecords` is
 * collection-scoped and has no per-route limit. A 50-repo registry repairs for the
 * cost of a few hundred paged reads instead of most of a gigabyte.
 *
 * Trust: a whole-host repair enumerates repos with `com.atproto.sync.listRepos`,
 * which is the PEER's claim about which repos it holds. Taking that at face value
 * while also passing `authoritative: true` would let a peer overwrite records
 * attributed to a repo it does not host. So for any host that is not an explicitly
 * trusted private one, every DID is checked against its own DID document before a
 * byte of it is ingested, and a repo already flagged as moved off this peer is
 * skipped outright.
 */
import { backfillDid, type Identity } from '@freeschool/pds-follow'
import { listRepos } from '../index/discovery-fallback.js'
import type { IndexTarget, PeerRepairRequest, RepairQueue, SyncLogger } from './pds-change-source.js'
import type { PeerStateStore } from './peer-state.js'
import { normalizePeerHost } from './cursor-map.js'
import { createIngestEvent, type IngestEvent } from '@atmo-dev/contrail'
import { safe } from '../lib/logging.js'

export interface PeerRepairOptions {
  collections: string[]
  target: IndexTarget
  /** Stable short names per host, so log lines never carry a bare hostname list. */
  nameForHost: (host: string) => string
  logger: SyncLogger
  identity: Identity
  /** Per-repo sync state: the moved-off flag and the pending-delete list. */
  state: PeerStateStore
  /** Hosts for which plain-HTTP / private-network identity resolution is allowed. */
  allowPrivateNetwork?: (host: string) => boolean
  /** Don't repeat a whole-host repair more often than this. */
  cooldownMs?: number
  /** Enumerate the repos on a host. `com.atproto.sync.listRepos` by default. */
  listReposForHost?: (host: string) => Promise<string[]>
  /** DID → its current `#atproto_pds` endpoint. Injectable for tests. */
  resolvePdsEndpoint?: (did: string, host: string) => Promise<string | null>
  /** The record's own application time. Production passes contrail's `recordTimeUs`. */
  recordTimeUs?: (record: unknown, collection: string, fallbackUs: number) => number
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
    const host = normalizePeerHost(request.host)
    const peer = this.options.nameForHost(request.host)
    const trustedPrivateHost = this.options.allowPrivateNetwork?.(request.host) ?? false
    const listFn = this.options.listReposForHost ?? listRepos
    let dids: string[]
    try {
      dids = request.did ? [request.did] : await listFn(request.host)
    } catch (err) {
      this.options.logger.warn('sync: peer repair could not enumerate repos', { peer, detail: describe(err) })
      return
    }
    let records = 0
    let deletes = 0
    let failures = 0
    let skipped = 0
    for (const did of dids) {
      if (this.stopped) return
      if (!(await this.homedHere(host, did, trustedPrivateHost, peer))) {
        skipped++
        continue
      }
      try {
        const result = await backfillDid(this.options.identity, did, this.options.collections, {
          method: 'listRecords',
          // `backfillDid` only honours `verify` on its `getRepo` path, so for the
          // `listRecords` repair the real protection is `homedHere()` above. The flag
          // is still set truthfully, so switching methods cannot quietly drop it.
          verify: !trustedPrivateHost,
          pdsOverride: request.host,
          allowPrivateNetwork: trustedPrivateHost,
        })
        if (result.error) {
          // A PDS answers RepoDeactivated / RepoTakendown / RepoSuspended /
          // RepoNotFound as XRPC errors; `status` is the bounded classification.
          failures++
          this.options.logger.warn('sync: peer repair skipped a repo', {
            peer,
            status: result.status ?? 'error',
          })
          continue
        }
        const fallbackUs = Date.now() * 1000
        const events: IngestEvent[] = result.records.map((record) =>
          createIngestEvent({
            did: record.did,
            collection: record.collection,
            rkey: record.rkey,
            operation: 'update',
            cid: record.cid,
            value: record.record,
            // The record's OWN time, not "now": stamping the repair's wall clock would
            // reorder a repaired event against every event around it, and
            // `authoritative: true` means that wrong time would win.
            timeUs: this.options.recordTimeUs?.(record.record, record.collection, fallbackUs) ?? fallbackUs,
            source: {
              id: REPAIR_SOURCE_ID,
              ...(record.rev ? { revision: record.rev } : {}),
            },
          }),
        )
        const present = new Set(result.records.map((r) => `${r.collection}/${r.rkey}`))
        events.push(...(await this.pendingDeleteEvents(host, did, present, fallbackUs)))
        deletes += events.length - result.records.length
        if (events.length > 0) {
          // A `listRecords` page IS the repo's current state for that collection, so
          // it legitimately supersedes whatever the stream told us before the gap.
          await this.options.target.ingest(events, { authoritative: true })
          records += result.records.length
        }
        await this.options.state.clearPendingDeletes(host, did)
      } catch (err) {
        failures++
        this.options.logger.warn('sync: peer repair failed for one repo', { peer, detail: describe(err) })
      }
    }
    this.options.logger.info('sync: peer repair complete', {
      peer,
      repos: dids.length,
      records,
      deletes,
      failures,
      skipped,
    })
  }

  /**
   * Is this repo really homed on this host?
   *
   * `listRepos` is the peer's own claim. A repo we have already seen move off this
   * peer is never re-read from it, and for any host that is not an explicitly trusted
   * private one the DID document has the final say.
   */
  private async homedHere(host: string, did: string, trustedPrivateHost: boolean, peer: string): Promise<boolean> {
    const stored = await this.options.state.getRepo(host, did).catch(() => undefined)
    if (stored?.movedOffThisPeer) return false
    if (trustedPrivateHost) return true
    try {
      const resolve =
        this.options.resolvePdsEndpoint ??
        (async (d: string) => (await this.options.identity.resolve(d)).pds ?? null)
      const endpoint = await resolve(did, host)
      if (!endpoint) return false
      return normalizePeerHost(endpoint) === host
    } catch (err) {
      // Unresolvable identity is not permission to trust the peer's claim.
      this.options.logger.warn('sync: peer repair could not confirm a repo home', { peer, detail: describe(err) })
      return false
    }
  }

  /**
   * Deletes the live source was told about but could not apply, for records the repo
   * no longer holds. A pending entry whose record came back in the page is dropped
   * without a delete: the record exists again, so deleting it would be wrong.
   */
  private async pendingDeleteEvents(
    host: string,
    did: string,
    present: ReadonlySet<string>,
    fallbackUs: number,
  ): Promise<IngestEvent[]> {
    const pending = await this.options.state.listPendingDeletes(host, did).catch(() => [])
    const out: IngestEvent[] = []
    for (const entry of pending) {
      if (present.has(`${entry.collection}/${entry.rkey}`)) continue
      const at = Date.parse(entry.at)
      out.push(
        createIngestEvent({
          did,
          collection: entry.collection,
          rkey: entry.rkey,
          operation: 'delete',
          cid: null,
          timeUs: Number.isFinite(at) ? at * 1000 : fallbackUs,
          source: { id: REPAIR_SOURCE_ID },
        }),
      )
    }
    return out
  }
}

/** `safe()` keeps the message diagnosable while stripping DIDs, emails and URIs. */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${safe(err.message)}`
  return safe(err)
}
