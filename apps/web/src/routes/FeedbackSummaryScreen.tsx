import { useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { useEvent, useFeedbackSummary } from '../lib/queries';

type Aspect = 'knowledge' | 'teaching' | 'experience';

const ASPECT_LABELS: Array<{ key: Aspect; label: string }> = [
  { key: 'knowledge', label: 'Knew the material' },
  { key: 'teaching', label: 'Taught it well' },
  { key: 'experience', label: 'The experience' },
];

/** Three stamped squares, never a decimal. `mean` may come from a scale wider
 * than three points (the server's own numeric range is 1-5); rounding and
 * clamping to 0-3 is deliberate — the host sees "roughly how many dots", not
 * the raw number. */
function AspectDots({ mean }: { mean: number }) {
  const filled = Math.min(3, Math.max(0, Math.round(mean)));
  return (
    <span className="inline-flex items-center gap-[3px]" role="img" aria-label={`${filled} of 3`}>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          aria-hidden="true"
          className="h-[9px] w-[9px] border-[1.5px] border-ink"
          style={{ background: n <= filled ? 'var(--c-ink)' : 'transparent' }}
        />
      ))}
    </span>
  );
}

/**
 * `/events/$id/feedback-summary` — the ONLY view anyone ever gets of
 * feedback on a class, for `GET /api/events/:id/feedback-summary`
 * (`apps/appview/src/http/routes/feedback.ts`). The route itself has no
 * auth check (everyone sees the same k-anonymous aggregate, by design — see
 * that route's doc comment); the host-only gate here is purely this screen
 * choosing when to surface the link, mirroring `AttendanceScreen`.
 *
 * Per-aspect means render as dots, never as a decimal, and there is no path
 * that renders an individual row — `feedbackSummary()` never returns one.
 */
export function FeedbackSummaryScreen() {
  const { id } = useParams({ from: '/events/$id/feedback-summary' });
  const { data: event, isPending: eventPending } = useEvent(id);
  const { data: summary, isPending: summaryPending } = useFeedbackSummary(id);

  if (eventPending || summaryPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x" />
      </Screen>
    );
  }

  if (!event || (event.viewerRelation !== 'host' && event.viewerRelation !== 'steward')) {
    return (
      <Screen title="Feedback summary" back>
        <div className="safe-x">
          <p className="text-body text-ink-soft">Only the host or a steward may see this class's feedback summary.</p>
        </div>
      </Screen>
    );
  }

  return (
    <Screen
      title={event.name}
      standfirst="Counts and presence only — never who said what, or a single row of ratings."
      back
    >
      <div className="safe-x space-y-5">
        <div className="plate p-4">
          <p className="text-body">
            {summary?.count ?? 0} {(summary?.count ?? 0) === 1 ? 'person has' : 'people have'} left feedback.
          </p>
        </div>

        {summary?.released ? (
          <>
            <div className="plate plate-green p-4">
              <p className="text-body">
                {summary.positive ?? 0} positive, {summary.negative ?? 0} negative.
              </p>
            </div>

            {summary.aspects && Object.keys(summary.aspects).length > 0 ? (
              <dl className="space-y-3">
                {ASPECT_LABELS.map(({ key, label }) => {
                  const aspect = summary.aspects?.[key];
                  if (!aspect) return null;
                  return (
                    <div key={key} className="plate flex items-center justify-between gap-3 p-3.5">
                      <dt className="text-body">{label}</dt>
                      <dd>
                        <AspectDots mean={aspect.mean} />
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : null}

            {summary.textReleased ? (
              summary.texts && summary.texts.length > 0 ? (
                <div>
                  <h2 className="mb-2 text-lede font-bold">What people said</h2>
                  <ul className="space-y-2">
                    {summary.texts.map((text, i) => (
                      <li key={i} className="plate p-3.5">
                        <p className="text-body">{text}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null
            ) : (
              <p className="text-caption text-ink-faint">
                Written comments stay withheld until at least {summary.textK ?? 5} people have answered.
              </p>
            )}
          </>
        ) : (
          <p className="text-caption text-ink-faint">The summary stays sealed until enough people respond.</p>
        )}
      </div>
    </Screen>
  );
}
