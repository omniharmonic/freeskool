import { Link } from '@tanstack/react-router';
import type { CalendarEvent } from '../lib/types';
import { formatTime, formatTimeRange } from '../lib/dates';
import { ClassArtwork } from './ClassArtwork';

export function ContentCard({ event }: { event: CalendarEvent }) {
  const time = event.startsAt ? event.endsAt ? formatTimeRange(event.startsAt, event.endsAt) : formatTime(event.startsAt) : 'Time to be arranged';
  const cancelled = event.status?.endsWith('#cancelled');
  return <Link to="/events/$id" params={{ id: event.uri }} className="content-card">
    <ClassArtwork cover={event.cover} name={event.name} />
    <div className="card-copy">
      <span className="card-kind">{cancelled ? 'Cancelled' : event.venueNeeded ? 'Looking for a space' : 'Free class'}</span>
      <p className="card-time">{time}</p>
      <h3>{event.name}</h3>
      <p className="card-place"><svg width="14" height="16" viewBox="0 0 16 18" fill="none" aria-hidden="true"><path d="M14 7c0 4-6 9-6 9S2 11 2 7a6 6 0 1 1 12 0Z" stroke="currentColor"/><circle cx="8" cy="7" r="2" stroke="currentColor"/></svg>{event.neighborhood || (event.venueNeeded ? 'Venue needed' : 'Location shared after you RSVP')}</p>
      {event.tags?.length ? <div className="card-tags">{event.tags.slice(0, 3).map(tag => <span key={tag}>{tag.replaceAll('-', ' ')}</span>)}</div> : null}
      {event.origin === 'listed' ? <p className="card-origin">Listed from another school</p> : null}
    </div>
  </Link>;
}
