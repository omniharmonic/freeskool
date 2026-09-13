import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { events, school, USE_MOCK } from '../lib/mock';
import { dayKey, formatDayStamp, formatWeekday, groupByDay, monthDays } from '../lib/dates';
import { Screen } from '../components/Screen';
import { EventCard } from '../components/EventCard';

// Not wired to `useCalendar` yet (Task 4) — real data defaults to empty
// rather than showing the mock month once USE_MOCK is off.
const calendarEvents = USE_MOCK ? events : [];

export function CalendarScreen() {
  const groups = useMemo(() => groupByDay(calendarEvents, (event) => event.startsAt), []);
  const dayRefs = useRef(new Map<string, HTMLElement>());
  const [focused, setFocused] = useState<string | null>(groups[0]?.key ?? null);

  const strip = useMemo(() => monthDays(2026, 8), []);
  const busy = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);

  const stripRef = useRef<HTMLDivElement>(null);

  // Open on the first day that has something on it, not on the 1st of the month.
  useEffect(() => {
    const first = groups[0]?.key;
    if (!first) return;
    stripRef.current?.querySelector(`[data-day="${first}"]`)?.scrollIntoView({
      block: 'nearest',
      inline: 'start',
    });
  }, [groups]);

  const jump = (key: string) => {
    setFocused(key);
    dayRefs.current.get(key)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <Screen
      title={school.name}
      standfirst={`Classes your neighbours are teaching this month in ${school.locality}. Nothing costs money.`}
      trailing={
        <Link to="/zine" className="display text-caption font-bold text-blue">
          Print zine
        </Link>
      }
      beneathTitle={
        <div ref={stripRef} className="hide-scrollbar mt-3 overflow-x-auto">
          <div className="safe-x flex gap-1.5 pb-1">
            {strip.map((date) => {
              const key = dayKey(date);
              const hasClass = busy.has(key);
              const isFocused = focused === key;
              return (
                <button
                  key={key}
                  data-day={key}
                  type="button"
                  disabled={!hasClass}
                  onClick={() => jump(key)}
                  className="flex w-[42px] shrink-0 flex-col items-center gap-0.5 border-[1.5px] py-1.5"
                  style={{
                    borderColor: hasClass ? 'var(--c-ink)' : 'transparent',
                    background: isFocused && hasClass ? 'var(--c-pink)' : 'transparent',
                    color: isFocused && hasClass ? 'var(--c-on-pink)' : hasClass ? 'var(--c-ink)' : 'var(--c-ink-faint)',
                    opacity: hasClass ? 1 : 0.55,
                  }}
                  aria-label={`${formatWeekday(date)} ${date.getDate()}${hasClass ? '' : ', no classes'}`}
                >
                  <span className="text-[10px] leading-none">{formatWeekday(date)}</span>
                  <span className="stamp text-[17px] leading-none">{date.getDate()}</span>
                  <span
                    className="h-[3px] w-[3px] rounded-full"
                    style={{ background: hasClass ? 'currentColor' : 'transparent' }}
                    aria-hidden="true"
                  />
                </button>
              );
            })}
          </div>
        </div>
      }
    >
      <div className="mt-5">
        {groups.map((group) => (
          <section
            key={group.key}
            ref={(node) => {
              if (node) dayRefs.current.set(group.key, node);
              else dayRefs.current.delete(group.key);
            }}
            className="scroll-mt-[76px]"
          >
            {/* Date stamp, the way a library due-date card reads. */}
            <h2 className="day-stamp safe-x sticky top-[58px] z-10 mb-2.5 flex items-baseline gap-2 py-1.5">
              <span className="stamp text-[15px]">{formatDayStamp(group.date, new Date(2026, 8, 17))}</span>
              <span className="h-px flex-1" style={{ background: 'var(--c-rule)' }} />
              <span className="text-caption text-ink-faint">
                {group.items.length} {group.items.length === 1 ? 'class' : 'classes'}
              </span>
            </h2>
            <div className="safe-x mb-7 space-y-4">
              {group.items.map((event) => (
                <EventCard key={event.uri} event={event} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Screen>
  );
}
