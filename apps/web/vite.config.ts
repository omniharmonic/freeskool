import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// Where the dev proxy sends `/api` and the AppView's `/oauth/*` paths. Overridable so a
// second stack can run beside a first (`APPVIEW_PROXY_TARGET=http://localhost:4100 pnpm
// --filter @freeschool/web dev`), which is also how the e2e suite is run against a
// throwaway school while another AppView holds :4000.
const appview = process.env.APPVIEW_PROXY_TARGET ?? 'http://localhost:4000';

// `root` is pinned so config resolution never walks up out of the workspace.
export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      // The manifest is hand-written in public/ (copied from R8) so the iOS-
      // specific fields stay reviewable; the plugin only owns the service worker.
      manifest: false,
      injectRegister: null,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,ttf}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/oauth\/(callback|jwks|client-metadata)/],
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // 30 days of the home school's calendar, per R8. Installed web apps
            // are exempt from ITP's 7-day storage eviction, so this survives.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/calendar'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'fs-calendar-public-v2',
              networkTimeoutSeconds: 6,
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  build: { target: 'es2022', sourcemap: false },
  server: {
    proxy: {
      // The AppView's session cookie is `SameSite=Lax`; proxying keeps the
      // PWA and the API on the same origin in dev so the cookie round-trips
      // without `changeOrigin` rewriting the Host header the AppView's CORS
      // check and OAuth client metadata both key off of.
      '/api': { target: appview, changeOrigin: false },
      // Exact AppView OAuth paths only (`apps/appview/src/http/routes/oauth.ts`):
      // `/oauth/client-metadata.json`, `/oauth/jwks.json`, `/oauth/callback`.
      // `/api/auth/oauth/start` already lives under the `/api` rule above.
      // Vite's proxy matches by URL *prefix*, so a blanket `'/oauth'` key here
      // would also swallow the SPA's own `/oauth/confirm` route (no AppView
      // route answers it, so a hard refresh or a shared link 404s there
      // instead of rendering `OAuthConfirmScreen`) — list the real paths
      // individually instead of widening the prefix.
      '/oauth/client-metadata.json': { target: appview, changeOrigin: false },
      '/oauth/jwks.json': { target: appview, changeOrigin: false },
      '/oauth/callback': { target: appview, changeOrigin: false },
    },
  },
});
