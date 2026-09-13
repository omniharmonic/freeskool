import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { ApiError } from '../lib/api';
import { useOwnershipReveal } from '../lib/queries';

/**
 * `/account/reveal/$token` — `GET /api/auth/take-ownership/:token`,
 * deliberately unauthenticated and single-use (the token itself IS the
 * credential; see the route's doc comment in
 * `apps/appview/src/http/routes/auth.ts`). Fetches once, shows the password
 * exactly once, and never logs or persists it beyond this component's own
 * state — no `localStorage`, no console output.
 */
export function RevealScreen() {
  const { token } = useParams({ from: '/account/reveal/$token' });
  const { data, isPending, error } = useOwnershipReveal(token);
  const [copied, setCopied] = useState(false);

  const onCopy = () => {
    if (!data) return;
    navigator.clipboard?.writeText(data.password).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  const code = error instanceof ApiError ? error.code : undefined;

  return (
    <Screen title="Your new password" back>
      <div className="safe-x">
        {isPending ? <p className="text-body text-ink-soft">Loading…</p> : null}

        {code === 'Expired' ? (
          <p className="text-body text-ink-soft">
            This link has expired. Go back to "Take ownership of this account" on the Me tab and ask for a new one.
          </p>
        ) : null}
        {code === 'AlreadyUsed' ? (
          <p className="text-body text-ink-soft">
            This link has already been used — the password was shown once, and can't be shown again.
          </p>
        ) : null}
        {code === 'NotFound' ? (
          <p className="text-body text-ink-soft">This link doesn't exist. Double-check you copied the whole thing.</p>
        ) : null}

        {data ? (
          <>
            <p className="text-body">Write this down now — it is shown once and cannot be retrieved again.</p>
            <div className="mt-4 plate space-y-3 p-4">
              <div>
                <p className="text-caption text-ink-soft">Handle</p>
                <p className="text-body">{data.handle}</p>
              </div>
              <div>
                <p className="text-caption text-ink-soft">Password</p>
                <p className="break-all text-body font-bold">{data.password}</p>
              </div>
              <Button ink="blue" onClick={onCopy}>
                {copied ? 'Copied' : 'Copy password'}
              </Button>
            </div>
            <p className="mt-4 text-caption text-ink-soft">{data.message}</p>
          </>
        ) : null}
      </div>
    </Screen>
  );
}
