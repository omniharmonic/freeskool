import { createRootRoute, createRoute, createRouter, Outlet, useRouterState } from '@tanstack/react-router';
import { TabBar } from './components/TabBar';
import { OfflineBanner } from './components/OfflineBanner';
import { InstallProvider } from './components/InstallNudge';
import { CalendarScreen } from './routes/CalendarScreen';
import { EventRedirect, EventScreen } from './routes/EventScreen';
import { EventEditScreen } from './routes/EventEditScreen';
import { AttendanceScreen } from './routes/AttendanceScreen';
import { FeedbackScreen } from './routes/FeedbackScreen';
import { FeedbackSummaryScreen } from './routes/FeedbackSummaryScreen';
import { SkillsScreen } from './routes/SkillsScreen';
import { SkillScreen } from './routes/SkillScreen';
import { RequestsScreen } from './routes/RequestsScreen';
import { MeScreen } from './routes/MeScreen';
import { NotificationSettingsScreen } from './routes/NotificationSettingsScreen';
import { SignInScreen } from './routes/SignInScreen';
import { VerifyScreen } from './routes/VerifyScreen';
import { OAuthConfirmScreen } from './routes/OAuthConfirmScreen';
import { ZineScreen } from './routes/ZineScreen';
import { InviteScreen } from './routes/InviteScreen';
import { Placeholder } from './routes/Placeholder';
import { AdminOverviewScreen } from './routes/admin/AdminLayout';
import { PolicyScreen } from './routes/admin/PolicyScreen';
import { ModerationScreen } from './routes/admin/ModerationScreen';
import { PeersScreen } from './routes/admin/PeersScreen';
import { NewsletterScreen } from './routes/admin/NewsletterScreen';

/** The zine and the sign-in flow (both doors plus the verify landing) are the
 * places without tabs. */
const CHROMELESS = ['/zine', '/signin', '/verify', '/oauth/confirm'];

function Shell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const chrome = !CHROMELESS.includes(pathname);
  return (
    <InstallProvider>
      {chrome ? <OfflineBanner /> : null}
      <Outlet />
      {chrome ? <TabBar /> : null}
    </InstallProvider>
  );
}

const rootRoute = createRootRoute({ component: Shell });

const routes = [
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: CalendarScreen }),
  // Pre-Task-4 path, kept working: it forwards to `/events/$id` (see
  // `EventRedirect`'s doc comment in `EventScreen.tsx`).
  createRoute({ getParentRoute: () => rootRoute, path: '/event/$eventId', component: EventRedirect }),
  createRoute({ getParentRoute: () => rootRoute, path: '/events/$id', component: EventScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/skills', component: SkillsScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/skills/$skillId', component: SkillScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/requests', component: RequestsScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/me', component: MeScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/signin', component: SignInScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/zine', component: ZineScreen }),

  createRoute({ getParentRoute: () => rootRoute, path: '/verify', component: VerifyScreen }), // Task 3
  createRoute({ getParentRoute: () => rootRoute, path: '/oauth/confirm', component: OAuthConfirmScreen }), // Task 3

  // Registered here as placeholders; each is replaced by its real screen in
  // the task named in the plan (`.superpowers/sdd/mvp-plan/task-*-brief.md`).
  createRoute({ getParentRoute: () => rootRoute, path: '/events/new', component: EventEditScreen }), // Task 5
  createRoute({ getParentRoute: () => rootRoute, path: '/events/$id/edit', component: EventEditScreen }), // Task 5
  createRoute({ getParentRoute: () => rootRoute, path: '/events/$id/attendance', component: AttendanceScreen }), // Task 5
  createRoute({ getParentRoute: () => rootRoute, path: '/events/$id/feedback', component: FeedbackScreen }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/events/$id/feedback-summary',
    component: FeedbackSummaryScreen,
  }),
  createRoute({ getParentRoute: () => rootRoute, path: '/invite/$token', component: InviteScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/me/settings', component: NotificationSettingsScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminOverviewScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin/policy', component: PolicyScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin/moderation', component: ModerationScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin/peers', component: PeersScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin/newsletter', component: NewsletterScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin/handoff', component: Placeholder }), // Task 10
  createRoute({ getParentRoute: () => rootRoute, path: '/how-it-works', component: Placeholder }), // Task 10
];

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultPreload: 'intent',
  scrollRestoration: false,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
