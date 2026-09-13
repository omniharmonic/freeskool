/**
 * `PdsChangeSource` — live indexing straight from peer PDS hosts.
 *
 * contrail 0.23 ships exactly one live `ChangeSource`, over Bluesky's Jetstream,
 * which can only see records whose PDS a public relay has crawled. Free School is
 * peer-to-peer at the PDS level and several peers are private, self-hosted, or
 * `http://localhost:3000`, so Jetstream can never see them. This is the missing
 * piece: one `com.atproto.sync.subscribeRepos` socket per peer host, spoken
 * directly, with its own cursor.
 *
 * It wears two hats, both required:
 *
 *   1. **`ChangeSource`** (`id`, `semantics`, `mark`, `read`) — the contract
 *      `bootstrapFreshProjection()` consumes when rebuilding a generation. `mark()`
 *      has to open a socket and take one event's seq because `subscribeRepos` has no
 *      head to ask for, which is what `explicitHead: false` declares.
 *   2. **A steady-state runner** (`start`, `stop`, `flush`) — because
 *      `contrail.ingest()` is hard-wired to Jetstream, the live loop is ours. It
 *      feeds `ingestRecords` through the injected `IndexTarget`.
 *
 * Design constraints this file exists to satisfy (R4 §"AppView notes"):
 *   - one socket per `peer` row, never a shared one: `seq` spaces are per host;
 *   - per-host cursor, debounced and monotonic (see ./peer-state.ts);
 *   - per-DID in-order processing (see ./host-subscription.ts);
 *   - `#account` statuses, all six, mapped to a stored repo status;
 *   - `#identity` → always re-resolve, and flag a repo that moved off this peer;
 *   - `#info OutdatedCursor` → repair every repo on the host (see ./repair.ts);
 *   - a real `User-Agent` so peer operators can identify and contact us;
 *   - backoff capped at 16 s, with reconnects logged by host NAME. Never a DID:
 *     R9 forbids any DID in a log line (see src/lib/logging.ts).
 */
import { createIngestEvent, type ChangeSource, type IngestEvent, type MutationBatch, type PreparedSnapshot, type SourceMutation, type SourcePosition, type SourceSemantics } from '@atmo-dev/contrail'
import { parseCommitAuthenticated, parseCommitUnauthenticated } from '@atproto/sync'
import { IdResolver } from '@atproto/identity'
import { lexToJson } from '@freeschool/pds-follow'
import { cursorMapReached, decodeCursorMap, encodeCursorMap, normalizePeerHost, type CursorMap } from './cursor-map.js'
import { accountStatusFrom, collectionMatcher, OUTDATED_CURSOR, type WireFrame } from './frame-handlers.js'
import {
  DEFAULT_MAX_RECONNECT_SECONDS,
  HostSubscription,
  markHostHead,
  SUBSCRIBE_REPOS,
  type OrderedFrame,
} from './host-subscription.js'
import type { PeerStateStore } from './peer-state.js'
import { safe } from '../lib/logging.js'

export const DEFAULT_SOURCE_ID = 'pds-subscribe-repos'

/** `subscribeRepos` gives us everything except a head to ask for. */
export const PDS_SOURCE_SEMANTICS: SourceSemantics = {
  ordinaryRecords: true,
  ordinaryDeletes: true,
  accountLifecycle: true,
  repositoryReplacement: true,
  verifiedCommits: true,
  /** There is no `getHead`; `mark()` has to open a socket and read one event. */
  explicitHead: false,
}

export interface PeerHostRef {
  /** PDS origin. Normalised on construction so one host is exactly one cursor key. */
  host: string
  /** Stable short name. The only peer identifier allowed in a log line. */
  name: string
  /** Skip commit signature + MST verification. Only sane for a local dev PDS. */
  unauthenticatedCommits?: boolean
  /** Allow plain-HTTP / private-network identity resolution for this peer. */
  allowPrivateNetwork?: boolean
}

export interface IngestSummary {
  accepted: number
}

/** Where decoded records go. Production wraps contrail's `ingestRecords`. */
export interface IndexTarget {
  ingest(events: IngestEvent[], options?: { authoritative?: boolean }): Promise<IngestSummary>
}

export interface PeerRepairRequest {
  host: string
  /** Omitted for a whole-host repair. */
  did?: string
  reason: 'OutdatedCursor' | 'sync-ahead' | 'desynchronized' | 'index-failed'
}

export interface RepairQueue {
  enqueue(request: PeerRepairRequest): Promise<void>
}

/** The subset of `src/lib/logging.ts`'s `log` this directory uses. */
export interface SyncLogger {
  info(msg: string, fields?: Record<string, string | number | boolean>): void
  warn(msg: string, fields?: Record<string, string | number | boolean>): void
  error(msg: string, fields?: Record<string, string | number | boolean>): void
}

export interface PdsChangeSourceOptions {
  /** One `subscribeRepos` socket per entry. */
  hosts: PeerHostRef[]
  /**
   * Operator-owned continuity epoch. MUST change whenever the peer set changes,
   * because a cursor map for one peer set is not comparable to a cursor map for
   * another — that is the difference between a visible break and a silent gap.
   */
  epoch: string
  /** NSIDs to index. A trailing `.*` is a prefix wildcard. */
  collections: string[]
  /** `freeschool-appview/<version> (+<APPVIEW_PUBLIC_URL>)`. */
  userAgent: string
  state: PeerStateStore
  target: IndexTarget
  repair: RepairQueue
  logger: SyncLogger
  id?: string
  /** Applies to every host that does not override it. */
  unauthenticatedCommits?: boolean
  maxReconnectSeconds?: number
  heartbeatIntervalMs?: number
  markTimeoutMs?: number
  /** DID → its current `#atproto_pds` endpoint. Injectable for tests. */
  resolvePdsEndpoint?: (did: string, host: string) => Promise<string | null>
  /** The record's own application time. Production passes contrail's `recordTimeUs`. */
  recordTimeUs?: (record: unknown, collection: string, fallbackUs: number) => number
  /** Idle timeout for one `read()` replay before it gives up on reaching `through`. */
  readIdleTimeoutMs?: number
  /** Attempts per event before the source gives up and repairs instead. */
  handlerAttempts?: number
  handlerRetryDelayMs?: number
  fatalFailureLimit?: number
  quarantineMs?: number
  restartDelayMs?: number
}

export class PdsChangeSource implements ChangeSource {
  readonly id: string
  readonly semantics = PDS_SOURCE_SEMANTICS

  private readonly hosts: PeerHostRef[]
  private readonly matchCollection: (collection: string) => boolean
  private readonly subscriptions = new Map<string, HostSubscription>()
  private readonly idResolver: IdResolver
  private started = false

  constructor(private readonly options: PdsChangeSourceOptions) {
    this.id = options.id ?? DEFAULT_SOURCE_ID
    this.hosts = options.hosts.map((h) => ({ ...h, host: normalizePeerHost(h.host) }))
    this.matchCollection = collectionMatcher(options.collections)
    this.idResolver = new IdResolver({ fetch: globalThis.fetch })
  }

  /* ───────────────────────────── steady-state operation ───────────────────────── */

  /** Open one socket per peer host. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    for (const peer of this.hosts) {
      const startCursor = await this.options.state.getCursor(peer.host)
      const subscription = new HostSubscription({
        host: peer.host,
        name: peer.name,
        userAgent: this.options.userAgent,
        startCursor,
        maxReconnectSeconds: this.options.maxReconnectSeconds ?? DEFAULT_MAX_RECONNECT_SECONDS,
        ...(this.options.heartbeatIntervalMs !== undefined
          ? { heartbeatIntervalMs: this.options.heartbeatIntervalMs }
          : {}),
        ...(this.options.restartDelayMs !== undefined ? { restartDelayMs: this.options.restartDelayMs } : {}),
        ...(this.options.fatalFailureLimit !== undefined
          ? { fatalFailureLimit: this.options.fatalFailureLimit }
          : {}),
        ...(this.options.quarantineMs !== undefined ? { quarantineMs: this.options.quarantineMs } : {}),
        ...(this.options.handlerAttempts !== undefined ? { handlerAttempts: this.options.handlerAttempts } : {}),
        ...(this.options.handlerRetryDelayMs !== undefined
          ? { handlerRetryDelayMs: this.options.handlerRetryDelayMs }
          : {}),
        onCursor: (seq) => this.options.state.recordCursor(peer.host, seq),
        handle: (frame) => this.handleFrame(peer, frame),
        handleInfo: (frame) => this.handleInfo(peer, frame),
        onHandlerFailure: (frame, error) => this.handleIndexFailure(peer, frame, error),
        onReconnect: (attempt, error) => {
          this.options.logger.info('sync: peer reconnect', {
            peer: peer.name,
            attempt,
            detail: describe(error),
          })
        },
        onError: (error) => {
          this.options.logger.warn('sync: peer stream error', { peer: peer.name, detail: describe(error) })
        },
        onQuarantine: (ms, failures) => {
          this.options.logger.error('sync: peer quarantined after repeated fatal errors', {
            peer: peer.name,
            failures,
            minutes: Math.round(ms / 60_000),
          })
        },
      })
      this.subscriptions.set(peer.host, subscription)
      subscription.start()
      this.options.logger.info('sync: peer stream open', {
        peer: peer.name,
        method: SUBSCRIBE_REPOS,
        cursor: startCursor ?? 'head',
      })
    }
  }

  async stop(): Promise<void> {
    this.started = false
    await Promise.all([...this.subscriptions.values()].map((s) => s.stop()))
    this.subscriptions.clear()
    await this.flush()
  }

  /** Write out any cursor the debounce is still holding. */
  async flush(): Promise<void> {
    await this.options.state.flush()
  }

  /* ──────────────────────────────── frame handling ────────────────────────────── */

  private async handleFrame(peer: PeerHostRef, frame: OrderedFrame): Promise<void> {
    switch (frame.kind) {
      case 'commit':
        return await this.handleCommit(peer, frame)
      case 'account':
        return await this.handleAccount(peer, frame)
      case 'identity':
        return await this.handleIdentity(peer, frame)
      case 'sync':
        return await this.handleSync(peer, frame)
    }
  }

  /**
   * An event we could not index after every retry. The cursor is about to move past
   * it, so the only recovery left is to have the repo re-read.
   *
   * A failed DELETE needs more than that: `listRecords` reports what a repo still
   * holds and can never infer an absence, so the intended deletion is recorded for
   * the repair to apply once it confirms the record really is gone.
   */
  private async handleIndexFailure(peer: PeerHostRef, frame: OrderedFrame, error: unknown): Promise<void> {
    this.options.logger.error('sync: giving up on an event; repairing the repo', {
      peer: peer.name,
      kind: frame.kind,
      seq: frame.seq,
      detail: describe(error),
    })
    if (frame.kind === 'commit') {
      for (const op of frame.commit.ops) {
        if (op.action !== 'delete') continue
        const [collection, rkey] = splitDataKey(op.path)
        if (!collection || !rkey || !this.matchCollection(collection)) continue
        await this.options.state
          .recordPendingDelete(peer.host, frame.did, { collection, rkey, at: frame.commit.time })
          .catch((err) =>
            this.options.logger.warn('sync: could not record a pending delete', {
              peer: peer.name,
              detail: describe(err),
            }),
          )
      }
    }
    await this.options.repair.enqueue({ host: peer.host, did: frame.did, reason: 'index-failed' })
  }

  private async handleCommit(peer: PeerHostRef, frame: Extract<WireFrame, { kind: 'commit' }>): Promise<void> {
    const events = await this.decodeCommit(peer, frame)
    if (events.length === 0) return
    const summary = await this.options.target.ingest(events)
    this.options.logger.info('sync: peer records indexed', {
      peer: peer.name,
      seq: frame.seq,
      records: summary.accepted,
    })
  }

  /** `#commit` → contrail `IngestEvent`s for the collections we index. */
  private async decodeCommit(
    peer: PeerHostRef,
    frame: Extract<WireFrame, { kind: 'commit' }>,
  ): Promise<IngestEvent[]> {
    const unauthenticated = peer.unauthenticatedCommits ?? this.options.unauthenticatedCommits ?? false
    const parsed = unauthenticated
      ? await parseCommitUnauthenticated(frame.commit, this.matchCollection)
      : await parseCommitAuthenticated(this.idResolver, frame.commit, this.matchCollection)
    const fallbackUs = frameTimeUs(frame.commit.time)
    const events: IngestEvent[] = []
    for (const op of parsed) {
      const shared = {
        did: op.did,
        collection: op.collection,
        rkey: op.rkey,
        uri: op.uri.toString(),
        source: {
          id: this.id,
          epoch: this.options.epoch,
          cursor: String(frame.seq),
          time_us: fallbackUs,
          revision: op.rev,
        },
      }
      if (op.event === 'delete') {
        events.push(createIngestEvent({ ...shared, operation: 'delete', cid: null, timeUs: fallbackUs }))
        continue
      }
      // DAG-CBOR records carry CID objects and Uint8Arrays, neither of which survives
      // JSON.stringify; `lexToJson` converts to the atproto JSON representation.
      const value = lexToJson(op.record)
      events.push(
        createIngestEvent({
          ...shared,
          operation: op.event,
          cid: op.cid.toString(),
          value,
          timeUs: this.options.recordTimeUs?.(value, op.collection, fallbackUs) ?? fallbackUs,
        }),
      )
    }
    if (events.length > 0) await this.options.state.setRepoRev(peer.host, frame.did, frame.commit.rev)
    return events
  }

  /**
   * `#account` → the repo's status on THIS host. The lexicon is careful that the
   * status belongs to the emitting host, not necessarily to the currently active
   * PDS, which is why the status is stored per (host, did).
   */
  private async handleAccount(peer: PeerHostRef, frame: Extract<WireFrame, { kind: 'account' }>): Promise<void> {
    const status = accountStatusFrom(frame)
    await this.options.state.setRepoStatus(peer.host, frame.did, status, frame.time)
    this.options.logger.info('sync: peer repo status', { peer: peer.name, status, seq: frame.seq })
    // The emitting host has lost sync with the repo, so its stream cannot be trusted
    // for that DID until we have re-read the repo from the authoritative PDS.
    if (status === 'desynchronized') {
      await this.options.repair.enqueue({ host: peer.host, did: frame.did, reason: 'desynchronized' })
    }
  }

  /**
   * `#identity` is advisory: it means the DID document MAY have changed, never which
   * field. The only correct response is to re-resolve, and the field we care about is
   * the `#atproto_pds` endpoint — a change there is the migration trigger.
   */
  private async handleIdentity(peer: PeerHostRef, frame: Extract<WireFrame, { kind: 'identity' }>): Promise<void> {
    const resolve = this.options.resolvePdsEndpoint ?? ((did: string) => this.resolveEndpoint(did))
    let endpoint: string | null
    try {
      endpoint = await resolve(frame.did, peer.host)
    } catch (err) {
      this.options.logger.warn('sync: peer identity re-resolve failed', { peer: peer.name, detail: describe(err) })
      return
    }
    if (!endpoint) return
    const moved = normalizePeerHost(endpoint) !== peer.host
    await this.options.state.setRepoIdentity(peer.host, frame.did, {
      movedOffThisPeer: moved,
      pds: endpoint,
      at: frame.time,
    })
    if (moved) {
      this.options.logger.info('sync: peer repo moved off this peer', { peer: peer.name, seq: frame.seq })
    }
  }

  /** `forceRefresh: true` — the whole point of `#identity` is that our cache is stale. */
  private async resolveEndpoint(did: string): Promise<string | null> {
    const data = await this.idResolver.did.resolveAtprotoData(did, true)
    return data.pds ?? null
  }

  /**
   * `#sync` asserts a repo's current state without the diff that got it there. Treat
   * it as "your view of this repo may be stale": if its `rev` is ahead of the newest
   * we have stored for this host, the stream skipped something and the repo needs a
   * re-read.
   */
  private async handleSync(peer: PeerHostRef, frame: Extract<WireFrame, { kind: 'sync' }>): Promise<void> {
    const known = (await this.options.state.getRepo(peer.host, frame.did))?.lastRev
    await this.options.state.setRepoRev(peer.host, frame.did, frame.rev)
    if (known !== undefined && frame.rev > known) {
      await this.options.repair.enqueue({ host: peer.host, did: frame.did, reason: 'sync-ahead' })
    }
  }

  /**
   * `#info OutdatedCursor` means the PDS could not replay as far back as we asked —
   * its stream retention (default 24 h) ran out — so everything between our cursor
   * and the first frame it did send is missing. The only honest recovery is to
   * re-read every repo on that host.
   */
  private async handleInfo(peer: PeerHostRef, frame: Extract<WireFrame, { kind: 'info' }>): Promise<void> {
    if (frame.name !== OUTDATED_CURSOR) {
      this.options.logger.info('sync: peer stream info', { peer: peer.name, name: frame.name })
      return
    }
    this.options.logger.warn('sync: peer cursor outdated; repairing host', { peer: peer.name })
    await this.options.repair.enqueue({ host: peer.host, reason: OUTDATED_CURSOR })
  }

  /* ────────────────────────── the ChangeSource contract ───────────────────────── */

  /**
   * A durable replay coordinate near the current head, as a cursor MAP.
   *
   * `subscribeRepos` exposes no head, so for each host we open a socket, take the
   * first event's `seq` and close. A host that says nothing inside the timeout
   * contributes its last stored cursor, or nothing at all: inventing a coordinate
   * would put a gap in the replay contrail then trusts.
   */
  async mark(options: { collections: string[]; snapshot?: PreparedSnapshot; signal?: AbortSignal }): Promise<SourcePosition> {
    void options.snapshot
    const map: CursorMap = {}
    for (const peer of this.hosts) {
      const head = await markHostHead({
        host: peer.host,
        userAgent: this.options.userAgent,
        ...(this.options.markTimeoutMs !== undefined ? { timeoutMs: this.options.markTimeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      const resolved = head ?? (await this.options.state.getCursor(peer.host))
      if (resolved !== undefined) map[peer.host] = resolved
    }
    return this.position(map)
  }

  /**
   * Replay `after → through`, per host, in seq order.
   *
   * Hosts are replayed one at a time: there is no common clock across peers — `seq`
   * is incomparable between them and `time` is the emitting host's wall clock — so
   * interleaving them would buy nothing but concurrency risk. Within a host, frames
   * arrive in seq order, which is the per-repo ordering the sync spec requires.
   */
  read(options: {
    collections: string[]
    snapshot?: PreparedSnapshot
    after: SourcePosition
    through: SourcePosition
    signal?: AbortSignal
  }): AsyncIterable<MutationBatch> {
    const self = this
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<MutationBatch> {
        self.assertPosition(options.after)
        self.assertPosition(options.through)
        const after = decodeCursorMap(options.after.cursor)
        const through = decodeCursorMap(options.through.cursor)
        const at: CursorMap = { ...after }

        for (const [host, target] of Object.entries(through)) {
          const peer = self.hosts.find((h) => h.host === host)
          if (!peer) continue
          const from = after[host]
          if (from !== undefined && from >= target) continue
          const mutations: SourceMutation[] = []
          const reached = await self.replayHost(peer, from, target, options.signal, async (frame) => {
            for (const event of await self.decodeCommit(peer, frame)) {
              mutations.push(toMutation(event, self.position({ ...at, [host]: frame.seq })))
            }
            at[host] = frame.seq
          })
          // Only claim the boundary when a frame at or past it actually arrived. An
          // idle timeout must leave the checkpoint short so `caughtUp` stays false and
          // contrail retries, rather than silently certifying a gap.
          if (reached) at[host] = Math.max(at[host] ?? 0, target)
          yield { mutations, checkpoint: self.position(at), caughtUp: false }
        }
        yield { mutations: [], checkpoint: self.position(at), caughtUp: cursorMapReached(at, through) }
      },
    }
  }

  /**
   * Drive one host's socket from `from` until a frame at or past `target`.
   * Returns whether the boundary was actually observed, rather than assumed.
   */
  private async replayHost(
    peer: PeerHostRef,
    from: number | undefined,
    target: number,
    signal: AbortSignal | undefined,
    onCommit: (frame: Extract<WireFrame, { kind: 'commit' }>) => Promise<void>,
  ): Promise<boolean> {
    const idleMs = this.options.readIdleTimeoutMs ?? 10_000
    let settle: (() => void) | undefined
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    let idle = setTimeout(() => settle?.(), idleMs)
    let reached = false
    const subscription = new HostSubscription({
      host: peer.host,
      name: peer.name,
      userAgent: this.options.userAgent,
      startCursor: from,
      maxReconnectSeconds: this.options.maxReconnectSeconds ?? DEFAULT_MAX_RECONNECT_SECONDS,
      onCursor: () => {},
      handle: async (frame) => {
        clearTimeout(idle)
        idle = setTimeout(() => settle?.(), idleMs)
        if (frame.kind === 'commit') await onCommit(frame)
        if (frame.seq >= target) {
          reached = true
          settle?.()
        }
      },
      // A replay that cannot decode an event must not silently drop it from the batch
      // contrail is about to trust, so end the replay short of `through` instead: the
      // checkpoint then stays behind and `caughtUp` stays false.
      onHandlerFailure: async (_frame, error) => {
        this.options.logger.warn('sync: replay could not decode an event', {
          peer: peer.name,
          detail: describe(error),
        })
        settle?.()
      },
      handleInfo: async (frame) => {
        if (frame.name === OUTDATED_CURSOR) {
          await this.options.repair.enqueue({ host: peer.host, reason: OUTDATED_CURSOR })
        }
      },
      onReconnect: (attempt, error) =>
        this.options.logger.info('sync: peer reconnect', { peer: peer.name, attempt, detail: describe(error) }),
      onError: (error) => this.options.logger.warn('sync: peer replay error', { peer: peer.name, detail: describe(error) }),
      onQuarantine: (ms) =>
        this.options.logger.warn('sync: replay host quarantined', { peer: peer.name, minutes: Math.round(ms / 60_000) }),
    })
    const onAbort = () => settle?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    subscription.start()
    try {
      await done
      return reached
    } finally {
      clearTimeout(idle)
      signal?.removeEventListener('abort', onAbort)
      await subscription.stop()
    }
  }

  private position(cursor: CursorMap): SourcePosition {
    return { source: this.id, epoch: this.options.epoch, cursor: encodeCursorMap(cursor) }
  }

  private assertPosition(position: SourcePosition): void {
    if (position.source !== this.id) {
      throw new Error(`position is for source "${position.source}", not "${this.id}"`)
    }
    if (position.epoch !== this.options.epoch) {
      throw new Error(
        `position epoch "${position.epoch}" is not comparable to this source's epoch "${this.options.epoch}"`,
      )
    }
  }
}

function toMutation(event: IngestEvent, position: SourcePosition): SourceMutation {
  const base = {
    uri: event.uri,
    did: event.did,
    collection: event.collection,
    rkey: event.rkey,
    sourceTimeUs: event.source?.time_us ?? event.time_us,
    position,
    ...(event.source?.revision ? { revision: event.source.revision } : {}),
  }
  if (event.operation === 'delete' || event.record === null || event.cid === null) {
    return { ...base, operation: 'delete' }
  }
  return { ...base, operation: 'put', cid: event.cid, value: JSON.parse(event.record) as unknown }
}

function frameTimeUs(time: string): number {
  const ms = Date.parse(time)
  return Number.isFinite(ms) ? ms * 1000 : Date.now() * 1000
}

/**
 * A diagnosable error string. `safe()` (src/lib/logging.ts) strips DIDs, emails and
 * AT-URIs and truncates, so the message can be kept: the name alone made real
 * failures ("Error") indistinguishable from each other.
 */
function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${safe(err.message)}`
  return safe(err)
}

/** `<collection>/<rkey>` from a `#commit` op path. */
function splitDataKey(path: string): [string | undefined, string | undefined] {
  const i = path.indexOf('/')
  if (i <= 0) return [undefined, undefined]
  return [path.slice(0, i), path.slice(i + 1) || undefined]
}
