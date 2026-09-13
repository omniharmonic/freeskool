import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { events, LEVEL_LABEL, USE_MOCK } from '../lib/mock';
import { formatDayStamp, formatTimeRange } from '../lib/dates';
import { Screen } from '../components/Screen';
import { HostCard, eventId, onInk } from '../components/EventCard';
import { Button, LevelDots, SkillChip } from '../components/bits';
import { useInstallFlow } from '../components/InstallNudge';
import { api } from '../lib/api';

// Not wired to `useEvent` yet (Task 4) — real data defaults to empty rather
// than showing the mock shell once USE_MOCK is off.
const pool = USE_MOCK ? events : [];

export function EventScreen() {
  const { eventId: id } = useParams({ from: '/event/$eventId' });
  const event = pool.find((candidate) => eventId(candidate.uri) === id);
  const [going, setGoing] = useState(false);
  const [shared, setShared] = useState<string | null>(null);
  const [showSupplies, setShowSupplies] = useState(false);
  const { afterRsvp, openInstallSheet, turnOnReminders, remindersOn, surface } = useInstallFlow();

  if (!event) {
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

  const onRsvp = async () => {
    const next = !going;
    setGoing(next);
    await api.rsvp.set(event.uri, { status: next ? 'going' : 'notgoing' }).catch(() => undefined);
    if (next) afterRsvp(); // the nudge asks after value, never on arrival
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

  const onShare = () => {
    // The payload is built BEFORE the call: no await may come between the tap
    // and navigator.share(), or WebKit rejects with NotAllowedError.
    const payload: ShareData = {
      title: event.name,
      text: `${event.name} — free class in ${event.locations[0]?.locality ?? 'Boulder'}`,
      url: location.href,
    };
    if (navigator.share) {
      navigator.share(payload).catch(() => undefined);
    } else {
      navigator.clipboard?.writeText(location.href).then(
        () => setShared('Link copied'),
        () => setShared('Copy the link from the address bar'),
      );
    }
  };

  const canRemind = surface === 'installed';
  const start = new Date(event.startsAt);

  return (
    <Screen title={event.name} back>
      <div className="safe-x">
        {/* Hero: the class's ink plate, stamped with when it happens. */}
        <div
          className={`plate plate-${event.ink} halftone overflow-hidden px-4 pt-7 pb-4`}
          style={{ '--ht': `var(--c-${event.ink})` } as React.CSSProperties}
        >
          <p className="stamp text-[15px]" style={{ color: onInk(event.ink) }}>
            {formatDayStamp(start, new Date(2026, 8, 17))}
          </p>
          <p className="stamp mt-1 text-[30px] leading-none" style={{ color: onInk(event.ink) }}>
            {formatTimeRange(event.startsAt, event.endsAt)}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5">
          <Link to="/skills/$skillId" params={{ skillId: event.skill.id }}>
            <SkillChip ink="pink">{event.skill.label}</SkillChip>
          </Link>
          <span className="flex items-center gap-1.5 text-caption text-ink-soft">
            <LevelDots level={event.level} />
            {LEVEL_LABEL[event.level]}
          </span>
        </div>

        <p className="mt-4 max-w-[62ch] text-body">{event.description}</p>

        <dl className="mt-5 space-y-2">
          {event.locations.map((location) => (
            <div key={location.name} className="flex gap-3">
              <dt className="w-[72px] shrink-0 text-caption text-ink-faint">Where</dt>
              <dd className="text-body">
                {location.name}, {location.locality}
              </dd>
            </div>
          ))}
          <div className="flex gap-3">
            <dt className="w-[72px] shrink-0 text-caption text-ink-faint">Going</dt>
            <dd className="text-body">
              {event.rsvpCount + (going ? 1 : 0)} people
              {event.capacity ? ` of ${event.capacity} places` : ''}
            </dd>
          </div>
        </dl>

        <h2 className="mt-7 mb-2.5 text-lede font-bold">Who's teaching</h2>
        <HostCard event={event} />

        {event.materials.length > 0 ? (
          <>
            <h2 className="mt-7 mb-2.5 text-lede font-bold">Bring with you</h2>
            <ul className="space-y-1.5">
              {event.materials.map((item) => (
                <li key={item} className="flex gap-2.5 text-body">
                  <span aria-hidden="true" className="mt-[9px] h-[6px] w-[6px] shrink-0 bg-ink" />
                  {item}
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {/* Supplies donation note: hidden unless a steward turned it on. */}
        {event.suppliesNote ? (
          <div className="mt-6">
            <button
              type="button"
              onClick={() => setShowSupplies((v) => !v)}
              className="text-caption font-medium text-blue underline decoration-dotted underline-offset-4"
              aria-expanded={showSupplies}
            >
              About supplies for this class
            </button>
            {showSupplies ? (
              <p className="mt-2 max-w-[56ch] border-l-[3px] border-amber pl-3 text-caption text-ink-soft">
                {event.suppliesNote}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-8 space-y-3">
          <Button wide onClick={onRsvp} ink={going ? 'green' : 'pink'}>
            {going ? "You're going — tap to cancel" : "I'll be there"}
          </Button>

          {/* Reminders are visibly gated, never silently broken (R8). */}
          <Button
            wide
            variant="quiet"
            ink="blue"
            onClick={canRemind ? () => void turnOnReminders() : openInstallSheet}
          >
            {remindersOn ? 'Reminders are on' : canRemind ? 'Remind me before class' : 'Remind me — add to Home Screen first'}
          </Button>

          <div className="grid grid-cols-2 gap-3">
            {/* A real navigation, no download attribute: iOS hands .ics to Calendar. */}
            <Button href={api.events.icsHref(event.uri)} variant="quiet" ink="ink">
              Add to calendar
            </Button>
            <Button onClick={onShare} variant="quiet" ink="ink">
              Share
            </Button>
          </div>

          <Button onClick={() => void onInvite()} variant="quiet" ink="green" wide>
            Bring a friend
          </Button>
          {shared ? <p className="text-caption text-ink-soft">{shared}</p> : null}
        </div>
      </div>
    </Screen>
  );
}
