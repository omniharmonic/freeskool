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
  const { data, isPending, isError, error, refetch } = useOwnershipReveal(token);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const onCopy = () => {
    if (!data) return;
    setCopyError(false);
    if (!navigator.clipboard) { setCopyError(true); return; }
    void navigator.clipboard.writeText(data.password).then(() => setCopied(true), () => setCopyError(true));
  };

  const code = error instanceof ApiError ? error.code : undefined;
  const knownError = code === 'Expired' || code === 'AlreadyUsed' || code === 'NotFound';

  return (
    <Screen title="Your new password" layout="form" standfirst="This account is yours. Keep its credentials somewhere only you can access." back>
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

        {/* Anything else that isn't one of the three real refusals above — a
            5xx, a non-JSON response, being offline — is NOT the same as the
            link being dead. Since the token is single-use, telling someone to
            "try again" by reloading risks nothing here (a failed request
            never consumed it), but a REFRESH of a page that later succeeds
            would; the copy is explicit that the link itself is still good. */}
        {isError && !knownError ? (
          <>
            <p className="text-body text-ink-soft">
              We couldn't load your password right now. Don't refresh — come back to this exact link once you're
              online; it has not been used.
            </p>
            <div className="mt-3">
              <Button ink="blue" onClick={() => void refetch()}>
                Retry
              </Button>
              {copyError ? <p role="alert">Copying didn’t work. Select the password above and copy it manually.</p> : null}
            </div>
          </>
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
              {copyError ? <p role="alert">Copying didn’t work. Select the password above and copy it manually.</p> : null}
            </div>
            <p className="mt-4 text-caption text-ink-soft">{data.message}</p>
          </>
        ) : null}
      </div>
    </Screen>
  );
}
