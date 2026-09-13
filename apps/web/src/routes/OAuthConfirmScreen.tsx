import { useState } from 'react';
import { api } from '../lib/api';
import { Button } from '../components/bits';

/** Verbatim from the plan's Global Constraints (PRD/R9) — do not paraphrase. */
const CONFIRM_COPY =
  "Before you continue: anyone on the internet will be able to see that this account is part of Free School, and that link can't be undone later — not by us, and not by you. If you'd rather keep Free School separate, go back and create a new identity instead.";

const UNAVAILABLE_MESSAGE = "Signing in with an existing account isn't available on this server yet.";

/**
 * The secondary door, one hard confirm away from `GET /api/auth/oauth/start`.
 *
 * That endpoint redirects the browser on success but answers with JSON on
 * failure — 428 `ConfirmationRequired` without `?confirm=1` (never reached
 * here, since this screen always sends it) and 503 `OAuthUnavailable` when
 * the AppView is not on an https origin. A blind `window.location` assignment
 * can't tell those apart ahead of time and would just render the JSON as a
 * page, so the button probes first with `redirect: 'manual'`: a real 302
 * comes back as an opaque-redirect response (no CORS error, even though the
 * OAuth provider is cross-origin) and only then does the browser navigate.
 */
export function OAuthConfirmScreen() {
  const [handle, setHandle] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const onContinue = async () => {
    setChecking(true);
    setError('');
    const url = api.auth.oauthStartUrl(true, handle);
    try {
      const res = await fetch(url, { redirect: 'manual', credentials: 'include' });
      if (res.type === 'opaqueredirect' || res.status === 0) {
        window.location.href = url;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      // The route's error *status* (503) is the stable contract here, not the error
      // *code* string: the AppView's class is named `OAuthUnavailableError` but its
      // `.code` is `OAuthNotConfigured` (confirmed against the running dev server) —
      // matching on 503 survives that kind of rename, and 503 has no other meaning
      // on this route (`apps/appview/src/http/routes/auth.ts`: everything else that
      // can fail here is 400, 428, or 502).
      setError(
        res.status === 503 || body.error === 'OAuthUnavailable'
          ? UNAVAILABLE_MESSAGE
          : body.message ?? 'Could not start sign-in. Try again.',
      );
    } catch {
      setError('Could not start sign-in. Try again.');
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="app-scroll">
      <div className="safe-top safe-x pb-10">
        <div className="pt-10">
          <h1 className="text-large leading-[1.02] font-extrabold">Use an existing AT Protocol account</h1>
          <p className="mt-3 max-w-[48ch] text-body">{CONFIRM_COPY}</p>
        </div>

        <label className="mt-8 block">
          <span className="text-caption text-ink-soft">Your handle, like name.bsky.social</span>
          <input
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="name.bsky.social"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="mt-1.5 block w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none"
          />
        </label>

        {error ? (
          <p role="alert" className="mt-2 text-caption text-pink">
            {error}
          </p>
        ) : null}

        <div className="mt-6 flex flex-col gap-3">
          <Button
            ink="blue"
            wide
            disabled={handle.trim().length === 0 || checking}
            onClick={() => void onContinue()}
          >
            {checking ? 'Checking…' : 'Continue anyway'}
          </Button>
          <Button href="/signin" ink="ink" variant="quiet" wide>
            Go back and create a new identity
          </Button>
        </div>
      </div>
    </div>
  );
}
