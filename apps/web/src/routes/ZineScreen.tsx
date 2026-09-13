import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { formatTime, formatTimeRange } from '../lib/dates';
import { useZineMonth } from '../lib/queries';

type Trim = 'letter' | 'a4';

function currentYyyyMm(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(yyyyMm: string, delta: number): string {
  const [y, m] = yyyyMm.split('-').map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(yyyyMm: string): string {
  const [y, m] = yyyyMm.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

/** `yyyy-mm-dd`, parsed as a LOCAL day — never `new Date('yyyy-mm-dd')`, which
 * jsdom and every browser parse as UTC midnight and can shift a day backward
 * in any timezone west of UTC. */
function localDateFromDayString(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/**
 * The monthly print zine: a photocopied free-school calendar, now on
 * `GET /api/zine/:yyyy-mm` (`api.zine.month`) instead of the mock pool.
 *
 * That endpoint returns the SAME redacted shape the public calendar does
 * (neighbourhood, never the street; no host identity) — see
 * `apps/appview/src/http/routes/zine.ts` — so this screen has no host name or
 * description to show, by design, not by omission.
 *
 * Print rules from R8 — explicit @page dimensions (size keywords are
 * unsupported on iOS), paper colour on a wrapper because Safari never prints
 * the `<body>` background, `page-break-inside: avoid` on class blocks because
 * `break-before/after: avoid` are no-ops, and no animation anywhere.
 */
export function ZineScreen() {
  const [trim, setTrim] = useState<Trim>('letter');
  const [month, setMonth] = useState(currentYyyyMm());
  const { data } = useZineMonth(month);
  const days = data?.days ?? [];
  const schoolName = data?.school.name ?? 'Free School';
  const weekdayFormat = useMemo(() => new Intl.DateTimeFormat('en-US', { weekday: 'long' }), []);

  return (
    <div className="app-scroll" style={{ background: 'var(--c-paper-3)' }}>
      <div className="no-print safe-top safe-x flex flex-wrap items-center justify-between gap-3 pb-3">
        <Link to="/" className="display text-caption font-bold text-blue">
          Back to the calendar
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5" role="group" aria-label="Month">
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
              aria-label="Previous month"
              className="border-[1.5px] border-ink px-2 py-1 text-caption"
            >
              ‹
            </button>
            <span className="min-w-[11ch] text-center text-caption font-medium">{monthLabel(month)}</span>
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              aria-label="Next month"
              className="border-[1.5px] border-ink px-2 py-1 text-caption"
            >
              ›
            </button>
          </div>
          <div className="flex" role="group" aria-label="Paper size">
            {(['letter', 'a4'] as Trim[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTrim(option)}
                aria-pressed={trim === option}
                className="border-[1.5px] border-ink px-2.5 py-1 text-caption font-medium"
                style={{
                  background: trim === option ? 'var(--c-ink)' : 'transparent',
                  color: trim === option ? 'var(--c-paper-2)' : 'var(--c-ink)',
                }}
              >
                {option === 'a4' ? 'A4' : 'Letter'}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => window.print()}
            className="border-[1.5px] border-ink bg-pink px-3 py-1 text-caption font-bold"
            style={{ color: 'var(--c-on-pink)' }}
          >
            Print
          </button>
        </div>
      </div>

      {/* @page cannot be nested under a class, so the A4 trim is injected. */}
      {trim === 'a4' ? (
        <style>{'@media print{@page{size:210mm 297mm;margin:14mm}}'}</style>
      ) : (
        <style>{'@media print{@page{size:8.5in 11in;margin:0.5in}}'}</style>
      )}

      <div className="px-3 pb-10">
        <article
          className="zine-page mx-auto"
          style={{
            width: '100%',
            maxWidth: trim === 'a4' ? '182mm' : '7.5in',
            padding: '28px 26px 34px',
            border: '1.5px solid #101010',
          }}
        >
          {/* Masthead: stencilled, misregistered, photocopied twice. */}
          <header style={{ borderBottom: '4px solid #101010', paddingBottom: 14 }}>
            <p className="stamp" style={{ fontSize: 13, letterSpacing: '0.08em' }}>
              {monthLabel(month)}. No fees, no grades, no sign-up sheet at the door.
            </p>
            <h1
              className="display"
              style={{
                fontSize: 'clamp(38px, 11vw, 64px)',
                lineHeight: 0.92,
                fontWeight: 800,
                marginTop: 6,
                textShadow: '3px 3px 0 #ff4d8d',
              }}
            >
              FREE
              <br />
              SCHOOL
            </h1>
            <p style={{ marginTop: 10, maxWidth: '52ch', fontSize: 13.5, lineHeight: 1.45 }}>
              Every class below is taught by somebody who lives near {schoolName}. Turn up. If you can teach
              something, {data?.howToPost ?? 'ask a steward how to post one.'}
            </p>
          </header>

          <div
            style={{
              columnCount: 2,
              columnGap: 22,
              columnRule: '1px solid #101010',
              marginTop: 16,
            }}
          >
            {days.length === 0 ? (
              <p className="text-caption text-ink-soft">Nothing posted for {monthLabel(month)} yet.</p>
            ) : null}
            {days.map((day) => (
              <section key={day.date} className="zine-class" style={{ marginBottom: 16 }}>
                <h2
                  className="stamp"
                  style={{
                    fontSize: 15,
                    borderBottom: '2px solid #101010',
                    paddingBottom: 3,
                    marginBottom: 7,
                  }}
                >
                  {weekdayFormat.format(localDateFromDayString(day.date))} {localDateFromDayString(day.date).getDate()}
                </h2>
                {day.events.map((event) => (
                  <div key={event.uri} className="zine-class" style={{ marginBottom: 11 }}>
                    <p className="stamp" style={{ fontSize: 12.5 }}>
                      {event.startsAt && event.endsAt
                        ? formatTimeRange(event.startsAt, event.endsAt)
                        : event.startsAt
                          ? formatTime(event.startsAt)
                          : 'Time TBD'}
                    </p>
                    <p className="display" style={{ fontSize: 15.5, lineHeight: 1.12, fontWeight: 700 }}>
                      {event.name}
                    </p>
                    <p style={{ fontSize: 11, lineHeight: 1.3, marginTop: 3 }}>
                      {event.venueNeeded ? 'Venue needed — got a room?' : (event.neighborhood ?? 'Location: ask a steward')}
                    </p>
                    {event.tags && event.tags.length > 0 ? (
                      <p style={{ fontSize: 10.5, lineHeight: 1.3, marginTop: 2, color: '#50506a' }}>
                        {event.tags.join(' · ')}
                      </p>
                    ) : null}
                  </div>
                ))}
              </section>
            ))}
          </div>

          <footer
            style={{
              borderTop: '4px solid #101010',
              marginTop: 10,
              paddingTop: 12,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 10,
              alignItems: 'baseline',
              justifyContent: 'space-between',
            }}
          >
            <p className="display" style={{ fontSize: 19, fontWeight: 800, letterSpacing: '-0.02em' }}>
              everybody's a teacher, everybody's a student
            </p>
            <p className="stamp" style={{ fontSize: 11.5 }}>
              freeschool.boulder. Ask for a class, offer a class.
            </p>
          </footer>
        </article>
      </div>
    </div>
  );
}
