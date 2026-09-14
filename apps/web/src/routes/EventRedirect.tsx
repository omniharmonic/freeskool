import { useMemo } from 'react';
import { Navigate, useParams } from '@tanstack/react-router';
import { LoadingState, PageState } from '../components/PageState';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { useCalendar } from '../lib/queries';

/**
 * How far either side of today the short-link lookup sweeps. A class shared by
 * QR code or printed in the zine is usually within weeks; a year and a bit in
 * both directions covers an old link to a class that has already happened.
 */
const WINDOW_DAYS = 400;

/** The short id a `/event/<id>` link carries: the AT-URI's last path segment
 * (`eventId()` in `EventCard.tsx`, and what the zine's QR codes encode). */
function shortId(uri: string): string {
  return uri.split('/').pop() ?? uri;
}

/**
 * `/event/$eventId` — the pre-Task-4 short link, still in the wild on printed
 * zines, QR codes and anything anyone bookmarked.
 *
 * `GET /api/events/:id` takes the FULL AT-URI, so this used to forward the
 * short id verbatim and land every old link on "Class not found" (UX audit
 * finding 6). It now resolves the short id the only way a client can: the
 * public calendar (`GET /api/calendar?from&to`) already returns each class's
 * `uri`, so the one whose last segment matches is the class being asked for.
 * A link that carries the whole AT-URI already needs no lookup at all.
 */
export function EventRedirect() {
  const { eventId } = useParams({ from: '/event/$eventId' });
  if (eventId.startsWith('at://')) {
    return <Navigate to="/events/$id" params={{ id: eventId }} replace />;
  }
  return <ShortLinkRedirect id={eventId} />;
}

function ShortLinkRedirect({ id }: { id: string }) {
  const range = useMemo(() => {
    const span = WINDOW_DAYS * 86_400_000;
    return { from: new Date(Date.now() - span).toISOString(), to: new Date(Date.now() + span).toISOString() };
  }, []);
  const { data, isPending, isError, refetch } = useCalendar(range);

  const match = data?.events.find((event) => event.uri === id || shortId(event.uri) === id);
  if (match) return <Navigate to="/events/$id" params={{ id: match.uri }} replace />;

  if (isPending) {
    return (
      <Screen title="Opening this class" back>
        <div className="safe-x"><LoadingState label="Finding this class…" /></div>
      </Screen>
    );
  }

  if (isError) {
    return (
      <Screen title="Couldn't open this class" back>
        <div className="safe-x">
          <PageState title="Let's try that again." error action={<Button onClick={() => void refetch()}>Try again</Button>}>
            Please check your connection and try again.
          </PageState>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title="That class link didn't resolve" back>
      <div className="safe-x">
        <p className="text-body text-ink-soft">
          This link points to a class that is not on the calendar. It may be an old link, or the class may have been
          cancelled.
        </p>
        <div className="mt-4">
          <Button href="/" ink="blue">
            Find a class
          </Button>
        </div>
      </div>
    </Screen>
  );
}
