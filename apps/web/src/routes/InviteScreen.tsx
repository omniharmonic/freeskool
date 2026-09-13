import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/queries';
import { Button } from '../components/bits';

type Status = 'checking' | 'redeeming' | 'redeemed' | 'error' | 'signed-out';

function messageFor(err: ApiError): string {
  switch (err.code) {
    case 'SelfRedeem':
      return "That's your own invite link — share it with someone else instead.";
    case 'AlreadyInvited':
      return "You're already in — no need to redeem this one.";
    case 'InviteExpired':
      return 'This invite link has expired.';
    case 'InviteExhausted':
      return 'This invite link has no uses left.';
    case 'NotFound':
      return "That invite link doesn't exist. Double-check you copied the whole thing.";
    default:
      return err.message || 'Could not accept this invite. Try again.';
  }
}

/**
 * `/invite/$token` — where a minted invite link (`api.invites.mint`, from
 * `EventScreen`'s "Bring a friend") lands.
 *
 * Signed in: redeem immediately, then land on the event if the invite was
 * scoped to one, otherwise the needs board (the same onboarding landing as
 * `VerifyScreen`, PRD §13). Signed out: `POST /api/invites/:token/redeem`
 * requires a viewer, so there is nothing to try yet — send them to sign in
 * with `?next=` pointing back here; the redemption itself happens once they
 * land back on this screen signed in.
 */
export function InviteScreen() {
  const { token } = useParams({ from: '/invite/$token' });
  const { data: me, isPending, isError } = useMe();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>('checking');
  const [message, setMessage] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (isPending) return;
    if (isError || !me) {
      setStatus('signed-out');
      return;
    }
    if (started.current) return;
    started.current = true;
    setStatus('redeeming');
    api.invites
      .redeem(token)
      .then((result) => {
        setStatus('redeemed');
        if (result.eventUri) {
          void navigate({ to: '/events/$id', params: { id: result.eventUri } });
        } else {
          void navigate({ to: '/requests' });
        }
      })
      .catch((err: unknown) => {
        setStatus('error');
        setMessage(err instanceof ApiError ? messageFor(err) : 'Could not accept this invite. Try again.');
      });
  }, [isPending, isError, me, token, navigate]);

  return (
    <div className="app-scroll">
      <div className="safe-top safe-x pb-10 pt-10">
        {status === 'checking' || status === 'redeeming' ? (
          <p className="text-body text-ink-soft">Getting you in…</p>
        ) : null}

        {status === 'signed-out' ? (
          <>
            <h1 className="text-large leading-[1.02] font-extrabold">You've been invited to Free School</h1>
            <p className="mt-3 max-w-[42ch] text-body text-ink-soft">
              Sign in (or create a free identity) and we'll take you straight in.
            </p>
            <div className="mt-6">
              <Button href={`/signin?next=${encodeURIComponent(`/invite/${token}`)}`} ink="blue">
                Sign in
              </Button>
            </div>
          </>
        ) : null}

        {status === 'error' ? (
          <>
            <h1 className="text-lede font-bold">That invite didn't work</h1>
            <p className="mt-2 max-w-[42ch] text-body text-ink-soft">{message}</p>
            <div className="mt-6">
              <Button href="/" ink="blue">
                Go to the calendar
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
