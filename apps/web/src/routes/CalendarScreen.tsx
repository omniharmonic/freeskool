import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { school } from '../lib/mock';
import { dayKey, formatDayStamp, formatTime, formatTimeRange, formatWeekday, groupByDay, monthDays } from '../lib/dates';
import { Screen } from '../components/Screen';
import { SkillChip } from '../components/bits';
import { useCalendar } from '../lib/queries';
import type { CalendarEvent } from '../lib/types';

const INKS = ['pink', 'blue', 'green', 'amber'] as const;

/** A real class carries no colour of its own; cycling through the four riso
 * inks keeps the list visually distinct without inventing a fact. */
function inkFor(index: number): (typeof INKS)[number] {
  return INKS[index % INKS.length]!;
}

function CalendarEventCard({ event, ink }: { event: CalendarEvent; ink: (typeof INKS)[number] }) {
  return (
    <Link
      to="/events/$id"
      params={{ id: event.uri }}
      className={`plate plate-press plate-${ink} block overflow-hidden`}
    >
      <div
        className="halftone flex items-end justify-between px-3.5 pt-6 pb-2"
        style={{ '--ht': `var(--c-${ink})` } as React.CSSProperties}
      >
        <span
          className="stamp text-[22px] leading-none"
          style={{ color: ink === 'pink' || ink === 'amber' ? 'var(--c-on-pink)' : 'var(--c-paper-2)' }}
        >
          {event.startsAt && event.endsAt
            ? formatTimeRange(event.startsAt, event.endsAt)
            : event.startsAt
              ? formatTime(event.startsAt)
              : 'Time TBD'}
        </span>
      </div>

      <div className="px-3.5 pt-3 pb-3.5">
        <h3 className="text-lede leading-snug">{event.name}</h3>
        <p className="mt-1 text-caption text-ink-soft">
          {event.venueNeeded ? 'Venue needed' : event.neighborhood ?? 'Location shared after you RSVP'}
        </p>
        {event.tags && event.tags.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-2">
            {event.tags.map((tag) => (
              <SkillChip key={tag}>{tag}</SkillChip>
            ))}
          </div>
        ) : null}
      </div>
    </Link>
  );
}

export function CalendarScreen() {
  const now = useMemo(() => new Date(), []);
  const year = now.getFullYear();
  const monthIndex = now.getMonth();
  const range = useMemo(
    () => ({
      from: new Date(year, monthIndex, 1).toISOString(),
      to: new Date(year, monthIndex + 1, 1).toISOString(),
    }),
    [year, monthIndex],
  );
  const { data } = useCalendar(range);
  const calendarEvents = data?.events ?? [];

  const groups = useMemo(
    () => groupByDay(calendarEvents, (event) => event.startsAt ?? ''),
    [calendarEvents],
  );
  const dayRefs = useRef(new Map<string, HTMLElement>());
  const [focused, setFocused] = useState<string | null>(groups[0]?.key ?? null);

  const strip = useMemo(() => monthDays(year, monthIndex), [year, monthIndex]);
  const busy = useMemo(() => new Set(groups.map((group) => group.key)), [groups]);

  const stripRef = useRef<HTMLDivElement>(null);

  // Open on the first day that has something on it, not on the 1st of the month.
  useEffect(() => {
    const first = groups[0]?.key;
    if (!first) return;
    setFocused(first);
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
        {groups.length === 0 ? (
          <div className="safe-x mt-2">
            <p className="text-body text-ink-soft">
              Nothing on the calendar yet.{' '}
              <Link to="/requests" className="font-medium text-blue underline decoration-dotted underline-offset-4">
                Post what you'd like to learn.
              </Link>
            </p>
          </div>
        ) : null}
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
              <span className="stamp text-[15px]">{formatDayStamp(group.date)}</span>
              <span className="h-px flex-1" style={{ background: 'var(--c-rule)' }} />
              <span className="text-caption text-ink-faint">
                {group.items.length} {group.items.length === 1 ? 'class' : 'classes'}
              </span>
            </h2>
            <div className="safe-x mb-7 space-y-4">
              {group.items.map((event, i) => (
                <CalendarEventCard key={event.uri} event={event} ink={inkFor(i)} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Screen>
  );
}
