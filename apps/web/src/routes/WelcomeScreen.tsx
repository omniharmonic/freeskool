import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FlowFrame } from '../components/FlowFrame';
import { HandleChooser } from '../components/HandleChooser';
import { ImagePicker } from '../components/ImagePicker';
import { SkillMultiPicker } from '../components/SkillPicker';
import { LoadingState } from '../components/PageState';
import { Button } from '../components/bits';
import { ApiError } from '../lib/api';
import { flattenSkills } from '../lib/skills';
import { consumeSignInReturn } from '../lib/signin-return';
import {
  useMe,
  useMeProfile,
  useOnboardedMutation,
  useSetSkillClaimsMutation,
  useSkillTree,
  useUpdateProfileMutation,
} from '../lib/queries';
import type { ImageInput, MeProfile, UpdateProfileInput } from '../lib/types';

/**
 * The first minute of membership (`/welcome`).
 *
 * Benjamin, signing up through the email door, "wasn't given the opportunity
 * to claim a handle or set up my profile" — the account was minted with a
 * generated handle and he was dropped straight on the requests board. This is
 * that missing minute: the handle he was given, the offer to choose his own,
 * a name and a face, and a first pass at what he could share.
 *
 * Everything here is skippable and nothing here publishes. The handle is the
 * one exception and it says so out loud: it is a public ATProto identity and
 * the directory keeps it forever. Skill claims are saved school-only at
 * "practicing" — a member decides what to make public later, in Me, where the
 * choice is explained.
 *
 * `VerifyScreen` sends a member here exactly once: a custodial session whose
 * `onboarded` flag is still false. "Finish" sets that flag
 * (`POST /api/me/onboarded`) and hands over to `consumeSignInReturn()`, so an
 * invitation that survived the magic link still lands where it was going.
 *
 * Anyone who arrives here after that — an old link, a typed address — is sent
 * to Me instead, and the profile card is prefilled from `GET /api/me`. Both
 * are UX audit finding 8: this screen used to offer the whole flow again with
 * empty fields, and "Save and continue" then wrote those empty fields over a
 * real name and bio.
 */
export function WelcomeScreen() {
  const navigate = useNavigate();
  const { data: me, isPending, isError } = useMe();
  // The profile a member may already have. `/welcome` is reachable by hand
  // (and by an old link) long after onboarding, so the cards start from what
  // is on file rather than from blank fields — UX audit finding 8.
  const { data: meProfile, isPending: profilePending } = useMeProfile();

  // Already been through this once: there is nothing here that Me does not do
  // better, so send them there rather than offering the whole flow again.
  // Latched on the FIRST answer only: "Finish" sets the flag and refetches `me`,
  // and that flip must not hijack the hand-off to the needs board.
  const arrived = useRef<boolean | null>(null);
  if (me && arrived.current === null) arrived.current = me.onboarded === true;
  const alreadyOnboarded = arrived.current === true;
  useEffect(() => {
    if (alreadyOnboarded) void navigate({ to: '/me' });
  }, [alreadyOnboarded, navigate]);

  if (isPending || alreadyOnboarded || (Boolean(me) && profilePending)) {
    return (
      <FlowFrame title="Welcome to Free School">
        <LoadingState label="Opening your notebook…" />
      </FlowFrame>
    );
  }

  if (isError || !me) {
    return (
      <FlowFrame title="Come as you are" description="Sign in first and we'll pick this up where you left it.">
        <Button href="/signin" ink="blue">
          Sign in
        </Button>
      </FlowFrame>
    );
  }

  return (
    <WelcomeCards
      handle={me.handle ?? ''}
      profile={meProfile?.profile}
      onDone={() => void navigate({ to: consumeSignInReturn() })}
    />
  );
}

function WelcomeCards({
  handle,
  profile,
  onDone,
}: {
  handle: string;
  profile?: MeProfile;
  onDone: () => void;
}) {
  const [step, setStep] = useState(1);
  const advance = (from: number) => setStep((current) => (current > from ? current : from + 1));

  // ── card 1: handle ───────────────────────────────────────────────────
  const [chosenHandle, setChosenHandle] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  // ── card 2: profile ──────────────────────────────────────────────────
  // Prefilled from `GET /api/me`, so a second visit shows the name and the
  // line a member already wrote instead of two empty boxes.
  const savedName = profile?.displayName ?? '';
  const savedBio = profile?.bio ?? '';
  const [displayName, setDisplayName] = useState(savedName);
  const [bio, setBio] = useState(savedBio);
  const [avatar, setAvatar] = useState<ImageInput | null | undefined>();
  const [profileError, setProfileError] = useState<string | null>(null);
  const updateProfile = useUpdateProfileMutation();

  /** Only what this member actually typed here. An empty box means "nothing to
   * say about that", never "erase what I had" (UX audit finding 8). */
  const saveProfile = async () => {
    setProfileError(null);
    const typedName = displayName.trim();
    const typedBio = bio.trim();
    const body: UpdateProfileInput = {
      ...(typedName && typedName !== savedName ? { displayName: typedName } : {}),
      ...(typedBio && typedBio !== savedBio ? { bio: typedBio } : {}),
      ...(avatar ? { avatar } : {}),
    };
    if (Object.keys(body).length === 0) {
      advance(2);
      return;
    }
    try {
      await updateProfile.mutateAsync(body);
      advance(2);
    } catch (err) {
      setProfileError(err instanceof ApiError ? err.message : 'Could not save that. Try again.');
    }
  };

  // ── card 3: skills ───────────────────────────────────────────────────
  const { data: skillTree } = useSkillTree();
  const flatSkills = useMemo(() => flattenSkills(skillTree?.skills ?? []), [skillTree]);
  const [skills, setSkills] = useState<string[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const setClaims = useSetSkillClaimsMutation();

  /** School-only, at "practicing": onboarding never publishes anything. */
  const saveSkills = async () => {
    setSkillsError(null);
    try {
      await setClaims.mutateAsync({
        claims: skills.map((skill) => ({ skill, level: 'practicing' as const, visibility: 'school' as const })),
      });
      advance(3);
    } catch (err) {
      setSkillsError(err instanceof ApiError ? err.message : 'Could not save those. Try again.');
    }
  };

  // ── finish ───────────────────────────────────────────────────────────
  const onboarded = useOnboardedMutation();
  const finish = async () => {
    // The flag is a convenience, not a gate: if it fails to save, the member
    // still gets where they were going (and sees this screen once more).
    try {
      await onboarded.mutateAsync();
    } catch {
      /* nothing to say about it here */
    }
    onDone();
  };

  const shownHandle = chosenHandle ?? handle;

  return (
    <FlowFrame
      title="Welcome to Free School"
      description="Three small things before you go in. You can skip any of them and change all of them later."
    >
      {/* UX audit journey finding 7 / controller 7: the counter used to sit over three
          cards that were all open at once, so it read like a wizard and gated nothing —
          and on a phone the page was very long. One card at a time, the strip moving with
          it, and every card still skippable. */}
      <p className="stamp text-caption text-ink-soft">Step {Math.min(step, 3)} of 3</p>
      <ol className="mt-1.5 flex gap-1.5" aria-label="Onboarding steps">
        {[1, 2, 3].map((n) => (
          <li
            key={n}
            aria-current={step === n ? 'step' : undefined}
            className="h-1 flex-1 border-[1.5px] border-ink"
            style={{ background: step >= n ? 'var(--c-ink)' : 'transparent' }}
          >
            <span className="sr-only">
              Step {n}
              {step === n ? ' (current)' : step > n ? ' (done)' : ''}
            </span>
          </li>
        ))}
      </ol>

      <section className="plate mt-3 p-4">
        <h2 className="text-lede font-bold">Choose your handle</h2>
        <p className="mt-2 text-caption text-ink-soft">This is the name we made for you.</p>
        <p className="display mt-1 text-lede font-bold break-all">{shownHandle}</p>

        {choosing ? (
          <div className="mt-3">
            <HandleChooser
              currentHandle={shownHandle}
              onSaved={(saved) => {
                setChosenHandle(saved);
                setChoosing(false);
                advance(1);
              }}
              onCancel={() => setChoosing(false)}
            />
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-3">
            <Button ink="blue" onClick={() => setChoosing(true)}>
              Choose my own
            </Button>
            <Button variant="quiet" ink="ink" onClick={() => advance(1)}>
              Next
            </Button>
          </div>
        )}

        <p className="mt-3 text-caption text-ink-faint">
          Your handle is public and lives in the AT Protocol directory permanently. Everything else here is only
          visible to members of this school.
        </p>
      </section>

      {step >= 2 ? (
      <section className="plate mt-3 p-4">
        <h2 className="text-lede font-bold">Say who you are</h2>
        <p className="mt-2 text-caption text-ink-soft">Only people at this school see this.</p>

        <div className="mt-3 space-y-3">
          <ImagePicker avatar value={avatar} onChange={setAvatar} />
          <label className="block">
            <span className="text-caption text-ink-soft">Display name</span>
            <input
              className="mt-1.5 min-h-[44px] w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={displayName}
              maxLength={120}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="What people call you"
            />
          </label>
          <label className="block">
            <span className="text-caption text-ink-soft">A line about you</span>
            <textarea
              className="mt-1.5 min-h-[72px] w-full resize-none border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={bio}
              maxLength={2000}
              onChange={(event) => setBio(event.target.value)}
              placeholder="What you're into, what you're learning"
            />
          </label>
        </div>

        {profileError ? (
          <p role="alert" className="mt-2 text-caption text-pink">
            {profileError}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-3">
          <Button ink="blue" disabled={updateProfile.isPending} onClick={() => void saveProfile()}>
            {updateProfile.isPending ? 'Saving…' : 'Save and continue'}
          </Button>
          <Button variant="quiet" ink="ink" onClick={() => advance(2)}>
            Skip the profile
          </Button>
        </div>
      </section>
      ) : null}

      {step >= 3 ? (
      <section className="plate mt-3 p-4">
        <h2 className="text-lede font-bold">What could you share?</h2>
        <p className="mt-2 text-caption text-ink-soft">
          Nothing formal — things you have done enough times to show someone else. These stay inside the school
          until you say otherwise.
        </p>

        <div className="mt-3">
          <SkillMultiPicker skills={flatSkills} values={skills} onChange={setSkills} allowPropose />
        </div>

        {skillsError ? (
          <p role="alert" className="mt-2 text-caption text-pink">
            {skillsError}
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap gap-3">
          <Button ink="blue" disabled={skills.length === 0 || setClaims.isPending} onClick={() => void saveSkills()}>
            {setClaims.isPending ? 'Saving…' : 'Save these skills'}
          </Button>
          <Button variant="quiet" ink="ink" onClick={() => advance(3)}>
            Skip skills for now
          </Button>
        </div>
      </section>
      ) : null}

      <div className="mt-6">
        <Button wide disabled={onboarded.isPending} onClick={() => void finish()}>
          Finish
        </Button>
        <p className="mt-2 text-caption text-ink-soft">
          Everything here lives in Me, and you can change it whenever you like.
        </p>
      </div>
    </FlowFrame>
  );
}
