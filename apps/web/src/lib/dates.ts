/** Date helpers for the calendar list. Grouping is by LOCAL calendar day. */

export interface DayGroup<T> {
  /** Local day key, `YYYY-MM-DD`. Stable to sort lexicographically. */
  key: string;
  date: Date;
  items: T[];
}

/** Local-day key. Never `toISOString()` — that silently shifts across midnight. */
export function dayKey(input: string | Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Group items into local calendar days, ascending by day and by time within
 * each day. Items whose timestamp does not parse are dropped rather than
 * clustered into a bogus day.
 */
export function groupByDay<T>(items: readonly T[], getStart: (item: T) => string): DayGroup<T>[] {
  const buckets = new Map<string, { date: Date; items: { at: number; item: T }[] }>();

  for (const item of items) {
    const start = new Date(getStart(item));
    const at = start.getTime();
    if (Number.isNaN(at)) continue;
    const key = dayKey(start);
    let bucket = buckets.get(key);
    if (!bucket) {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      bucket = { date, items: [] };
      buckets.set(key, bucket);
    }
    bucket.items.push({ at, item });
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, bucket]) => ({
      key,
      date: bucket.date,
      items: bucket.items.sort((a, b) => a.at - b.at).map((entry) => entry.item),
    }));
}

const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

export function formatDayStamp(date: Date, today = new Date()): string {
  const k = dayKey(date);
  if (k === dayKey(today)) return `Today, ${monthDay.format(date)}`;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (k === dayKey(tomorrow)) return `Tomorrow, ${monthDay.format(date)}`;
  return `${weekday.format(date)}, ${monthDay.format(date)}`;
}

export function formatTimeRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return `${clock.format(start).toLowerCase().replace(' ', '')}–${clock.format(end).toLowerCase().replace(' ', '')}`;
}

export function formatWeekday(date: Date): string {
  return weekday.format(date);
}

/** The days of one month, for the date strip. */
export function monthDays(year: number, monthIndex: number): Date[] {
  const count = new Date(year, monthIndex + 1, 0).getDate();
  return Array.from({ length: count }, (_, i) => new Date(year, monthIndex, i + 1));
}
