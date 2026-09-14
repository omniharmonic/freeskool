import { useMemo, useState } from 'react';
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
  useOnboardedMutation,
  useSetSkillClaimsMutation,
  useSkillTree,
  useUpdateProfileMutation,
} from '../lib/queries';
import type { ImageInput } from '../lib/types';

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
 */
export function WelcomeScreen() {
  const navigate = useNavigate();
  const { data: me, isPending, isError } = useMe();

  if (isPending) {
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

  return <WelcomeCards handle={me.handle ?? ''} onDone={() => void navigate({ to: consumeSignInReturn() })} />;
}

function WelcomeCards({ handle, onDone }: { handle: string; onDone: () => void }) {
  const [step, setStep] = useState(1);
  const advance = (from: number) => setStep((current) => (current > from ? current : from + 1));

  // ── card 1: handle ───────────────────────────────────────────────────
  const [chosenHandle, setChosenHandle] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);

  // ── card 2: profile ──────────────────────────────────────────────────
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatar, setAvatar] = useState<ImageInput | null | undefined>();
  const [profileError, setProfileError] = useState<string | null>(null);
  const updateProfile = useUpdateProfileMutation();

  const saveProfile = async () => {
    setProfileError(null);
    try {
      await updateProfile.mutateAsync({
        displayName: displayName.trim(),
        bio: bio.trim(),
        ...(avatar ? { avatar } : {}),
      });
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
      <p className="stamp text-caption text-ink-soft">Step {Math.min(step, 3)} of 3</p>

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
              Skip choosing a handle
            </Button>
          </div>
        )}

        <p className="mt-3 text-caption text-ink-faint">
          Your handle is public and lives in the AT Protocol directory permanently. Everything else here is only
          visible to members of this school.
        </p>
      </section>

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
