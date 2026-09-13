import { describe, expect, it } from 'vitest';
import { buildRecurrence, previewOccurrences, validateEnd, type RecurrenceState } from './recurrence';

// Noon UTC on a Thursday: the local calendar day and the UTC day rrule
// actually evaluates BYDAY against agree, so these tests exercise the plain
// case. `DENVER_EVENING_START` below (same calendar date, typed as a Denver
// evening class) is the case where they DON'T agree.
const THURSDAY_START = '2026-09-17T12:00:00Z';

describe('buildRecurrence', () => {
  it('weekly Thursdays, count 8, builds FREQ=WEEKLY;BYDAY=TH;COUNT=8', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: ['TH'], count: 8 };
    const series = buildRecurrence(state, THURSDAY_START, 'America/Denver');
    expect(series?.rrule).toBe('FREQ=WEEKLY;BYDAY=TH;COUNT=8');
    expect(series).toMatchObject({ freq: 'weekly', byDay: ['TH'], count: 8, timezone: 'America/Denver' });
    expect(series?.interval).toBeUndefined();
    expect(series?.until).toBeUndefined();
  });

  it('every-2-weeks carries INTERVAL=2 in both the string and the structured field', () => {
    const state: RecurrenceState = { freq: 'biweekly', byDay: ['TH'], count: 4 };
    const series = buildRecurrence(state, THURSDAY_START, 'America/Denver');
    expect(series?.rrule).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;COUNT=4');
    expect(series?.interval).toBe(2);
  });

  it('monthly builds FREQ=MONTHLY with no BYDAY', () => {
    const state: RecurrenceState = { freq: 'monthly', byDay: [], until: '2027-01-01T00:00:00Z' };
    const series = buildRecurrence(state, THURSDAY_START, 'America/Denver');
    expect(series?.rrule).toBe('FREQ=MONTHLY;UNTIL=20270101T000000Z');
    expect(series?.byDay).toBeUndefined();
  });

  it('"none" builds nothing at all (no series to send)', () => {
    const state: RecurrenceState = { freq: 'none', byDay: [] };
    expect(buildRecurrence(state, THURSDAY_START, 'America/Denver')).toBeUndefined();
  });

  it('defaults BYDAY from the start date when the editor has not picked one', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: [], count: 4 };
    const series = buildRecurrence(state, THURSDAY_START, 'America/Denver');
    expect(series?.byDay).toEqual(['TH']);
  });
});

describe('validateEnd — until XOR count', () => {
  it('accepts count alone', () => {
    expect(() => validateEnd(8, undefined)).not.toThrow();
  });

  it('accepts until alone', () => {
    expect(() => validateEnd(undefined, '2027-01-01')).not.toThrow();
  });

  it('accepts neither (an open-ended series, capped server-side)', () => {
    expect(() => validateEnd(undefined, undefined)).not.toThrow();
  });

  it('rejects both count AND until set at once', () => {
    expect(() => validateEnd(8, '2027-01-01')).toThrow(/never both/);
  });

  it('buildRecurrence itself enforces the same rule', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: ['TH'], count: 8, until: '2027-01-01' };
    expect(() => buildRecurrence(state, THURSDAY_START, 'America/Denver')).toThrow(/never both/);
  });
});

describe('previewOccurrences', () => {
  it('returns 4 dates by default, all landing on Thursday', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: ['TH'], count: 8 };
    const dates = previewOccurrences(state, THURSDAY_START, 'America/Denver');
    expect(dates).toHaveLength(4);
    for (const d of dates) expect(d.getUTCDay()).toBe(4); // Thursday
  });

  it('respects a smaller `n`', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: ['TH'], count: 8 };
    expect(previewOccurrences(state, THURSDAY_START, 'America/Denver', 2)).toHaveLength(2);
  });

  it('is empty for "none"', () => {
    expect(previewOccurrences({ freq: 'none', byDay: [] }, THURSDAY_START, 'America/Denver')).toEqual([]);
  });

  it('biweekly occurrences land 14 days apart', () => {
    const state: RecurrenceState = { freq: 'biweekly', byDay: ['TH'], count: 4 };
    const dates = previewOccurrences(state, THURSDAY_START, 'America/Denver');
    const gapDays = (dates[1]!.getTime() - dates[0]!.getTime()) / 86_400_000;
    expect(gapDays).toBe(14);
  });
});

/**
 * Found manually while verifying Task 5 against the live AppView +
 * materializer: a Thursday 6:30pm Denver class is Friday 00:30 UTC
 * (`new Date('2026-09-17T18:30:00-06:00').getUTCDay() === 5`). `rrule` is
 * UTC-naive and matches `BYDAY` against `getUTCDay()`, so sending the host's
 * own literal `BYDAY=TH` used to make the materializer search forward to the
 * NEXT UTC-Thursday — a full week late. Task 12 fixed this server-side
 * (`apps/appview/src/jobs/materialize-series.ts#plannedOccurrences` now
 * expands `BYDAY` in the series' OWN timezone, not naive UTC), so Task 10
 * removes the client-side shift that used to work around it
 * (`resolveByDay`'s doc comment) — the wire payload now carries the host's
 * literal local-day choice verbatim, as these pin.
 */
describe('BYDAY crosses the UTC day boundary (evening classes west of UTC)', () => {
  // Same calendar Thursday as THURSDAY_START, but at 6:30pm Denver time —
  // 2026-09-18T00:30:00Z, a Friday in UTC.
  const DENVER_EVENING_START = '2026-09-17T18:30:00-06:00';

  it("sends the host's literal local-day BYDAY verbatim, with no UTC shift", () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: ['TH'], count: 8 };
    const series = buildRecurrence(state, DENVER_EVENING_START, 'America/Denver');
    expect(series?.byDay).toEqual(['TH']);
    expect(series?.rrule).toBe('FREQ=WEEKLY;BYDAY=TH;COUNT=8');
  });

  it('the default (no day picked) is likewise the start date\'s own LOCAL weekday, unshifted', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: [], count: 8 };
    const series = buildRecurrence(state, DENVER_EVENING_START, 'America/Denver');
    expect(series?.byDay).toEqual(['TH']);
  });

  it('previewOccurrences still includes the host\'s own start instant as occurrence #1 (the floating-local expansion keeps this correct without a wire-level shift)', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: ['TH'], count: 8 };
    const dates = previewOccurrences(state, DENVER_EVENING_START, 'America/Denver', 4);
    expect(dates[0]!.getTime()).toBe(new Date(DENVER_EVENING_START).getTime());
    // Every later occurrence is exactly N weeks after the first, so the
    // series stays on "Thursday evening, Denver time" throughout.
    for (let i = 1; i < dates.length; i++) {
      const gapDays = (dates[i]!.getTime() - dates[0]!.getTime()) / 86_400_000;
      expect(gapDays).toBe(7 * i);
    }
  });
});
