import { KnowledgeShelf, PractitionerShelf } from '../components/KnowledgeShelf';
import { ApiError } from '../lib/api';
import { Link, useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Button, MemberAvatar, SkillChip, ThresholdRule, claimLevelLabel } from '../components/bits';
import { useEvent, useRequests, useSkill } from '../lib/queries';
import { ContentCard } from '../components/ContentCard';
import { FieldGlyph } from '../components/FieldGlyph';
import { LoadingState, PageState } from '../components/PageState';
import type { SkillPeople } from '../lib/types';

/**
 * TIER: `GET /api/skills/:id` now carries `tier` (Task 12) — a "Sensitive"
 * chip renders under the title for a Tier B skill (`apps/appview/src/lib/
 * skill-tiers.ts`).
 *
 * Resources and opt-in practitioners share the same stable skill URI.
 */
export function SkillScreen() {
  const { skillId } = useParams({ from: '/skills/$skillId' });
  const { data: skill, isPending, isError, error, refetch } = useSkill(skillId);
  const { data: requestsData } = useRequests();

  if (isPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x"><LoadingState label="Finding this skill…" /></div>
      </Screen>
    );
  }

  if (isError && !(error instanceof ApiError && error.status === 404)) {
    return <Screen title="Couldn’t load this skill" back><div className="safe-x"><PageState title="Let’s try that again." error action={<Button onClick={() => void refetch()}>Try again</Button>}>Please check your connection and try again.</PageState></div></Screen>;
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
    <Screen title={skill.label} layout="library" back>
      <div className="safe-x">
        <nav className="breadcrumbs" aria-label="Skill ancestry"><Link to="/skills">Skills</Link>{skill.ancestors?.map(a => <span key={a.uri}> / <Link to="/skills/$skillId" params={{skillId:a.uri}}>{a.label}</Link></span>)}</nav>
        <div className="skill-detail-intro"><FieldGlyph seed={skill.id} /><div>
        {skill.tier === 'B' || skill.status === 'proposed' ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {skill.tier === 'B' ? <SkillChip ink="pink">Sensitive — kept off public listings by default</SkillChip> : null}
            {skill.status === 'proposed' ? <SkillChip ink="ink">proposed</SkillChip> : null}
          </div>
        ) : null}
        {skill.description ? <p className="max-w-[60ch] text-body">{skill.description}</p> : <p className="text-body">Learn it together. Pass it on.</p>}</div></div>
        {skill.children?.length ? <section className="mb-7"><h2 className="section-heading">Explore this skill</h2><div className="skill-links">{skill.children.map(child => <Link key={child.uri} to="/skills/$skillId" params={{skillId:child.uri}} className="skill-link">{child.label}</Link>)}</div></section> : null}

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
          <h2 className="safe-x mt-7 mb-2.5 text-lede font-bold">Classes sharing this skill</h2>
          <div className="safe-x content-grid">
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
      <div className="safe-x">
        <KnowledgeShelf skill={skill.uri}/>
        {/* `people` is present only for a signed-in viewer (R9: the roster is
            never public), so its absence — not a separate `useMe()` — is what
            decides which of these two the reader gets. */}
        {skill.people ? (
          <PeopleWithSkill people={skill.people} />
        ) : (
          <>
            <PractitionerShelf skill={skill.uri}/>
            <div className="library-empty mt-3">
              <p>Sign in to see members who know this skill, and to vouch for what someone can do.</p>
              <a href="/signin" className="context-link">Sign in ↗</a>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}

/**
 * Who at this school holds this skill. Members-only, capped server-side at 50
 * with `count` still carrying the full visible total — so a big skill reads
 * "24 people know this" and shows as many as the page can hold. A member who
 * has hidden themselves from the directory is absent here too.
 */
function PeopleWithSkill({ people }: { people: SkillPeople }) {
  return (
    <section className="knowledge-shelf">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">Learning is a social thing</p>
          <h2>People with this skill</h2>
        </div>
        <Link to="/people" className="context-link">All the people ↗</Link>
      </div>
      {people.members.length === 0 ? (
        <div className="library-empty">
          <p>Nobody has put this on their own page yet.</p>
          <p>If you know some of it, add it in your notebook — that is how the next person finds you.</p>
        </div>
      ) : (
        <>
          <p className="section-caption">
            {people.count} {people.count === 1 ? 'person knows' : 'people know'} this.
          </p>
          <ul className="member-grid">
            {people.members.map((member) => {
              const name = member.displayName || member.handle || 'A member';
              return (
                <li key={member.did}>
                  <Link to="/people/$did" params={{ did: member.did }} className="member-card">
                    <MemberAvatar src={member.avatarUrl} name={name} />
                    <div className="min-w-0 flex-1">
                      <p className="member-card-name">{name}</p>
                      <p className="member-card-meta">
                        {claimLevelLabel(member.level)}
                        {member.vouchCount > 0
                          ? ` · ${member.vouchCount} ${member.vouchCount === 1 ? 'vouch' : 'vouches'}`
                          : ''}
                      </p>
                    </div>
                    <span aria-hidden="true" className="text-ink-faint">↗</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** One taught-in class. `GET /api/skills/:id`'s `taughtIn` carries only the
 * event's URI and the level it was taught at, so this fetches the event
 * itself to show the things people actually want to see (when, where). */
function TaughtInEventCard({ eventUri }: { eventUri: string }) {
  const { data: event, isPending } = useEvent(eventUri);
  if (isPending || !event) return null;

  return <ContentCard event={event} />;
}
