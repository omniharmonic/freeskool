/**
 * The recurrence editor's pure logic: editor state → the AppView's `series`
 * input (`EventSeriesInput`, mirrors `createBody.series` in
 * `apps/appview/src/http/routes/events.ts`) and a client-side preview of the
 * next few occurrences, computed with the same `rrule` major the AppView's
 * materializer uses (`apps/appview/src/jobs/materialize-series.ts`).
 *
 * Unlike the AppView, plain `import { RRule } from 'rrule'` resolves fine
 * here: Vite (and Vitest, which runs on Vite) honours the package's `module`
 * field, so there is no need for the deep `rrule/dist/esm/index.js` path the
 * AppView needs to work around Node's CJS resolution.
 *
 * The RRULE string built here carries no `RRULE:` prefix and no `DTSTART` —
 * that matches the wire shape `createBody.series.rrule` expects, and it is
 * exactly what the materializer's `RRule.parseString(series.rrule)` (combined
 * with its own explicit `dtstart`) parses back out.
 */
import { RRule, type Weekday } from 'rrule';
import type { EventSeriesInput } from './types';

export type RecurrenceFreq = 'none' | 'weekly' | 'biweekly' | 'monthly';
export type WeekdayCode = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export const WEEKDAY_CODES: readonly WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export const WEEKDAY_LABEL: Record<WeekdayCode, string> = {
  MO: 'Mon',
  TU: 'Tue',
  WE: 'Wed',
  TH: 'Thu',
  FR: 'Fri',
  SA: 'Sat',
  SU: 'Sun',
};

export interface RecurrenceState {
  freq: RecurrenceFreq;
  /** Meaningful for `weekly`/`biweekly` only; a `monthly` series repeats on
   * the start date's day-of-month, and `none` ignores it entirely. */
  byDay: WeekdayCode[];
  /** A series ends by a count of occurrences, or by a date — never both;
   * `validateEnd` (called by `buildRecurrence` and `previewOccurrences`)
   * throws if the editor state somehow has both set. Neither set means
   * open-ended, which the AppView's materializer caps at 18 months. */
  count?: number;
  until?: string;
}

export const NO_RECURRENCE: RecurrenceState = { freq: 'none', byDay: [] };

/** RFC 5545, and `createEventAsHost`/`updateEventAsHost`: `until` XOR `count`. */
export function validateEnd(count: number | undefined, until: string | undefined): void {
  if (count !== undefined && until !== undefined) {
    throw new Error('a series ends by a count or by a date, never both');
  }
}

const RRULE_WEEKDAY: Record<WeekdayCode, Weekday> = {
  MO: RRule.MO,
  TU: RRule.TU,
  WE: RRule.WE,
  TH: RRule.TH,
  FR: RRule.FR,
  SA: RRule.SA,
  SU: RRule.SU,
};

const SHORT_WEEKDAY_TO_CODE: Record<string, WeekdayCode> = {
  Mon: 'MO',
  Tue: 'TU',
  Wed: 'WE',
  Thu: 'TH',
  Fri: 'FR',
  Sat: 'SA',
  Sun: 'SU',
};

/**
 * HISTORY (why this file used to shift `BYDAY`, and why it no longer does):
 * `rrule` — both the copy imported here and the one the AppView's
 * materializer used before Task 12 — is UTC-naive: it matches `BYDAY`
 * against a candidate's `getUTCDay()`, not the host's local calendar day. An
 * evening class in any zone west of UTC (Denver 6:30pm is already Friday
 * 00:30 UTC) lands on a DIFFERENT weekday in UTC than the one the host
 * typed, so sending that literal `BYDAY=TH` against a UTC-naive `rrule` used
 * to make it search forward for the next UTC-Thursday and materialize every
 * occurrence a week late.
 *
 * Task 12 fixed this SERVER-SIDE: `apps/appview/src/jobs/
 * materialize-series.ts#plannedOccurrences` now expands `BYDAY` in the
 * series' OWN timezone (a floating-local frame), so `BYDAY` is matched
 * against the host's actual local weekday, never UTC. `buildRecurrence`
 * below therefore sends the host's literal `BYDAY` pick verbatim — no
 * shift, no translation, anywhere in this module (see `resolveByDay`'s doc
 * comment). `previewOccurrences` does its own floating-local expansion
 * purely to keep the CLIENT'S preview accurate; nothing here shifts what
 * goes over the wire.
 *
 * `hostLocalWeekdayCode` right below is unrelated to that history — it is
 * only `localWeekdayCode`'s last-resort fallback for an IANA zone name it
 * cannot resolve at all.
 */
function hostLocalWeekdayCode(iso: string): WeekdayCode {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return 'MO';
  // The JS runtime's OWN local day (`Date#getDay`, never `getUTCDay`) — the
  // closest thing to "the host's literal calendar day" available without a
  // working IANA zone. `timezone` is always the browser's own zone in
  // practice (`Intl.DateTimeFormat().resolvedOptions().timeZone`, from
  // `EventEditScreen.tsx`), so this and the real answer coincide whenever
  // this fallback is ever actually reached.
  return WEEKDAY_CODES[(instant.getDay() + 6) % 7]!;
}

/**
 * The weekday the host actually meant, in THEIR timezone — not the ISO
 * string's own date digits. By the time `startsAt` reaches this module it is
 * already a UTC `Z` instant (`EventEditScreen.tsx`'s `localToIso` converts
 * the `datetime-local` value before calling `buildRecurrence`), so recovering
 * "what calendar day was this for the host" needs the IANA zone, not string
 * parsing — and `Intl`'s own DST-aware conversion is more correct than
 * reconstructing it from a fixed UTC offset besides.
 */
function localWeekdayCode(iso: string, timezone: string): WeekdayCode {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return 'MO';
  try {
    const short = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(instant);
    return SHORT_WEEKDAY_TO_CODE[short] ?? hostLocalWeekdayCode(iso);
  } catch {
    return hostLocalWeekdayCode(iso); // an unrecognized IANA zone name: fall back to the host's own local day, never UTC
  }
}

/**
 * The editor's weekday picker shows LOCAL days (the host types "Thursdays");
 * this resolves that choice — or the inferred default, the start date's own
 * local day — into the codes actually sent over the wire.
 *
 * Per the controller's Task 10 ruling: this used to translate the picker's
 * local-day choice into a UTC-equivalent code before it reached `rrule` or
 * the wire (`effectiveByDay`, removed here, plus its `weekdayShift`/
 * `shiftWeekday` helpers) — a workaround for `rrule`'s own UTC-naive `BYDAY`
 * matching. Task 12 moved the real fix server-side
 * (`apps/appview/src/jobs/materialize-series.ts#plannedOccurrences` now
 * expands `BYDAY` in the series' OWN timezone), so the wire payload now
 * carries the host's literal local-day choice unmodified — no translation
 * here at all.
 */
function resolveByDay(
  state: Pick<RecurrenceState, 'freq' | 'byDay'>,
  startsAt: string,
  timezone: string,
): WeekdayCode[] | undefined {
  if (state.freq === 'monthly' || state.freq === 'none') return undefined;
  return state.byDay.length > 0 ? state.byDay : [localWeekdayCode(startsAt, timezone)];
}

/**
 * A real instant -> a "floating" Date whose UTC getters equal its wall-clock
 * fields in `zone`. Mirrors `toFloatingLocal` in
 * `apps/appview/src/jobs/materialize-series.ts` (which uses `luxon`; this
 * module carries no date library beyond `rrule`, so `Intl.DateTimeFormat`
 * does the same job). Used ONLY by `previewOccurrences` below — the wire
 * payload (`buildRecurrence`) never needs this, since the server now does
 * its own timezone-correct expansion from the literal `BYDAY` it receives.
 * Falls back to the instant unchanged for an unrecognized IANA zone name,
 * same as `localWeekdayCode`'s fallback.
 */
function toFloatingLocal(instant: Date, zone: string): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(instant);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
    const hour = get('hour') % 24; // hour12:false reports midnight as "24"
    return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second')));
  } catch {
    return instant;
  }
}

/**
 * The inverse of `toFloatingLocal`: a floating Date's UTC fields, re-localized
 * to `zone` — the real instant whose wall-clock reading in `zone` matches
 * `floating`'s UTC fields. `Intl` exposes no direct "local wall-clock ->
 * instant" conversion (that's what `luxon`'s `DateTime.fromObject` buys the
 * server), so this solves for it by fixed-point iteration: guess the
 * instant, see what `zone`'s offset at that guess implies, correct, repeat.
 * Converges in one pass whenever the UTC offset does not change across the
 * correction (true for every case except a guess landing exactly on a DST
 * transition) — acceptable here since this only feeds a non-authoritative
 * "next few classes" preview; the server's own `fromFloatingLocal` is what
 * actually schedules anything.
 */
function fromFloatingLocal(floating: Date, zone: string): Date {
  let instant = floating.getTime();
  for (let i = 0; i < 2; i++) {
    const asFloating = toFloatingLocal(new Date(instant), zone);
    instant += floating.getTime() - asFloating.getTime();
  }
  return new Date(instant);
}

/** `2026-12-31T23:59:59.000Z` → `20261231T235959Z` (RFC 5545 UTC DATE-TIME). */
function untilStamp(iso: string): string {
  return new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function rruleString(parts: {
  freq: 'WEEKLY' | 'MONTHLY';
  interval?: number;
  byDay?: WeekdayCode[];
  until?: string;
  count?: number;
}): string {
  const segments = [`FREQ=${parts.freq}`];
  if (parts.interval && parts.interval > 1) segments.push(`INTERVAL=${parts.interval}`);
  if (parts.byDay?.length) segments.push(`BYDAY=${parts.byDay.join(',')}`);
  if (parts.until) segments.push(`UNTIL=${untilStamp(parts.until)}`);
  if (parts.count) segments.push(`COUNT=${parts.count}`);
  return segments.join(';');
}

/** Build the AppView's `series` input from the editor state, or `undefined` for "none". */
export function buildRecurrence(
  state: RecurrenceState,
  startsAt: string,
  timezone: string,
): EventSeriesInput | undefined {
  if (state.freq === 'none') return undefined;
  validateEnd(state.count, state.until);

  const byDay = resolveByDay(state, startsAt, timezone);
  const interval = state.freq === 'biweekly' ? 2 : 1;
  const freq: EventSeriesInput['freq'] = state.freq === 'monthly' ? 'monthly' : 'weekly';

  return {
    rrule: rruleString({
      freq: freq === 'monthly' ? 'MONTHLY' : 'WEEKLY',
      interval,
      byDay,
      until: state.until,
      count: state.count,
    }),
    freq,
    ...(interval > 1 ? { interval } : {}),
    ...(byDay ? { byDay } : {}),
    ...(state.until ? { until: state.until } : {}),
    ...(state.count ? { count: state.count } : {}),
    timezone,
  };
}

/**
 * A client-side preview of the next `n` occurrences (inclusive of the start
 * date), for the editor's "next 4 classes" line. Builds the rule directly
 * rather than round-tripping `buildRecurrence`'s string, since this only
 * ever runs in the browser. `timezone` must be the same zone `buildRecurrence`
 * will be called with, or the preview can disagree with what actually gets
 * posted.
 *
 * Expands in the FLOATING-local frame (`toFloatingLocal`/`fromFloatingLocal`
 * above) rather than feeding `rrule` the real instant directly — `rrule` is
 * UTC-naive, so a real instant's `BYDAY` would match against the UTC
 * weekday, not `timezone`'s, exactly the bug `buildRecurrence` used to work
 * around with a shift (see `resolveByDay`'s doc comment). This keeps the
 * preview honest without reintroducing that shift into the wire payload.
 */
export function previewOccurrences(state: RecurrenceState, startsAt: string, timezone: string, n = 4): Date[] {
  if (state.freq === 'none' || !startsAt) return [];
  validateEnd(state.count, state.until);
  const dtstart = new Date(startsAt);
  if (Number.isNaN(dtstart.getTime())) return [];

  const byDay = resolveByDay(state, startsAt, timezone);
  const interval = state.freq === 'biweekly' ? 2 : 1;
  const rule = new RRule({
    freq: state.freq === 'monthly' ? RRule.MONTHLY : RRule.WEEKLY,
    interval,
    ...(byDay ? { byweekday: byDay.map((code) => RRULE_WEEKDAY[code]) } : {}),
    dtstart: toFloatingLocal(dtstart, timezone),
  });
  return rule.all((_date, i) => i < n).map((d) => fromFloatingLocal(d, timezone));
}
