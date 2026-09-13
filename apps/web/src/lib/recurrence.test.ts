import { describe, expect, it } from 'vitest';
import { buildRecurrence, previewOccurrences, validateEnd, type RecurrenceState } from './recurrence';

const THURSDAY_START = '2026-09-17T18:30:00-06:00'; // a Thursday

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
    const dates = previewOccurrences(state, THURSDAY_START);
    expect(dates).toHaveLength(4);
    for (const d of dates) expect(d.getUTCDay()).toBe(4); // Thursday
  });

  it('respects a smaller `n`', () => {
    const state: RecurrenceState = { freq: 'weekly', byDay: ['TH'], count: 8 };
    expect(previewOccurrences(state, THURSDAY_START, 2)).toHaveLength(2);
  });

  it('is empty for "none"', () => {
    expect(previewOccurrences({ freq: 'none', byDay: [] }, THURSDAY_START)).toEqual([]);
  });

  it('biweekly occurrences land 14 days apart', () => {
    const state: RecurrenceState = { freq: 'biweekly', byDay: ['TH'], count: 4 };
    const dates = previewOccurrences(state, THURSDAY_START);
    const gapDays = (dates[1]!.getTime() - dates[0]!.getTime()) / 86_400_000;
    expect(gapDays).toBe(14);
  });
});
