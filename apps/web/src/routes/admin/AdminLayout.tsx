import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { Screen } from '../../components/Screen';
import { SessionGate } from '../../components/SessionGate';
import { useMe } from '../../lib/queries';

/**
 * Mirrors `Role.Steward` (40) in `packages/shared/src/roles.ts`. The web app
 * has no dependency on `@freeschool/shared` (see `apps/web/package.json`),
 * so the number is duplicated here rather than imported — same approach as
 * `EventEditScreen.tsx`'s `me.role < 20` check for `Role.Host`.
 */
const STEWARD_ROLE = 40;

type AdminTab = 'overview' | 'policy' | 'moderation' | 'peers' | 'newsletter' | 'handoff';

const TABS: ReadonlyArray<{ key: AdminTab; to: string; label: string }> = [
  { key: 'policy', to: '/admin/policy', label: 'Policy' },
  { key: 'moderation', to: '/admin/moderation', label: 'Moderation' },
  { key: 'peers', to: '/admin/peers', label: 'Peers' },
  { key: 'newsletter', to: '/admin/newsletter', label: 'Newsletter' },
  // Task 10 builds the real screen; the route itself still exists (`router.tsx`'s
  // Placeholder), so this link already works — it just lands on "coming later."
  { key: 'handoff', to: '/admin/handoff', label: 'Hand-off' },
];

function AdminSubNav({ current }: { current: AdminTab }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Admin sections" className="-mx-0.5 mb-1 flex gap-1.5 overflow-x-auto pb-2">
      {TABS.map((tab) => {
        const active = current === tab.key || pathname === tab.to;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            aria-current={active ? 'page' : undefined}
            className="shrink-0 border-[1.5px] border-ink px-3 py-1.5 text-caption font-medium"
            style={{
              background: active ? 'var(--c-ink)' : 'transparent',
              color: active ? 'var(--c-paper-2)' : 'var(--c-ink)',
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Signed in, but not a steward. Plain state, never a crash — the brief's
 * requirement verbatim. */
function StewardsOnlyNotice() {
  return (
    <div className="plate p-4">
      <p className="text-body">Stewards only.</p>
      <p className="mt-1.5 text-caption text-ink-soft">
        This area is for the school's stewards. Ask a steward if you think you should have access.
      </p>
    </div>
  );
}

function RoleGate({ children }: { children: ReactNode }) {
  // `SessionGate` (the parent) already resolved `useMe()` successfully before
  // rendering this; this second call is a cache hit, not a second request.
  const { data: me, isPending } = useMe();
  if (isPending) return null;
  if (!me || me.role < STEWARD_ROLE) return <StewardsOnlyNotice />;
  return <>{children}</>;
}

interface AdminLayoutProps {
  title: string;
  current: AdminTab;
  standfirst?: string;
  children: ReactNode;
}

/**
 * Shared shell for every `/admin/*` screen. Two gates, per the brief:
 *   - nobody signed in → the existing `SessionGate` door (same pattern as
 *     `NotificationSettingsScreen.tsx`);
 *   - signed in but role < steward → a plain "Stewards only" notice here,
 *     never a crash.
 * Wraps the result in `Screen` with the sub-nav sitting `beneathTitle`, so it
 * scrolls with the page rather than pinning a second chrome bar.
 */
export function AdminLayout({ title, current, standfirst, children }: AdminLayoutProps) {
  return (
    <SessionGate prompt="Sign in as a steward to manage this school.">
      <RoleGate>
        <Screen
          title={title}
          standfirst={standfirst}
          back={current !== 'overview'}
          beneathTitle={<AdminSubNav current={current} />}
        >
          <div className="safe-x">{children}</div>
        </Screen>
      </RoleGate>
    </SessionGate>
  );
}

/** `/admin` — the hub: both gates, then links to each sub-screen. */
export function AdminOverviewScreen() {
  return (
    <AdminLayout
      title="Admin"
      current="overview"
      standfirst="Steward tools: policy, moderation, peers, and the monthly newsletter."
    >
      <ul className="space-y-3">
        {TABS.map((tab) => (
          <li key={tab.key} className="plate p-3.5">
            <Link to={tab.to} className="text-body font-bold text-blue">
              {tab.label}
            </Link>
          </li>
        ))}
      </ul>
    </AdminLayout>
  );
}
