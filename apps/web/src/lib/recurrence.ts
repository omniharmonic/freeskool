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

const WEEKDAY_INDEX: Record<WeekdayCode, number> = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };
const SHORT_WEEKDAY_TO_CODE: Record<string, WeekdayCode> = {
  Mon: 'MO',
  Tue: 'TU',
  Wed: 'WE',
  Thu: 'TH',
  Fri: 'FR',
  Sat: 'SA',
  Sun: 'SU',
};

/** The weekday `rrule` itself will see. `RRule` (both here and in the
 * materializer, `apps/appview/src/jobs/materialize-series.ts`) is UTC-naive:
 * `BYDAY` matches a candidate's `getUTCDay()`, not the host's local calendar
 * day. An evening class in any zone west of UTC (Denver 6:30pm is already
 * Friday 00:30 UTC) lands on a DIFFERENT weekday in UTC than the one the host
 * typed — send `BYDAY=TH` for that and the server's RRule engine searches
 * forward for the next UTC-Thursday AT OR AFTER `dtstart`, which is up to 6
 * days later: the host's own first class silently falls outside its own
 * series, and every later occurrence is materialized a week later than
 * intended. Confirmed against the live AppView + materializer while
 * verifying this task: a `-06:00` Thursday evening start with `BYDAY=TH`
 * produced 8 "TH" occurrences that were all actually a week late, because
 * `getUTCDay()` of that instant is Friday. */
function utcWeekdayCode(iso: string): WeekdayCode {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return 'MO';
  return WEEKDAY_CODES[(instant.getUTCDay() + 6) % 7]!;
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
    return SHORT_WEEKDAY_TO_CODE[short] ?? utcWeekdayCode(iso);
  } catch {
    return utcWeekdayCode(iso); // an unrecognized IANA zone name: fall back to UTC (shift 0)
  }
}

function shiftWeekday(code: WeekdayCode, shift: number): WeekdayCode {
  const idx = (((WEEKDAY_INDEX[code] + shift) % 7) + 7) % 7;
  return WEEKDAY_CODES[idx]!;
}

/** Every day of the week shifts by the SAME amount between "local calendar
 * day" and "the UTC day rrule sees" for a given instant (it is a fixed
 * offset, not a per-day fact) — always -1, 0, or +1 for any real timezone. */
function weekdayShift(startsAt: string, timezone: string): number {
  return WEEKDAY_INDEX[utcWeekdayCode(startsAt)] - WEEKDAY_INDEX[localWeekdayCode(startsAt, timezone)];
}

/**
 * The editor's weekday picker shows LOCAL days (the host types "Thursdays");
 * this translates that choice — or the inferred default, the start date's
 * own local day — into the UTC-equivalent codes `rrule` needs to actually
 * include `dtstart` as the series' first occurrence. See `utcWeekdayCode`'s
 * doc comment for why the translation exists at all.
 *
 * TEMPORARY, per the controller's Task 5 review ruling: this client-side
 * shift is a workaround, not the real fix. The real fix is expanding BYDAY
 * in the series' OWN timezone server-side (assigned to Task 12, on
 * `apps/appview/src/jobs/materialize-series.ts`); once that lands, Task 10
 * removes this shift entirely and sends the host's literal local-day choice
 * unmodified. Do not build further client-side timezone logic on top of this
 * — it is scaffolding for a backend gap, not a design to extend.
 */
function effectiveByDay(
  state: Pick<RecurrenceState, 'freq' | 'byDay'>,
  startsAt: string,
  timezone: string,
): WeekdayCode[] | undefined {
  if (state.freq === 'monthly' || state.freq === 'none') return undefined;
  const local = state.byDay.length > 0 ? state.byDay : [localWeekdayCode(startsAt, timezone)];
  const shift = weekdayShift(startsAt, timezone);
  return shift === 0 ? local : local.map((code) => shiftWeekday(code, shift));
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

  const byDay = effectiveByDay(state, startsAt, timezone);
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

/** A client-side preview of the next `n` occurrences (inclusive of the start
 * date), for the editor's "next 4 classes" line. Builds the rule directly
 * rather than round-tripping `buildRecurrence`'s string, since this only
 * ever runs in the browser. `timezone` must be the same zone `buildRecurrence`
 * will be called with, or the preview can disagree with what actually gets
 * posted. */
export function previewOccurrences(state: RecurrenceState, startsAt: string, timezone: string, n = 4): Date[] {
  if (state.freq === 'none' || !startsAt) return [];
  validateEnd(state.count, state.until);
  const dtstart = new Date(startsAt);
  if (Number.isNaN(dtstart.getTime())) return [];

  const byDay = effectiveByDay(state, startsAt, timezone);
  const interval = state.freq === 'biweekly' ? 2 : 1;
  const rule = new RRule({
    freq: state.freq === 'monthly' ? RRule.MONTHLY : RRule.WEEKLY,
    interval,
    ...(byDay ? { byweekday: byDay.map((code) => RRULE_WEEKDAY[code]) } : {}),
    dtstart,
  });
  return rule.all((_date, i) => i < n);
}
