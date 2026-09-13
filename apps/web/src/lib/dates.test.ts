import { describe, expect, it } from 'vitest';
import { dayKey, formatDayStamp, groupByDay, monthDays } from './dates';

interface Row {
  id: string;
  startsAt: string;
}

const start = (row: Row) => row.startsAt;

describe('groupByDay', () => {
  it('groups by local calendar day, ascending, and sorts within each day', () => {
    const rows: Row[] = [
      { id: 'late', startsAt: '2026-09-17T21:00:00-06:00' },
      { id: 'next-day', startsAt: '2026-09-18T19:00:00-06:00' },
      { id: 'early', startsAt: '2026-09-17T17:00:00-06:00' },
    ];
    const groups = groupByDay(rows, start);
    expect(groups.map((group) => group.key)).toEqual(['2026-09-17', '2026-09-18']);
    expect(groups[0]!.items.map((row) => row.id)).toEqual(['early', 'late']);
    expect(groups[1]!.items.map((row) => row.id)).toEqual(['next-day']);
  });

  it('keys off the local day, not the UTC day', () => {
    // 21:00 Mountain on the 17th is 03:00 UTC on the 18th. Grouping by the UTC
    // date would file this class under the wrong day in the list.
    const key = dayKey('2026-09-17T21:00:00-06:00');
    expect(key).toBe(new Date('2026-09-17T21:00:00-06:00').getFullYear() + '-09-17');
    expect(key).not.toBe('2026-09-18');
  });

  it('drops unparseable timestamps rather than inventing a day', () => {
    const groups = groupByDay([{ id: 'bad', startsAt: 'soon' }], start);
    expect(groups).toEqual([]);
  });

  it('returns nothing for an empty list', () => {
    expect(groupByDay([], start)).toEqual([]);
  });
});

describe('formatDayStamp', () => {
  const today = new Date(2026, 8, 17);
  it('names today and tomorrow before falling back to a weekday', () => {
    expect(formatDayStamp(new Date(2026, 8, 17), today)).toBe('Today, Sep 17');
    expect(formatDayStamp(new Date(2026, 8, 18), today)).toBe('Tomorrow, Sep 18');
    expect(formatDayStamp(new Date(2026, 8, 24), today)).toBe('Thu, Sep 24');
  });
});

describe('monthDays', () => {
  it('spans the whole month', () => {
    const days = monthDays(2026, 8); // September
    expect(days).toHaveLength(30);
    expect(days[0]!.getDate()).toBe(1);
    expect(days.at(-1)!.getDate()).toBe(30);
  });

  it('handles February in a leap year', () => {
    expect(monthDays(2028, 1)).toHaveLength(29);
  });
});
