import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Screen } from '../../components/Screen';
import { Button } from '../../components/bits';
import { SessionGate } from '../../components/SessionGate';
import { ApiError } from '../../lib/api';
import { useHandoffAcceptMutation } from '../../lib/queries';
import type { HandoffAcceptResult } from '../../lib/types';

/**
 * `/admin/handoff/accept/$token` — `POST /api/handoff/:token/accept`. Open to
 * any signed-in Member (NOT steward-gated — see the module doc comment on
 * `apps/appview/src/http/routes/handoff.ts` for why accepting lives outside
 * `/api/admin`). Acceptance is explicit, not automatic on page load: it grants
 * stewardship, which is consequential enough to need a deliberate tap.
 */
export function HandoffAcceptScreen() {
  return (
    <SessionGate prompt="Sign in to accept this hand-off.">
      <HandoffAcceptForm />
    </SessionGate>
  );
}

function HandoffAcceptForm() {
  const { token } = useParams({ from: '/admin/handoff/accept/$token' });
  const acceptMutation = useHandoffAcceptMutation();
  const [result, setResult] = useState<HandoffAcceptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onAccept = async () => {
    setError(null);
    try {
      const res = await acceptMutation.mutateAsync(token);
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not accept this hand-off. Try again.');
    }
  };

  return (
    <Screen title="Accept stewardship" back>
      <div className="safe-x">
        {result ? (
          <div className="plate plate-green p-4">
            <p className="text-body">You're now a steward of this school.</p>
            {result.warning === 'single-steward' ? (
              <p className="mt-2 text-caption text-ink-soft">
                You're the only active steward right now — consider handing off to someone else too, so the
                school never depends on just one person.
              </p>
            ) : null}
          </div>
        ) : (
          <>
            <p className="text-body text-ink-soft">
              Accepting makes you a steward of this school — able to moderate what's on the calendar, and to take
              destructive actions alongside other stewards' sign-off.
            </p>
            {error ? <p className="mt-3 text-body text-pink">{error}</p> : null}
            <div className="mt-5">
              <Button wide ink="pink" onClick={() => void onAccept()} disabled={acceptMutation.isPending}>
                Accept stewardship
              </Button>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}
