import { createRootRoute, createRoute, createRouter, Outlet, useRouterState } from '@tanstack/react-router';
import { TabBar } from './components/TabBar';
import { OfflineBanner } from './components/OfflineBanner';
import { InstallProvider } from './components/InstallNudge';
import { CalendarScreen } from './routes/CalendarScreen';
import { EventScreen } from './routes/EventScreen';
import { SkillsScreen } from './routes/SkillsScreen';
import { SkillScreen } from './routes/SkillScreen';
import { RequestsScreen } from './routes/RequestsScreen';
import { MeScreen } from './routes/MeScreen';
import { SignInScreen } from './routes/SignInScreen';
import { ZineScreen } from './routes/ZineScreen';

/** The zine and the sign-in screen are the two places without tabs. */
const CHROMELESS = ['/zine', '/signin'];

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
  createRoute({ getParentRoute: () => rootRoute, path: '/event/$eventId', component: EventScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/skills', component: SkillsScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/skills/$skillId', component: SkillScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/requests', component: RequestsScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/me', component: MeScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/signin', component: SignInScreen }),
  createRoute({ getParentRoute: () => rootRoute, path: '/zine', component: ZineScreen }),
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
