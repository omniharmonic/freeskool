import { Screen } from '../components/Screen';
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
  const { data, isPending, isError } = useHowItWorks();

  return (
    <Screen
      title={data?.title ?? 'How this skool works'}
      back
      trailing={
        <button
          type="button"
          onClick={() => window.print()}
          className="border-[1.5px] border-ink bg-pink px-3 py-1 text-caption font-bold"
          style={{ color: 'var(--c-on-pink)' }}
        >
          Print
        </button>
      }
    >
      <div className="safe-x space-y-6 pb-4">
        {isPending ? <p className="text-body text-ink-soft">Loading…</p> : null}
        {isError ? (
          <p className="text-body text-ink-soft">Could not load this page right now. Try again in a moment.</p>
        ) : null}

        {data?.sections.map((section) => (
          <section key={section.heading}>
            <h2 className="text-lede font-bold">{section.heading}</h2>
            <p className="mt-1.5 max-w-[60ch] text-body">{section.body}</p>
          </section>
        ))}

        {data ? (
          <p className="text-caption text-ink-faint">Last updated {dateFormat.format(new Date(data.lastUpdated))}.</p>
        ) : null}
      </div>
    </Screen>
  );
}
