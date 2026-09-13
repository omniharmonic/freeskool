/**
 * Durable per-host cursors and per-repo sync state.
 *
 * R4 §"AppView notes" specifies a `peer_host(cursor, …)` column and a
 * `peer_repo(did, home_host, status, last_rev, …)` table. Those tables do not exist
 * yet and this step is not allowed to add a migration, so the same state lives in
 * `fs_app_meta` — the key/value table the schema already describes as "small
 * key/value for indexer bookkeeping we own (not contrail's cursors)". The key layout
 * mirrors the eventual columns one-to-one, so promoting it to real tables is a data
 * copy, not a redesign:
 *
 *   peer:cursor:<host>       → <seq>
 *   peer:repo:<host>:<did>   → {"status","statusAt","movedOffThisPeer","pds","lastRev"}
 *
 * Cursor writes are **debounced** (1 s, the same window Tap and the R4 spike use —
 * a busy host would otherwise fsync per event) and **monotonic**: a partitioned
 * runner can hand back a cursor lower than one already stored when a slow partition
 * finishes last, and walking backwards would replay. The cursor therefore always
 * lags the contiguous completed prefix, which makes delivery at-least-once — every
 * record write downstream must be an idempotent upsert, which contrail's
 * `ingestRecords` source-ordering guard provides.
 */
import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/index.js'
import { appMeta } from '../db/schema.js'
import type { AccountStatus } from './frame-handlers.js'

export type PeerRepoStatus = AccountStatus | 'active'

export interface PeerRepoState {
  status: PeerRepoStatus
  statusAt: string
  /** Set on `#identity` when the DID document no longer names this peer. */
  movedOffThisPeer?: boolean
  /** The `#atproto_pds` endpoint the last re-resolution saw. */
  pds?: string
  /** Newest repo revision we have observed on this host; the `since` for a re-sync. */
  lastRev?: string
}

export interface PeerStateStore {
  getCursor(host: string): Promise<number | undefined>
  /** Record progress. Monotonic and debounced; never awaits a write. */
  recordCursor(host: string, seq: number): void
  /** Write out anything the debounce is still holding. */
  flush(): Promise<void>
  getRepo(host: string, did: string): Promise<PeerRepoState | undefined>
  getRepoStatus(host: string, did: string): Promise<PeerRepoStatus | undefined>
  setRepoStatus(host: string, did: string, status: PeerRepoStatus, at: string): Promise<void>
  setRepoIdentity(
    host: string,
    did: string,
    update: { movedOffThisPeer: boolean; pds?: string; at: string },
  ): Promise<void>
  setRepoRev(host: string, did: string, rev: string): Promise<void>
}

export const CURSOR_KEY_PREFIX = 'peer:cursor:'
export const REPO_KEY_PREFIX = 'peer:repo:'

export const cursorKey = (host: string) => `${CURSOR_KEY_PREFIX}${host}`
export const repoKey = (host: string, did: string) => `${REPO_KEY_PREFIX}${host}:${did}`

/**
 * Shared debounce + monotonic bookkeeping. Subclasses only have to say how a host's
 * cursor and a repo's state are read and written.
 */
abstract class BasePeerState implements PeerStateStore {
  private readonly pending = new Map<string, number>()
  private readonly highWater = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(protected readonly flushIntervalMs = 1_000) {}

  protected abstract readCursor(host: string): Promise<number | undefined>
  /**
   * Write `seq` only if it is ahead of what is stored, and return the cursor that is
   * stored afterwards. Monotonicity has to be enforced HERE, not just by the
   * in-memory high-water mark above: a fresh instance (a restarted process, a second
   * replica) starts with an empty map and would otherwise overwrite a higher stored
   * cursor with a lower one, which replays.
   */
  protected abstract writeCursor(host: string, seq: number): Promise<number>
  protected abstract readRepo(host: string, did: string): Promise<PeerRepoState | undefined>
  protected abstract writeRepo(host: string, did: string, state: PeerRepoState): Promise<void>

  async getCursor(host: string): Promise<number | undefined> {
    const inMemory = this.highWater.get(host)
    if (inMemory !== undefined) return inMemory
    const stored = await this.readCursor(host)
    if (stored !== undefined) this.highWater.set(host, stored)
    return stored
  }

  recordCursor(host: string, seq: number): void {
    if (!Number.isInteger(seq) || seq < 0) return
    const prev = this.highWater.get(host)
    if (prev !== undefined && seq <= prev) return
    this.highWater.set(host, seq)
    this.pending.set(host, seq)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.flushIntervalMs)
    this.timer.unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.pending.size === 0) return await this.writing
    const batch = [...this.pending.entries()]
    this.pending.clear()
    // Serialize writes so two flushes cannot interleave and store an older seq last.
    this.writing = this.writing.then(async () => {
      for (const [host, seq] of batch) {
        // The store may report a higher cursor than we asked for — another writer got
        // there first — so adopt whatever it ended up holding.
        this.highWater.set(host, await this.writeCursor(host, seq))
      }
    })
    return await this.writing
  }

  async getRepo(host: string, did: string): Promise<PeerRepoState | undefined> {
    return await this.readRepo(host, did)
  }

  async getRepoStatus(host: string, did: string): Promise<PeerRepoStatus | undefined> {
    return (await this.readRepo(host, did))?.status
  }

  async setRepoStatus(host: string, did: string, status: PeerRepoStatus, at: string): Promise<void> {
    const current = (await this.readRepo(host, did)) ?? { status: 'active', statusAt: at }
    await this.writeRepo(host, did, { ...current, status, statusAt: at })
  }

  async setRepoIdentity(
    host: string,
    did: string,
    update: { movedOffThisPeer: boolean; pds?: string; at: string },
  ): Promise<void> {
    const current = (await this.readRepo(host, did)) ?? { status: 'active' as PeerRepoStatus, statusAt: update.at }
    await this.writeRepo(host, did, {
      ...current,
      movedOffThisPeer: update.movedOffThisPeer,
      ...(update.pds ? { pds: update.pds } : {}),
    })
  }

  async setRepoRev(host: string, did: string, rev: string): Promise<void> {
    const current = (await this.readRepo(host, did)) ?? {
      status: 'active' as PeerRepoStatus,
      statusAt: new Date().toISOString(),
    }
    if (current.lastRev !== undefined && current.lastRev >= rev) return
    await this.writeRepo(host, did, { ...current, lastRev: rev })
  }
}

/** The production store: our own `fs_app_meta` key/value table. */
export class AppMetaPeerState extends BasePeerState {
  constructor(
    private readonly db: Db,
    flushIntervalMs = 1_000,
  ) {
    super(flushIntervalMs)
  }

  private async read<T>(key: string): Promise<T | undefined> {
    const rows = await this.db.select({ value: appMeta.value }).from(appMeta).where(eq(appMeta.key, key)).limit(1)
    return rows[0]?.value as T | undefined
  }

  private async write(key: string, value: unknown): Promise<void> {
    await this.db
      .insert(appMeta)
      .values({ key, value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } })
  }

  protected async readCursor(host: string): Promise<number | undefined> {
    const seq = await this.read<number>(cursorKey(host))
    return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : undefined
  }

  protected async writeCursor(host: string, seq: number): Promise<number> {
    // `value` is jsonb; `#>> '{}'` unwraps the scalar so it can be compared as a
    // number. Only this class ever writes a `peer:cursor:` key, so the cast is safe.
    // bigint, not integer: R4 found a live host already past 1.03e9.
    await this.db
      .insert(appMeta)
      .values({ key: cursorKey(host), value: seq })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: seq, updatedAt: new Date() },
        setWhere: sql`(${appMeta.value} #>> '{}')::bigint < ${seq}`,
      })
    return (await this.readCursor(host)) ?? seq
  }

  protected async readRepo(host: string, did: string): Promise<PeerRepoState | undefined> {
    return await this.read<PeerRepoState>(repoKey(host, did))
  }

  protected async writeRepo(host: string, did: string, state: PeerRepoState): Promise<void> {
    await this.write(repoKey(host, did), state)
  }
}

/** In-memory store. Used by the hermetic suites and by `mark()`/`read()` replays. */
export class MemoryPeerState extends BasePeerState {
  private readonly cursors = new Map<string, number>()
  private readonly repos = new Map<string, PeerRepoState>()

  constructor(flushIntervalMs = 1_000) {
    super(flushIntervalMs)
  }

  protected async readCursor(host: string): Promise<number | undefined> {
    return this.cursors.get(host)
  }

  protected async writeCursor(host: string, seq: number): Promise<number> {
    const prev = this.cursors.get(host)
    const next = prev === undefined ? seq : Math.max(prev, seq)
    this.cursors.set(host, next)
    return next
  }

  protected async readRepo(host: string, did: string): Promise<PeerRepoState | undefined> {
    return this.repos.get(repoKey(host, did))
  }

  protected async writeRepo(host: string, did: string, state: PeerRepoState): Promise<void> {
    this.repos.set(repoKey(host, did), state)
  }
}
