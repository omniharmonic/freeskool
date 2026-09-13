/**
 * `subscribeRepos` frame → the shapes the rest of the source works in.
 *
 * Everything here is pure: no sockets, no database, no clock beyond what the caller
 * passes in.
 *
 * Why a hand-written validator rather than a lexicon one:
 *   - `@atproto/sync` does not re-export its generated `subscribeRepos` lexicon
 *     module (its package `exports` is `.` only, and `index.d.ts` re-exports only
 *     `runner`/`firehose`/`events`), so `$message.safeParse` is unreachable.
 *   - `@atproto/api`'s `ComAtprotoSyncSubscribeRepos` validators type CIDs as
 *     `multiformats`' `CID`, while the CBOR decoder behind `Subscription` produces
 *     `@atproto/lex-data`'s `Cid`. Same bytes, different nominal type.
 *   - `@atproto/sync`'s `Firehose` drops `#info` entirely (`didAndSeqForEvt` returns
 *     undefined and the loop `continue`s) and cannot report reconnects, which are
 *     two of the seven pre-production fixes in R4 §"Concrete changes to make".
 *     We drive `Subscription` ourselves, so we validate ourselves.
 *
 * The wire shapes below are transcribed from the lexicon and were confirmed against
 * live PDSes by `packages/pds-follow/probes/raw-frames.mjs`.
 */
import type { parseCommitUnauthenticated } from '@atproto/sync'

/** The commit shape `@atproto/sync`'s parsers accept, without a deep import. */
export type WireCommit = Parameters<typeof parseCommitUnauthenticated>[0]

/** Every `#account` status in the lexicon, including the two R4 found missing from
 * `@atproto/sync`'s `AccountStatus` union. */
export const ACCOUNT_STATUSES = [
  'deactivated',
  'suspended',
  'takendown',
  'deleted',
  'desynchronized',
  'throttled',
] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]

export type WireFrame =
  | { kind: 'commit'; seq: number; did: string; commit: WireCommit }
  | { kind: 'sync'; seq: number; did: string; rev: string; time: string }
  | { kind: 'identity'; seq: number; did: string; handle?: string; time: string }
  | { kind: 'account'; seq: number; did: string; active: boolean; status?: string; time: string }
  | { kind: 'info'; name: string; message?: string }

const TYPE_PREFIX = 'com.atproto.sync.subscribeRepos#'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isSeq = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isDid = (v: unknown): v is string => typeof v === 'string' && v.startsWith('did:')

/**
 * Structurally validate one decoded frame. Returns `undefined` for anything we do
 * not understand — an unknown `$type`, a malformed body — which the subscription
 * then skips rather than crashing the socket on.
 */
export function parseFrame(value: unknown): WireFrame | undefined {
  if (!isRecord(value)) return undefined
  const type = value['$type']
  if (typeof type !== 'string' || !type.startsWith(TYPE_PREFIX)) return undefined
  switch (type.slice(TYPE_PREFIX.length)) {
    case 'commit': {
      if (!isSeq(value['seq']) || !isDid(value['repo'])) return undefined
      if (!(value['blocks'] instanceof Uint8Array) || !Array.isArray(value['ops'])) return undefined
      if (typeof value['rev'] !== 'string' || typeof value['time'] !== 'string') return undefined
      return {
        kind: 'commit',
        seq: value['seq'],
        did: value['repo'],
        // The CBOR decoder has already produced the `Cid` objects and the CAR bytes
        // the parsers want; this cast names a type we cannot import, nothing more.
        commit: value as unknown as WireCommit,
      }
    }
    case 'sync': {
      if (!isSeq(value['seq']) || !isDid(value['did'])) return undefined
      if (typeof value['rev'] !== 'string' || typeof value['time'] !== 'string') return undefined
      return { kind: 'sync', seq: value['seq'], did: value['did'], rev: value['rev'], time: value['time'] }
    }
    case 'identity': {
      if (!isSeq(value['seq']) || !isDid(value['did']) || typeof value['time'] !== 'string') return undefined
      return {
        kind: 'identity',
        seq: value['seq'],
        did: value['did'],
        time: value['time'],
        ...(typeof value['handle'] === 'string' ? { handle: value['handle'] } : {}),
      }
    }
    case 'account': {
      if (!isSeq(value['seq']) || !isDid(value['did']) || typeof value['time'] !== 'string') return undefined
      if (typeof value['active'] !== 'boolean') return undefined
      return {
        kind: 'account',
        seq: value['seq'],
        did: value['did'],
        time: value['time'],
        active: value['active'],
        ...(typeof value['status'] === 'string' ? { status: value['status'] } : {}),
      }
    }
    case 'info': {
      if (typeof value['name'] !== 'string') return undefined
      return {
        kind: 'info',
        name: value['name'],
        ...(typeof value['message'] === 'string' ? { message: value['message'] } : {}),
      }
    }
    default:
      return undefined
  }
}

/**
 * `#account` → the status we store.
 *
 * `active: true` is `active`; `active: false` carries a status we pass through when
 * the lexicon knows it. An unrecognised status on an inactive repo is treated as
 * `deactivated` — "this host no longer serves this repo" is the only claim we can
 * make safely, and it is the non-destructive one.
 */
export function accountStatusFrom(frame: { active: boolean; status?: string }): AccountStatus | 'active' {
  if (frame.active) return 'active'
  const status = frame.status
  if (status && (ACCOUNT_STATUSES as readonly string[]).includes(status)) return status as AccountStatus
  return 'deactivated'
}

/** The collection filter `@atproto/sync` wants. Trailing `.*` is a prefix wildcard. */
export function collectionMatcher(collections: string[]): (collection: string) => boolean {
  const exact = new Set<string>()
  const prefixes: string[] = []
  for (const pattern of collections) {
    if (pattern.endsWith('.*')) prefixes.push(pattern.slice(0, -2))
    else exact.add(pattern)
  }
  return (collection) => exact.has(collection) || prefixes.some((p) => collection.startsWith(p))
}

/** `#info` names that mean "you have a gap; repair the whole host". */
export const OUTDATED_CURSOR = 'OutdatedCursor'
