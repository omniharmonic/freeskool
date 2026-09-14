import { FlowFrame } from '../components/FlowFrame';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { Button } from '../components/bits';

/** Verbatim from the plan's Global Constraints (PRD/R9) — do not paraphrase. */
const CONFIRM_COPY =
  "Before you continue: anyone on the internet will be able to see that this account is part of Free School, and that link can't be undone later — not by us, and not by you. If you'd rather keep Free School separate, go back and create a new identity instead.";

const UNAVAILABLE_MESSAGE = "Signing in with an existing account isn't available on this server yet.";

/**
 * The secondary door, one hard confirm away from `GET /api/auth/oauth/start`.
 *
 * That endpoint itself is never a good pre-flight probe: on success it does
 * real upstream work (PAR, an `oauthState` row — `apps/appview/src/http/oauth.ts`),
 * so hitting it twice (once to check, once to navigate) would double that cost on
 * every click. `GET /oauth/client-metadata.json` checks the same `oauthUsable`
 * flag (`assertOauthUsable()`, `apps/appview/src/http/routes/oauth.ts`) and
 * answers the same 503 when it is false, but does nothing else on success — it
 * just returns a static JSON document — so it is free to use as the probe.
 * Only a probe that succeeds navigates, once, straight to the start URL.
 *
 * The handle field and "Continue anyway" both live in one `<form>` with one
 * `onSubmit` — Enter in the field and a click on the (now `type="submit"`)
 * button are the same event, never two independent handlers racing each
 * other. `if (checking) return` guards the rest: a second submit — a fast
 * double-tap, say — while the first is still in flight does nothing.
 * `redirecting` latches true the instant `window.location.href` is assigned,
 * so nothing after that point — this call finishing up, or a stray one from
 * before the guard existed — can flash an error on a screen that is already
 * on its way to Bluesky.
 */
export function OAuthConfirmScreen() {
  const [handle, setHandle] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const redirecting = useRef(false);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (checking) return;
    setChecking(true);
    setError('');
    try {
      const res = await fetch('/oauth/client-metadata.json', { credentials: 'include' });
      if (res.status === 503) {
        // The route's error *status* is the stable contract here, not the error
        // *code* string: the AppView's class is named `OAuthUnavailableError` but
        // its `.code` is `OAuthNotConfigured` (confirmed against the running dev
        // server) — matching on 503 survives that kind of rename, and 503 has no
        // other meaning on this route.
        setError(UNAVAILABLE_MESSAGE);
        return;
      }
      // Anything else — ok, some other non-ok status, or a body that doesn't
      // parse — is inconclusive, and never a reason to stop here: `GET
      // /api/auth/oauth/start` is the real check, and this always proceeds to
      // it rather than second-guess a probe route with no other job.
      redirecting.current = true;
      window.location.href = api.auth.oauthStartUrl(true, handle);
    } catch {
      if (!redirecting.current) setError('Could not start sign-in. Try again.');
    } finally {
      if (!redirecting.current) setChecking(false);
    }
  };

  return (
    <FlowFrame title="Use an existing AT Protocol account" description={<p className="page-note">{CONFIRM_COPY}</p>}>
      <form onSubmit={(event) => void onSubmit(event)}>
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
          <Button type="submit" ink="blue" wide disabled={handle.trim().length === 0 || checking}>
            {checking ? 'Starting…' : 'Continue anyway'}
          </Button>
          <Button href="/signin" ink="ink" variant="quiet" wide>
            Go back and create a new identity
          </Button>
        </div>
      </form>
    </FlowFrame>
  );
}
