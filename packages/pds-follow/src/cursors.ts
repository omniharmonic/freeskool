/**
 * Per-host cursor persistence.
 *
 * `subscribeRepos` cursors are **per-host sequence numbers**. A PDS's `seq`
 * space is entirely its own — seq 4211 on `eurosky.social` has nothing to do
 * with seq 4211 on `northsky.social` — so the store is keyed by host, never
 * global. Reconnecting with another host's cursor either replays from the
 * beginning of that host's log or earns a `FutureCursor` error.
 *
 * In the production AppView this becomes one row per peer host:
 *   peer_host(host text primary key, name text, cursor bigint, last_event_at timestamptz)
 * written with the same debounce, inside the same transaction as the records
 * the events produced where you want exactly-once; idempotent upserts plus a
 * periodic cursor write is the cheaper and usually correct choice.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type CursorFile = Record<string, { cursor: number; updatedAt: string }>

export class CursorStore {
  private state: CursorFile = {}
  private dirty = false
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    /** Debounce window: a busy host would otherwise fsync on every event. */
    private readonly flushIntervalMs = 1_000,
  ) {}

  async load(): Promise<void> {
    try {
      this.state = JSON.parse(await readFile(this.path, 'utf8')) as CursorFile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      this.state = {}
    }
  }

  get(host: string): number | undefined {
    return this.state[host]?.cursor
  }

  all(): CursorFile {
    return { ...this.state }
  }

  /**
   * Record progress. Monotonic per host: a runner can hand back a cursor lower
   * than one already stored when an older partition finishes last, and we must
   * not walk backwards and replay.
   */
  set(host: string, cursor: number): void {
    const prev = this.state[host]?.cursor
    if (prev !== undefined && cursor <= prev) return
    this.state[host] = { cursor, updatedAt: new Date().toISOString() }
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  /** Atomic-ish write: temp file + rename, so a crash mid-write can't truncate the store. */
  async flush(): Promise<void> {
    if (!this.dirty) return await this.writing
    this.dirty = false
    const snapshot = JSON.stringify(this.state, null, 2)
    this.writing = (async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.tmp`
      await writeFile(tmp, snapshot + '\n', 'utf8')
      await rename(tmp, this.path)
    })()
    return await this.writing
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.dirty = true
    await this.flush()
  }
}
