import type { ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { FieldGlyph } from '../../components/FieldGlyph';
import { LoadingState } from '../../components/PageState';
import { Screen } from '../../components/Screen';
import { SessionGate } from '../../components/SessionGate';
import { useMe, useSkillProposals } from '../../lib/queries';

/**
 * Mirrors `Role.Steward` (40) in `packages/shared/src/roles.ts`. The web app
 * has no dependency on `@freeschool/shared` (see `apps/web/package.json`),
 * so the number is duplicated here rather than imported — same approach as
 * `EventEditScreen.tsx`'s `me.role < 20` check for `Role.Host`.
 */
const STEWARD_ROLE = 40;

type AdminTab = 'overview' | 'policy' | 'moderation' | 'peers' | 'skills' | 'newsletter' | 'handoff';

const TABS: ReadonlyArray<{ key: AdminTab; to: string; label: string; description: string }> = [
  { key: 'overview', to: '/admin', label: 'Overview', description: 'Everything you need to care for the school.' },
  { key: 'policy', to: '/admin/policy', label: 'Policy', description: 'Set the shared agreements and keep the door open.' },
  { key: 'moderation', to: '/admin/moderation', label: 'Moderation', description: 'Review concerns and make decisions together.' },
  { key: 'peers', to: '/admin/peers', label: 'Peers', description: 'Connect this school to other learning communities.' },
  { key: 'skills', to: '/admin/skills', label: 'Skills', description: 'Review what members have proposed for the shared taxonomy.' },
  { key: 'newsletter', to: '/admin/newsletter', label: 'Newsletter', description: 'Put the coming month into a simple email.' },
  { key: 'handoff', to: '/admin/handoff', label: 'Hand-off', description: 'Invite another person to share stewardship.' },
];

function AdminSubNav({ current }: { current: AdminTab }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label="Admin sections" className="admin-nav">
      {TABS.map((tab) => {
        const active = current === tab.key || pathname === tab.to;
        return (
          <Link
            key={tab.key}
            to={tab.to}
            activeOptions={{ exact: true }}
            aria-current={active ? 'page' : undefined}

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
  if (isPending) return <LoadingState label="Opening steward tools…" />;
  // Every way this can go — no session read, a role below steward, a refusal —
  // ends in the same plain notice, never an error (UX audit finding 16).
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
    <SessionGate screen prompt="Sign in as a steward to manage this school.">
      <Screen title={title} layout="admin" standfirst={standfirst} back={current !== 'overview'}>
        <div className="safe-x"><RoleGate><div className="admin-workbench"><AdminSubNav current={current} /><div className="admin-content">{children}</div></div></RoleGate></div>
      </Screen>
    </SessionGate>
  );
}

/**
 * The "Skills" tool card's overview copy, per the brief: titled "Proposed
 * skills" and showing the pending count rather than the tab's own
 * description. `undefined` while `useSkillProposals` is still loading (a
 * signed-in steward's first paint), so the card reads a plain "…" rather
 * than flashing "0 pending" and then correcting itself.
 */
function useProposedSkillsCount(): string {
  // Only a steward may ask: the route 403s for everyone else, and an ordinary
  // member who opens `/admin` should see the "Stewards only" notice without a
  // refused request behind it (UX audit finding 16).
  const { data: me } = useMe();
  const isSteward = (me?.role ?? 0) >= STEWARD_ROLE;
  const { data, isPending } = useSkillProposals(isSteward);
  if (!isSteward) return '';
  if (isPending) return '…';
  const count = data?.proposals.length ?? 0;
  if (count === 0) return 'Nothing pending';
  return count === 1 ? '1 pending' : `${count} pending`;
}

/** `/admin` — the hub: both gates, then links to each sub-screen. */
export function AdminOverviewScreen() {
  const pendingCopy = useProposedSkillsCount();
  return (
    <AdminLayout
      title="Steward tools"
      current="overview"
      standfirst="Care for the commons. Keep the school welcoming, connected, and in good hands."
    >
      <ul className="admin-tools">
        {TABS.filter((tab) => tab.key !== 'overview').map((tab) => (
          <li key={tab.key}>
            <Link to={tab.to} className="admin-tool">
              <FieldGlyph seed={tab.key} />
              <h2>{tab.key === 'skills' ? 'Proposed skills' : tab.label}</h2>
              <p>{tab.key === 'skills' ? pendingCopy : tab.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </AdminLayout>
  );
}
