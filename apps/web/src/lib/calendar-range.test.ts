import { describe, expect, it } from 'vitest';
import { calendarDays, calendarRange } from './calendar-range';
import { dayKey } from './dates';
describe('calendar navigation', () => {
  it('includes neighboring months in a complete Monday-first month grid', () => {
    const days = calendarDays(new Date(2026, 7, 15), 'month');
    expect(dayKey(days[0]!)).toBe('2026-07-27');
    expect(dayKey(days.at(-1)!)).toBe('2026-09-06');
    expect(days).toHaveLength(42);
  });
  it('keeps cross-year weeks intact', () => {
    const r = calendarRange(new Date(2027, 0, 1), 'week');
    expect(dayKey(r.from)).toBe('2026-12-28');
    expect(dayKey(r.to)).toBe('2027-01-04');
  });
  it('uses local calendar days across daylight saving transitions', () => {
    const r = calendarRange(new Date(2026, 2, 8), 'day');
    expect(dayKey(r.from)).toBe('2026-03-08');
    expect(dayKey(r.to)).toBe('2026-03-09');
    expect(r.to.getHours()).toBe(0);
  });
});
