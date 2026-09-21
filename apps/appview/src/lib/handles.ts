/**
 * Handle generation: `<word><word><3 digits>.<domain>` — e.g. `calmotter417.test`.
 *
 * NEVER derived from the email (R9): the handle is public forever, and an email-derived
 * handle is a permanent, unrevocable disclosure. The word list is deliberately bland and
 * place/nature-flavoured; the PDS also rejects handles containing a slur, and
 * `mintAccount` retries on rejection.
 */
import { randomInt } from 'node:crypto'
import { config, type Config } from '../config.js'

const FIRST = [
  'calm', 'quiet', 'bright', 'open', 'warm', 'clear', 'kind', 'plain', 'steady', 'fresh',
  'wide', 'still', 'early', 'easy', 'free', 'glad', 'soft', 'true', 'newly', 'good',
]

const SECOND = [
  'otter', 'maple', 'creek', 'meadow', 'finch', 'cedar', 'willow', 'heron', 'aspen', 'wren',
  'birch', 'sparrow', 'clover', 'juniper', 'alder', 'thrush', 'laurel', 'plover', 'sorrel', 'sedge',
]

export function generateHandle(domain: string, reserved: ReadonlySet<string> = reservedLabels()): string {
  const d = domain.replace(/^\./, '')
  // A drawn prefix always ends in three digits and a reserved label never does, so a
  // collision needs an operator to have reserved a digit-suffixed label. Draw again if
  // it happens: minting `boulder417` when `boulder417` is a school host would hand a
  // member a name the edge answers for.
  for (let attempt = 0; attempt < 20; attempt++) {
    const prefix = `${FIRST[randomInt(FIRST.length)]!}${SECOND[randomInt(SECOND.length)]!}${randomInt(100, 1000)}`
    if (!reserved.has(prefix)) return `${prefix}.${d}`
  }
  // 20 draws from 360 000 all landing on a reserved label means the reserved list has
  // swallowed the space. Refusing is right: `mintAccount` retries, and a handle nobody
  // vetted is worse than a signup that fails loudly.
  throw new Error('could not generate a handle outside the reserved list')
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
 * THE reserved label list — one list, three readers: the handle generator, the handle
 * chooser (`isValidChosenHandle`) and school creation.
 *
 * Since the Caddy inversion (MS §3) a label under the school domain is not just a name
 * that would be confusing on a person (`admin`, `pds`) — it is a name the EDGE may hand
 * to a school's app (`boulder.freeskool.xyz` serves Boulder and resolves Boulder's
 * handle). A member who owned that label would own a school's origin: the session
 * cookie is `Domain=.freeskool.xyz`. So the handle namespace and the school namespace
 * are one namespace, and this is where it is written down.
 *
 * `denver` and `boulder` are here as cities that will exist; `SCHOOL_LABELS` adds the
 * ones a given deployment already runs (`reservedLabels`).
 *
 * Mirrored, deliberately, in `apps/web/src/components/HandleChooser.tsx` — the PWA
 * cannot import server code. Keep the two identical.
 */
export const RESERVED_LABELS: readonly string[] = [
  'admin', 'www', 'pds', 'skills', 'school', 'help', 'mail', 'api',
  'app', 'static', 'assets', 'internal', 'denver', 'boulder',
  'tributary', 'events', 'directory', 'gate',
]

/**
 * Older name for the same list, kept so nothing that reads it has to change at once.
 * @deprecated read `RESERVED_LABELS` (static) or `reservedLabels()` (config included).
 */
export const RESERVED_HANDLE_PREFIXES = RESERVED_LABELS

/**
 * The labels this deployment's schools answer for: `SCHOOL_LABELS`, plus the label of
 * the school it already runs when that school's handle sits directly under the school
 * domain (`boulder.freeskool.xyz` → `boulder`). Federation Task 2 replaces the config
 * half of this with the `fs_school_domain` table; the shape of the answer stays.
 */
export function schoolLabels(
  c: Pick<Config, 'SCHOOL_LABELS' | 'SCHOOL_HANDLE' | 'schoolDomainSuffix'> = config(),
): ReadonlySet<string> {
  const labels = new Set(c.SCHOOL_LABELS.map((l) => l.trim().toLowerCase()).filter(Boolean))
  const legacy = labelUnder(c.SCHOOL_HANDLE, c.schoolDomainSuffix)
  if (legacy) labels.add(legacy)
  return labels
}

/** `RESERVED_LABELS` plus every label a school on this deployment already answers for. */
export function reservedLabels(
  c: Pick<Config, 'SCHOOL_LABELS' | 'SCHOOL_HANDLE' | 'schoolDomainSuffix'> = config(),
): ReadonlySet<string> {
  return new Set([...RESERVED_LABELS, ...schoolLabels(c)])
}

/**
 * The single label of `host` directly under `suffix`, or null. `boulder.freeskool.xyz`
 * under `freeskool.xyz` is `boulder`; `a.boulder.freeskool.xyz` is nothing, because a
 * school host is one label deep and so is a handle host.
 */
export function labelUnder(host: string, suffix: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  const s = suffix.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '')
  if (!h || !s || !h.endsWith(`.${s}`)) return null
  const label = h.slice(0, -(s.length + 1))
  return label && !label.includes('.') ? label : null
}

/**
 * Pure format/reserved check for a chosen handle PREFIX (not the full `prefix.domain`
 * handle) — no DB, no PDS. Deliberately STRICT (case-sensitive): `routes/me.ts` is the
 * one that normalizes (`normalizeHandlePrefix`, below) before calling this, so a
 * mobile keyboard's auto-capitalization never reads as "invalid" to the member. This
 * function itself makes no assumption about whether its input was normalized.
 * `routes/me.ts` layers the actual availability check (`taken`) on top of this, since
 * that one needs I/O.
 */
export function isValidChosenHandle(
  prefix: string,
  reserved: ReadonlySet<string> = reservedLabels(),
): { ok: true } | { ok: false; reason: 'invalid' | 'reserved' } {
  if (!HANDLE_PREFIX_RE.test(prefix)) return { ok: false, reason: 'invalid' }
  if (reserved.has(prefix)) return { ok: false, reason: 'reserved' }
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
