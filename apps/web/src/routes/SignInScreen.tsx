import { useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { school } from '../lib/mock';
import { Button } from '../components/bits';
import { api, ApiError } from '../lib/api';

type Status = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Two doors, in R9's order: a new Free School identity first, an existing
 * ATProto account second — the latter is now its own screen
 * (`OAuthConfirmScreen`, `/oauth/confirm`) because linking an existing DID to
 * Free School is public and permanent and gets a hard confirm of its own.
 *
 * The primary door POSTs an email to `/api/auth/signup`; the AppView mints a
 * custodial identity and emails (or, with no SMTP configured, logs) a magic
 * link. `VerifyScreen` (`/verify`) is where that link lands.
 */
export function SignInScreen() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus('sending');
    try {
      await api.auth.signup({ email });
      setStatus('sent');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setStatus('error');
    }
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

        {status === 'sent' ? (
          <div className="mt-8 plate plate-green p-4">
            <p className="text-body font-bold">Check your email</p>
            <p className="mt-1.5 text-caption text-ink-soft">
              We sent a link to {email}. Open it on this device to finish signing in.
            </p>
          </div>
        ) : (
          <form className="mt-8" onSubmit={(event) => void onSubmit(event)}>
            <label className="block">
              <span className="text-caption text-ink-soft">Your email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="mt-1.5 block w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none"
              />
            </label>

            {status === 'error' ? (
              <p role="alert" className="mt-2 text-caption text-pink">
                {errorMessage}
              </p>
            ) : null}

            <div className="mt-6">
              <Button type="submit" wide disabled={status === 'sending' || email.trim().length < 3}>
                {status === 'sending' ? 'Sending…' : 'Create a new Free School identity (recommended)'}
              </Button>
              <p className="mt-2 text-caption text-ink-soft">
                Your Free School records stay on the school's own server and are not attached to any account you
                already have.
              </p>
            </div>
          </form>
        )}

        <hr className="rule my-8" />

        {/*
          A client-side `Link`, not a plain `<a>`: the dev proxy forwards any
          `/oauth/*` request to the AppView (`vite.config.ts`, for the real
          `/oauth/callback` etc.), which has no `/oauth/confirm` route and
          would 404 a full navigation here. Router-level navigation never
          touches the network, so it lands on the real screen regardless.
        */}
        <Link
          to="/oauth/confirm"
          className="text-body font-medium text-blue underline decoration-[1.5px] underline-offset-[5px]"
        >
          Use an existing AT Protocol account
        </Link>
        <p className="mt-2 max-w-[48ch] text-caption text-ink-soft">
          For people who already have a Bluesky or other ATProto handle and want Free School on it.
        </p>
      </div>
    </div>
  );
}
