import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { LoadingState, PageState } from '../components/PageState';
import { Button, CLAIM_LEVEL_ORDER, MemberAvatar, SkillChip, claimLevelLabel } from '../components/bits';
import { ApiError } from '../lib/api';
import { formatDayStamp, formatTime } from '../lib/dates';
import {
  useCreateRequestMutation,
  useMe,
  useMemberProfile,
  useMyAttestations,
  useUnvouchMutation,
  useVouchMutation,
} from '../lib/queries';
import type { MemberClaim, MemberProfileResponse } from '../lib/types';

/**
 * Mirrors `Role.Facilitator` in `packages/shared/src/roles.ts` (30). Below
 * this, every member counts as "Host" under the default policy
 * (`hostMinAttended: 0`), so the label would be true of everyone and say
 * nothing — show what they actually did instead (UX audit finding 2).
 */
const NAMEABLE_ROLE = 30;

/**
 * One member's profile, for another member.
 *
 * Never public (R9): `GET /api/members/:did` sits behind a session and answers
 * 404 — not 403 — for anyone who has turned their directory listing off, so a
 * hidden member is indistinguishable from one who was never here. Signed-out
 * readers never reach this screen at all; `/people/$did` gives them the
 * opt-in public profile instead (see `router.tsx`).
 *
 * Vouching is the one write here. It is a count and a name, never a score:
 * "someone I know says they have seen this person do this". A vouch can always
 * be taken back — the id for that comes from the viewer's own
 * `GET /api/me/attestations`, since the profile itself only says *whether* the
 * viewer vouched, not which record said so.
 */
export function MemberProfileScreen() {
  const { did } = useParams({ from: '/people/$did' });
  const { data: me } = useMe();
  const { data: profile, isPending, isError, error, refetch } = useMemberProfile(did);

  // A members-only page must never be indexed, even if the link leaks.
  useEffect(() => {
    const tag = document.createElement('meta');
    tag.name = 'robots';
    tag.content = 'noindex, nofollow';
    document.head.appendChild(tag);
    return () => tag.remove();
  }, []);

  if (isPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x">
          <LoadingState label="Opening their page…" />
        </div>
      </Screen>
    );
  }

  if (isError && error instanceof ApiError && error.status === 404) {
    return (
      <Screen title="Not in the directory" back>
        <div className="safe-x">
          <PageState title="This person isn’t in the school directory." action={<Button href="/people" ink="blue">See who is</Button>}>
            Everyone chooses whether to be listed. They may still be at classes — the directory is the
            only thing this hides.
          </PageState>
        </div>
      </Screen>
    );
  }

  if (isError || !profile) {
    return (
      <Screen title="Couldn’t load this page" back>
        <div className="safe-x">
          <PageState title="Let’s try that again." error action={<Button onClick={() => void refetch()}>Try again</Button>}>
            Please check your connection and try again.
          </PageState>
        </div>
      </Screen>
    );
  }

  return <MemberProfileBody profile={profile} viewerDid={me?.did} />;
}

function MemberProfileBody({ profile, viewerDid }: { profile: MemberProfileResponse; viewerDid?: string }) {
  const name = profile.displayName || profile.handle || 'A member';
  const own = viewerDid === profile.did;
  const attestationsQuery = useMyAttestations();
  const attestations = attestationsQuery.data;
  const vouchMutation = useVouchMutation();
  const unvouchMutation = useUnvouchMutation();
  const queryClient = useQueryClient();
  const [vouchError, setVouchError] = useState<string | null>(null);
  /**
   * "Ask <name> to teach this" (UX audit journey finding 13): a profile used to be the
   * end of the road. This posts an ordinary needs-board request for that skill and
   * addresses it to this member — `askedOf` is app-side on the AppView and never reaches
   * the record, so nothing published here names them.
   */
  const createRequest = useCreateRequestMutation();
  const [asked, setAsked] = useState<Record<string, boolean>>({});
  const [askError, setAskError] = useState<string | null>(null);
  const [askingSkill, setAskingSkill] = useState<string | null>(null);

  const onAsk = async (claim: MemberClaim) => {
    setAskError(null);
    setAskingSkill(claim.skillUri);
    try {
      await createRequest.mutateAsync({
        title: claim.skillLabel,
        skill: claim.skillUri,
        askedOf: profile.did,
      });
      setAsked((prev) => ({ ...prev, [claim.skillUri]: true }));
    } catch (err) {
      setAskError(
        err instanceof ApiError && err.status === 401
          ? 'Sign in again to ask someone to teach something.'
          : 'Could not send that ask. Try again.',
      );
    } finally {
      setAskingSkill(null);
    }
  };
  /** What this viewer has just done, which the server copy may not show yet. */
  const [justChanged, setJustChanged] = useState<Record<string, boolean>>({});

  const givenIdFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const given of attestations?.given ?? []) {
      if (given.subjectDid === profile.did) map.set(given.skillUri, given.id);
    }
    return map;
  }, [attestations, profile.did]);

  const grouped = useMemo(() => groupByLevel(profile.claims), [profile.claims]);

  const onToggleVouch = async (claim: MemberClaim, vouched: boolean) => {
    setVouchError(null);
    try {
      if (vouched) {
        // The profile says only THAT the viewer vouched, never which record did
        // it — the id lives in the viewer's own list, which may not have landed
        // yet (or may predate this session). One refetch settles it before
        // telling anybody it can't be undone.
        let id = givenIdFor.get(claim.skillUri);
        if (!id) {
          const fresh = await attestationsQuery.refetch();
          id = fresh.data?.given.find(
            (given) => given.subjectDid === profile.did && given.skillUri === claim.skillUri,
          )?.id;
        }
        if (!id) {
          setVouchError('Your vouch isn’t loaded yet. Try again in a moment.');
          return;
        }
        await unvouchMutation.mutateAsync({ id, subjectDid: profile.did });
        setJustChanged((prev) => ({ ...prev, [claim.skillUri]: false }));
      } else {
        await vouchMutation.mutateAsync({ subjectDid: profile.did, skillUri: claim.skillUri });
        setJustChanged((prev) => ({ ...prev, [claim.skillUri]: true }));
      }
    } catch (err) {
      // A refused vouch usually means this page is out of date rather than that
      // anything is wrong: 409 `AlreadyVouched` says the vouch is already there,
      // 404 `SubjectNotHolding` says the claim has gone. Reconcile with the
      // server before the member presses it again — otherwise the button keeps
      // asking for something that cannot happen. The local override for this one
      // skill is dropped too, so the refetched truth is what shows.
      setJustChanged((prev) => {
        const { [claim.skillUri]: _dropped, ...rest } = prev;
        return rest;
      });
      void queryClient.invalidateQueries({ queryKey: ['member', profile.did] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
      void queryClient.invalidateQueries({ queryKey: ['skill'] });
      void queryClient.invalidateQueries({ queryKey: ['my-attestations'] });
      setVouchError(err instanceof ApiError ? err.message : 'Could not save that vouch. Try again.');
    }
  };

  return (
    <Screen
      title={name}
      layout="library"
      back
      // The page's own heading, in place of the standard large title: the
      // avatar belongs beside the name, not stacked above it.
      intro={
        <div className="page-heading safe-x member-header">
          <MemberAvatar src={profile.avatarUrl} name={name} size={96} />
          <div className="min-w-0">
            <h1 className="lt-title member-header-name">{name}</h1>
            {profile.handle ? <p className="member-card-handle">{profile.handle}</p> : null}
            <p className="member-card-meta">
              {profile.role >= NAMEABLE_ROLE
                ? profile.roleLabel
                : `Hosted ${profile.badges.counts.hosted} ${profile.badges.counts.hosted === 1 ? 'class' : 'classes'}`}
              {profile.vouchCount > 0
                ? ` · ${profile.vouchCount} ${profile.vouchCount === 1 ? 'vouch' : 'vouches'}`
                : ''}
            </p>
            {profile.bio ? <p className="mt-3 max-w-[58ch] text-body text-ink-soft">{profile.bio}</p> : null}
          </div>
        </div>
      }
    >
      <div className="safe-x">
        {profile.badges?.badges?.length ? (
          <ul className="badge-list mt-4">
            {profile.badges.badges.map((badge) => (
              <li key={badge} className="text-body">
                {badge}
              </li>
            ))}
          </ul>
        ) : null}

        <section className="knowledge-shelf">
          <h2>What they say they can do</h2>
          <p className="section-caption">
            Self-described, with vouches from people who have seen it. Counts, never scores.
          </p>
          {/* UX audit journey finding 12: the Vouch button used to be unexplained. What a
              vouch IS belongs beside the act, not in a policy page — the link is for the
              rest. */}
          <p className="section-caption">
            A vouch says you have seen this person do this. Counts show in the school; who vouched is visible
            only to them.{' '}
            <Link to="/how-it-works" className="font-bold text-blue">
              How vouches work
            </Link>
          </p>
          {vouchError ? (
            <p role="alert" className="mb-3 text-body text-pink">
              {vouchError}
            </p>
          ) : null}
          {askError ? (
            <p role="alert" className="mb-3 text-body text-pink">
              {askError}
            </p>
          ) : null}
          {profile.claims.length === 0 ? (
            <p className="text-body text-ink-soft">Nothing added yet.</p>
          ) : (
            grouped.map(([level, claims]) => (
              <div key={level} className="member-claim-group">
                <h3 className="section-heading">{claimLevelLabel(level)}</h3>
                <ul className="space-y-3">
                  {claims.map((claim) => (
                    <ClaimRow
                      key={claim.skillUri}
                      claim={claim}
                      own={own}
                      vouched={justChanged[claim.skillUri] ?? claim.viewerVouched}
                      delta={deltaFor(claim, justChanged[claim.skillUri])}
                      busy={vouchMutation.isPending || unvouchMutation.isPending}
                      attesters={(attestations?.received ?? []).filter((r) => r.skillUri === claim.skillUri)}
                      onToggle={(vouched) => void onToggleVouch(claim, vouched)}
                      askName={own ? undefined : firstName(name)}
                      asked={asked[claim.skillUri] ?? false}
                      asking={askingSkill === claim.skillUri}
                      onAsk={() => void onAsk(claim)}
                    />
                  ))}
                </ul>
              </div>
            ))
          )}
        </section>

        {profile.hosting.length > 0 ? (
          <section className="knowledge-shelf">
            <h2>Upcoming classes they host</h2>
            <ul className="space-y-3">
              {profile.hosting.map((event) => (
                <li key={event.uri}>
                  <Link to="/events/$id" params={{ id: event.uri }} className="plate block p-3.5">
                    <p className="text-body">{event.name}</p>
                    <p className="mt-1 text-caption text-ink-soft">
                      {formatDayStamp(new Date(event.startsAt))} · {formatTime(event.startsAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {profile.resources.length > 0 ? (
          <section className="knowledge-shelf">
            <h2>Notes</h2>
            <ul className="space-y-3">
              {profile.resources.map((resource) => (
                <li key={resource.id}>
                  <Link to="/knowledge/$id" params={{ id: resource.id }} className="plate block p-3.5">
                    <p className="text-body">{resource.title}</p>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Screen>
  );
}

function ClaimRow({
  claim,
  own,
  vouched,
  delta,
  busy,
  attesters,
  onToggle,
  askName,
  asked,
  asking,
  onAsk,
}: {
  claim: MemberClaim;
  own: boolean;
  vouched: boolean;
  delta: number;
  busy: boolean;
  attesters: Array<{ id: string; attesterDisplayName?: string; attesterHandle?: string }>;
  onToggle: (vouched: boolean) => void;
  /** What to call them in "Ask … to teach this". Absent on your own profile. */
  askName?: string;
  asked: boolean;
  asking: boolean;
  onAsk: () => void;
}) {
  const [showWho, setShowWho] = useState(false);
  const count = Math.max(0, claim.vouchCount + delta);

  return (
    <li className="plate p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-body">
            <Link to="/skills/$skillId" params={{ skillId: claim.skillUri }}>
              {claim.skillLabel}
            </Link>
            {claim.visibility === 'school' ? <SkillChip>School only</SkillChip> : null}
          </p>
          <p className="mt-1 text-caption text-ink-soft">
            {count === 0 ? 'No vouches yet' : `${count} ${count === 1 ? 'vouch' : 'vouches'}`}
          </p>
        </div>
        <button
          type="button"
          disabled={own || busy}
          title={own ? 'You can’t vouch for your own skills' : undefined}
          aria-pressed={vouched}
          onClick={() => onToggle(vouched)}
          className="min-h-[44px] shrink-0 border-[1.5px] border-ink px-3 py-1.5 text-caption font-medium disabled:opacity-40"
          style={{
            background: vouched ? 'var(--c-green)' : 'transparent',
            color: vouched ? 'var(--c-ink)' : 'var(--c-ink)',
          }}
        >
          {vouched ? 'Vouched ✓' : 'Vouch'}
        </button>
      </div>

      {askName ? (
        <div className="mt-2.5">
          {asked ? (
            <p role="status" className="text-caption text-ink-soft">
              Asked. It’s on the needs board now, and {askName} has been told — they can say yes by posting a
              class, or leave it.
            </p>
          ) : (
            <button
              type="button"
              disabled={asking}
              className="min-h-[44px] text-caption font-bold text-blue disabled:opacity-40"
              onClick={onAsk}
            >
              {asking ? 'Asking…' : `Ask ${askName} to teach this`}
            </button>
          )}
        </div>
      ) : null}

      {own ? (
        <div className="mt-2.5">
          <button
            type="button"
            className="min-h-[44px] text-caption font-bold text-blue"
            aria-expanded={showWho}
            onClick={() => setShowWho((open) => !open)}
          >
            {showWho ? 'Hide who vouched' : `Who vouched${attesters.length ? ` (${attesters.length})` : ''}`}
          </button>
          {showWho ? (
            attesters.length === 0 ? (
              <p className="text-caption text-ink-soft">Nobody has vouched for this one yet.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {attesters.map((attester) => (
                  <li key={attester.id} className="text-caption text-ink-soft">
                    {attester.attesterDisplayName || attester.attesterHandle || 'Someone at this school'}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/**
 * What to call somebody in a sentence. A display name is whatever they typed, and a
 * handle is not a name at all — "Ask wren.fs.boulder to teach this" reads like a robot —
 * so this takes the first word of a display name and falls back to the whole string.
 */
function firstName(name: string): string {
  const first = name.trim().split(/\s+/)[0];
  return first && !first.includes('.') ? first : name;
}

/** Most practised first; anything the server adds later lands at the end. */
function groupByLevel(claims: MemberClaim[]): Array<[string, MemberClaim[]]> {
  const byLevel = new Map<string, MemberClaim[]>();
  for (const claim of claims) {
    const list = byLevel.get(claim.level) ?? [];
    list.push(claim);
    byLevel.set(claim.level, list);
  }
  const known = CLAIM_LEVEL_ORDER.filter((level) => byLevel.has(level)).map(
    (level) => [level, byLevel.get(level)!] as [string, MemberClaim[]],
  );
  const rest = [...byLevel.entries()].filter(
    ([level]) => !(CLAIM_LEVEL_ORDER as readonly string[]).includes(level),
  );
  return [...known, ...rest];
}

/** How far the count has moved since the server said what it said. */
function deltaFor(claim: MemberClaim, justChanged: boolean | undefined): number {
  if (justChanged === undefined || justChanged === claim.viewerVouched) return 0;
  return justChanged ? 1 : -1;
}
