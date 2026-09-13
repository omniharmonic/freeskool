import type { ReactNode } from 'react';
import { useMe } from '../lib/queries';
import { ApiError } from '../lib/api';
import { LoadingState, PageState } from './PageState';
import { Screen } from './Screen';
import { Button } from './bits';

interface SessionGateProps {
  children: ReactNode;
  screen?: boolean;
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
export function SessionGate({ children, prompt, screen = false }: SessionGateProps) {
  const { data, isPending, isError, error, refetch } = useMe();

  if (isPending) {
    const loading = <LoadingState label="Checking your sign-in…" />;
    return screen ? <Screen title="Welcome" layout="form"><div className="safe-x">{loading}</div></Screen> : loading;
  }
  if (isError && error instanceof ApiError && error.status !== 401) {
    const recovery = <PageState title="We couldn’t check your sign-in." error action={<Button onClick={() => void refetch()}>Try again</Button>}>Please try again in a moment.</PageState>;
    return screen ? <Screen title="Welcome" layout="form"><div className="safe-x">{recovery}</div></Screen> : recovery;
  }

  if (isError || !data) {
    const notice = (
      <div className="plate p-4">
        <p className="text-body text-ink-soft">{prompt ?? 'Sign in to do that.'}</p>
        <div className="mt-3">
          <Button href="/signin" ink="blue">
            Sign in
          </Button>
        </div>
      </div>
    );
    return screen ? <Screen title="Come as you are" layout="form" back><div className="safe-x">{notice}</div></Screen> : notice;
  }

  return <>{children}</>;
}
