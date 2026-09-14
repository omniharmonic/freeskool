import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { FlowFrame } from '../components/FlowFrame';
import { Button } from '../components/bits';
import { api, ApiError } from '../lib/api';

import { rememberSignInReturn } from '../lib/signin-return';

type Status = 'idle' | 'sending' | 'sent' | 'error';

/**
 * Two doors, in R9's order: the email door first, an existing ATProto
 * account second — the latter is now its own screen
 * (`OAuthConfirmScreen`, `/oauth/confirm`) because linking an existing DID to
 * Free School is public and permanent and gets a hard confirm of its own.
 *
 * The primary door POSTs an email to `/api/auth/signin` (`api.auth.signin` —
 * same handler as `/api/auth/signup` on the AppView, see
 * `apps/appview/src/http/routes/auth.ts`): a new member gets a fresh
 * custodial identity, a returning member gets the same account and a fresh
 * link, and an email whose PDS account exists but got orphaned (a prior
 * signup that lost the mail send) is quietly adopted rather than failing
 * forever. Either way the AppView emails (or, with no SMTP configured, logs)
 * a magic link; `VerifyScreen` (`/verify`) is where that link lands. "New
 * here or coming back" is exactly why the button no longer distinguishes
 * the two.
 */
export function SignInScreen() {
  useEffect(() => rememberSignInReturn(window.location.search), []);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus('sending');
    try {
      await api.auth.signin({ email });
      setStatus('sent');
    } catch (err) {
      setErrorMessage(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setStatus('error');
    }
  };

  return (
    <FlowFrame title="Come as you are" description="Free classes taught by people who live here. Sign in to join a class, ask for something new, or share what you know.">
        {status === 'sent' ? (
          <div role="status" className="plate plate-green p-5">
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
              <p className="mt-1.5 text-caption text-ink-soft">New here or coming back, this is the door.</p>
            </label>

            {status === 'error' ? (
              <p role="alert" className="mt-2 text-caption text-pink">
                {errorMessage}
              </p>
            ) : null}

            <div className="mt-6">
              <Button type="submit" wide disabled={status === 'sending' || email.trim().length < 3}>
                {status === 'sending' ? 'Sending…' : 'Continue with email'}
              </Button>
              <p className="mt-2 text-caption text-ink-soft">
                Your Free School records stay on the school's own server and are not attached to any account you
                already have.
              </p>
            </div>
          </form>
        )}

        <hr className="rule my-8" />

        <Link
          to="/oauth/confirm"
          className="text-body font-medium text-blue underline decoration-[1.5px] underline-offset-[5px]"
        >
          Use an existing AT Protocol account
        </Link>
        <p className="mt-2 max-w-[48ch] text-caption text-ink-soft">
          For people who already have a Bluesky or other ATProto handle and want Free School on it.
        </p>
    </FlowFrame>
  );
}
