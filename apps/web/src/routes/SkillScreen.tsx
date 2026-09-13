import { Link, useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Button, SkillChip, ThresholdRule } from '../components/bits';
import { useEvent, useRequests, useSkill } from '../lib/queries';
import { formatTime, formatTimeRange } from '../lib/dates';

/**
 * TIER: `GET /api/skills/:id` now carries `tier` (Task 12) — a "Sensitive"
 * chip renders under the title for a Tier B skill (`apps/appview/src/lib/
 * skill-tiers.ts`).
 *
 * NOT SHOWN: a "resources" section (zines, tool-library links) — there is
 * no backend route for skill resources; the mock-era section read from
 * `lib/mock.ts` data that nothing real replaces yet.
 */
export function SkillScreen() {
  const { skillId } = useParams({ from: '/skills/$skillId' });
  const { data: skill, isPending, isError } = useSkill(skillId);
  const { data: requestsData } = useRequests();

  if (isPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x" />
      </Screen>
    );
  }

  if (isError || !skill) {
    return (
      <Screen title="Skill not found" back>
        <div className="safe-x">
          <p className="text-body text-ink-soft">Nothing is filed under that name yet.</p>
          <div className="mt-4">
            <Button href="/skills" ink="blue">
              Browse all skills
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  const waiting = (requestsData?.requests ?? []).filter(
    (request) => request.skill === skill.uri && request.status === 'open',
  );

  return (
    <Screen title={skill.label} back>
      <div className="safe-x">
        {skill.tier === 'B' ? (
          <div className="mb-3">
            <SkillChip ink="pink">Sensitive — kept off public listings by default</SkillChip>
          </div>
        ) : null}
        {skill.description ? <p className="max-w-[60ch] text-body">{skill.description}</p> : null}

        {skill.taughtIn.length === 0 ? (
          <div className="mt-5">
            <div className="plate plate-amber p-4">
              <p className="text-body">Nobody has put this on the calendar yet.</p>
              <p className="mt-1 text-caption text-ink-soft">
                Ask for it and we'll find a teacher, or offer to teach it yourself.
              </p>
              <div className="mt-3.5">
                <Button href="/requests" ink="amber">
                  Ask for this class
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {skill.taughtIn.length > 0 ? (
        <>
          <h2 className="safe-x mt-7 mb-2.5 text-lede font-bold">Coming up</h2>
          <div className="safe-x space-y-4">
            {skill.taughtIn
              .filter((t): t is { event: string; level: number } => Boolean(t.event))
              .map((t) => (
                <TaughtInEventCard key={t.event} eventUri={t.event} />
              ))}
          </div>
        </>
      ) : null}

      {waiting.length > 0 ? (
        <>
          <h2 className="safe-x mt-7 mb-2.5 text-lede font-bold">People waiting</h2>
          <div className="safe-x space-y-3">
            {waiting.map((request) => (
              <Link key={request.uri} to="/requests" className="plate plate-amber block p-3.5">
                <p className="text-body">{request.title}</p>
                {typeof request.threshold === 'number' ? (
                  <div className="mt-3">
                    <ThresholdRule count={request.rsvpCount} threshold={request.threshold} />
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </Screen>
  );
}

/** One taught-in class. `GET /api/skills/:id`'s `taughtIn` carries only the
 * event's URI and the level it was taught at, so this fetches the event
 * itself to show the things people actually want to see (when, where). */
function TaughtInEventCard({ eventUri }: { eventUri: string }) {
  const { data: event, isPending } = useEvent(eventUri);
  if (isPending || !event) return null;

  return (
    <Link to="/events/$id" params={{ id: event.uri }} className="plate plate-press plate-blue block overflow-hidden">
      <div className="halftone px-3.5 pt-3 pb-2" style={{ '--ht': 'var(--c-blue)' } as React.CSSProperties}>
        <span className="stamp text-[18px] leading-none" style={{ color: 'var(--c-paper-2)' }}>
          {event.startsAt && event.endsAt
            ? formatTimeRange(event.startsAt, event.endsAt)
            : event.startsAt
              ? formatTime(event.startsAt)
              : 'Time TBD'}
        </span>
      </div>
      <div className="px-3.5 pt-2.5 pb-3.5">
        <h3 className="text-lede leading-snug">{event.name}</h3>
        <p className="mt-1 text-caption text-ink-soft">
          {event.venueNeeded ? 'Venue needed' : event.neighborhood ?? 'Location shared after you RSVP'}
        </p>
      </div>
    </Link>
  );
}
