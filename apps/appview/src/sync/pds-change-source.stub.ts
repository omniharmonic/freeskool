/**
 * STUB. See ./README.md.
 *
 * A live `ChangeSource` over `com.atproto.sync.subscribeRepos`, spoken directly to each
 * peer PDS. Deliberately NOT implemented in this step — the real file is
 * `pds-change-source.ts` and a later step adds it. Everything here either throws
 * `not implemented` or is a pure, already-testable helper the real source will need.
 */
import type { ChangeSource, MutationBatch, PreparedSnapshot, SourcePosition, SourceSemantics } from '@atmo-dev/contrail'

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`)
    this.name = 'NotImplementedError'
  }
}

export interface PdsChangeSourceOptions {
  /** Peer PDS hosts to subscribe to. One `subscribeRepos` socket each. */
  hosts: string[]
  /**
   * Operator-owned continuity epoch. MUST change whenever `hosts` changes, because a
   * cursor map for one peer set is not comparable to a cursor map for another.
   */
  epoch: string
  id?: string
}

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

export class PdsChangeSource implements ChangeSource {
  readonly id: string
  readonly semantics = PDS_SOURCE_SEMANTICS

  constructor(private readonly options: PdsChangeSourceOptions) {
    this.id = options.id ?? 'pds-subscribe-repos'
  }

  async mark(_options: {
    collections: string[]
    snapshot?: PreparedSnapshot
    signal?: AbortSignal
  }): Promise<SourcePosition> {
    throw new NotImplementedError('PdsChangeSource.mark — open one subscribeRepos socket per peer and take the first #commit seq')
  }

  read(_options: {
    collections: string[]
    snapshot?: PreparedSnapshot
    after: SourcePosition
    through: SourcePosition
    signal?: AbortSignal
  }): AsyncIterable<MutationBatch> {
    throw new NotImplementedError('PdsChangeSource.read — replay after→through per host, decoding #commit CAR blocks')
  }

  /** The epoch this source will stamp on every position it emits. */
  get epoch(): string {
    return this.options.epoch
  }

  get hosts(): readonly string[] {
    return this.options.hosts
  }
}

/* ───────────────── the one piece that is real: the cursor-map codec ───────────────── */

export type CursorMap = Record<string, number>

/**
 * `SourcePosition.cursor` is a single opaque string, but `subscribeRepos` seqs are
 * per-host. We encode the whole map into that one string, sorted so the encoding is
 * canonical and two equal maps compare equal as strings.
 */
export function encodeCursorMap(map: CursorMap): string {
  const entries = Object.entries(map)
    .filter(([, seq]) => Number.isInteger(seq) && seq >= 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.map(([host, seq]) => `${encodeURIComponent(host)}=${seq}`).join('&')
}

export function decodeCursorMap(cursor: string): CursorMap {
  const out: CursorMap = {}
  if (!cursor) return out
  for (const part of cursor.split('&')) {
    const i = part.lastIndexOf('=')
    if (i <= 0) continue
    const host = decodeURIComponent(part.slice(0, i))
    const seq = Number(part.slice(i + 1))
    if (Number.isInteger(seq) && seq >= 0) out[host] = seq
  }
  return out
}

/** A position is behind another only when EVERY host is at or behind it. */
export function cursorMapReached(at: CursorMap, through: CursorMap): boolean {
  return Object.entries(through).every(([host, seq]) => (at[host] ?? -1) >= seq)
}
