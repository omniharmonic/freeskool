import { Link } from '@tanstack/react-router';
import type { FreeSchoolEvent } from '../lib/mock';
import { formatTimeRange } from '../lib/dates';
import { LevelDots, SkillChip } from './bits';

/** Readable type colour for a given ink block. */
export function onInk(ink: FreeSchoolEvent['ink']): string {
  return ink === 'pink' || ink === 'amber' ? 'var(--c-on-pink)' : 'var(--c-paper-2)';
}

export function eventId(uri: string): string {
  return uri.split('/').pop() ?? uri;
}

export function EventCard({ event }: { event: FreeSchoolEvent }) {
  const spots = event.capacity ? event.capacity - event.rsvpCount : null;

  return (
    <Link
      to="/event/$eventId"
      params={{ eventId: eventId(event.uri) }}
      className={`plate plate-press plate-${event.ink} block overflow-hidden`}
    >
      {/* Hero: a screened ink block with the time stamped into it. */}
      <div
        className="halftone flex items-end justify-between px-3.5 pt-6 pb-2"
        style={{ '--ht': `var(--c-${event.ink})` } as React.CSSProperties}
      >
        {/* Pink and amber print light: they take dark type, blue and green take paper. */}
        <span className="stamp text-[22px] leading-none" style={{ color: onInk(event.ink) }}>
          {formatTimeRange(event.startsAt, event.endsAt)}
        </span>
        <LevelDots level={event.level} inkColor={onInk(event.ink)} />
      </div>

      <div className="px-3.5 pt-3 pb-3.5">
        <h3 className="text-lede leading-snug">{event.name}</h3>
        <p className="mt-1 text-caption text-ink-soft">{event.locations[0]?.name}</p>

        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <SkillChip>{event.skill.label}</SkillChip>
          <span className="text-caption text-ink-faint">
            {event.host.displayName}, vouched for by {event.host.attestations}
          </span>
        </div>

        <hr className="rule my-3" />

        <p className="text-caption text-ink-soft">
          {event.rsvpCount} going
          {spots !== null ? (spots > 0 ? `, ${spots} spots left` : ', full — waitlist open') : ''}
        </p>
      </div>
    </Link>
  );
}

/** The host, with counts of what people actually did. Never a score. */
export function HostCard({ event }: { event: FreeSchoolEvent }) {
  const initials = event.host.displayName
    .split(' ')
    .map((part) => part[0])
    .join('');

  return (
    <div className="plate plate-blue flex items-center gap-3 p-3">
      <div
        className="halftone halftone-dense grid h-11 w-11 shrink-0 place-items-center"
        style={{ '--ht': 'var(--c-blue)' } as React.CSSProperties}
      >
        <span className="stamp text-[15px]" style={{ color: 'var(--c-paper-2)' }}>
          {initials}
        </span>
      </div>
      <div className="min-w-0">
        <p className="display text-[16px] font-bold">{event.host.displayName}</p>
        <p className="text-caption text-ink-soft">
          {event.host.attestations} people have vouched for this skill, and {event.host.hostedCount} classes taught
        </p>
      </div>
    </div>
  );
}
