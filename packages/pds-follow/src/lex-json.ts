/**
 * Lexicon data model -> JSON.
 *
 * Records decoded from CAR blocks are DAG-CBOR, so CIDs arrive as CID objects
 * and `bytes` fields as Uint8Array. Neither survives `JSON.stringify` (a CID
 * stringifies to `{}`), so convert to the atproto JSON representation:
 *   CID        -> { "$link": "bafy..." }
 *   Uint8Array -> { "$bytes": "<base64>" }
 * Records fetched via `listRecords` are already in this form and pass through.
 */

/**
 * Duck-typed CID check. The CID class comes from `multiformats` via
 * `@atproto/lex-data`; importing it here just to `instanceof` would risk two
 * copies of multiformats in the tree disagreeing, so shape-check instead.
 */
function isCidLike(value: object): boolean {
  const v = value as { code?: unknown; version?: unknown; multihash?: unknown }
  return (
    typeof v.code === 'number' &&
    typeof v.version === 'number' &&
    typeof v.multihash === 'object' &&
    v.multihash !== null
  )
}

export function lexToJson(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (value instanceof Uint8Array) {
    return { $bytes: Buffer.from(value).toString('base64') }
  }
  if (Array.isArray(value)) return value.map((v) => lexToJson(v))
  if (typeof value === 'object') {
    if (isCidLike(value)) return { $link: String(value) }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = lexToJson(v)
    }
    return out
  }
  return value
}
