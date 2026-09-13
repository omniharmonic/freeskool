/**
 * All crypto in one place.
 *
 *  - custodial account passwords: AES-256-GCM under a VERSIONED key, so rotating the
 *    key re-wraps rather than locks every member out (OpenMeet's custodial pattern);
 *  - feedback ballots: HMAC-SHA256 under a PER-EVENT key that is destroyed at window
 *    close, which is what makes a ballot permanently un-attributable;
 *  - sessions: `<id>.<hmac>` — the cookie is a pointer plus a signature, never a token;
 *  - occurrence rkeys: a deterministic hash so a re-run of the materializer is a no-op.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

const NUL = String.fromCharCode(0)

/* versioned AES-256-GCM */

export interface Wrapped {
  keyVersion: string
  blob: Buffer
}

export function wrapSecret(
  plaintext: string,
  keys = config().CUSTODY_KEYS,
  version = config().CUSTODY_KEY_VERSION,
): Wrapped {
  const key = keys.get(version)
  if (!key) throw new Error(`no custody key for version ${version}`)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { keyVersion: version, blob: Buffer.concat([iv, ct, cipher.getAuthTag()]) }
}

export function unwrapSecret(wrapped: Wrapped, keys = config().CUSTODY_KEYS): string {
  const key = keys.get(wrapped.keyVersion)
  if (!key) throw new Error(`no custody key for version ${wrapped.keyVersion}`)
  const iv = wrapped.blob.subarray(0, 12)
  const tag = wrapped.blob.subarray(wrapped.blob.length - 16)
  const ct = wrapped.blob.subarray(12, wrapped.blob.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

/* feedback ballots */

export function newBallotKey(): Buffer {
  return randomBytes(32)
}

/**
 * The ballot token. `pepper` is a deployment-wide secret so that a leaked database
 * alone is not enough even before the per-event key is destroyed.
 */
export function ballotToken(
  perEventKey: Buffer,
  did: string,
  pepper = config().FEEDBACK_BALLOT_PEPPER,
): string {
  return createHmac('sha256', perEventKey).update(`${pepper}${NUL}${did}`).digest('base64url')
}

/* sessions */

export function newSessionId(): string {
  return randomBytes(24).toString('base64url')
}

export function signSessionId(id: string, secret = config().SESSION_SECRET): string {
  return `${id}.${createHmac('sha256', secret).update(id).digest('base64url')}`
}

export function verifySessionCookie(cookie: string, secret = config().SESSION_SECRET): string | null {
  const i = cookie.lastIndexOf('.')
  if (i <= 0) return null
  const id = cookie.slice(0, i)
  const sig = Buffer.from(cookie.slice(i + 1), 'base64url')
  const want = createHmac('sha256', secret).update(id).digest()
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return null
  return id
}

/* magic links */

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

/* deterministic occurrence rkey */

const B32 = '234567abcdefghijklmnopqrstuvwxyz'

/**
 * rkey = base32(sha256(seriesRkey + NUL + originalStartsAt))[0..12].
 *
 * Deterministic so the materializer is idempotent across runs AND across processes:
 * two workers computing the same slot write the same rkey, and the second write is a
 * no-op `putRecord` rather than a duplicate occurrence.
 */
export function occurrenceRkey(seriesRkey: string, originalStartsAt: string): string {
  const digest = createHash('sha256')
    .update(`${seriesRkey}${NUL}${normalizeInstant(originalStartsAt)}`)
    .digest()
  let out = ''
  for (let i = 0; i < 13; i++) out += B32[digest[i]! & 31]
  return out
}

/** Same instant must always produce the same rkey regardless of offset spelling. */
export function normalizeInstant(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error('invalid instant')
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function randomPassword(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
