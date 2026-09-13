import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { school } from '../lib/mock';
import { Sheet } from '../components/Sheet';
import { Button } from '../components/bits';
import { api } from '../lib/api';

/**
 * Two doors, in R9's order: a new Free School identity first, an existing
 * ATProto account second and behind a hard confirm — because linking an
 * existing DID to Free School is public and permanent.
 *
 * Both doors POST to /api/auth/* on this origin: OAuth runs server-side so the
 * session is a cookie, and cookies are the one thing iOS copies at install.
 */
export function SignInScreen() {
  const [handle, setHandle] = useState('');
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();

  // A real email-based signup flow lands in Task 3 (VerifyScreen, "check your
  // email" states); this keeps the shell working against the real endpoint
  // in the meantime.
  const createIdentity = async () => {
    await api.auth.signup({ email: handle }).catch(() => undefined);
    void navigate({ to: '/me' });
  };

  const useExisting = () => {
    setConfirming(false);
    // `oauth/start` is a GET that redirects the browser; it is not a fetch.
    window.location.href = api.auth.oauthStartUrl(true, handle);
  };

  return (
    <div className="app-scroll">
      <div className="safe-top safe-x pb-10">
        <div className="pt-10">
          <p className="stamp text-[13px] text-pink">{school.monthLabel}</p>
          <h1 className="mt-2 text-large leading-[1.02] font-extrabold">{school.name}</h1>
          <p className="mt-3 max-w-[42ch] text-body text-ink-soft">
            Free classes taught by people who live here. You need a name to RSVP under — that's the only
            reason to sign in.
          </p>
        </div>

        <label className="mt-8 block">
          <span className="text-caption text-ink-soft">Pick a name people will see</span>
          <div className="mt-1.5 flex items-stretch">
            <input
              value={handle}
              onChange={(event) => setHandle(event.target.value)}
              placeholder="wren"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none"
            />
            <span className="flex items-center border-[1.5px] border-l-0 border-ink px-3 text-caption text-ink-soft">
              .fs.boulder
            </span>
          </div>
        </label>

        <div className="mt-6">
          <Button wide onClick={() => void createIdentity()} disabled={handle.trim().length < 2}>
            Create a new Free School identity (recommended)
          </Button>
          <p className="mt-2 text-caption text-ink-soft">
            Your Free School records stay on the school's own server and are not attached to any account you
            already have.
          </p>
        </div>

        <hr className="rule my-8" />

        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="text-body font-medium text-blue underline decoration-[1.5px] underline-offset-[5px]"
        >
          Use an existing AT Protocol account
        </button>
        <p className="mt-2 max-w-[48ch] text-caption text-ink-soft">
          For people who already have a Bluesky or other ATProto handle and want Free School on it.
        </p>
      </div>

      <Sheet
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Before you continue"
        footer={
          <div className="flex gap-3">
            <Button ink="ink" variant="quiet" onClick={() => setConfirming(false)}>
              Go back
            </Button>
            <Button ink="blue" onClick={() => void useExisting()}>
              I understand, continue
            </Button>
          </div>
        }
      >
        <p className="max-w-[56ch] text-body">
          Anyone on the internet will be able to see that this account is part of Free School, and that link
          can't be undone later — not by us, and not by you. If you'd rather keep Free School separate, go back
          and create a new identity instead.
        </p>
      </Sheet>
    </div>
  );
}
