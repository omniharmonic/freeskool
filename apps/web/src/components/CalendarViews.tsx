import { Link } from '@tanstack/react-router';
import { calendarDays, type CalendarView } from '../lib/calendar-range';
import { dayKey, formatTime, formatDayStamp } from '../lib/dates';
import type { CalendarEvent } from '../lib/types';
import { ContentGrid } from './ContentGrid';

export function CalendarViews({ view, date, events, onDay }: { view: CalendarView; date: Date; events: CalendarEvent[]; onDay: (date: Date) => void }) {
  const days = calendarDays(date, view);
  const forDay = (day: Date) => events.filter(e => e.startsAt && dayKey(e.startsAt) === dayKey(day)).sort((a,b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!));
  if (view === 'day') return <section className="calendar-single-day"><h2>{formatDayStamp(date)}</h2>{forDay(date).length ? <ContentGrid events={forDay(date)} /> : <div className="empty-board"><h3>A little room in the day.</h3><p>No matching classes on this date.</p><Link to="/events/new" className="text-action">Offer something you know ↗</Link></div>}</section>;
  return <div className={`calendar-board calendar-board-${view}`} tabIndex={0} aria-label={`${view === 'month' ? 'Month' : 'Week'} calendar`}>
    {view === 'month' ? <div className="calendar-weekdays" aria-hidden="true">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=><span key={d}>{d}</span>)}</div> : null}
    <div className={view === 'month' ? 'month-grid' : 'week-grid'}>{days.map(day=>{
      const entries = forDay(day);
      const today = dayKey(day) === dayKey(new Date());
      return <section key={dayKey(day)} className={`calendar-cell ${day.getMonth() !== date.getMonth() ? 'outside-month' : ''} ${today ? 'is-today' : ''}`}>
        <button className="calendar-cell-day" onClick={()=>onDay(day)} aria-label={`View ${day.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric',year:'numeric'})}`} aria-current={today ? 'date' : undefined}>
          {view === 'week' ? <span>{day.toLocaleDateString(undefined,{weekday:'short'})}</span> : null}<strong>{day.getDate()}</strong>
        </button>
        {view === 'month' && entries.length ? <button className="month-day-summary" aria-label={`${entries.length} ${entries.length===1?'class':'classes'} on ${day.toLocaleDateString(undefined,{month:'long',day:'numeric'})}`} onClick={()=>onDay(day)}><span aria-hidden="true">●</span> {entries.length}</button> : null}
        <div className="calendar-cell-events">{(view === 'month' ? entries.slice(0,3) : entries).map(event=><Link to="/events/$id" params={{id:event.uri}} key={event.uri} className={`calendar-mini-event ${event.status?.endsWith('#cancelled') ? 'is-cancelled' : ''}`}>
          {view === 'week' && event.cover ? <img src={event.cover.url} alt="" loading="lazy" /> : null}
          <time>{event.startsAt ? formatTime(event.startsAt) : 'Time TBA'}</time><span>{event.name}</span>
          {view === 'week' && event.neighborhood ? <small>{event.neighborhood}</small> : null}
          {event.status?.endsWith('#cancelled') ? <small>Cancelled</small> : null}
        </Link>)}
        {view === 'month' && entries.length > 3 ? <button className="calendar-more" onClick={()=>onDay(day)}>+{entries.length-3} more</button> : null}
        {view === 'week' && !entries.length ? <p className="calendar-day-empty">Open for possibilities</p> : null}</div>
      </section>;
    })}</div>
  </div>;
}
