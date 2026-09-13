import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ZineMonthResponse } from '../lib/types';
import { formatTime, formatTimeRange } from '../lib/dates';
import { paginateBlocks } from '../lib/paginate';

export function ZinePages({ data, trim }: { data: ZineMonthResponse; trim: 'letter' | 'a4' }) {
  const measure = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => data.days.flatMap(day => day.events.map(event => ({date:day.date,event}))), [data]);
  const [pages, setPages] = useState<number[][][]>([[[], []]]);
  const label = new Date(`${data.month}-15T12:00:00`).toLocaleDateString(undefined,{month:'long',year:'numeric'});
  const height = trim === 'a4' ? 1016 : 960;
  function header(first: boolean) { return <header className={`zine-masthead ${first ? 'zine-masthead-first' : ''}`}><p className="stamp">{label} · Always free. Open to everyone.</p>{first ? <><h1>FREE SCHOOL</h1><p>{data.school.name}{data.school.region ? ` · ${data.school.region}` : ''}</p><p>A little knowledge. A lot to share. Find your next class below.</p></> : <h2>{data.school.name} <span>· continued</span></h2>}</header>; }
  function footer(page:number,total:number) { return <footer className="zine-page-footer"><div><strong>Everybody’s a teacher. Everybody’s a student.</strong><p>{data.howToPost}</p><p>RSVP online for exact locations and the latest updates.</p></div><span>{page} / {total}</span></footer>; }
  function block(index: number) {
    const item = blocks[index]!;
    const day = new Date(`${item.date}T12:00:00`);
    return <section className="zine-entry" key={item.event.uri}>
      <h3>{day.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'})} <span>· {item.event.startsAt ? item.event.endsAt ? formatTimeRange(item.event.startsAt,item.event.endsAt) : formatTime(item.event.startsAt) : 'Time TBD'}</span></h3>
      <p className="zine-entry-title">{item.event.name}</p>
      <p>{item.event.status?.endsWith('#cancelled') ? 'Cancelled · ' : ''}{item.event.venueNeeded ? 'Venue needed — got a room?' : item.event.neighborhood ?? 'Location: ask a steward'}</p>
      {item.event.tags?.length ? <p className="zine-entry-tags">{item.event.tags.join(' · ')}</p> : null}
    </section>;
  }
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    let active = true;
    const calculate = () => {
      if (!active) return;
      const heights = Array.from(node.querySelectorAll('.zine-entry')).map(el => el.getBoundingClientRect().height || 110);
      const firstHeader = node.querySelector('.zine-masthead-first')?.getBoundingClientRect().height || 160;
      const nextHeader = node.querySelector('.zine-masthead:not(.zine-masthead-first)')?.getBoundingClientRect().height || 60;
      const footerHeight = node.querySelector('.zine-page-footer')?.getBoundingClientRect().height || 60;
      // Measured footer plus padding, borders, two gaps and a small print rounding margin.
      const reserved = footerHeight + 90;
      const packed = paginateBlocks(heights, height - firstHeader - reserved, height - nextHeader - reserved);
      setPages(previous => JSON.stringify(previous) === JSON.stringify(packed) ? previous : packed);
    };
    calculate();
    void document.fonts?.ready.then(calculate);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(calculate) : null;
    observer?.observe(node);
    return () => { active = false; observer?.disconnect(); };
  }, [blocks, height, trim]);
  return <>
    <p className="zine-page-count no-print" role="status">{pages.length} {pages.length === 1 ? 'page' : 'pages'} · {blocks.length} {blocks.length === 1 ? 'class' : 'classes'} · {trim === 'a4' ? 'A4' : 'Letter'}<span> Preview at actual print proportions. Scroll across on smaller screens.</span></p>
    <div className={`zine-measure zine-sheet-${trim}`} ref={measure} aria-hidden="true">{header(true)}{header(false)}{footer(999,999)}<div className="zine-measure-column">{blocks.map((_,i)=>block(i))}</div></div>
    <div className="zine-preview" id="main-content" tabIndex={-1}>{pages.map((columns,index)=><article className={`zine-page zine-sheet zine-sheet-${trim}`} key={index} aria-label={`Zine page ${index+1} of ${pages.length}`}>
      {header(index===0)}
      <div className="zine-page-columns">{columns.map((items,col)=><div key={col}>{items.map(block)}</div>)}{!blocks.length ? <p>Nothing posted for {label} yet.</p> : null}</div>
      {footer(index+1,pages.length)}
    </article>)}</div>
  </>;
}
