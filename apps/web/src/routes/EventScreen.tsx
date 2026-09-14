import { KnowledgeShelf } from '../components/KnowledgeShelf';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useParams } from '@tanstack/react-router';
import { LoadingState, PageState } from '../components/PageState';
import { ClassHero } from '../components/ClassArtwork';
import { Screen } from '../components/Screen';
import { Sheet } from '../components/Sheet';
import { Button, SkillChip, Toggle } from '../components/bits';
import { SessionGate } from '../components/SessionGate';
import { useInstallFlow } from '../components/InstallNudge';
import { api, ApiError } from '../lib/api';
import { formatDayStamp, formatTime, formatTimeRange } from '../lib/dates';
import { useEvent, useMe, useMemberProfile, useMyRsvp, useRsvpClearMutation, useRsvpMutation } from '../lib/queries';
import type { EventDetail, EventLocation, SkillLevelRef } from '../lib/types';

/** Verbatim from the plan's global constraints — do not paraphrase. */
const PERMANENCE_SENTENCE =
  'Anyone will be able to see, permanently, that you planned to be at this place at this time.';

/**
 * Machine tags written by calendar routing/exchange rather than by the host —
 * never member-facing (UX audit finding 4). The school's actual routing-tag
 * set isn't exposed to this client yet, so these three are named by hand:
 * `skillshare`/`free-school` come from the school's own routing, `demo` from
 * seed data. Any other tag is assumed host-written and still renders.
 */
const ROUTING_TAGS = new Set(['skillshare', 'free-school', 'demo']);

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
  const { data: event, isPending, isError, error, refetch } = useEvent(id);

  if (isPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x"><LoadingState label="Finding this class…" /></div>
      </Screen>
    );
  }

  if (isError && !(error instanceof ApiError && error.status === 404)) {
    return <Screen title="Couldn’t load this class" back><div className="safe-x"><PageState title="Let’s try that again." error action={<Button onClick={() => void refetch()}>Try again</Button>}>Please check your connection and try again.</PageState></div></Screen>;
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
  const endsAt = event.endsAt ? new Date(event.endsAt) : start;
  const isPast = Boolean(endsAt && endsAt.getTime() < Date.now());

  const cancelled = event.status?.endsWith('#cancelled');
  // The host's own meeting link first, then any legacy `uris` from a class published
  // before task 19c. `javascript:` and friends never render.
  const meetingLinks = [
    ...(event.meetingLink ? [{ uri: event.meetingLink, name: 'Join the class' }] : []),
    ...(event.uris ?? []).filter(link => link.uri !== event.meetingLink),
  ].filter(link => { try { return ['http:','https:'].includes(new URL(link.uri).protocol); } catch { return false; } });
  return (
    <Screen title={event.name} layout="detail" back>
      <div className="safe-x">
        {cancelled ? <p className="event-notice" role="status">This class has been cancelled. Check the calendar for other ways to learn together.</p> : null}
        <a href="#class-details" className="event-jump context-link">Time, place &amp; RSVP ↓</a>
        <ClassHero cover={event.cover} name={event.name} />
        <div className="event-layout">
          <div className="event-story">
            <div className="flex flex-wrap items-center gap-2 mb-5">
              {event.origin === 'listed' ? <SkillChip ink="ink">Listed from another school</SkillChip> : null}
              {event.venueNeeded ? <SkillChip ink="pink">Venue needed</SkillChip> : null}
              {(event.tags ?? []).filter(tag => !ROUTING_TAGS.has(tag)).map(tag => <SkillChip key={tag} ink="blue">{tag}</SkillChip>)}
            </div>
            <section className="event-section"><h2>About this class</h2>
              <p className="event-description">{event.publicOverview?.description || 'The host hasn’t added a public overview yet.'}</p>
            </section>
            {event.publicOverview?.audience ? <section className="event-section"><h2>Who it’s for</h2><p className="event-description">{event.publicOverview.audience}</p></section> : null}
            {event.publicOverview?.accessibility ? <section className="event-section"><h2>Access &amp; comfort</h2><p className="event-description">{event.publicOverview.accessibility}</p></section> : null}
            {/* Task 19c: `attendeeNotes` is app-side and the API only sends it to a
                viewer who also gets the address — the host, a steward, or someone who
                has RSVP'd. `locationRedacted` mirrors that same gate. */}
            {event.attendeeNotes && !event.locationRedacted ? <section className="event-section"><h2>For attendees</h2><p className="event-description">{event.attendeeNotes}</p></section> : null}
            {event.skills.length ? <section className="event-section"><h2>What you’ll learn</h2><div className="class-skill-list">{event.skills.map((skill,i)=><ClassSkill key={`${skill.skill}-${i}`} skill={skill}/>)}</div></section> : null}
            {event.materials.length > 0 || event.suppliesNote ? <section className="event-section"><h2>What to bring</h2>
              {event.materials.length ? <ul className="list-disc space-y-2 pl-5 text-body">{event.materials.map((m,i) => <li key={`${m}-${i}`}>{m}</li>)}</ul> : null}
              {event.suppliesNote ? <p className="mt-3 text-body text-ink-soft">{event.suppliesNote}</p> : null}
            </section> : null}
            <KnowledgeShelf event={event.uri} allowContribute={event.viewerRelation === 'host' && event.listed}/>{event.viewerRelation === 'host' && event.listed ? <a href={`/knowledge/new?${new URLSearchParams({event:event.uri, ...(event.skills[0] ? {skill:event.skills[0].skill} : {})})}`} className="context-link">Add class notes or a resource ↗</a> : null}
            {event.viewerRelation === 'attendee' && isPast ? <div className="event-section"><h2>How did it go?</h2><p className="mb-4 text-body text-ink-soft">A few anonymous words help the host teach it better next time.</p><Link to="/events/$id/feedback" params={{id:event.uri}} className="primary-action">Leave feedback</Link></div> : null}
            {event.viewerRelation === 'host' ? <section className="event-host-tools"><h2>Your class, your tools</h2><div className="grid grid-cols-2 gap-3">
              <Link to="/events/$id/edit" params={{id:event.uri}} className="fs-button fs-button-quiet">Edit this class</Link>
              <Link to="/events/$id/attendance" params={{id:event.uri}} className="fs-button fs-button-quiet">Check off attendance</Link>
              <Link to="/events/$id/feedback-summary" params={{id:event.uri}} className="fs-button fs-button-quiet col-span-2">See feedback summary</Link>
            </div></section> : null}
          </div>
          <aside id="class-details" className="event-rail" aria-label="Class details and RSVP">
            <p className="event-cost">Always free <span>·</span> {event.mode?.endsWith('#virtual') ? 'Online' : event.mode?.endsWith('#hybrid') ? 'In person + online' : 'In person'}</p>
            <div className="event-date"><p>{start ? formatDayStamp(start) : 'Date to be announced'}</p><p>{event.startsAt && event.endsAt ? formatTimeRange(event.startsAt,event.endsAt) : event.startsAt ? formatTime(event.startsAt) : 'Time to be announced'}</p></div>
            <dl className="event-location"><dt>Where</dt><dd>{event.mode?.endsWith('#virtual') ? <span>{event.locationRedacted ? 'Online. RSVP to see the meeting link.' : 'Online. Use the meeting link below; if none is listed, check back for details.'}</span> : event.venueNeeded ? <span>We’re looking for a space{event.neighborhood ? ` in ${event.neighborhood}` : ''}. No address yet — check back, or offer one if you have a room.</span> : event.locationRedacted ? <span>{event.neighborhood ? `Somewhere in ${event.neighborhood}. ` : "This class's host hasn't shared a neighbourhood yet. "}The exact address shows up here once you RSVP.</span> : locations.length ? locations.map((location,i) => <div key={i}>{formatAddress(location)}</div>) : <span>No address yet — check back, or offer one if you have a room.</span>}</dd></dl>
            {/* The host's meeting link is app-side now (`meetingLink`); `uris` only ever
                still carries one on a class published before task 19c, and the API
                gates both the same way. */}
            {!event.locationRedacted && meetingLinks.length ? <div className="class-meeting-links">{meetingLinks.map((link,i)=><a key={`${link.uri}-${i}`} href={link.uri} target="_blank" rel="noopener noreferrer" className="context-link">{link.name || 'Class link'} ↗</a>)}</div> : null}
            {event.hostDid ? <HostLine did={event.hostDid} /> : null}
            <h2 className="mt-6 text-body font-bold">Who's coming</h2><p className="mt-2 text-body text-ink-soft">{event.rsvps.going} going{event.rsvps.interested ? `, ${event.rsvps.interested} interested` : ''}</p>
            <div className="mt-5"><SessionGate prompt="Sign in to RSVP, invite a friend, or turn on reminders."><EventActions event={event} /></SessionGate></div>
          </aside>
        </div>
      </div>
    </Screen>
  );
}

/**
 * Who is teaching this class, and the way through to them.
 *
 * A class page that never names its host is a dead end: the one question every
 * learner asks before they RSVP ("who is this person, and what else do they
 * share?") had no answer here, and the member profile — vouches, other classes,
 * notes — was reachable only through the People tab.
 *
 * `hostDid` is on the event for any LISTED class, to any viewer
 * (`publicRecordFields` in `apps/appview/src/http/visibility.ts`: the record
 * lives in the host's own repo and the DID is inside its AT-URI). The NAME is
 * not public, though — the directory is members-only (R9) — so this renders for
 * a signed-in member and stays silent otherwise, exactly like the roster does.
 * A member who has hidden themselves 404s from `GET /api/members/:did`, and
 * that too renders as nothing rather than as a broken link.
 */
function HostLine({ did }: { did: string }) {
  const { data: me } = useMe();
  const { data: host } = useMemberProfile(me ? did : undefined);
  if (!host) return null;
  const name = host.displayName || host.handle || 'A member';
  return (
    <>
      <h2 className="mt-6 text-body font-bold">Who's teaching</h2>
      <p className="mt-2 text-body">
        <Link to="/people/$did" params={{ did }}>
          {name}
        </Link>
      </p>
    </>
  );
}

function ClassSkill({skill}:{skill:SkillLevelRef}) {
  const query=useQuery({queryKey:['skill',skill.skill],queryFn:()=>api.skills.get(skill.skill),enabled:Boolean(api.skills)});
  const levels={1:'Introductory · no experience assumed',2:'Intermediate · some familiarity helpful',3:'Advanced · for practiced learners'};
  return <div className="class-skill"><Link to="/skills/$skillId" params={{skillId:skill.skill}}>{query.data?.label??'Explore this skill'} ↗</Link><p>{levels[skill.level]}</p>{skill.prerequisites?<p className="class-prerequisites">Before you come: {skill.prerequisites}</p>:null}</div>;
}

function EventActions({ event }: { event: EventDetail }) {
  const { surface, afterRsvp, openInstallSheet } = useInstallFlow();
  const { data: myRsvpData } = useMyRsvp(event.uri);
  const rsvpMutation = useRsvpMutation();
  const clearMutation = useRsvpClearMutation();

  const [alsoPublicRecord, setAlsoPublicRecord] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
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
    setActionError(null);
    setAlsoPublicRecord(next);
    if (currentStatus === 'going' || currentStatus === 'interested') {
      rsvpMutation.mutate({ eventId: event.uri, status: currentStatus, alsoPublicRecord: next }, { onError: () => { setAlsoPublicRecord(myRsvpData?.rsvp?.alsoPublicRecord ?? false); setActionError('Could not update your RSVP visibility. Try again.'); } });
    }
  };

  const onTapStatus = (status: 'going' | 'interested') => {
    setActionError(null);
    // Tapping "I'll be there" again while already waitlisted leaves the
    // waitlist — `currentStatus` is 'waitlisted', not 'going', but it is
    // still the same request the button represents.
    if (currentStatus === status || (status === 'going' && currentStatus === 'waitlisted')) {
      clearMutation.mutate(event.uri, { onError: () => setActionError('Could not withdraw your RSVP. Try again.') });
      return;
    }
    rsvpMutation.mutate(
      { eventId: event.uri, status, alsoPublicRecord },
      { onSuccess: () => afterRsvp(), onError: () => setActionError('Could not save your RSVP. Check your connection and try again.') }, // the install nudge fires only on a REAL, successful RSVP
    );
  };

  const onInvite = async () => {
    setActionError(null);
    try {
      const minted = await api.invites.mint({ eventUri: event.uri });
      setInviteUrl(minted.url);
      if (navigator.share) await navigator.share({ title: event.name, url: minted.url });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(minted.url); setShared('Invite link copied'); }
    } catch (err) {
      if (!(err instanceof Error && err.name === 'AbortError')) setActionError('Could not share the invite. You can copy the link below if it was created.');
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
    })().catch(() => setReminderNote('Could not turn on reminders. Check your device settings and try again.'));
  };

  return (
    <div className="event-actions space-y-3">
      {actionError ? <p role="alert">{actionError}</p> : null}
      <div className="grid grid-cols-2 gap-3">
        <Button
          wide
          onClick={() => onTapStatus('going')}
          disabled={rsvpMutation.isPending || clearMutation.isPending || Boolean(event.status?.endsWith('#cancelled'))}
          ink={currentStatus === 'going' ? 'green' : currentStatus === 'waitlisted' ? 'amber' : 'pink'}
        >
          {currentStatus === 'going'
            ? "You're going"
            : currentStatus === 'waitlisted'
              ? "You're on the waitlist"
              : "I'll be there"}
        </Button>
        <Button
          wide
          variant="quiet"
          onClick={() => onTapStatus('interested')}
          disabled={rsvpMutation.isPending || clearMutation.isPending || Boolean(event.status?.endsWith('#cancelled'))}
          ink={currentStatus === 'interested' ? 'green' : 'blue'}
        >
          {currentStatus === 'interested' ? "You're interested" : 'Interested'}
        </Button>
      </div>
      {currentStatus === 'waitlisted' && myRsvpData?.rsvp?.waitlistPosition ? (
        <p className="text-caption text-ink-soft">
          You're #{myRsvpData.rsvp.waitlistPosition} on the waitlist — you'll be notified if a spot opens.
        </p>
      ) : null}

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
      {shared ? <p role="status" className="text-caption text-ink-soft">{shared}</p> : null}
      {inviteUrl ? <label className="block text-caption text-ink-soft">Invite link<input readOnly value={inviteUrl} className="mt-2 w-full px-3 py-2" onFocus={e => e.currentTarget.select()} /></label> : null}

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
