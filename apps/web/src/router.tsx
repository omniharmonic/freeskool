
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Outlet, useRouterState } from '@tanstack/react-router';
import { useMe } from './lib/queries';
import { FlowFrame } from './components/FlowFrame';
import { Button } from './components/bits';
import { TabBar } from './components/TabBar';
import { OfflineBanner } from './components/OfflineBanner';
import { InstallProvider } from './components/InstallNudge';
import { CalendarScreen } from './routes/CalendarScreen';

// Load each flow when it is opened; the public calendar remains immediately available.
const KnowledgeScreen = lazyRouteComponent(() => import('./routes/KnowledgeScreen'), 'KnowledgeScreen');
const ResourceScreen = lazyRouteComponent(() => import('./routes/KnowledgeScreen'), 'ResourceScreen');
const NewResourceScreen = lazyRouteComponent(() => import('./routes/KnowledgeScreen'), 'NewResourceScreen');
const EditResourceScreen = lazyRouteComponent(() => import('./routes/KnowledgeScreen'), 'EditResourceScreen');
const PublicProfileScreen = lazyRouteComponent(() => import('./routes/KnowledgeScreen'), 'PublicProfileScreen');
const EventRedirect = lazyRouteComponent(() => import('./routes/EventScreen'), 'EventRedirect');
const EventScreen = lazyRouteComponent(() => import('./routes/EventScreen'), 'EventScreen');
const EventEditScreen = lazyRouteComponent(() => import('./routes/EventEditScreen'), 'EventEditScreen');
const AttendanceScreen = lazyRouteComponent(() => import('./routes/AttendanceScreen'), 'AttendanceScreen');
const FeedbackScreen = lazyRouteComponent(() => import('./routes/FeedbackScreen'), 'FeedbackScreen');
const FeedbackSummaryScreen = lazyRouteComponent(() => import('./routes/FeedbackSummaryScreen'), 'FeedbackSummaryScreen');
const SkillsScreen = lazyRouteComponent(() => import('./routes/SkillsScreen'), 'SkillsScreen');
const SkillScreen = lazyRouteComponent(() => import('./routes/SkillScreen'), 'SkillScreen');
const RequestsScreen = lazyRouteComponent(() => import('./routes/RequestsScreen'), 'RequestsScreen');
const PeopleScreen = lazyRouteComponent(() => import('./routes/PeopleScreen'), 'PeopleScreen');
const MemberProfileScreen = lazyRouteComponent(() => import('./routes/MemberProfileScreen'), 'MemberProfileScreen');
const MeScreen = lazyRouteComponent(() => import('./routes/MeScreen'), 'MeScreen');
const NotificationSettingsScreen = lazyRouteComponent(() => import('./routes/NotificationSettingsScreen'), 'NotificationSettingsScreen');
const SignInScreen = lazyRouteComponent(() => import('./routes/SignInScreen'), 'SignInScreen');
const VerifyScreen = lazyRouteComponent(() => import('./routes/VerifyScreen'), 'VerifyScreen');
const WelcomeScreen = lazyRouteComponent(() => import('./routes/WelcomeScreen'), 'WelcomeScreen');
const OAuthConfirmScreen = lazyRouteComponent(() => import('./routes/OAuthConfirmScreen'), 'OAuthConfirmScreen');
const ZineScreen = lazyRouteComponent(() => import('./routes/ZineScreen'), 'ZineScreen');
const InviteScreen = lazyRouteComponent(() => import('./routes/InviteScreen'), 'InviteScreen');
const HowItWorksScreen = lazyRouteComponent(() => import('./routes/HowItWorksScreen'), 'HowItWorksScreen');
const RevealScreen = lazyRouteComponent(() => import('./routes/RevealScreen'), 'RevealScreen');
const AdminOverviewScreen = lazyRouteComponent(() => import('./routes/admin/AdminLayout'), 'AdminOverviewScreen');
const PolicyScreen = lazyRouteComponent(() => import('./routes/admin/PolicyScreen'), 'PolicyScreen');
const ModerationScreen = lazyRouteComponent(() => import('./routes/admin/ModerationScreen'), 'ModerationScreen');
const PeersScreen = lazyRouteComponent(() => import('./routes/admin/PeersScreen'), 'PeersScreen');
const NewsletterScreen = lazyRouteComponent(() => import('./routes/admin/NewsletterScreen'), 'NewsletterScreen');
const HandoffScreen = lazyRouteComponent(() => import('./routes/admin/HandoffScreen'), 'HandoffScreen');
const HandoffAcceptScreen = lazyRouteComponent(() => import('./routes/admin/HandoffAcceptScreen'), 'HandoffAcceptScreen');

/** The zine and the sign-in flow (both doors plus the verify landing) are the
 * places without tabs. */
const CHROMELESS = ['/zine', '/signin', '/verify', '/oauth/confirm', '/welcome'];

function Shell() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const chrome = !CHROMELESS.includes(pathname) && !pathname.startsWith('/invite/');
  return (
    <InstallProvider>
      <a className="skip-link" href="#main-content">Skip to content</a>
      {chrome ? <OfflineBanner /> : null}
      <Outlet />
      {chrome ? <TabBar /> : null}
    </InstallProvider>
  );
}

/**
 * `/people/$did` is two pages behind one address. A signed-in member gets the
 * members-only directory profile (skills, vouches, what they host); everyone
 * else gets the opt-in public notebook, which only exists for a member who
 * asked for it. Nothing about a member is disclosed by the choice itself:
 * both sides 404 politely when there is nothing to show.
 */
function PersonProfileRoute() {
  const { isPending, data } = useMe();
  if (isPending) return <FlowFrame title="Opening this page" description="Just a moment…">{null}</FlowFrame>;
  return data ? <MemberProfileScreen /> : <PublicProfileScreen />;
}

const rootRoute = createRootRoute({
  component: Shell,
  notFoundComponent: () => <FlowFrame title="This page wandered off" description="The link may be old, or the address may have a typo."><Button href="/">Find a class</Button></FlowFrame>,
  errorComponent: ({ reset }) => <FlowFrame title="Something didn’t load" description="Your connection may have dropped. Try opening this page again."><Button onClick={reset}>Try again</Button></FlowFrame>,
});

const routes = [
  createRoute({getParentRoute:()=>rootRoute,path:'/knowledge',component:KnowledgeScreen}),
  createRoute({getParentRoute:()=>rootRoute,path:'/knowledge/new',component:NewResourceScreen}),
  createRoute({getParentRoute:()=>rootRoute,path:'/knowledge/$id',component:ResourceScreen}),
  createRoute({getParentRoute:()=>rootRoute,path:'/knowledge/$id/edit',component:EditResourceScreen}),
  createRoute({getParentRoute:()=>rootRoute,path:'/people',component:PeopleScreen}),
  createRoute({getParentRoute:()=>rootRoute,path:'/people/$did',component:PersonProfileRoute}),
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
  // Where `/verify` sends a brand-new custodial member, once (Task 11).
  createRoute({ getParentRoute: () => rootRoute, path: '/welcome', component: WelcomeScreen }),

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
  createRoute({ getParentRoute: () => rootRoute, path: '/admin/handoff', component: HandoffScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin/handoff/accept/$token', component: HandoffAcceptScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/how-it-works', component: HowItWorksScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/account/reveal/$token', component: RevealScreen }),
];

export const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  defaultPreload: 'intent',
  defaultPendingComponent: () => <FlowFrame title="Opening the next page" description="Just a moment…">{null}</FlowFrame>,
  scrollRestoration: false,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
