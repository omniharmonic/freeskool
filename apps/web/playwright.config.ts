import { defineConfig, devices } from '@playwright/test';

/**
 * The end-to-end suite (`e2e/mvp.spec.ts`) runs against a STACK THE OPERATOR STARTED —
 * compose (PDS + Postgres), the AppView on :4000, the PWA on :5173 — exactly as the root
 * README's "Run the MVP locally" describes. There is deliberately no `webServer` here:
 * these tests make real records on a real PDS under a real school DID, and a test runner
 * that silently boots that for you is a test runner that silently creates accounts.
 *
 *   pnpm e2e
 *
 * One worker, no retries: the spec is one story told in order (sign up → ask → post →
 * RSVP → attendance → feedback → summary → zine → policy), with state carried between
 * steps. A retry would replay half a story against records the first attempt already
 * wrote.
 */
export default defineConfig({
  testDir: './e2e',
  // The whole story runs in about 20 seconds; the headroom is for the recurrence step,
  // which ends inside the materializer's peer backfill — minutes, on a local PDS that has
  // accumulated a few hundred repos.
  timeout: 5 * 60 * 1000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    // Playwright's own defaults here are "wait forever", which turns a locator that matches
    // nothing into a hung run with no output instead of a failure with a selector in it.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // An iPhone-sized viewport, because every screen in this app was drawn for one.
    viewport: { width: 430, height: 932 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 430, height: 932 } } }],
});
