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

/** The weekday of an ISO date(-time) string's own date digits — deliberately
 * not a local-timezone conversion, since the calendar day a host typed is
 * the day that matters, not what the viewing browser's clock says it is. */
function weekdayCodeOfDateString(iso: string): WeekdayCode {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return 'MO';
  const [, y, m, d] = match;
  const utc = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return WEEKDAY_CODES[(utc.getUTCDay() + 6) % 7]!;
}

function effectiveByDay(state: Pick<RecurrenceState, 'freq' | 'byDay'>, startsAt: string): WeekdayCode[] | undefined {
  if (state.freq === 'monthly' || state.freq === 'none') return undefined;
  return state.byDay.length > 0 ? state.byDay : [weekdayCodeOfDateString(startsAt)];
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

  const byDay = effectiveByDay(state, startsAt);
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
 * ever runs in the browser. */
export function previewOccurrences(state: RecurrenceState, startsAt: string, n = 4): Date[] {
  if (state.freq === 'none' || !startsAt) return [];
  validateEnd(state.count, state.until);
  const dtstart = new Date(startsAt);
  if (Number.isNaN(dtstart.getTime())) return [];

  const byDay = effectiveByDay(state, startsAt);
  const interval = state.freq === 'biweekly' ? 2 : 1;
  const rule = new RRule({
    freq: state.freq === 'monthly' ? RRule.MONTHLY : RRule.WEEKLY,
    interval,
    ...(byDay ? { byweekday: byDay.map((code) => RRULE_WEEKDAY[code]) } : {}),
    dtstart,
  });
  return rule.all((_date, i) => i < n);
}
