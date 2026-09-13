/**
 * The cursor-map codec.
 *
 * `subscribeRepos` sequence numbers are **per PDS**: seq 4211 on one peer has
 * nothing to do with seq 4211 on another. contrail's `SourcePosition.cursor` is a
 * single opaque string, so a multi-peer source encodes the whole map into it and
 * pins `epoch` to the peer set's identity — adding a peer is then a visible
 * continuity break rather than a silent gap.
 */

export type CursorMap = Record<string, number>

/**
 * Sorted, so the encoding is canonical: two equal maps compare equal as strings,
 * which is what lets contrail compare positions without parsing them.
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

/** A position has been reached only when EVERY host named in it is at or past its seq. */
export function cursorMapReached(at: CursorMap, through: CursorMap): boolean {
  return Object.entries(through).every(([host, seq]) => (at[host] ?? -1) >= seq)
}

/** Normalised peer origin: no trailing slash, no `/xrpc`, so one host is one key. */
export function normalizePeerHost(host: string): string {
  const u = new URL(host.includes('://') ? host : `https://${host}`)
  return `${u.protocol}//${u.host}`
}

/** `https://pds.example` → `wss://pds.example`, which is what `Subscription` wants. */
export function toWebSocketOrigin(host: string): string {
  return normalizePeerHost(host).replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
}
