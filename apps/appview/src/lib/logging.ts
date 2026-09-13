/**
 * Logging policy (R9): no request bodies, no DIDs, no emails, no handles, no record
 * contents. Anything that could carry one goes through `safe()`, which keeps shapes
 * and drops values.
 */
const DID_RE = /did:[a-z0-9]+:[a-zA-Z0-9._:%-]+/g
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g
const AT_URI_RE = /at:\/\/[^\s"']+/g
export function safe(value: unknown): string {
  const s = typeof value === 'string' ? value : value instanceof Error ? `${value.name}: ${value.message}` : String(value)
  return s
    .replace(DID_RE, 'did:<redacted>')
    .replace(EMAIL_RE, '<email>')
    .replace(AT_URI_RE, 'at://<uri>')
    .slice(0, 500)
}

/**
 * NOTE on handles (A9): `safe()` deliberately does NOT carry a handle pattern. Anything
 * broad enough to catch `alice.test` also eats `peer.name` out of every sync log line,
 * which IS a hostname and is the one identifier those lines exist to carry. The rule that
 * keeps handles out of logs is upstream instead: never log an error's MESSAGE. Use
 * `describeError` below — there is no `String(err)` left in this codebase.
 */

/**
 * A bounded error label for a log line: the class name, plus the XRPC error CODE when
 * the error carries one. THE rule for logging an error (set by commit 89b3341): no
 * `String(err)` anywhere, ever.
 *
 * **Never the message.** R9 forbids DIDs, handles, emails, record contents and AT-URIs
 * in logs, and `safe()` is a net, not a guarantee — an XRPC message like `could not find
 * repo for alice.test` has no business being near a log line at all. The `error` code
 * (`RepoNotFound`, `FutureCursor`, `ConsumerTooSlow`, …) is a closed vocabulary from the
 * lexicon and carries the diagnostic value anyway.
 *
 * The code may arrive from a peer, so it is only used when it looks like the identifier
 * the lexicon says it is; anything else is dropped rather than echoed.
 */
const XRPC_ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err === 'string' ? 'error' : 'unknown'
  const code = (err as { error?: unknown }).error
  return typeof code === 'string' && XRPC_ERROR_CODE.test(code) ? `${err.name}: ${code}` : err.name
}

export const log = {
  info: (msg: string, fields?: Record<string, string | number | boolean>) =>
    console.log(`[appview] ${safe(msg)}${fields ? ' ' + fmt(fields) : ''}`),
  warn: (msg: string, fields?: Record<string, string | number | boolean>) =>
    console.warn(`[appview] ${safe(msg)}${fields ? ' ' + fmt(fields) : ''}`),
  error: (msg: string, fields?: Record<string, string | number | boolean>) =>
    console.error(`[appview] ${safe(msg)}${fields ? ' ' + fmt(fields) : ''}`),
}

function fmt(fields: Record<string, string | number | boolean>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? safe(v) : v}`)
    .join(' ')
}

/** contrail's Logger, scrubbed. contrail logs DIDs and URIs freely; we do not. */
export const quietLogger = {
  log: (...args: unknown[]) => console.log('[contrail]', ...args.map(safe)),
  warn: (...args: unknown[]) => console.warn('[contrail]', ...args.map(safe)),
  error: (...args: unknown[]) => console.error('[contrail]', ...args.map(safe)),
}
