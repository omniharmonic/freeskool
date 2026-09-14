import { Link } from '@tanstack/react-router';
import { LoadingState, PageState } from '../components/PageState';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { useHowItWorks } from '../lib/queries';

const dateFormat = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * `/how-it-works` — `GET /api/school/how-it-works` (`apps/appview/src/lib/
 * how-it-works.ts`), rendered live from the school's own record and its
 * CURRENT policy thresholds. Printable: the print rules in `styles.css`
 * (`.app-chrome`, `.tab-bar`, `.no-print` all hidden under `@media print`)
 * are already global — imported once in `main.tsx` — so nothing route-
 * specific needs to be extracted; this screen just avoids putting anything
 * essential inside the chrome that print already hides.
 */
export function HowItWorksScreen() {
  const { data, isPending, isError, refetch } = useHowItWorks();

  return (
    <Screen
      layout="reading"
      title={data?.title ?? 'How this skool works'}
      back
      trailing={
        // B5: a real tap target (>= 44px) — the shared `Button`, not a
        // bespoke one-off sized to fit the header bar.
        <Button type="button" onClick={() => window.print()}>
          Print
        </Button>
      }
    >
      <div className="safe-x reading-sections pb-4">
        {isPending ? <LoadingState label="Opening the school’s shared agreements…" /> : null}
        {isError ? (
          <PageState title="Could not load this page right now." error action={<button className="primary-action" onClick={() => void refetch()}>Try again</button>}>Try again in a moment.</PageState>
        ) : null}

        {data?.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-lede font-bold">{section.heading}</h2>
            <p className="mt-1.5 max-w-[60ch] text-body">{section.body}</p>
          </section>
        ))}

        <section>
          <h2 className="text-lede font-bold">Other free schools</h2>
          <p className="mt-1.5 max-w-[60ch] text-body">
            This is one school among others, each run by the people in it. The directory lists them and links
            to each one’s own calendar.
          </p>
          <p className="mt-1.5">
            <Link to="/schools" className="text-caption font-bold text-blue">
              See the other schools <span aria-hidden="true">↗</span>
            </Link>
          </p>
        </section>

        {data ? (
          <p className="text-caption text-ink-faint">Last updated {dateFormat.format(new Date(data.lastUpdated))}.</p>
        ) : null}
      </div>
    </Screen>
  );
}
