import { useEffect, useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { SessionGate } from '../components/SessionGate';
import { SkillPicker } from '../components/SkillPicker';
import { LoadingState, PageState } from '../components/PageState';
import { Button, MemberAvatar } from '../components/bits';
import { flattenSkills } from '../lib/skills';
import { useMembers, useSkillTree } from '../lib/queries';
import type { MemberSummary } from '../lib/types';

/**
 * The people directory.
 *
 * Members-only by construction (R9: this roster is never public) — `GET
 * /api/members` 401s without a session, so the screen sits behind
 * `SessionGate` rather than rendering an empty list to a stranger. A member
 * who has turned their own directory listing off (Me → "Hide me from the
 * school directory") is absent from every page here, including their own
 * search results.
 *
 * Two filters, both server-side: a display-name substring (`q`) and one exact
 * skill (`skill`). The text box updates on every keystroke and the request
 * follows 250ms later, so typing a name is one query rather than one per
 * letter; picking a skill is a deliberate act and fires at once.
 */

/** Long enough to swallow a name typed at speed, short enough to feel typed. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Mirrors `Role.Facilitator` in `packages/shared/src/roles.ts` (30). Below
 * this, every member counts as "Host" under the default policy
 * (`hostMinAttended: 0`), so the label would be true of everyone and say
 * nothing — show what they actually did instead (UX audit finding 2).
 */
const NAMEABLE_ROLE = 30;
export function PeopleScreen() {
  return (
    <SessionGate screen prompt="Sign in to see the people at this school.">
      <PeopleContent />
    </SessionGate>
  );
}

function PeopleContent() {
  /** What is in the box, and what has reached the API — the gap is the debounce. */
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  const [skill, setSkill] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const { data: tree } = useSkillTree();
  const flatSkills = useMemo(() => flattenSkills(tree?.skills ?? []), [tree]);

  const filters = useMemo(
    () => ({ ...(query.trim() ? { q: query.trim() } : {}), ...(skill ? { skill } : {}) }),
    [query, skill],
  );
  const { data, isPending, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useMembers(filters);

  const members: MemberSummary[] = data?.pages.flatMap((page) => page.members) ?? [];
  const filtering = Boolean(filters.q || filters.skill);

  return (
    <Screen
      title="People"
      layout="library"
      standfirst="Everyone who has signed in here, and what they say they can share."
    >
      <div className="safe-x">
        <div className="people-filters">
          <label className="block">
            <span className="text-caption text-ink-soft">Search people by name</span>
            <input
              type="search"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              placeholder="A name"
              className="mt-1.5 min-h-[44px] w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none"
            />
          </label>
          <div>
            <span className="text-caption text-ink-soft">Who knows a particular skill</span>
            <div className="mt-1.5">
              <SkillPicker
                skills={flatSkills}
                value={skill}
                onChange={(uri) => setSkill(uri)}
                clearLabel="Clear"
                placeholder="Start typing a skill"
              />
            </div>
          </div>
        </div>

        {isPending ? <LoadingState label="Finding people…" /> : null}
        {isError ? (
          <PageState
            title="The directory couldn’t load."
            error
            action={<Button onClick={() => void refetch()}>Try again</Button>}
          >
            Please check your connection and try again.
          </PageState>
        ) : null}

        {!isPending && !isError && members.length === 0 ? (
          <PageState title={filtering ? 'Nobody here yet under that search.' : 'Nobody here yet.'}>
            {filtering
              ? 'Try a shorter name, or clear the skill filter.'
              : 'People appear here once they sign in. Anyone can hide themselves from this list.'}
          </PageState>
        ) : null}

        {members.length > 0 ? (
          <ul className="member-grid">
            {members.map((member) => (
              <li key={member.did}>
                <MemberCard member={member} />
              </li>
            ))}
          </ul>
        ) : null}

        {hasNextPage ? (
          <div className="mt-5">
            <Button
              variant="quiet"
              ink="ink"
              wide
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage ? 'Loading…' : 'Show more people'}
            </Button>
          </div>
        ) : null}
      </div>
    </Screen>
  );
}

function MemberCard({ member }: { member: MemberSummary }) {
  const name = member.displayName || member.handle || 'A member';
  const parts = [
    // Only Facilitator and Steward are worth naming; everyone else gets their
    // skill count instead (the directory listing has no hosted-class count).
    ...(member.role >= NAMEABLE_ROLE ? [member.roleLabel] : []),
    `${member.claimCount} ${member.claimCount === 1 ? 'skill' : 'skills'}`,
    ...(member.vouchCount > 0
      ? [`${member.vouchCount} ${member.vouchCount === 1 ? 'vouch' : 'vouches'}`]
      : []),
  ];

  return (
    <Link to="/people/$did" params={{ did: member.did }} className="member-card">
      <MemberAvatar src={member.avatarUrl} name={name} />
      <div className="min-w-0 flex-1">
        <p className="member-card-name">{name}</p>
        {member.displayName && member.handle ? (
          <p className="member-card-handle">{member.handle}</p>
        ) : null}
        <p className="member-card-meta">{parts.join(' · ')}</p>
      </div>
      <span aria-hidden="true" className="text-ink-faint">
        ↗
      </span>
    </Link>
  );
}
