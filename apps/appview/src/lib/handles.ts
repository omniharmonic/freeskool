/**
 * Handle generation: `<word><word><3 digits>.<domain>` — e.g. `calmotter417.test`.
 *
 * NEVER derived from the email (R9): the handle is public forever, and an email-derived
 * handle is a permanent, unrevocable disclosure. The word list is deliberately bland and
 * place/nature-flavoured; the PDS also rejects handles containing a slur, and
 * `mintAccount` retries on rejection.
 */
import { randomInt } from 'node:crypto'

const FIRST = [
  'calm', 'quiet', 'bright', 'open', 'warm', 'clear', 'kind', 'plain', 'steady', 'fresh',
  'wide', 'still', 'early', 'easy', 'free', 'glad', 'soft', 'true', 'newly', 'good',
]

const SECOND = [
  'otter', 'maple', 'creek', 'meadow', 'finch', 'cedar', 'willow', 'heron', 'aspen', 'wren',
  'birch', 'sparrow', 'clover', 'juniper', 'alder', 'thrush', 'laurel', 'plover', 'sorrel', 'sedge',
]

export function generateHandle(domain: string): string {
  const a = FIRST[randomInt(FIRST.length)]!
  const b = SECOND[randomInt(SECOND.length)]!
  const n = String(randomInt(100, 1000))
  return `${a}${b}${n}.${domain.replace(/^\./, '')}`
}

/** Total space, for the "is this collision-prone?" question: 20 x 20 x 900 = 360 000. */
export const HANDLE_SPACE = FIRST.length * SECOND.length * 900

/**
 * A member-chosen handle PREFIX (`/welcome`'s "pick your own handle" — Task 6/11): 1
 * char, or 3-20 chars starting and ending with `[a-z0-9]` with only `-` allowed between.
 * Lowercase only, on purpose — the PDS itself is case-insensitive about handles, and a
 * mixed-case prefix here would just be a second, inconsistent spelling of the same one.
 */
export const HANDLE_PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$/

/**
 * Prefixes that would be confusing or misleading as a member's OWN handle (mimicking
 * infrastructure, not a person) — reserved regardless of whether the PDS would actually
 * accept them.
 */
export const RESERVED_HANDLE_PREFIXES = ['admin', 'www', 'pds', 'skills', 'boulder', 'school', 'help', 'mail', 'api']

/**
 * Pure format/reserved check for a chosen handle PREFIX (not the full `prefix.domain`
 * handle) — no DB, no PDS. Deliberately STRICT (case-sensitive): `routes/me.ts` is the
 * one that normalizes (`normalizeHandlePrefix`, below) before calling this, so a
 * mobile keyboard's auto-capitalization never reads as "invalid" to the member. This
 * function itself makes no assumption about whether its input was normalized.
 * `routes/me.ts` layers the actual availability check (`taken`) on top of this, since
 * that one needs I/O.
 */
export function isValidChosenHandle(prefix: string): { ok: true } | { ok: false; reason: 'invalid' | 'reserved' } {
  if (!HANDLE_PREFIX_RE.test(prefix)) return { ok: false, reason: 'invalid' }
  if (RESERVED_HANDLE_PREFIXES.includes(prefix)) return { ok: false, reason: 'reserved' }
  return { ok: true }
}

/**
 * Trims and lowercases a member-typed handle prefix BEFORE it reaches
 * `isValidChosenHandle` — review round 1 (should-fix): a phone's auto-capitalized first
 * letter (or pasted leading/trailing whitespace) must not turn an otherwise-fine prefix
 * into "invalid". The PDS itself is case-insensitive about handles, so lowercasing here
 * loses nothing.
 */
export function normalizeHandlePrefix(prefix: string): string {
  return prefix.trim().toLowerCase()
}
