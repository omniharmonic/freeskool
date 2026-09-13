/**
 * One `com.atproto.sync.subscribeRepos` socket against one peer PDS.
 *
 * Built on `@atproto/xrpc-server`'s `Subscription` rather than `@atproto/sync`'s
 * `Firehose` because `Firehose` cannot do two things R4 lists as pre-production
 * fixes: it drops `#info` frames (so a 24 h `OutdatedCursor` gap is silent) and it
 * never surfaces a reconnect (so a flapping peer is invisible). `Subscription`
 * exposes both — `validate` sees every frame and `onReconnectError` fires per
 * attempt — while still owning the WebSocket, the exponential backoff and the
 * heartbeat.
 *
 * Ordering comes from `@atproto/sync`'s `MemoryRunner`: a partitioned queue where
 * events from different repos run concurrently but events from one repo run strictly
 * in order, which is exactly what the sync spec requires, and whose cursor only
 * advances past a contiguous prefix of completed work, so a crash replays rather
 * than skips.
 */
import { MemoryRunner } from '@atproto/sync'
import { Subscription } from '@atproto/xrpc-server'
import { parseFrame, type WireFrame } from './frame-handlers.js'
import { toWebSocketOrigin } from './cursor-map.js'

export const SUBSCRIBE_REPOS = 'com.atproto.sync.subscribeRepos'

/** R4 §"Rate limits": 8–16 s is the right ceiling for a small registry. */
export const DEFAULT_MAX_RECONNECT_SECONDS = 16

export interface HostSubscriptionOptions {
  /** Normalised peer origin, e.g. `https://pds.example`. */
  host: string
  /** Stable short name. The ONLY peer identifier that may reach a log line. */
  name: string
  userAgent: string
  /** Seq to resume from, or undefined to start at the host's head. */
  startCursor: number | undefined
  /** Called with the contiguous completed prefix. Debounced downstream. */
  onCursor: (seq: number) => void
  /** Per-DID ordered handler for `#commit` / `#sync` / `#identity` / `#account`. */
  handle: (frame: WireFrame) => Promise<void>
  /** `#info` carries no DID or seq, so it bypasses the runner. */
  handleInfo: (frame: Extract<WireFrame, { kind: 'info' }>) => Promise<void>
  onReconnect: (attempt: number, error: unknown) => void
  onError: (error: unknown) => void
  maxReconnectSeconds?: number
  heartbeatIntervalMs?: number
  /** Delay before re-entering the read loop after a fatal socket error. */
  restartDelayMs?: number
}

export class HostSubscription {
  private readonly runner: MemoryRunner
  private readonly subscription: Subscription<WireFrame>
  private readonly abort = new AbortController()
  private loop: Promise<void> | null = null
  private stopped = false

  constructor(private readonly options: HostSubscriptionOptions) {
    this.runner = new MemoryRunner({
      ...(options.startCursor !== undefined ? { startCursor: options.startCursor } : {}),
      // 8 repos in flight: the concurrency the R4 spike ran at against live PDSes.
      concurrency: 8,
      setCursor: async (cursor: number) => {
        options.onCursor(cursor)
      },
    })
    this.subscription = new Subscription<WireFrame>({
      // `service` is an origin; `Subscription` appends `/xrpc/<method>` itself.
      service: toWebSocketOrigin(options.host),
      method: SUBSCRIBE_REPOS,
      maxReconnectSeconds: options.maxReconnectSeconds ?? DEFAULT_MAX_RECONNECT_SECONDS,
      ...(options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: options.heartbeatIntervalMs } : {}),
      headers: { 'user-agent': options.userAgent },
      signal: this.abort.signal,
      getParams: async () => {
        const cursor = this.runner.getCursor()
        return cursor === undefined ? undefined : { cursor }
      },
      validate: (value) => parseFrame(value),
      onReconnectError: (error, attempt) => options.onReconnect(attempt, error),
    })
  }

  /** Start reading. Returns once the loop is running, not once it is finished. */
  start(): void {
    this.loop ??= this.run()
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        for await (const frame of this.subscription) {
          if (this.stopped) break
          if (frame.kind === 'info') {
            await this.options.handleInfo(frame)
            continue
          }
          // Partition by DID: concurrent across repos, sequential within one.
          await this.runner.trackEvent(frame.did, frame.seq, async () => {
            try {
              await this.options.handle(frame)
            } catch (err) {
              this.options.onError(err)
            }
          })
        }
        // A clean end of stream with no abort still means the peer hung up.
        if (this.stopped) return
      } catch (err) {
        if (this.stopped || (err as { name?: string })?.name === 'AbortError') return
        this.options.onError(err)
      }
      if (this.stopped) return
      await new Promise((resolve) => setTimeout(resolve, this.options.restartDelayMs ?? 1_000))
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort.abort()
    await this.runner.destroy().catch(() => {})
    await this.loop?.catch(() => {})
    this.loop = null
  }
}

/**
 * Open a socket, take the first frame that carries a `seq`, and close.
 *
 * `subscribeRepos` has no `getHead`, so this is the only honest head coordinate —
 * which is exactly why `PDS_SOURCE_SEMANTICS.explicitHead` is false. Resolves
 * `undefined` when the host says nothing inside `timeoutMs`: a quiet peer has no
 * observable head, and inventing one from the wall clock would be a lie.
 */
export async function markHostHead(options: {
  host: string
  userAgent: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<number | undefined> {
  const abort = new AbortController()
  const onOuterAbort = () => abort.abort()
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => abort.abort(), options.timeoutMs ?? 10_000)
  const subscription = new Subscription<WireFrame>({
    service: toWebSocketOrigin(options.host),
    method: SUBSCRIBE_REPOS,
    headers: { 'user-agent': options.userAgent },
    signal: abort.signal,
    validate: (value) => parseFrame(value),
  })
  try {
    for await (const frame of subscription) {
      if (frame.kind === 'info') continue
      return frame.seq
    }
    return undefined
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return undefined
    throw err
  } finally {
    clearTimeout(timer)
    abort.abort()
    options.signal?.removeEventListener('abort', onOuterAbort)
  }
}
