import { LoadingState, PageState } from '../components/PageState';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ZinePages } from '../components/ZinePages';
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
  const { data, isPending, isError, refetch } = useZineMonth(month);

  return (
    <div className="app-scroll" style={{ background: 'var(--c-paper-3)' }}>
      {data?.truncated ? <p role="status" className="safe-x py-3 text-body">This month has more classes than the zine can hold. The printed calendar may be incomplete.</p> : null}
      <div className="zine-toolbar no-print safe-top safe-x flex flex-wrap items-center justify-between gap-3 pb-3">
        <Link to="/" className="display text-caption font-bold text-blue">
          Back to the calendar
        </Link>
        <div className="zine-controls flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5" role="group" aria-label="Month">
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, -1))}
              aria-label="Previous month"
              className="min-h-[44px] min-w-[44px] border-[1.5px] border-ink px-2 py-1 text-caption"
            >
              ‹
            </button>
            <span className="min-w-[11ch] text-center text-caption font-medium">{monthLabel(month)}</span>
            <button
              type="button"
              onClick={() => setMonth((m) => shiftMonth(m, 1))}
              aria-label="Next month"
              className="min-h-[44px] min-w-[44px] border-[1.5px] border-ink px-2 py-1 text-caption"
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
                className="min-h-[44px] min-w-[44px] border-[1.5px] border-ink px-2.5 py-1 text-caption font-medium"
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
            disabled={isPending || isError}
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
        {isPending ? <div className="mx-auto max-w-xl"><LoadingState label="Preparing the monthly zine…" /></div> : null}
        {isError ? <div className="mx-auto max-w-xl"><PageState title="The zine couldn’t load." error action={<button className="primary-action" onClick={() => void refetch()}>Try again</button>}>Wait until the calendar loads before printing.</PageState></div> : null}
        {data ? <ZinePages data={data} trim={trim} /> : null}
      </div>
    </div>
  );
}
