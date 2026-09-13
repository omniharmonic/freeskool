import type { ReactNode } from 'react';
import { useMe } from '../lib/queries';
import { Button } from './bits';

interface SessionGateProps {
  children: ReactNode;
  /** Sentence above the sign-in button; defaults to a generic prompt. */
  prompt?: string;
}

/**
 * Gate for anything that needs a signed-in viewer (RSVP, skill claims,
 * posting a request, admin screens — Tasks 4-8). `useMe()` hits `GET
 * /api/auth/me`, which 401s with nobody signed in (`retry: false`, see
 * `queries.ts`); that rejection, not a loading flash, is what flips this to
 * the sign-in prompt.
 */
export function SessionGate({ children, prompt }: SessionGateProps) {
  const { data, isPending, isError } = useMe();

  if (isPending) return null;

  if (isError || !data) {
    return (
      <div className="plate p-4">
        <p className="text-body text-ink-soft">{prompt ?? 'Sign in to do that.'}</p>
        <div className="mt-3">
          <Button href="/signin" ink="blue">
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
