/**
 * Read helpers over contrail's projection. Everything the HTTP layer needs from the
 * index goes through here so the `records_*` table names live in exactly one place.
 *
 * `contrail.query()` returns `RecordRow` whose `record` is the raw JSON text (SQLite)
 * or JSONB (Postgres) — `parseRecord()` normalizes both.
 */
import type { RecordRow } from '@atmo-dev/contrail'
import { NSID } from '../lexicons/nsids.js'
import type { Indexer } from './indexer.js'

export interface IndexedRecord<T = Record<string, unknown>> {
  uri: string
  did: string
  collection: string
  rkey: string
  cid: string | null
  value: T
  counts?: Record<string, number>
}

export function parseRecord<T = Record<string, unknown>>(
  row: RecordRow & { counts?: Record<string, number> },
): IndexedRecord<T> {
  let value: unknown = row.record
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = {}
    }
  }
  return {
    uri: row.uri,
    did: row.did,
    collection: row.collection,
    rkey: row.rkey,
    cid: row.cid,
    value: (value ?? {}) as T,
    counts: row.counts,
  }
}

export async function listCollection<T = Record<string, unknown>>(
  indexer: Indexer,
  short: string,
  options: Parameters<Indexer['contrail']['query']>[1] = {},
): Promise<{ records: IndexedRecord<T>[]; cursor?: string }> {
  const res = await indexer.contrail.query(short, options, indexer.db)
  return {
    records: res.records.map((r) => parseRecord<T>(r)),
    cursor: res.cursor,
  }
}

export async function getRecordByUri<T = Record<string, unknown>>(
  indexer: Indexer,
  short: string,
  uri: string,
): Promise<IndexedRecord<T> | null> {
  const parts = parseAtUri(uri)
  if (!parts) return null
  // An author can have many more than one page of classes, skills, or notes.
  // Follow the index cursor instead of interpreting "not in the first 100" as missing.
  let cursor: string | undefined
  const visited = new Set<string>()
  do {
    const res = await indexer.contrail.query(
      short,
      { did: parts.did, limit: 100, ...(cursor ? { cursor } : {}) },
      indexer.db,
    )
    const row = res.records.find((r) => r.uri === uri)
    if (row) return parseRecord<T>(row)
    cursor = res.cursor
    if (cursor && visited.has(cursor)) break
    if (cursor) visited.add(cursor)
  } while (cursor)
  return null
}

/** Events in a window. The window filter is a range query on the indexed `startsAt`. */
export async function eventsInWindow(
  indexer: Indexer,
  from: string,
  to: string,
  limit = 200,
): Promise<IndexedRecord[]> {
  const res = await indexer.contrail.query(
    'event',
    {
      rangeFilters: { startsAt: { min: from, max: to } },
      limit,
      sort: { recordField: 'startsAt', direction: 'asc' },
    },
    indexer.db,
  )
  return res.records.map((r) => parseRecord(r))
}

/** Every sidecar of one short name whose `references.event` points at this event. */
export async function sidecarsForEvent<T = Record<string, unknown>>(
  indexer: Indexer,
  short: string,
  eventUri: string,
  field = 'event.uri',
): Promise<IndexedRecord<T>[]> {
  // contrail's per-collection tables carry no `collection` column — the table IS the
  // collection — so it is supplied as a literal to keep `RecordRow` whole.
  const nsid = nsidFor(short)
  const rows = await indexer.db
    .prepare(
      `SELECT uri, did, '${nsid}' AS collection, rkey, cid, record, time_us, indexed_at
         FROM records_${safeShort(short)}
        WHERE ${jsonPath(field)} = ?
        ORDER BY time_us DESC LIMIT 200`,
    )
    .bind(eventUri)
    .all<RecordRow>()
  return rows.results.map((r) => parseRecord<T>(r))
}

/** `a.b` → `record->'a'->>'b'`; `a` → `record->>'a'`. */
function nsidFor(short: string): string {
  const nsid = (NSID as Record<string, string | undefined>)[short]
  if (!nsid)
    throw new Error(`no NSID registered for collection short name ${short}`)
  return nsid
}

function jsonPath(field: string): string {
  const parts = field.split('.')
  const last = parts.pop()!
  const head = parts.map((p) => `->'${escapeKey(p)}'`).join('')
  return `record${head}->>'${escapeKey(last)}'`
}

function escapeKey(k: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error(`unsafe json key: ${k}`)
  return k
}

function safeShort(short: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(short))
    throw new Error(`unsafe collection short name: ${short}`)
  return short
}

export function parseAtUri(
  uri: string,
): { did: string; collection: string; rkey: string } | null {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri)
  if (!m || !m[1] || !m[2] || !m[3]) return null
  return { did: m[1], collection: m[2], rkey: m[3] }
}
