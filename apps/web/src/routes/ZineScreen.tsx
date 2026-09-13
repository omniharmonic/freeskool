import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { events, school } from '../lib/mock';
import { formatTimeRange, groupByDay } from '../lib/dates';

type Trim = 'letter' | 'a4';

/**
 * The monthly print zine: a photocopied free-school calendar.
 *
 * Print rules from R8 — explicit @page dimensions (size keywords are
 * unsupported on iOS), paper colour on a wrapper because Safari never prints
 * the body background, `page-break-inside: avoid` on class blocks because
 * `break-before/after: avoid` are no-ops, and no animation anywhere.
 */
export function ZineScreen() {
  const [trim, setTrim] = useState<Trim>('letter');
  const groups = useMemo(() => groupByDay(events, (event) => event.startsAt), []);
  const weekdayFormat = new Intl.DateTimeFormat('en-US', { weekday: 'long' });

  return (
    <div className="app-scroll" style={{ background: 'var(--c-paper-3)' }}>
      <div className="no-print safe-top safe-x flex items-center justify-between gap-3 pb-3">
        <Link to="/" className="display text-caption font-bold text-blue">
          Back to the calendar
        </Link>
        <div className="flex items-center gap-2">
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
              {school.monthLabel}. No fees, no grades, no sign-up sheet at the door.
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
              Every class below is taught by somebody who lives in {school.locality}. Turn up. If you can teach
              something, the back page is how. Photocopy this and put it somewhere people stand still.
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
            {groups.map((group) => (
              <section key={group.key} className="zine-class" style={{ marginBottom: 16 }}>
                <h2
                  className="stamp"
                  style={{
                    fontSize: 15,
                    borderBottom: '2px solid #101010',
                    paddingBottom: 3,
                    marginBottom: 7,
                  }}
                >
                  {weekdayFormat.format(group.date)} {group.date.getDate()}
                </h2>
                {group.items.map((event) => (
                  <div key={event.uri} className="zine-class" style={{ marginBottom: 11 }}>
                    <p className="stamp" style={{ fontSize: 12.5 }}>
                      {formatTimeRange(event.startsAt, event.endsAt)}
                    </p>
                    <p className="display" style={{ fontSize: 15.5, lineHeight: 1.12, fontWeight: 700 }}>
                      {event.name}
                    </p>
                    <p style={{ fontSize: 11.5, lineHeight: 1.38, marginTop: 2 }}>
                      {event.description.split('. ')[0]}.
                    </p>
                    <p style={{ fontSize: 11, lineHeight: 1.3, marginTop: 3 }}>
                      {event.host.displayName}, {event.locations[0]?.name}
                    </p>
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
              {school.motto}
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
