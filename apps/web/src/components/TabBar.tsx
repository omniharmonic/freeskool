import { Link, useRouterState } from '@tanstack/react-router';

const tabs = [
  { to: '/', label: 'Calendar', glyph: CalendarGlyph },
  { to: '/skills', label: 'Skills', glyph: SkillsGlyph },
  { to: '/requests', label: 'Requests', glyph: RequestsGlyph },
  { to: '/people', label: 'People', glyph: PeopleGlyph },
  { to: '/me', label: 'Me', glyph: MeGlyph },
] as const;

export function TabBar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav className="tab-bar glass app-chrome" aria-label="Sections">
      <div className="flex items-stretch justify-around px-1 pt-1.5">
        {tabs.map(({ to, label, glyph: Glyph }) => {
          const active = to === '/' ? pathname === '/' || pathname.startsWith('/event') : pathname.startsWith(to) || (to === '/skills' && pathname.startsWith('/knowledge'));
          return (
            <Link
              key={to}
              to={to}
              className="flex min-w-0 flex-1 flex-col items-center gap-0.5 py-1"
              aria-current={active ? 'page' : undefined}
              style={{ color: active ? 'var(--c-pink)' : 'var(--c-ink-faint)' }}
            >
              <Glyph active={active} />
              <span className="display text-[11px] leading-none font-bold tracking-normal">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

type GlyphProps = { active: boolean };
const stroke = (active: boolean) => ({
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: active ? 2.3 : 1.7,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
});

/* Drawn, not iconographic-library: stamped rectangles and rules, like the
   rest of the press. */
function CalendarGlyph({ active }: GlyphProps) {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" aria-hidden="true" {...stroke(active)}>
      <rect x="3" y="5" width="18" height="16" />
      <path d="M3 10h18M8 3v4M16 3v4" />
      {active ? <rect x="6" y="13" width="4" height="4" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}
function SkillsGlyph({ active }: GlyphProps) {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" aria-hidden="true" {...stroke(active)}>
      <path d="M4 6h7M4 12h11M4 18h6" />
      <circle cx="19" cy="6" r={active ? 2.4 : 2} fill={active ? 'currentColor' : 'none'} />
      <circle cx="20" cy="18" r={active ? 2.4 : 2} fill={active ? 'currentColor' : 'none'} />
    </svg>
  );
}
function RequestsGlyph({ active }: GlyphProps) {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" aria-hidden="true" {...stroke(active)}>
      <path d="M4 5h16v10H9l-5 4z" />
      {active ? <path d="M8 10h8" /> : null}
    </svg>
  );
}
/* Two figures, one behind the other: the directory, not one person. */
function PeopleGlyph({ active }: GlyphProps) {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" aria-hidden="true" {...stroke(active)}>
      <circle cx="9.5" cy="8.5" r="3.3" fill={active ? 'currentColor' : 'none'} />
      <path d="M3 19.5c1.3-3.4 3.5-5 6.5-5s5.2 1.6 6.5 5" />
      <path d="M16 5.6a3.3 3.3 0 0 1 0 6.3M18 14.9c1.6.7 2.8 2.2 3.5 4.1" />
    </svg>
  );
}
function MeGlyph({ active }: GlyphProps) {
  return (
    <svg width="25" height="25" viewBox="0 0 24 24" aria-hidden="true" {...stroke(active)}>
      <circle cx="12" cy="8.5" r="3.6" fill={active ? 'currentColor' : 'none'} />
      <path d="M4.5 20c1.6-4 4.2-5.8 7.5-5.8S18.4 16 20 20" />
    </svg>
  );
}
