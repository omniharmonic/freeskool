import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { applyPrefs, readPrefs, writePrefs, type ThemeChoice } from '../lib/prefs';
import { Screen } from '../components/Screen';
import { Button, Toggle } from '../components/bits';
import { Sheet } from '../components/Sheet';
import { useInstallFlow } from '../components/InstallNudge';
import { api, ApiError } from '../lib/api';
import {
  useMe,
  useMeBadges,
  useMeProfile,
  useMyClaims,
  useSetSkillClaimsMutation,
  useSkillTree,
  useUpdateProfileMutation,
  useVisibilityDefaults,
} from '../lib/queries';
import type { SkillClaimInput, SkillClaimLevel, SkillClaimsResponse, SkillNode } from '../lib/types';

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

function isClaimLevel(value: unknown): value is SkillClaimLevel {
  return value === 'learning' || value === 'practicing' || value === 'proficient' || value === 'teaching';
}

/** Flattens the claims response (public PDS records + app-side school-only
 * entries) into one editable list. A claim missing `skill`/`level` — it
 * should never happen, but `public[].value` is `JSON.parse`d server-side
 * from an arbitrary record — is dropped rather than rendered broken. */
function claimsFromServer(data: SkillClaimsResponse | undefined): EditableClaim[] {
  if (!data) return [];
  const fromPublic: EditableClaim[] = data.public
    .filter((p) => typeof p.value.skill === 'string' && isClaimLevel(p.value.level))
    .map((p) => ({
      skill: p.value.skill as string,
      level: p.value.level as SkillClaimLevel,
      note: typeof p.value.note === 'string' ? p.value.note : undefined,
      visibility: 'public' as const,
    }));
  const fromSchool: EditableClaim[] = data.school
    .filter((s) => isClaimLevel(s.level))
    .map((s) => ({ skill: s.skill, level: s.level as SkillClaimLevel, note: s.note, visibility: 'school' as const }));
  return [...fromPublic, ...fromSchool];
}

function flattenSkills(nodes: SkillNode[], trail: string[] = []): Array<{ uri: string; path: string }> {
  const out: Array<{ uri: string; path: string }> = [];
  for (const node of nodes) {
    const path = [...trail, node.label];
    out.push({ uri: node.uri, path: path.join(' › ') });
    out.push(...flattenSkills(node.children, path));
  }
  return out;
}

export function MeScreen() {
  const [prefs, setPrefs] = useState(readPrefs);
  const { surface, permission, remindersOn, turnOnReminders, openInstallSheet } = useInstallFlow();
  const navigate = useNavigate();

  const { data: me } = useMe();
  const { data: meProfile } = useMeProfile();
  const { data: badges } = useMeBadges();
  const { data: visibilityDefaults } = useVisibilityDefaults();
  const { data: claimsData } = useMyClaims();
  const { data: skillTree } = useSkillTree();
  const flatSkills = flattenSkills(skillTree?.skills ?? []);

  const updateProfileMutation = useUpdateProfileMutation();
  const setClaimsMutation = useSetSkillClaimsMutation();

  const oauthLocked = visibilityDefaults?.oauthDoor ?? false;

  useEffect(() => {
    applyPrefs(prefs);
    writePrefs(prefs);
  }, [prefs]);

  // ── profile edit ──────────────────────────────────────────────────────
  const [editingProfile, setEditingProfile] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [profileError, setProfileError] = useState<string | null>(null);

  useEffect(() => {
    if (!meProfile || editingProfile) return;
    setDisplayName(meProfile.profile.displayName ?? '');
    setBio(meProfile.profile.bio ?? '');
  }, [meProfile, editingProfile]);

  // `displayName`/`bio` also carry `maxLength` on their inputs below, matching
  // `profileBody` in `apps/appview/src/http/routes/me.ts` exactly (120/2000) —
  // belt-and-suspenders, since the server is `.strict()` but still the source
  // of truth. On failure (400 past some other limit, 401, ...) the editor
  // stays open with the server's message, rather than closing as if it saved.
  const saveProfile = async () => {
    setProfileError(null);
    try {
      await updateProfileMutation.mutateAsync({ displayName: displayName.trim(), bio: bio.trim() });
      setEditingProfile(false);
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : 'Could not save your profile. Try again.');
    }
  };

  // ── skill claims editor ──────────────────────────────────────────────
  const [claims, setClaims] = useState<EditableClaim[]>([]);
  const [claimsInitialized, setClaimsInitialized] = useState(false);
  useEffect(() => {
    if (claimsInitialized || !claimsData) return;
    setClaims(claimsFromServer(claimsData));
    setClaimsInitialized(true);
  }, [claimsData, claimsInitialized]);

  const [draftSkillUri, setDraftSkillUri] = useState('');
  const [draftSkillSearch, setDraftSkillSearch] = useState('');
  const [draftLevel, setDraftLevel] = useState<SkillClaimLevel>('practicing');
  const [draftVisibility, setDraftVisibility] = useState<'public' | 'school'>(oauthLocked ? 'school' : 'public');
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [tierBConfirmOpen, setTierBConfirmOpen] = useState(false);

  const matchingSkills = draftSkillSearch.trim()
    ? flatSkills.filter((s) => s.path.toLowerCase().includes(draftSkillSearch.trim().toLowerCase())).slice(0, 8)
    : [];

  const addClaim = () => {
    if (!draftSkillUri) return;
    setClaims((prev) => [
      ...prev.filter((c) => c.skill !== draftSkillUri),
      { skill: draftSkillUri, level: draftLevel, visibility: oauthLocked ? 'school' : draftVisibility },
    ]);
    setDraftSkillUri('');
    setDraftSkillSearch('');
    setDraftLevel('practicing');
    setDraftVisibility(oauthLocked ? 'school' : 'public');
  };

  const removeClaim = (skill: string) => {
    setClaims((prev) => prev.filter((c) => c.skill !== skill));
  };

  const setClaimVisibility = (skill: string, visibility: 'public' | 'school') => {
    setClaims((prev) => prev.map((c) => (c.skill === skill ? { ...c, visibility } : c)));
  };

  // Tier B confirm flow: the client has no way to know a skill's tier up
  // front (`GET /api/skills` doesn't expose it — see `SkillsScreen.tsx`'s
  // doc comment), so this is always try-then-confirm, driven entirely by
  // the server's 400 `TierBConfirmRequired`, never a client-side guess.
  const submitClaims = async (confirmTierB: boolean) => {
    setClaimsError(null);
    const body: { claims: SkillClaimInput[]; confirmTierB?: boolean } = {
      claims: claims.map((c) => ({ skill: c.skill, level: c.level, note: c.note, visibility: c.visibility })),
      ...(confirmTierB ? { confirmTierB: true } : {}),
    };
    try {
      await setClaimsMutation.mutateAsync(body);
      setTierBConfirmOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TierBConfirmRequired') {
        setTierBConfirmOpen(true);
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

  return (
    <Screen title="Me" standfirst={meProfile?.profile.bio}>
      <div className="safe-x">
        <div className="plate plate-pink flex items-center gap-3.5 p-4">
          <div
            className="halftone halftone-dense grid h-14 w-14 shrink-0 place-items-center"
            style={{ '--ht': 'var(--c-pink)' } as React.CSSProperties}
          >
            <span className="stamp text-[18px]" style={{ color: 'var(--c-paper-2)' }}>
              {(meProfile?.profile.displayName ?? me?.handle ?? '??').slice(0, 2).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="display text-lede font-bold">{meProfile?.profile.displayName || me?.handle || 'You'}</p>
            {me?.handle ? <p className="text-caption text-ink-soft">{me.handle}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => {
              setProfileError(null);
              setEditingProfile((v) => !v);
            }}
            className="shrink-0 text-caption font-bold text-blue"
          >
            {editingProfile ? 'Cancel' : 'Edit'}
          </button>
        </div>

        {editingProfile ? (
          <div className="plate mt-3 space-y-3 p-3.5">
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
            {profileError ? <p className="text-body text-pink">{profileError}</p> : null}
            <Button wide onClick={() => void saveProfile()}>
              Save
            </Button>
          </div>
        ) : null}

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="plate plate-blue px-3.5 py-3">
            <p className="stamp text-[26px] leading-none">{badges?.counts.attended ?? 0}</p>
            <p className="mt-1 text-caption text-ink-soft">classes attended</p>
          </div>
          <div className="plate plate-green px-3.5 py-3">
            <p className="stamp text-[26px] leading-none">{badges?.counts.hosted ?? 0}</p>
            <p className="mt-1 text-caption text-ink-soft">classes taught</p>
          </div>
        </div>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">What you say you can do</h2>
        {oauthLocked ? (
          <p className="mb-2.5 border-l-[3px] border-amber pl-3 text-caption text-ink-soft">
            Signed in with an existing account: claims here stay school-only and can't be made public in v1.
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
                    <p className="text-body">{skillInfo?.path ?? claim.skill}</p>
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
          {draftSkillUri ? (
            <div className="flex items-center justify-between gap-3 border-[1.5px] border-ink bg-sheet px-3 py-2">
              <span className="text-body">{flatSkills.find((s) => s.uri === draftSkillUri)?.path ?? draftSkillUri}</span>
              <button type="button" className="text-caption text-blue" onClick={() => setDraftSkillUri('')}>
                Change
              </button>
            </div>
          ) : (
            <>
              <input
                className="w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                value={draftSkillSearch}
                onChange={(e) => setDraftSkillSearch(e.target.value)}
                placeholder="Search the skill taxonomy"
                aria-label="Search the skill taxonomy"
              />
              {matchingSkills.length > 0 ? (
                <ul className="divide-y divide-rule border-[1.5px] border-ink">
                  {matchingSkills.map((s) => (
                    <li key={s.uri}>
                      <button
                        type="button"
                        className="block w-full px-3 py-2 text-left text-body"
                        onClick={() => {
                          setDraftSkillUri(s.uri);
                          setDraftSkillSearch('');
                        }}
                      >
                        {s.path}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}

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
            Add to the list below
          </Button>
        </div>

        {claimsError ? <p className="mt-2 text-body text-pink">{claimsError}</p> : null}
        <div className="mt-3 mb-2">
          <Button wide onClick={() => void submitClaims(false)} disabled={setClaimsMutation.isPending}>
            Save what I can do
          </Button>
        </div>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">Badges</h2>
        {badges && badges.badges.length > 0 ? (
          <ul className="space-y-1.5">
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

        <h2 className="mt-8 mb-2.5 text-lede font-bold">Settings</h2>
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
        </div>

        <div className="mt-6 mb-2">
          <Button
            wide
            variant="quiet"
            ink="ink"
            onClick={() => {
              void api.auth.logout().catch(() => undefined);
              void navigate({ to: '/signin' });
            }}
          >
            Sign out
          </Button>
        </div>
      </div>

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
