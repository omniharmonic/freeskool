/**
 * Every route in `apps/web/src/router.tsx`, photographed at both sizes, as two different
 * people — the raw material for the UX audit (spec §4.6).
 *
 *   pnpm --filter @freeschool/web exec playwright test e2e/audit.spec.ts
 *
 * Output: `apps/web/test-results/audit/<persona>/<viewport>/<route>.png`, one full-page
 * shot each, gitignored. `<viewport>` is `mobile` (the suite's 430x932 default) or
 * `desktop` (the 1280x800 project in `playwright.config.ts`); running the file plainly
 * gets both, because both projects match it.
 *
 * WHAT THIS FAILS ON is deliberately narrow: an uncaught console error or an HTTP 5xx.
 * It asserts nothing about what the pages SAY — a screenshot suite that also asserted copy
 * would fail on every deliberate word change and get deleted within a month. The judgement
 * happens by eye, over the images, and lands in the audit document.
 *
 * THE PERSONAS are a steward (`demo+steward`, who sees every admin screen for real) and an
 * ordinary member holding no roles, so each screen is photographed both from the inside and
 * from the outside — a member's `/admin` is the "Stewards only" notice, and that notice is
 * exactly the kind of thing worth looking at. The member's address is stable rather than
 * per-run: `POST /api/auth/signin` resends for an address it knows instead of minting a
 * second account, so repeated audits reuse one member instead of littering the PDS.
 *
 * Three routes are skipped, and named in `SKIPPED` below: each needs a single-use token
 * that only exists inside a flow this file does not drive.
 */
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { demoUser, signInAs, signUpFresh, skillUriFor } from './personas';

const AUDIT_ROOT = fileURLToPath(new URL('../test-results/audit', import.meta.url));

/** The member with no roles, reused across runs (see this file's doc comment). */
const MEMBER_ADDRESS = 'audit-newcomer@example.org';

/** Routes that need a one-time token minted inside a flow this file does not drive. */
const SKIPPED = ['/account/reveal/$token', '/admin/handoff/accept/$token', '/invite/$token'];

/**
 * Console lines that are not the app failing.
 *
 * The dev server talking to itself (`[vite]`, the service worker, the DevTools ad), and
 * the browser's own "Failed to load resource" line for a 4xx: a 401 on a members-only
 * route or a 403 on somebody else's admin screen is the API ANSWERING, and every screen
 * here renders a real state for it. The server breaking is judged separately and
 * absolutely, by the 5xx rule below, which no filter can silence.
 */
const NOISE = [
  /favicon/i,
  /\[vite\]/i,
  /react devtools/i,
  /workbox/i,
  /service ?worker/i,
  /manifest/i,
  /Failed to load resource: the server responded with a status of 4\d\d/i,
];

interface Shot {
  /** The route pattern, exactly as `router.tsx` spells it — also the file name. */
  route: string;
  /** The address to open, with real ids substituted in. */
  url: string;
}

/** `/events/$id/attendance` -> `events-id-attendance`; `/` -> `root`. */
function slug(route: string): string {
  const cleaned = route.replace(/\$/g, '').replace(/^\/|\/$/g, '').replace(/\//g, '-');
  return cleaned || 'root';
}

/** `mobile` or `desktop`, from whichever project this worker is running. */
function viewportName(page: Page): string {
  return (page.viewportSize()?.width ?? 0) >= 1024 ? 'desktop' : 'mobile';
}

/**
 * The list of addresses to photograph, built once per persona: every route in
 * `router.tsx` in its own order, with a real id from the seeded school wherever the
 * pattern has a parameter.
 */
async function routesFor(page: Page): Promise<Shot[]> {
  const amir = await demoUser('amir');
  const event = await firstEventUri(page);
  const skill = await skillUriFor(page, 'bicycle-mechanics');
  const note = await firstNoteId(page);
  const e = encodeURIComponent;

  const withIds: Array<[string, string]> = [
    ['/', '/'],
    ['/signin', '/signin'],
    ['/verify', '/verify'],
    ['/oauth/confirm', '/oauth/confirm'],
    ['/welcome', '/welcome'],
    ['/how-it-works', '/how-it-works'],
    ['/zine', '/zine'],
    ['/events/new', '/events/new'],
    ['/event/$eventId', `/event/${e(event)}`],
    ['/events/$id', `/events/${e(event)}`],
    ['/events/$id/edit', `/events/${e(event)}/edit`],
    ['/events/$id/attendance', `/events/${e(event)}/attendance`],
    ['/events/$id/feedback', `/events/${e(event)}/feedback`],
    ['/events/$id/feedback-summary', `/events/${e(event)}/feedback-summary`],
    ['/skills', '/skills'],
    ['/skills/$skillId', `/skills/${e(skill)}`],
    ['/requests', '/requests'],
    ['/people', '/people'],
    ['/people/$did', `/people/${e(amir.did)}`],
    ['/knowledge', '/knowledge'],
    ['/knowledge/new', '/knowledge/new'],
    ...(note
      ? ([
          ['/knowledge/$id', `/knowledge/${e(note)}`],
          ['/knowledge/$id/edit', `/knowledge/${e(note)}/edit`],
        ] as Array<[string, string]>)
      : []),
    ['/me', '/me'],
    ['/me/settings', '/me/settings'],
    ['/admin', '/admin'],
    ['/admin/policy', '/admin/policy'],
    ['/admin/moderation', '/admin/moderation'],
    ['/admin/peers', '/admin/peers'],
    ['/admin/skills', '/admin/skills'],
    ['/admin/newsletter', '/admin/newsletter'],
    ['/admin/handoff', '/admin/handoff'],
  ];
  return withIds.map(([route, url]) => ({ route, url }));
}

/** Any class on the calendar — the audit needs a real one, not which one. */
async function firstEventUri(page: Page): Promise<string> {
  const from = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 200 * 24 * 3_600_000).toISOString().slice(0, 10);
  const res = await page.request.get(`/api/calendar?from=${from}&to=${to}`);
  const { events } = (await res.json()) as { events: Array<{ uri: string }> };
  if (!events[0]) throw new Error('no classes on the calendar — has the demo seed been run?');
  return events[0].uri;
}

/** A field note, when the school has one; the two knowledge routes are dropped if not. */
async function firstNoteId(page: Page): Promise<string | undefined> {
  const res = await page.request.get('/api/resources');
  if (!res.ok()) return undefined;
  const body = (await res.json()) as { resources?: Array<{ id: string }> };
  return body.resources?.[0]?.id;
}

/**
 * Walk every route, photograph it, and collect the two kinds of problem this file judges.
 * Everything is collected and reported at the end rather than thrown at the first one: a
 * screenshot suite that stops at route three has photographed three routes.
 */
async function audit(page: Page, persona: string): Promise<string[]> {
  const problems: string[] = [];
  let current = '';

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (NOISE.some((pattern) => pattern.test(text))) return;
    problems.push(`${current}: console error — ${text}`);
  });
  page.on('pageerror', (error) => {
    problems.push(`${current}: uncaught — ${error.message}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500) problems.push(`${current}: HTTP ${response.status()} ${response.url()}`);
  });

  const folder = join(AUDIT_ROOT, persona, viewportName(page));
  await mkdir(folder, { recursive: true });

  for (const shot of await routesFor(page)) {
    current = shot.route;
    await page.goto(shot.url, { waitUntil: 'domcontentloaded' });
    // The screens fetch after they mount; give the queries a moment to land so the
    // picture is of the page rather than of its skeleton.
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expect(page.locator('#main-content, main').first()).toBeVisible();
    const file = join(folder, `${slug(shot.route)}.png`);
    await mkdir(dirname(file), { recursive: true });
    await page.screenshot({ path: file, fullPage: true });
  }
  return problems;
}

test.describe('UX audit: every route, both viewports', () => {
  test('as a steward', async ({ browser }) => {
    const page = await browser.newPage();
    await signInAs(page, 'steward');
    const problems = await audit(page, 'steward');
    await page.close();
    expect(problems, `skipped by design: ${SKIPPED.join(', ')}`).toEqual([]);
  });

  test('as an ordinary member', async ({ browser }) => {
    const page = await browser.newPage();
    await signUpFresh(page, MEMBER_ADDRESS);
    const problems = await audit(page, 'member');
    await page.close();
    expect(problems, `skipped by design: ${SKIPPED.join(', ')}`).toEqual([]);
  });
});
