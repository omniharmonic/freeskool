import { useEffect, useState } from 'react';
import { Navigate, useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, SkillChip, Toggle } from '../components/bits';
import { SessionGate } from '../components/SessionGate';
import { useInstallFlow } from '../components/InstallNudge';
import { api } from '../lib/api';
import { formatDayStamp, formatTime, formatTimeRange } from '../lib/dates';
import { useEvent, useMyRsvp, useRsvpClearMutation, useRsvpMutation } from '../lib/queries';
import type { EventDetail, EventLocation } from '../lib/types';

/** Verbatim from the plan's global constraints — do not paraphrase. */
const PERMANENCE_SENTENCE =
  'Anyone will be able to see, permanently, that you planned to be at this place at this time.';

/**
 * `/event/$eventId` is the pre-Task-4 route, built around a mock short id
 * (`eventId()` in `EventCard.tsx`, the last path segment of the AT-URI). The
 * real `GET /api/events/:id` needs the FULL AT-URI — the same shape the new
 * `/events/$id/*` placeholders already use (Task 1's router skeleton) — so
 * this route now just forwards there rather than trying to resolve a partial
 * id into a full one.
 */
export function EventRedirect() {
  const { eventId } = useParams({ from: '/event/$eventId' });
  return <Navigate to="/events/$id" params={{ id: eventId }} replace />;
}

function formatAddress(location: EventLocation): string {
  const rec = location as Record<string, unknown>;
  const pick = (key: string): string | undefined => {
    const v = rec[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  return [pick('name'), pick('street'), pick('locality'), pick('region'), pick('postalCode')]
    .filter((v): v is string => Boolean(v))
    .join(', ');
}

export function EventScreen() {
  const { id } = useParams({ from: '/events/$id' });
  const { data: event, isPending, isError } = useEvent(id);

  if (isPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x" />
      </Screen>
    );
  }

  if (isError || !event) {
    return (
      <Screen title="Class not found" back>
        <div className="safe-x">
          <p className="text-body text-ink-soft">
            This class is not on the calendar any more. It may have been cancelled, or the link may be old.
          </p>
          <div className="mt-4">
            <Button href="/" ink="blue">
              Back to the calendar
            </Button>
          </div>
        </div>
      </Screen>
    );
  }

  const start = event.startsAt ? new Date(event.startsAt) : null;
  const locations = event.locations ?? [];

  return (
    <Screen title={event.name} back>
      <div className="safe-x">
        {/* Hero: the class's ink plate, stamped with when it happens. A fixed
            ink rather than a per-class one — real events carry no colour, and
            inventing one from the data would be decoration pretending to be
            information. */}
        <div
          className="plate plate-blue halftone overflow-hidden px-4 pt-7 pb-4"
          style={{ '--ht': 'var(--c-blue)' } as React.CSSProperties}
        >
          <p className="stamp text-[15px]" style={{ color: 'var(--c-paper-2)' }}>
            {start ? formatDayStamp(start) : 'Date to be announced'}
          </p>
          <p className="stamp mt-1 text-[30px] leading-none" style={{ color: 'var(--c-paper-2)' }}>
            {event.startsAt && event.endsAt
              ? formatTimeRange(event.startsAt, event.endsAt)
              : event.startsAt
                ? formatTime(event.startsAt)
                : 'Time to be announced'}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {event.origin === 'listed' ? <SkillChip ink="ink">Listed from another school</SkillChip> : null}
          {event.venueNeeded ? <SkillChip ink="pink">Venue needed</SkillChip> : null}
          {(event.tags ?? []).map((tag) => (
            <SkillChip key={tag} ink="blue">
              {tag}
            </SkillChip>
          ))}
        </div>

        {event.description ? <p className="mt-4 max-w-[62ch] text-body">{event.description}</p> : null}

        <dl className="mt-5 space-y-2">
          <div className="flex gap-3">
            <dt className="w-[72px] shrink-0 text-caption text-ink-faint">Where</dt>
            <dd className="text-body">
              {event.locationRedacted ? (
                <span className="text-ink-soft">
                  {event.neighborhood
                    ? `Somewhere in ${event.neighborhood}. `
                    : "This class's host hasn't shared a neighbourhood yet. "}
                  The exact address shows up here once you RSVP.
                </span>
              ) : locations.length > 0 ? (
                locations.map((location, i) => <div key={i}>{formatAddress(location)}</div>)
              ) : (
                <span className="text-ink-soft">No address yet — check back, or offer one if you have a room.</span>
              )}
            </dd>
          </div>
        </dl>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">Who's coming</h2>
        <div className="plate plate-green p-3.5">
          <p className="text-body">
            {event.rsvps.going} going
            {event.rsvps.interested ? `, ${event.rsvps.interested} interested` : ''}
          </p>
        </div>

        <SessionGate prompt="Sign in to RSVP, invite a friend, or turn on reminders.">
          <EventActions event={event} />
        </SessionGate>
      </div>
    </Screen>
  );
}

function EventActions({ event }: { event: EventDetail }) {
  const { surface, afterRsvp, openInstallSheet } = useInstallFlow();
  const { data: myRsvpData } = useMyRsvp(event.uri);
  const rsvpMutation = useRsvpMutation();
  const clearMutation = useRsvpClearMutation();

  const [alsoPublicRecord, setAlsoPublicRecord] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const [remindersOn, setRemindersOn] = useState(false);
  const [reminderNote, setReminderNote] = useState<string | null>(null);

  // Mirrors the server's truth exactly, including back to `false` when there is
  // no live RSVP any more (clearing an RSVP must force re-acceptance of the
  // permanence warning on the next one — it must never carry the old consent
  // forward).
  useEffect(() => {
    setAlsoPublicRecord(myRsvpData?.rsvp?.alsoPublicRecord ?? false);
  }, [myRsvpData]);

  const currentStatus = myRsvpData?.rsvp?.status ?? null;

  const onConfirmPublic = (next: boolean) => {
    setAlsoPublicRecord(next);
    if (currentStatus === 'going' || currentStatus === 'interested') {
      rsvpMutation.mutate({ eventId: event.uri, status: currentStatus, alsoPublicRecord: next });
    }
  };

  const onTapStatus = (status: 'going' | 'interested') => {
    if (currentStatus === status) {
      clearMutation.mutate(event.uri);
      return;
    }
    rsvpMutation.mutate(
      { eventId: event.uri, status, alsoPublicRecord },
      { onSuccess: () => afterRsvp() }, // the install nudge fires only on a REAL, successful RSVP
    );
  };

  const onInvite = async () => {
    const minted = await api.invites.mint({ eventUri: event.uri }).catch(() => null);
    if (!minted) return;
    if (navigator.share) {
      navigator.share({ title: event.name, url: minted.url }).catch(() => undefined);
    } else {
      navigator.clipboard?.writeText(minted.url).then(
        () => setShared('Invite link copied'),
        () => undefined,
      );
    }
  };

  const onRemindMe = () => {
    if (surface !== 'installed') {
      openInstallSheet();
      return;
    }
    void (async () => {
      setReminderNote(null);
      if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        setReminderNote("This device can't receive push reminders.");
        return;
      }
      // Called directly from the tap handler — WebKit requires the permission
      // prompt to originate synchronously inside a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setReminderNote('No reminders, no problem — you can turn this on later.');
        return;
      }
      const { key } = await api.push.vapidKey().catch(() => ({ key: null }));
      if (!key) {
        setReminderNote('Reminders are not set up on this server yet.');
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return;
      await api.push.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
      setRemindersOn(true);
    })();
  };

  return (
    <div className="mt-8 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Button wide onClick={() => onTapStatus('going')} ink={currentStatus === 'going' ? 'green' : 'pink'}>
          {currentStatus === 'going' ? "You're going" : "I'll be there"}
        </Button>
        <Button
          wide
          variant="quiet"
          onClick={() => onTapStatus('interested')}
          ink={currentStatus === 'interested' ? 'green' : 'blue'}
        >
          {currentStatus === 'interested' ? "You're interested" : 'Interested'}
        </Button>
      </div>

      <div className="plate p-3.5">
        <div className="flex items-center justify-between gap-3">
          <span className="max-w-[34ch] text-caption text-ink-soft">Also publish my RSVP publicly</span>
          <Toggle
            checked={alsoPublicRecord}
            label="Also publish my RSVP publicly"
            onChange={(next) => {
              if (next) setWarningOpen(true);
              else onConfirmPublic(false);
            }}
          />
        </div>
      </div>

      {/* Reminders are visibly gated, never silently broken (R8). */}
      <Button wide variant="quiet" ink="blue" onClick={onRemindMe}>
        {remindersOn
          ? 'Reminders are on'
          : surface === 'installed'
            ? 'Remind me before class'
            : 'Remind me — add to Home Screen first'}
      </Button>
      {reminderNote ? <p className="text-caption text-ink-soft">{reminderNote}</p> : null}

      <div className="grid grid-cols-2 gap-3">
        {/* A real navigation, no download attribute: iOS hands .ics to Calendar. */}
        <Button href={api.events.icsHref(event.uri)} variant="quiet" ink="ink">
          Add to calendar
        </Button>
        <Button onClick={() => void onInvite()} variant="quiet" ink="green">
          Bring a friend
        </Button>
      </div>
      {shared ? <p className="text-caption text-ink-soft">{shared}</p> : null}

      <Sheet open={warningOpen} onClose={() => setWarningOpen(false)} title="Make this RSVP public?">
        <p className="text-body">{PERMANENCE_SENTENCE}</p>
        <div className="mt-5 flex gap-3 pb-1">
          <Button
            ink="pink"
            onClick={() => {
              setWarningOpen(false);
              onConfirmPublic(true);
            }}
          >
            Yes, make it public
          </Button>
          <Button ink="ink" variant="quiet" onClick={() => setWarningOpen(false)}>
            Cancel
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
