import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { Button } from '../components/bits';

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
      .then(() => {
        void navigate({ to: '/requests' });
      })
      .catch((err: unknown) => {
        setStatus('error');
        setErrorMessage(err instanceof ApiError ? err.message : 'Could not verify that link. Try again.');
      });
  }, [navigate]);

  return (
    <div className="app-scroll">
      <div className="safe-top safe-x pb-10 pt-10">
        {status === 'verifying' ? <p className="text-body text-ink-soft">Signing you in…</p> : null}
        {status === 'error' ? (
          <>
            <h1 className="text-lede font-bold">That link didn't work</h1>
            <p className="mt-2 max-w-[42ch] text-body text-ink-soft">{errorMessage}</p>
            <div className="mt-6">
              <Button href="/signin" ink="blue">
                Back to sign in
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
