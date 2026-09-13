import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { dayKey, formatDayStamp, groupByDay } from '../lib/dates';
import { Screen } from '../components/Screen';
import { ContentGrid } from '../components/ContentGrid';
import { SchoolMark } from '../components/SchoolMark';
import { useCalendar } from '../lib/queries';
import { api } from '../lib/api';
import { CalendarViews } from '../components/CalendarViews';
import { addDays, calendarRange, type CalendarView } from '../lib/calendar-range';

export function CalendarScreen() {
  const [month, setMonth] = useState(() => { const date = new URLSearchParams(window.location.search).get('date'); const parsed = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`) : new Date(); return Number.isNaN(parsed.getTime()) ? new Date() : parsed; });
  const [view, setView] = useState<CalendarView>(() => { const selected = new URLSearchParams(window.location.search).get('view'); return ['list','month','week','day'].includes(selected??'') ? selected as CalendarView : 'list'; });
  const [search, setSearch] = useState('');
  useEffect(()=>{const query=new URLSearchParams(window.location.search);query.set('view',view);query.set('date',dayKey(month));window.history.replaceState(window.history.state,'',`${window.location.pathname}?${query}`);},[view,month]);
  const [showPast, setShowPast] = useState(false);
  const range = useMemo(() => { const r = calendarRange(month, view); return { from: r.from.toISOString(), to: r.to.toISOString() }; }, [month, view]);
  const { data, isPending, isError, refetch } = useCalendar(range);
  const { data: info } = useQuery({ queryKey: ['school-info'], queryFn: () => api.school.howItWorks(), enabled: Boolean(api.school), staleTime: 300_000 });
  const school = info?.school;
  const today = dayKey(new Date());
  const events = useMemo(() => (data?.events ?? []).filter(event => {
    const matches = `${event.name} ${event.neighborhood ?? ''} ${(event.tags ?? []).join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim());
    const past = event.endsAt ?? event.startsAt;
    return matches && (view !== 'list' || showPast || !past || Date.parse(past) >= Date.now());
  }), [data, search, showPast, view]);
  const groups = useMemo(() => groupByDay(events, event => event.startsAt ?? ''), [events]);
  const dayRefs = useRef(new Map<string, HTMLElement>());
  const monthLabel = view === 'day' ? month.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : view === 'week' ? `${new Date(range.from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(new Date(range.to), -1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}` : month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  function moveMonth(amount: number) { setMonth(current => view === 'day' ? addDays(current, amount) : view === 'week' ? addDays(current, amount * 7) : new Date(current.getFullYear(), current.getMonth() + amount, 1)); }
  function jump(key: string) { dayRefs.current.get(key)?.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); }
  return <Screen title={school?.name ?? 'Free School'} wide trailing={<Link to="/zine" className="header-print">Print zine</Link>} intro={
    <div className="calendar-intro">
      <div><p className="local-line"><span className="status-dot" />{school?.region || 'Your local learning commons'}</p>
        <h1>Everybody has<br />something to share.</h1>
        <p>A school without walls. Learn a skill, share what you know,<br className="desktop-break" /> and find your people. Always free. Open to everyone.</p>
        <div className="intro-actions"><Link to="/events/new" className="primary-action"><span aria-hidden="true">＋</span> Post a class</Link><Link to="/requests" className="text-action">Ask to learn something <span aria-hidden="true">↗</span></Link></div>
      </div>
      <div className="commons-drawing"><SchoolMark /><span>Built by all of us.</span></div>
    </div>
  }>
    <div className="calendar-toolbar">
      <div className="month-control"><h2>{monthLabel}</h2><div><button type="button" aria-label={`Previous ${view === 'list' ? 'month' : view}`} onClick={() => moveMonth(-1)}>‹</button><button type="button" aria-label={`Next ${view === 'list' ? 'month' : view}`} onClick={() => moveMonth(1)}>›</button></div><button className="today-button" type="button" onClick={() => setMonth(new Date())}>Today</button></div>
      <label className="calendar-search"><svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.5" stroke="currentColor"/><path d="m12 12 5 5" stroke="currentColor"/></svg><input type="search" placeholder="Find a class, skill or neighborhood" aria-label="Search classes" value={search} onChange={e => setSearch(e.target.value)} /></label>
    </div>
    <div className="calendar-view-controls"><div className="view-switch" role="group" aria-label="Calendar view">{(['list','month','week','day'] as CalendarView[]).map(option => <button key={option} aria-pressed={view === option} onClick={() => setView(option)}>{option[0]!.toUpperCase()+option.slice(1)}</button>)}</div><p>{view === 'week' ? 'A week of possibilities. Select a date to explore its classes.' : view === 'month' ? 'The month at a glance. Select a date for the full lineup.' : 'Find something worth showing up for.'}</p></div>
    <div className={`calendar-layout ${view !== 'list' ? 'calendar-layout-board' : ''}`}>
      {view !== 'list' ? <div className="calendar-view-panel">{isPending ? <p role="status">Finding classes…</p> : isError ? <div className="empty-board" role="alert"><p>The calendar couldn’t load.</p><button onClick={() => void refetch()}>Try again</button></div> : <CalendarViews view={view} date={month} events={events} onDay={day => {setMonth(day);setView('day');}} />}</div> : null}
      <aside className="calendar-sidebar" hidden={view !== 'list'}>
        <div className="sidebar-heading"><span className="status-dot" />On the calendar</div>
        <label className="past-toggle"><input type="checkbox" checked={showPast} onChange={e => setShowPast(e.target.checked)} /> Include past classes</label>
        <div className="day-index">{groups.map(group => <button key={group.key} onClick={() => jump(group.key)}><span>{group.key === today ? 'Today' : group.date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}</span><span>{group.items.length}</span></button>)}</div>
        <div className="commons-note"><SchoolMark /><h3>Made of people,<br />not institutions.</h3><p>No fees. No credentials needed. Just a little curiosity and something to share.</p><Link to="/how-it-works">How this school works <span aria-hidden="true">↗</span></Link></div>
        <Link to="/skills" className="sidebar-link">Explore the skill library <span aria-hidden="true">↗</span></Link>
      </aside>
      <div className="calendar-list" hidden={view !== 'list'} aria-live="polite" aria-busy={isPending}>
        {data?.truncated ? <p role="status" className="mb-4 text-caption text-ink-soft">This busy month reached the calendar’s display limit. Some later classes may be missing.</p> : null}
        {isPending ? <div className="calendar-loading"><SchoolMark /><p>Finding what’s happening…</p></div> : null}
        {isError ? <div className="empty-board" role="alert"><h2>The calendar couldn’t load.</h2><p>Check your connection and try again.</p><button className="primary-action" onClick={() => void refetch()}>Try again</button></div> : null}
        {!isPending && !isError && !groups.length ? <div className="empty-board"><SchoolMark /><h2>{search ? 'No classes match your search.' : 'Room for something new.'}</h2><p>{search ? 'Try a different skill or neighborhood.' : 'Nothing on the calendar yet. Bring a little of what you know, or ask for something you’d love to learn.'}</p><Link to="/requests" className="text-action">Post what you'd like to learn.</Link></div> : null}
        {groups.map(group => <section className="calendar-day" key={group.key} ref={node => { if (node) dayRefs.current.set(group.key, node); else dayRefs.current.delete(group.key); }}>
          <div className="calendar-day-heading"><h2>{formatDayStamp(group.date)}</h2><span>{group.items.length} {group.items.length === 1 ? 'class' : 'classes'}</span></div>
          <ContentGrid events={group.items} />
        </section>)}
        <footer className="calendar-footer"><span>Everybody’s a teacher. Everybody’s a student.</span><Link to="/zine">Take the calendar offline. Print a zine ↗</Link></footer>
      </div>
    </div>
  </Screen>;
}
