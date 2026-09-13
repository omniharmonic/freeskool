export type CalendarView = 'list' | 'month' | 'week' | 'day';
export function addDays(date: Date, amount: number) { return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount); }
export function startOfWeek(date: Date) { return addDays(date, -(date.getDay() + 6) % 7); }
export function calendarRange(date: Date, view: CalendarView) {
  if (view === 'day') return { from: addDays(date, 0), to: addDays(date, 1) };
  if (view === 'week') { const from = startOfWeek(date); return { from, to: addDays(from, 7) }; }
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const next = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  if (view === 'list') return { from: first, to: next };
  const from = startOfWeek(first);
  const finalWeek = startOfWeek(addDays(next, -1));
  return { from, to: addDays(finalWeek, 7) };
}
export function calendarDays(date: Date, view: CalendarView) {
  const { from, to } = calendarRange(date, view);
  const days: Date[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  return days;
}
