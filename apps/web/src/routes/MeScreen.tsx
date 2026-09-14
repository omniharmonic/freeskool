import { useQueryClient } from '@tanstack/react-query';
import { LoadingState, PageState } from '../components/PageState';
import { ImagePicker } from '../components/ImagePicker';
import type { ImageInput } from '../lib/types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { applyPrefs, readPrefs, writePrefs, type ThemeChoice } from '../lib/prefs';
import { SessionGate } from '../components/SessionGate';
import { Screen } from '../components/Screen';
import { Button, SkillChip, Toggle } from '../components/bits';
import { Sheet } from '../components/Sheet';
import { SkillPicker } from '../components/SkillPicker';
import { flattenSkills } from '../lib/skills';
import { useInstallFlow } from '../components/InstallNudge';
import { api, ApiError } from '../lib/api';
import {
  useImportBskyProfileMutation,
  useMe,
  useMeBadges,
  useMeProfile,
  useMyAttestations,
  useMyClaims,
  useSetSkillClaimsMutation,
  useSkillTree,
  useTakeOwnershipMutation,
  useUpdateProfileMutation,
  useVisibilityDefaults,
} from '../lib/queries';
import type { SkillClaimInput, SkillClaimLevel, SkillClaimsResponse } from '../lib/types';

const CLAIM_LEVEL_LABEL: Record<SkillClaimLevel, string> = {
  learning: 'Learning',
  practicing: 'Practicing',
  proficient: 'Proficient',
  teaching: 'Teaching',
};
const CLAIM_LEVELS: SkillClaimLevel[] = ['learning', 'practicing', 'proficient', 'teaching'];

interface EditableClaim {
  skill: string;
  level: SkillClaimLevel;
  note?: string;
  visibility: 'public' | 'school';
}

/** "display name and bio", not "displayName, bio". */
function formatFields(fields: string[]): string {
  const words = fields.map((field) =>
    field === 'displayName' ? 'display name' : field === 'bio' ? 'bio' : field === 'avatar' ? 'photo' : field,
  );
  if (words.length <= 1) return words[0] ?? 'profile';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function isClaimLevel(value: unknown): value is SkillClaimLevel {
  return value === 'learning' || value === 'practicing' || value === 'proficient' || value === 'teaching';
}

/** Flattens the claims response (public PDS records + app-side school-only
 * entries) into one editable list. A claim missing `skill`/`level` — it
 * should never happen, but `public[].value` is `JSON.parse`d server-side
 * from an arbitrary record — is dropped rather than rendered broken.
 *
 * B2 (#19): an OAuth-door session has its public toggles forced off
 * server-side (403 `PublicTogglesLocked` on any attempt to set
 * `visibility: 'public'`) — but a session like that can still have
 * already-published public claims from before it signed in this way, or
 * from a different door entirely. Rebuilding those claims with
 * `visibility: 'public'` here would make the whole claims list un-savable
 * (the server rejects the public ones, so *nothing* saves). When
 * `oauthLocked` is true, every public claim is coerced to `'school'` up
 * front instead; `coercedPublicCount` tells the caller whether to show the
 * one-line notice. The server retracts the now-stale public record on save
 * (a concurrent backend fix) — this screen only has to stop resubmitting it
 * as public. */
function claimsFromServer(
  data: SkillClaimsResponse | undefined,
  oauthLocked: boolean,
): { claims: EditableClaim[]; coercedPublicCount: number } {
  if (!data) return { claims: [], coercedPublicCount: 0 };
  let coercedPublicCount = 0;
  const fromPublic: EditableClaim[] = data.public
    .filter((p) => typeof p.value.skill === 'string' && isClaimLevel(p.value.level))
    .map((p) => {
      if (oauthLocked) coercedPublicCount += 1;
      return {
        skill: p.value.skill as string,
        level: p.value.level as SkillClaimLevel,
        note: typeof p.value.note === 'string' ? p.value.note : undefined,
        visibility: oauthLocked ? ('school' as const) : ('public' as const),
      };
    });
  const fromSchool: EditableClaim[] = data.school
    .filter((s) => isClaimLevel(s.level))
    .map((s) => ({ skill: s.skill, level: s.level as SkillClaimLevel, note: s.note, visibility: 'school' as const }));
  return { claims: [...fromPublic, ...fromSchool], coercedPublicCount };
}

export function MeScreen() {
  return <SessionGate screen prompt="Sign in to keep track of your skills, classes, and preferences."><MeContent /></SessionGate>;
}

function MeContent() {
  const [prefs, setPrefs] = useState(readPrefs);
  const { surface, permission, remindersOn, turnOnReminders, openInstallSheet } = useInstallFlow();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [signoutError, setSignoutError] = useState('');

  const { data: me } = useMe();
  const { data: meProfile, isPending: profilePending, isError: profileLoadError, refetch: refetchProfile } = useMeProfile();
  const { data: badges } = useMeBadges();
  const { data: visibilityDefaults, isPending: visibilityPending, isError: visibilityError, refetch: refetchVisibility } = useVisibilityDefaults();
  const { data: claimsData, isPending: claimsPending, isError: claimsLoadError, refetch: refetchClaims } = useMyClaims();
  const { data: skillTree } = useSkillTree();
  const flatSkills = useMemo(() => flattenSkills(skillTree?.skills ?? []), [skillTree]);

  const { data: attestations } = useMyAttestations();
  const updateProfileMutation = useUpdateProfileMutation();
  const setClaimsMutation = useSetSkillClaimsMutation();
  const importBskyMutation = useImportBskyProfileMutation();

  /**
   * Task 7: an OAuth-door session that asks to publish anything gets one 400
   * `PublicLinkageConfirmRequired` first — linking an existing account to this
   * school is permanent, so it is confirmed once, out loud. This remembers
   * which request is waiting on that confirmation.
   */
  const [linkageConfirm, setLinkageConfirm] = useState<null | 'profile' | 'claims'>(null);
  const [bskyNotice, setBskyNotice] = useState<string | null>(null);

  const oauthLocked = visibilityDefaults?.oauthDoor ?? false;

  useEffect(() => {
    applyPrefs(prefs);
    writePrefs(prefs);
  }, [prefs]);

  // ── profile edit ──────────────────────────────────────────────────────
  const [editingProfile, setEditingProfile] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [publicListing, setPublicListing] = useState(false);
  const [avatar, setAvatar] = useState<ImageInput | null | undefined>();
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (!meProfile || editingProfile) return;
    setDisplayName(meProfile.profile.displayName ?? '');
    setBio(meProfile.profile.bio ?? '');
    setPublicListing(meProfile.profile.publicListing ?? false);
  }, [meProfile, editingProfile]);

  // `displayName`/`bio` also carry `maxLength` on their inputs below, matching
  // `profileBody` in `apps/appview/src/http/routes/me.ts` exactly (120/2000) —
  // belt-and-suspenders, since the server is `.strict()` but still the source
  // of truth. On failure (400 past some other limit, 401, ...) the editor
  // stays open with the server's message, rather than closing as if it saved.
  const saveProfile = async (confirmPublicLinkage = false) => {
    setProfileError(null);
    try {
      await updateProfileMutation.mutateAsync({ displayName: displayName.trim(),
        ...(avatar !== undefined ? { avatar } : {}), bio: bio.trim(), publicListing,
        ...(confirmPublicLinkage ? { confirmPublicLinkage: true } : {}) });
      setEditingProfile(false);
      setAvatar(undefined);
      setLinkageConfirm(null);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PublicLinkageConfirmRequired') {
        setLinkageConfirm('profile');
        return;
      }
      setProfileError(err instanceof ApiError ? err.message : 'Could not save your profile. Try again.');
    }
  };

  /** The members directory opt-out. Not a profile field: it lives in
   * `fs_member_prefs`, and `PUT /api/me` takes it on its own. */
  const listedInDirectory = meProfile?.directoryListing ?? true;
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const setDirectoryListing = (listed: boolean) => {
    setDirectoryError(null);
    updateProfileMutation.mutate(
      { directoryListing: listed },
      { onError: () => setDirectoryError('Could not change that. Try again.') },
    );
  };

  const refreshFromBluesky = async () => {
    setBskyNotice(null);
    try {
      const result = await importBskyMutation.mutateAsync();
      setBskyNotice(
        result.imported
          ? `Brought over your ${formatFields(result.fields)} from Bluesky.`
          : 'Nothing to bring over from Bluesky right now.',
      );
    } catch (err) {
      setBskyNotice(err instanceof ApiError ? err.message : 'Could not reach Bluesky. Try again.');
    }
  };

  // ── skill claims editor ──────────────────────────────────────────────
  const [claims, setClaims] = useState<EditableClaim[]>([]);
  const [claimsInitialized, setClaimsInitialized] = useState(false);
  // B2: set only when loading in already-published public claims actually had
  // to coerce one or more of them to school-only for this session.
  const [oauthCoercedNotice, setOauthCoercedNotice] = useState(false);
  useEffect(() => {
    if (claimsInitialized || !claimsData) return;
    const { claims: loaded, coercedPublicCount } = claimsFromServer(claimsData, oauthLocked);
    setClaims(loaded);
    setOauthCoercedNotice(coercedPublicCount > 0);
    setClaimsInitialized(true);
  }, [claimsData, claimsInitialized, oauthLocked]);

  const [draftSkillUri, setDraftSkillUri] = useState('');
  const [draftLevel, setDraftLevel] = useState<SkillClaimLevel>('practicing');
  const [draftVisibility, setDraftVisibility] = useState<'public' | 'school'>(oauthLocked ? 'school' : 'public');
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [tierBConfirmOpen, setTierBConfirmOpen] = useState(false);
  // R1: the server still saved the school-only claims even though the repo credential has
  // lapsed — this is not an error banner, just a nudge to re-sign-in before the next public
  // publish/retract can go through.
  const [reauthNotice, setReauthNotice] = useState(false);

  const addClaim = () => {
    if (!draftSkillUri) return;
    setClaims((prev) => [
      ...prev.filter((c) => c.skill !== draftSkillUri),
      { skill: draftSkillUri, level: draftLevel, visibility: oauthLocked ? 'school' : draftVisibility },
    ]);
    setDraftSkillUri('');
    setDraftLevel('practicing');
    setDraftVisibility(oauthLocked ? 'school' : 'public');
  };

  const removeClaim = (skill: string) => {
    setClaims((prev) => prev.filter((c) => c.skill !== skill));
  };

  const setClaimVisibility = (skill: string, visibility: 'public' | 'school') => {
    setClaims((prev) => prev.map((c) => (c.skill === skill ? { ...c, visibility } : c)));
  };

  // Tier B confirm flow: `GET /api/skills` now exposes each node's `tier`
  // (Task 12), so a new Tier B claim already defaults to school-only up
  // front (see the skill-picker's `onClick` above) — but the server's 400
  // `TierBConfirmRequired` is still the real gate (a stale tree, or a claim
  // typed by URI, could disagree with what's shown), so this stays
  // try-then-confirm rather than trusting the client's own tier read.
  const submitClaims = async (confirmTierB: boolean, confirmPublicLinkage = false) => {
    setClaimsError(null);
    setReauthNotice(false);
    const body: { claims: SkillClaimInput[]; confirmTierB?: boolean; confirmPublicLinkage?: boolean } = {
      claims: claims.map((c) => ({ skill: c.skill, level: c.level, note: c.note, visibility: c.visibility })),
      ...(confirmTierB ? { confirmTierB: true } : {}),
      ...(confirmPublicLinkage ? { confirmPublicLinkage: true } : {}),
    };
    try {
      const result = await setClaimsMutation.mutateAsync(body);
      setTierBConfirmOpen(false);
      setLinkageConfirm(null);
      setReauthNotice(Boolean(result.reauthRequired));
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TierBConfirmRequired') {
        setTierBConfirmOpen(true);
        return;
      }
      if (err instanceof ApiError && err.code === 'PublicLinkageConfirmRequired') {
        setLinkageConfirm('claims');
        return;
      }
      setClaimsError(err instanceof ApiError ? err.message : 'Could not save your skills. Try again.');
    }
  };

  const notificationState =
    surface !== 'installed'
      ? 'Off — iPhone only sends these from apps on your Home Screen'
      : remindersOn || permission === 'granted'
        ? 'On for the classes you RSVP to'
        : permission === 'denied'
          ? 'Turned off in iOS Settings'
          : 'Not asked yet';

  if (profilePending || claimsPending || visibilityPending) return <Screen title="Me" layout="account"><div className="safe-x"><LoadingState label="Opening your notebook…" /></div></Screen>;
  if (profileLoadError || claimsLoadError || visibilityError) return <Screen title="Me" layout="account"><div className="safe-x"><PageState title="Your notebook couldn’t load." error action={<Button onClick={() => { void refetchProfile(); void refetchClaims(); void refetchVisibility(); }}>Try again</Button>}>Your saved profile and skills are still there. Please try again before making changes.</PageState></div></Screen>;

  return (
    <Screen title="Me" layout="account" standfirst="Your own corner of the school. What you’re learning, what you can share, and how you want to stay connected.">
      <nav className="safe-x editor-nav" aria-label="Account sections"><a href="#my-profile">Profile</a><a href="#my-skills">Skills</a><a href="#my-badges">Badges</a><a href="#my-settings">Settings</a></nav>
      <div className="safe-x account-layout"><div className="account-main">
        <div className="profile-card" id="my-profile">
          <div className="profile-monogram">
            {meProfile?.profile.avatarUrl ? <img src={meProfile.profile.avatarUrl} alt="Your profile image" /> : <span>{(meProfile?.profile.displayName ?? me?.handle ?? 'You').slice(0,2).toUpperCase()}</span>}
          </div>
          <div className="min-w-0 flex-1">
            <p className="display text-lede font-bold">{meProfile?.profile.displayName || me?.handle || 'You'}</p>
            {me?.handle ? <p className="text-caption text-ink-soft">{me.handle}</p> : null}
            {meProfile?.profile.bio ? <p className="mt-3 text-body text-ink-soft">{meProfile.profile.bio}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => {
              setProfileError(null);
              setAvatar(undefined);
              setEditingProfile((v) => !v);
            }}
            className="shrink-0 text-caption font-bold text-blue"
          >
            {editingProfile ? 'Cancel' : 'Edit'}
          </button>
        </div>

        {editingProfile ? (
          <div className="plate mt-3 space-y-3 p-3.5">
            <ImagePicker avatar value={avatar} existingUrl={meProfile?.profile.avatarUrl} onChange={setAvatar} />
            <label className="block">
              <span className="text-caption text-ink-soft">Display name</span>
              <input
                className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                value={displayName}
                maxLength={120}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-caption text-ink-soft">Bio</span>
              <textarea
                className="mt-1.5 min-h-[72px] w-full resize-none border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                value={bio}
                maxLength={2000}
                onChange={(e) => setBio(e.target.value)}
              />
            </label>
            <label className="public-profile-choice"><input type="checkbox" aria-describedby="profile-sharing-details" checked={publicListing} disabled={oauthLocked && !publicListing} onChange={e=>setPublicListing(e.target.checked)}/><span><strong>Share my profile publicly</strong></span></label><p id="profile-sharing-details" className="text-caption text-ink-soft">Share my name, bio, photo, public skill claims, and contributed resources. Show me on related skill pages. Attendance and school-only skills stay private.</p>
            {profileError ? <p className="text-body text-pink">{profileError}</p> : null}
            <Button wide disabled={updateProfileMutation.isPending} onClick={() => void saveProfile(false)}>
              Save
            </Button>
          </div>
        ) : null}

        {me?.kind === 'oauth' ? (
          <div className="mt-3">
            <Button variant="quiet" ink="ink" disabled={importBskyMutation.isPending} onClick={() => void refreshFromBluesky()}>
              Refresh from Bluesky
            </Button>
            {bskyNotice ? <p className="mt-2 text-caption text-ink-soft">{bskyNotice}</p> : null}
          </div>
        ) : null}

        <Link to="/knowledge" search={{mine:true}} className="context-link">My knowledge contributions ↗</Link>
        {/* `/people/$did` is the member-facing page for a signed-in viewer and the
            opt-in public notebook for everyone else (see `router.tsx`), so this link
            shows you what the school sees, not what a stranger does. */}
        {me && listedInDirectory ? <Link to="/people/$did" params={{did:me.did}} className="context-link">Your page in the school directory ↗</Link> : null}
        <div className="activity-counts">
          <div className="activity-count">
            <p className="stamp text-[26px] leading-none">{badges?.counts.attended ?? 0}</p>
            <p className="mt-1 text-caption text-ink-soft">classes attended</p>
          </div>
          <div className="activity-count">
            <p className="stamp text-[26px] leading-none">{badges?.counts.hosted ?? 0}</p>
            <p className="mt-1 text-caption text-ink-soft">classes taught</p>
          </div>
        </div>

        <h2 id="my-skills" className="mt-7 mb-2.5 text-lede font-bold">What you say you can do</h2>
        {oauthLocked ? (
          <p className="mb-2.5 border-l-[3px] border-amber pl-3 text-caption text-ink-soft">
            Signed in with an existing account: claims here stay school-only and can't be made public in v1.
          </p>
        ) : null}
        {oauthCoercedNotice ? (
          <p className="mb-2.5 border-l-[3px] border-amber pl-3 text-caption text-ink-soft">
            Your public claims were switched to school-only because this account signed in through another
            provider.
          </p>
        ) : null}
        {claims.length === 0 ? <p className="text-body text-ink-soft">Nothing added yet.</p> : null}
        <ul className="space-y-3">
          {claims.map((claim) => {
            const skillInfo = flatSkills.find((s) => s.uri === claim.skill);
            return (
              <li key={claim.skill} className="plate p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-body">
                      <span>{skillInfo?.path ?? claim.skill}</span>
                      {skillInfo?.tier === 'B' ? <SkillChip ink="pink">Sensitive</SkillChip> : null}
                    </p>
                    <p className="mt-1 text-caption text-ink-soft">{CLAIM_LEVEL_LABEL[claim.level]}</p>
                  </div>
                  <button type="button" className="shrink-0 text-caption text-ink-faint" onClick={() => removeClaim(claim.skill)}>
                    Remove
                  </button>
                </div>
                <div className="mt-2.5 flex items-center gap-1.5" role="group" aria-label={`Visibility for ${skillInfo?.path ?? claim.skill}`}>
                  {(['school', 'public'] as const).map((v) => {
                    const disabled = v === 'public' && oauthLocked;
                    const active = claim.visibility === v;
                    return (
                      <button
                        key={v}
                        type="button"
                        disabled={disabled}
                        aria-pressed={active}
                        onClick={() => setClaimVisibility(claim.skill, v)}
                        className="border-[1.5px] border-ink px-2.5 py-1 text-caption font-medium capitalize disabled:opacity-40"
                        style={{
                          background: active ? 'var(--c-ink)' : 'transparent',
                          color: active ? 'var(--c-paper-2)' : 'var(--c-ink)',
                        }}
                      >
                        {v === 'school' ? 'School only' : 'Public'}
                      </button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="plate mt-3 space-y-3 p-3.5">
          <p className="text-caption text-ink-soft">Add a skill</p>
          <SkillPicker
            skills={flatSkills}
            value={draftSkillUri}
            allowPropose
            placeholder="Start typing a skill"
            onChange={(uri, skill) => {
              setDraftSkillUri(uri);
              // Tier B (sensitive) defaults to school-only; Tier A to public —
              // an oauth-door session still always defaults to school-only.
              if (skill) setDraftVisibility(oauthLocked || skill.tier === 'B' ? 'school' : 'public');
            }}
          />

          <div>
            <span className="text-caption text-ink-soft">How much practice</span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {CLAIM_LEVELS.map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  aria-pressed={draftLevel === lvl}
                  onClick={() => setDraftLevel(lvl)}
                  className="border-[1.5px] border-ink px-3 py-1.5 text-caption font-medium"
                  style={{
                    background: draftLevel === lvl ? 'var(--c-ink)' : 'transparent',
                    color: draftLevel === lvl ? 'var(--c-paper-2)' : 'var(--c-ink)',
                  }}
                >
                  {CLAIM_LEVEL_LABEL[lvl]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="text-caption text-ink-soft">Visibility</span>
            <div className="mt-1.5 flex gap-2">
              {(['school', 'public'] as const).map((v) => {
                const disabled = v === 'public' && oauthLocked;
                return (
                  <button
                    key={v}
                    type="button"
                    disabled={disabled}
                    aria-pressed={draftVisibility === v}
                    onClick={() => setDraftVisibility(v)}
                    className="border-[1.5px] border-ink px-3 py-1.5 text-caption font-medium capitalize disabled:opacity-40"
                    style={{
                      background: draftVisibility === v ? 'var(--c-ink)' : 'transparent',
                      color: draftVisibility === v ? 'var(--c-paper-2)' : 'var(--c-ink)',
                    }}
                  >
                    {v === 'school' ? 'School only' : 'Public'}
                  </button>
                );
              })}
            </div>
            {oauthLocked ? (
              <p className="mt-1.5 text-caption text-ink-faint">
                Signed in with an existing account — this session can't make claims public in v1.
              </p>
            ) : null}
          </div>

          <Button variant="quiet" ink="ink" onClick={addClaim} disabled={!draftSkillUri}>
            Add this skill
          </Button>
        </div>

        {claimsError ? <p className="mt-2 text-body text-pink">{claimsError}</p> : null}
        {reauthNotice ? (
          <p className="mt-2 border-l-[3px] border-amber pl-3 text-caption text-ink-soft">
            Saved here. Sign in again to update your public records.
          </p>
        ) : null}
        <div className="mt-3 mb-2">
          <Button wide onClick={() => void submitClaims(false)} disabled={setClaimsMutation.isPending}>
            Save what I can do
          </Button>
        </div>

        <h2 id="my-badges" className="mt-7 mb-2.5 text-lede font-bold">Badges</h2>
        {badges && badges.badges.length > 0 ? (
          <ul className="badge-list">
            {badges.badges.map((badge) => (
              <li key={badge} className="text-body">
                {badge}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-soft">Nothing yet — badges are sentences about things you've done.</p>
        )}
        <p className="mt-2 text-caption text-ink-faint">
          Badges are labels for things you did. They are not points and nothing ranks them.
        </p>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">Vouches you’ve received</h2>
        {attestations?.received.length ? (
          <ul className="space-y-2">
            {attestations.received.map((vouch) => (
              <li key={vouch.id} className="text-body">
                {vouch.attesterDisplayName || vouch.attesterHandle || 'Someone at this school'} vouched for{' '}
                {vouch.skillLabel}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body text-ink-soft">
            Nobody has vouched for you yet. People vouch from your page in the school directory.
          </p>
        )}
        <p className="mt-2 text-caption text-ink-faint">
          A vouch is one person saying they have seen you do something. It is a count, never a score.
        </p>

        </div><aside className="account-side" aria-label="Account preferences"><h2 id="my-settings" className="mb-4 text-lede font-bold">Settings</h2>
        <div className="plate divide-y-[1.5px] divide-rule">
          <div className="p-3.5">
            <p className="text-body">Appearance</p>
            <div className="mt-2.5 flex gap-1.5" role="group" aria-label="Appearance">
              {(['system', 'light', 'dark'] as ThemeChoice[]).map((choice) => {
                const active = prefs.theme === choice;
                return (
                  <button
                    key={choice}
                    type="button"
                    onClick={() => setPrefs({ ...prefs, theme: choice })}
                    aria-pressed={active}
                    className="flex-1 border-[1.5px] border-ink py-1.5 text-caption font-medium capitalize"
                    style={{
                      background: active ? 'var(--c-ink)' : 'transparent',
                      color: active ? 'var(--c-paper-2)' : 'var(--c-ink)',
                    }}
                  >
                    {choice}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
              <span className="block text-body">Reduce blur</span>
              <span className="block text-caption text-ink-soft">
                Safari has no system setting for this, so it lives here. Frosted bars become solid.
              </span>
            </span>
            <Toggle
              label="Reduce blur"
              checked={prefs.reduceBlur}
              onChange={(reduceBlur) => setPrefs({ ...prefs, reduceBlur })}
            />
          </div>

          <div className="flex items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
              <span className="block text-body">Hide me from the school directory</span>
              <span className="block text-caption text-ink-soft">
                People at this school can see who else is here, and what everyone says they can share.
                Hiding takes you out of that list and off every skill page.
              </span>
              {directoryError ? <span className="block text-caption text-pink">{directoryError}</span> : null}
            </span>
            <Toggle
              label="Hide me from the school directory"
              checked={!listedInDirectory}
              onChange={(hidden) => setDirectoryListing(!hidden)}
            />
          </div>

          <div className="flex items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
              <span className="block text-body">Reminders</span>
              <span className="block text-caption text-ink-soft">{notificationState}</span>
            </span>
            <button
              type="button"
              onClick={surface === 'installed' ? () => void turnOnReminders() : openInstallSheet}
              className="shrink-0 text-caption font-bold text-blue"
            >
              {surface === 'installed' ? 'Change' : 'How?'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
              <span className="block text-body">Notification settings</span>
              <span className="block text-caption text-ink-soft">Per-category inbox, push and email choices.</span>
            </span>
            <a href="/me/settings" className="shrink-0 text-caption font-bold text-blue">
              Open
            </a>
          </div>

          <div className="flex items-center justify-between gap-4 p-3.5">
            <span className="min-w-0">
              <span className="block text-body">How this skool works</span>
              <span className="block text-caption text-ink-soft">A plain-language explainer, good for printing.</span>
            </span>
            <a href="/how-it-works" className="shrink-0 text-caption font-bold text-blue">
              Open
            </a>
          </div>
        </div>

        {me && me.role >= 40 ? <a href="/admin" className="context-link mt-5">Open steward tools</a> : null}
        {me?.isCustodial ? <TakeOwnershipSection /> : null}

        <div className="mt-6 mb-2">
          {signoutError ? <p role="alert" className="mb-3 text-caption">{signoutError}</p> : null}
          <Button
            wide
            variant="quiet"
            ink="ink"
            onClick={() => {
              void (async () => {
                try {
                  await api.auth.logout();
                  await queryClient.cancelQueries();
                  queryClient.clear();
                  void navigate({ to: '/signin' });
                } catch { setSignoutError('Could not sign out. Check your connection and try again.'); }
              })();
            }}
          >
            Sign out
          </Button>
        </div>
      </aside></div>

      <Sheet
        open={linkageConfirm !== null}
        onClose={() => setLinkageConfirm(null)}
        title="This links your account to the school"
        footer={
          <div className="flex gap-3 pb-1">
            <Button
              ink="pink"
              onClick={() => void (linkageConfirm === 'claims' ? submitClaims(false, true) : saveProfile(true))}
            >
              Link it and share
            </Button>
            <Button ink="ink" variant="quiet" onClick={() => setLinkageConfirm(null)}>
              Not now
            </Button>
          </div>
        }
      >
        <p className="text-body">
          Publishing from an account you already had links this account to the school for good. Anyone can
          see the connection, and there is no way to take it back later.
        </p>
      </Sheet>

      <Sheet
        open={tierBConfirmOpen}
        onClose={() => setTierBConfirmOpen(false)}
        title="This is a sensitive skill"
        footer={
          <div className="flex gap-3 pb-1">
            <Button ink="pink" onClick={() => void submitClaims(true)}>
              Make it public anyway
            </Button>
            <Button ink="ink" variant="quiet" onClick={() => setTierBConfirmOpen(false)}>
              Keep it school-only
            </Button>
          </div>
        }
      >
        <p className="text-body">
          One of the skills you're trying to make public is kept off the public taxonomy by default. Making a
          public claim about it means anyone can see you claim it — not just people at this school.
        </p>
      </Sheet>
    </Screen>
  );
}

type OwnershipState =
  | { kind: 'idle' }
  | { kind: 'done'; revealUrl?: string }
  | { kind: 'pending'; expiresAt?: string }
  | { kind: 'error'; message: string };

/**
 * Visible only for a custodial account (`me.isCustodial`, `GET /api/auth/me`).
 * `POST /api/auth/take-ownership` rotates the PDS password server-side and
 * hands back either nothing (mail sent) or a `revealUrl` (mail unconfigured
 * or the send failed) — see `apps/appview/src/lib/custody.ts#takeOwnership`'s
 * doc comment. The password itself never passes through this screen; it
 * lives only behind the one-time `/account/reveal/:token` link.
 */
function TakeOwnershipSection() {
  const takeOwnershipMutation = useTakeOwnershipMutation();
  const [state, setState] = useState<OwnershipState>({ kind: 'idle' });

  const onTakeOwnership = async () => {
    try {
      const result = await takeOwnershipMutation.mutateAsync();
      setState({ kind: 'done', revealUrl: result.revealUrl });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RevealPending') {
        const body = err.body as { expiresAt?: string } | undefined;
        setState({ kind: 'pending', expiresAt: body?.expiresAt });
        return;
      }
      setState({
        kind: 'error',
        message: err instanceof ApiError ? err.message : 'Could not rotate your password. Try again.',
      });
    }
  };

  return (
    <>
      <h2 className="mt-8 mb-2.5 text-lede font-bold">Take ownership of this account</h2>
      <div className="plate ownership-panel p-3.5">
        <p className="text-body">
          Right now this app holds the password to your account so it can publish on your behalf. Taking ownership
          gives you that password directly — after that, the app can no longer act for you, and it never keeps a
          copy.
        </p>

        {state.kind === 'done' ? (
          <div className="mt-3">
            <p className="text-body text-ink-soft">Check your email for a link to see your new password.</p>
            {state.revealUrl ? (
              <p className="mt-2 text-caption text-ink-soft">
                No mail is set up on this server — use this link instead:{' '}
                <a className="break-all text-blue underline" href={state.revealUrl}>
                  {state.revealUrl}
                </a>
              </p>
            ) : null}
          </div>
        ) : state.kind === 'pending' ? (
          <p className="mt-3 text-body text-pink">
            A take-ownership link is already pending
            {state.expiresAt ? ` — it's good until ${new Date(state.expiresAt).toLocaleString()}` : ''}. Check your
            email, or wait for it to expire before trying again.
          </p>
        ) : state.kind === 'error' ? (
          <p className="mt-3 text-body text-pink">{state.message}</p>
        ) : null}

        <div className="mt-3">
          <Button
            ink="pink"
            onClick={() => void onTakeOwnership()}
            disabled={takeOwnershipMutation.isPending || state.kind === 'done'}
          >
            Take ownership
          </Button>
        </div>
      </div>
    </>
  );
}
