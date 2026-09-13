import { useLayoutEffect, useRef } from 'react';
import type { CalendarEvent } from '../lib/types';
import { ContentCard } from './ContentCard';

/** Keep the source/keyboard order while letting each image set its card's height. */
export function ContentGrid({ events }: { events: CalendarEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === 'undefined') return;
    const cards = Array.from(grid.children) as HTMLElement[];
    function size(card: HTMLElement) {
      const rows = Math.ceil((card.getBoundingClientRect().height + 18) / 8);
      card.style.gridRowEnd = `span ${Math.max(1, rows)}`;
    }
    cards.forEach(size);
    grid.classList.add('content-grid-adaptive');
    const observer = new ResizeObserver(entries => entries.forEach(entry => size(entry.target as HTMLElement)));
    cards.forEach(card => observer.observe(card));
    return () => {
      observer.disconnect();
      grid.classList.remove('content-grid-adaptive');
      cards.forEach(card => card.style.removeProperty('grid-row-end'));
    };
  }, [events]);
  return <div ref={ref} className="content-grid">{events.map(event => <ContentCard key={event.uri} event={event} />)}</div>;
}
