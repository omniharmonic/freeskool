import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { FlowFrame } from '../components/FlowFrame';
import { LoadingState } from '../components/PageState';
import { Button } from '../components/bits';

import { consumeSignInReturn } from '../lib/signin-return';

type Status = 'verifying' | 'error';

/**
 * Where the magic link from `SignInScreen`'s signup lands. `GET
 * /api/auth/verify?token=` (with `Accept: application/json`, which `api.ts`
 * sends) sets the session cookie and returns the DID; from there the needs
 * board — not the calendar — is the onboarding landing (PRD §13 constraint 2).
 */
export function VerifyScreen() {
  const [status, setStatus] = useState<Status>('verifying');
  const [errorMessage, setErrorMessage] = useState('');
  const navigate = useNavigate();
  // StrictMode (`main.tsx`) double-invokes effects in dev; confirmed live
  // against the AppView that a second call with the same token 400s (it's
  // single-use) after the first already navigated away. Harmless, but noisy
  // and wasteful, so the verify call itself only ever runs once.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = new URLSearchParams(window.location.search).get('token');
    if (!token) {
      setStatus('error');
      setErrorMessage('This link is missing its token. Copy the whole link from the email.');
      return;
    }
    api.auth
      .verify(token)
      .then(async () => {
        // Task 11: a brand-new custodial member gets the welcome screen once —
        // the handle they were given, a name, a face, a first skill. Anyone
        // who has been through it (and anyone who brought their own account,
        // handle and all) goes straight where they were headed. A failure to
        // read the session back is not a failure to sign in: they are already
        // in, so land them rather than stranding them on an error.
        try {
          const session = await api.auth.me();
          if (session.kind === 'custodial' && !session.onboarded) {
            void navigate({ to: '/welcome' });
            return;
          }
        } catch {
          /* fall through to the ordinary landing */
        }
        void navigate({ to: consumeSignInReturn() });
      })
      .catch((err: unknown) => {
        setStatus('error');
        setErrorMessage(err instanceof ApiError ? err.message : 'Could not verify that link. Try again.');
      });
  }, [navigate]);

  return (
    <FlowFrame title={status === 'verifying' ? 'Welcome to Free School' : "That link didn't work"}>
        {status === 'verifying' ? <LoadingState label="Signing you in…" /> : null}
        {status === 'error' ? (
          <>
            <p className="mt-2 max-w-[42ch] text-body text-ink-soft">{errorMessage}</p>
            <div className="mt-6">
              <Button href="/signin" ink="blue">
                Back to sign in
              </Button>
            </div>
          </>
        ) : null}
    </FlowFrame>
  );
}
