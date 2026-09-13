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
