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
 * events from one repo run strictly in order, which is what the sync spec requires,
 * and whose cursor only advances past a contiguous prefix of completed work, so a
 * crash replays rather than skips.
 *
 * Two layers of retry, doing different jobs:
 *   - `Subscription` reconnects a dropped socket itself, capped at
 *     `maxReconnectSeconds`, reporting each attempt through `onReconnectError`;
 *   - a **fatal** error ends its iterator instead (an error frame such as
 *     `FutureCursor`, which R4 observed as op -1 plus close 1008). The loop below
 *     re-enters with its own exponential delay to the same ceiling, and quarantines
 *     a host that keeps failing so one broken peer cannot spin forever.
 */
import { MemoryRunner } from '@atproto/sync'
import { Subscription } from '@atproto/xrpc-server'
import { parseFrame, type WireFrame } from './frame-handlers.js'
import { toWebSocketOrigin } from './cursor-map.js'

export const SUBSCRIBE_REPOS = 'com.atproto.sync.subscribeRepos'

/** R4 §"Rate limits": 8–16 s is the right ceiling for a small registry. */
export const DEFAULT_MAX_RECONNECT_SECONDS = 16
export const DEFAULT_RESTART_DELAY_MS = 1_000
/** Consecutive fatal failures before a host is parked. */
export const DEFAULT_FATAL_FAILURE_LIMIT = 10
export const DEFAULT_QUARANTINE_MS = 10 * 60_000
/** Attempts per event before we give up on indexing it and repair instead. */
export const DEFAULT_HANDLER_ATTEMPTS = 3
export const DEFAULT_HANDLER_RETRY_DELAY_MS = 100

/** Every frame the runner can order. `#info` has no DID or seq and bypasses it. */
export type OrderedFrame = Exclude<WireFrame, { kind: 'info' }>

/**
 * Exponential restart delay for the fatal-error loop, capped at the same ceiling the
 * socket's own reconnects use. `attempt` is 1 for the first failure.
 */
export function restartDelayFor(attempt: number, baseMs: number, capMs: number): number {
  if (attempt <= 1) return Math.min(baseMs, capMs)
  return Math.min(baseMs * 2 ** (attempt - 1), capMs)
}

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
  handle: (frame: OrderedFrame) => Promise<void>
  /** `#info` carries no DID or seq, so it bypasses the runner. */
  handleInfo: (frame: Extract<WireFrame, { kind: 'info' }>) => Promise<void>
  /**
   * An event that failed every attempt. The cursor advances past it regardless —
   * wedging the host on one poisoned record would stop every other repo on it — so
   * this callback is the only chance to arrange a repair.
   */
  onHandlerFailure: (frame: OrderedFrame, error: unknown) => Promise<void>
  onReconnect: (attempt: number, error: unknown) => void
  onError: (error: unknown) => void
  /** The host is parked for `ms` after too many consecutive fatal failures. */
  onQuarantine: (ms: number, consecutiveFailures: number) => void
  maxReconnectSeconds?: number
  heartbeatIntervalMs?: number
  /** Base delay before re-entering the read loop after a fatal socket error. */
  restartDelayMs?: number
  fatalFailureLimit?: number
  quarantineMs?: number
  handlerAttempts?: number
  handlerRetryDelayMs?: number
}

export class HostSubscription {
  private readonly runner: MemoryRunner
  private readonly subscription: Subscription<WireFrame>
  private readonly abort = new AbortController()
  private loop: Promise<void> | null = null
  private stopped = false
  private consecutiveFatal = 0

  constructor(private readonly options: HostSubscriptionOptions) {
    this.runner = new MemoryRunner({
      ...(options.startCursor !== undefined ? { startCursor: options.startCursor } : {}),
      // `trackEvent` is awaited below, so the read loop already processes one frame at
      // a time and this ceiling is never the binding constraint. Awaiting is the
      // deliberate choice: it bounds memory (an un-awaited runner just accumulates
      // frames in p-queue with no backpressure) and makes ordering trivially correct.
      // R4 measured ~5,700 frames/s replay with a two-collection filter, far past what
      // a curated peer set produces.
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
          // A delivered frame proves the socket opened and is healthy: the fatal-error
          // escalation starts over from here.
          this.consecutiveFatal = 0
          if (frame.kind === 'info') {
            await this.options.handleInfo(frame)
            continue
          }
          // Partition by DID: sequential within one repo, which the sync spec requires.
          await this.runner.trackEvent(frame.did, frame.seq, () => this.dispatch(frame))
        }
        // A clean end of stream with no abort still means the peer hung up.
        if (this.stopped) return
      } catch (err) {
        if (this.stopped || (err as { name?: string })?.name === 'AbortError') return
        this.options.onError(err)
      }
      if (this.stopped) return
      if (!(await this.backOff())) return
    }
  }

  /**
   * Wait before re-dialling. Escalates exponentially to the reconnect ceiling and,
   * once a host has failed `fatalFailureLimit` times in a row without ever delivering
   * a frame, parks it for `quarantineMs`. Returns false if we were stopped while waiting.
   */
  private async backOff(): Promise<boolean> {
    this.consecutiveFatal++
    const limit = this.options.fatalFailureLimit ?? DEFAULT_FATAL_FAILURE_LIMIT
    let delay: number
    if (this.consecutiveFatal >= limit) {
      delay = this.options.quarantineMs ?? DEFAULT_QUARANTINE_MS
      this.options.onQuarantine(delay, this.consecutiveFatal)
      // Reset so the next cycle escalates from the bottom again rather than parking
      // on every single failure from here on.
      this.consecutiveFatal = 0
    } else {
      delay = restartDelayFor(
        this.consecutiveFatal,
        this.options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS,
        (this.options.maxReconnectSeconds ?? DEFAULT_MAX_RECONNECT_SECONDS) * 1_000,
      )
    }
    return await this.sleep(delay)
  }

  /** Interruptible sleep. Resolves false when `stop()` happened while waiting. */
  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.abort.signal.removeEventListener('abort', onAbort)
        resolve(!this.stopped)
      }, ms)
      const onAbort = () => {
        clearTimeout(timer)
        resolve(false)
      }
      this.abort.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * Run one event's handler, retrying a few times before giving up.
   *
   * This must NOT throw: a throw escapes `MemoryRunner.trackEvent` before it commits
   * the cursor, so the host would replay the same failing event forever and every
   * other repo on that peer would starve behind it. Instead the failure is reported
   * (so a repair can be arranged) and the cursor is allowed to advance.
   */
  private async dispatch(frame: OrderedFrame): Promise<void> {
    const attempts = Math.max(1, this.options.handlerAttempts ?? DEFAULT_HANDLER_ATTEMPTS)
    const retryDelay = this.options.handlerRetryDelayMs ?? DEFAULT_HANDLER_RETRY_DELAY_MS
    let lastError: unknown
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.stopped) return
      try {
        await this.options.handle(frame)
        return
      } catch (err) {
        lastError = err
        if (attempt < attempts) await this.sleep(retryDelay * attempt)
      }
    }
    try {
      await this.options.onHandlerFailure(frame, lastError)
    } catch (err) {
      this.options.onError(err)
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
