import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { registerSW } from 'virtual:pwa-register';
import { router } from './router';
import { applyPrefs, readPrefs } from './lib/prefs';
import './styles.css';
import './interface.css';

applyPrefs(readPrefs());

// autoUpdate: the new service worker takes over on the next navigation. No
// "reload?" toast — a free-school calendar is not worth interrupting someone for.
registerSW({ immediate: true });
// Remove the previous cache, which could contain a signed-in viewer’s private addresses.
if ('caches' in window) void caches.delete('fs-calendar-v1').catch(() => undefined);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The calendar is served from the Workbox cache when offline, so a stale
      // render is correct rather than an error state.
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from index.html');

createRoot(host).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
