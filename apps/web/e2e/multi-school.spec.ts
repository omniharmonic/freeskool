/**
 * TWO SCHOOLS, ONE APPVIEW — the federation phase's acceptance journey (MS §11,
 * "E2E personas across two schools").
 *
 *   pnpm --filter @freeschool/appview seed:demo --schools boulder,denver
 *   pnpm --filter @freeschool/web exec playwright test e2e/multi-school.spec.ts
 *
 * THE STACK THIS NEEDS, and why each part:
 *
 *   - the AppView on :4000 with `MULTI_SCHOOL=1` — the flag that makes `withSchool` read
 *     the request host at all;
 *   - `SESSION_COOKIE_DOMAIN=` (EMPTY) — Chromium refuses a `Domain=.localhost` cookie
 *     outright, so no dev configuration can make one session span `boulder.localhost` and
 *     `denver.localhost`. This stack therefore exercises the host-only branch of the
 *     switch: the session row moves, the cookie does not, and the PWA says so and sends
 *     the member to the new city's own door. Production sets `.freeskool.xyz` and takes
 *     the other branch (`infra/production/.env.example`,
 *     `docs/runbooks/multi-school-rollout.md`);
 *   - the PWA on :5173, whose dev proxy is `changeOrigin: false`, so the AppView receives
 *     the ORIGINAL `Host` and resolves Boulder or Denver from it. Nothing else is needed:
 *     `*.localhost` is reserved by RFC 6761 and resolves to loopback in the browser with
 *     no `/etc/hosts` entry.
 *
 * WHAT IT PROVES, in the order a person would meet it: Maya is one identity in two cities
 * with two different standings; the switcher actually moves her; a steward of one city is
 * nobody in the other; a member of one city never meets the other's people or classes; the
 * public directory names both; and leaving takes her out of one roster and not the other.
 *
 * RE-RUNNABLE. The last journey leaves Denver and then walks back in through the same
 * door, restoring the directory listing leaving turned off (leaving is the stronger
 * statement, so `joinSchool` deliberately does NOT re-list a returning member —
 * `apps/appview/src/lib/membership.ts`). Every other journey only reads.
 */
import { expect, test, type Page } from '@playwright/test';
import { demoUser, originFor, signInAsOn } from './personas';

const BOULDER = originFor('boulder');
const DENVER = originFor('denver');

/** A class that exists only in Denver, and one that exists only in Boulder. */
const DENVER_CLASS = 'Seed swap and starts';
const BOULDER_CLASS = 'Kimchi from one cabbage';

/** `GET /api/me` on one school's host — the role, the school and the evidence behind it. */
async function meOn(page: Page, origin: string): Promise<{ school: string; role: number; did: string }> {
  const res = await page.request.get(`${origin}/api/me`);
  expect(res.ok(), `GET ${origin}/api/me -> ${res.status()}`).toBe(true);
  return (await res.json()) as { school: string; role: number; did: string };
}

/**
 * A person's row in the directory, located by DID rather than by name.
 *
 * A dev box accumulates accounts from every previous e2e run, several of which share a
 * first name with a persona ("Wren p9zuz"), so a name locator answers the wrong question:
 * "is anybody called Wren here" instead of "is DENVER'S Wren here". The row is a link to
 * `/people/<did>`, and the DID's suffix survives URL encoding untouched.
 */
function memberRow(page: Page, did: string) {
  return page.locator(`a[href*="${did.replace('did:plc:', '')}"]`);
}

/** One school's public row from `GET /api/schools`, by its label. */
async function schoolByLabel(page: Page, label: string, origin = BOULDER): Promise<{ did: string; host: string }> {
  const res = await page.request.get(`${origin}/api/schools`);
  const { schools } = (await res.json()) as { schools: Array<{ did: string; label: string; host: string }> };
  const found = schools.find((school) => school.label === label);
  if (!found) throw new Error(`no school labelled "${label}" — run the seed with --schools boulder,denver`);
  return found;
}

async function calendarNames(page: Page, origin: string): Promise<string[]> {
  const from = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 200 * 24 * 3_600_000).toISOString().slice(0, 10);
  const res = await page.request.get(`${origin}/api/calendar?from=${from}&to=${to}`);
  const { events } = (await res.json()) as { events: Array<{ name: string }> };
  return events.map((event) => event.name);
}

test.describe.serial('two schools on one AppView', () => {
  test('the two cities are two different schools on two different hosts', async ({ page }) => {
    // Before anybody signs in: the host alone decides which school answers. This is the
    // whole tenancy mechanism, and if it is broken every assertion below is meaningless.
    for (const [origin, name] of [
      [BOULDER, 'Boulder Free School'],
      [DENVER, 'Denver Free School'],
    ] as const) {
      const res = await page.request.get(`${origin}/api/school/how-it-works`);
      expect(res.ok()).toBe(true);
      const body = (await res.json()) as { school: { name: string } };
      expect(body.school.name, `${origin} should be ${name}`).toBe(name);
    }
  });

  test('Maya signs in on Boulder: Boulder’s calendar, Boulder’s people, and she may host', async ({ page }) => {
    const maya = await signInAsOn(page, 'maya', 'boulder');

    await page.goto(`${BOULDER}/`);
    // The city's name is the calendar's masthead — a link home, not a heading.
    await expect(page.getByRole('link', { name: 'Boulder Free School' })).toBeVisible();

    // Her own class is on this calendar, and Denver's is not.
    const names = await calendarNames(page, BOULDER);
    expect(names).toContain(BOULDER_CLASS);
    expect(names, 'a Denver class reached Boulder’s calendar').not.toContain(DENVER_CLASS);

    // Boulder's directory has Boulder's people in it — and nobody from Denver.
    const theo = await demoUser('theo');
    const wren = await demoUser('wren');
    await page.goto(`${BOULDER}/people`);
    await expect(memberRow(page, maya.did)).toBeVisible();
    await expect(memberRow(page, theo.did)).toBeVisible();
    await expect(memberRow(page, wren.did), 'Denver’s steward is in Boulder’s directory').toHaveCount(0);

    // HOST in Boulder, where the bar is zero attended classes — visible as the ABSENCE of
    // the "hosting is not unlocked yet" notice on the class form.
    const me = await meOn(page, BOULDER);
    expect(me.did).toBe(maya.did);
    expect(me.role, 'Maya should be a Host in Boulder').toBeGreaterThanOrEqual(20);
    await page.goto(`${BOULDER}/events/new`);
    await expect(page.getByText('Hosting is unlocked by attending a few classes', { exact: false })).toHaveCount(0);
  });

  test('she switches school and lands in Denver, as a Member there', async ({ page }) => {
    await signInAsOn(page, 'maya', 'boulder');
    await page.goto(`${BOULDER}/me`);

    // The switcher renders only for a member of more than one school, which is the
    // product's own statement that Maya is in two.
    const switcher = page.getByRole('button', { name: /Boulder Free School/ });
    await expect(switcher).toBeVisible();
    await switcher.click();
    await expect(page.getByRole('option', { name: /Boulder Free School/ })).toBeVisible();

    // The server half of the switch, asserted directly: the session moves to Denver and
    // the response names the host to go to. The PWA never builds that host itself.
    const denver = await schoolByLabel(page, 'denver');
    const switched = await page.request.post(`${BOULDER}/api/auth/switch-school`, {
      data: { schoolDid: denver.did },
    });
    expect(switched.status()).toBe(200);
    expect(((await switched.json()) as { host: string }).host).toBe(new URL(DENVER).hostname);

    /**
     * THE BROWSER HALF — and here the dev stack diverges from production, ON PURPOSE.
     *
     * In production every city is a subdomain of one registrable domain and
     * `SESSION_COOKIE_DOMAIN=.freeskool.xyz` makes the session cookie follow the member
     * across this hop, so they arrive signed in and land on the new city's home screen.
     * Locally the cities are `*.localhost`, and **Chromium refuses a cookie with
     * `Domain=localhost` or `Domain=.localhost` outright** — it stores nothing at all, so
     * no configuration of the dev AppView can make one session span `boulder.localhost`
     * and `denver.localhost`. (Verified against this stack: with `SESSION_COOKIE_DOMAIN`
     * set either way, `context.cookies()` comes back empty and every signed-in screen is
     * a sign-in prompt.) The dev AppView therefore runs with `SESSION_COOKIE_DOMAIN=`.
     *
     * So this run exercises the OTHER branch, and it is a branch the product owns rather
     * than a dev-only shrug: `POST /api/auth/switch-school` reports `sessionSpansHosts`,
     * and when it is false the switcher sends the member to the new city's own door with
     * `?switched=1` instead of dropping them on its home screen signed out with nothing
     * said. Production before the cookie-domain cutover takes exactly this path.
     */
    await page.getByRole('option', { name: 'Denver Free School' }).click();
    await page.waitForURL(
      (url) =>
        url.origin === DENVER && url.pathname === '/signin' && url.searchParams.get('switched') === '1',
      { timeout: 30_000 },
    );
    expect(new URL(page.url()).searchParams.get('returnTo')).toBe('/');
    // The name comes from THIS host's own public page, so a signed-out visitor can still
    // be told whose school they are standing in; the fallback covers a slow first paint.
    await expect(
      page.getByText(/You switched to Denver Free School\.|You switched schools\./),
    ).toBeVisible();

    // Denver's own door, and the session it opens is Denver's.
    await signInAsOn(page, 'maya', 'denver');
    const authMe = await page.request.get(`${DENVER}/api/auth/me`);
    expect(authMe.ok(), `GET ${DENVER}/api/auth/me -> ${authMe.status()}`).toBe(true);
    const viewer = (await authMe.json()) as { school?: { did: string; name: string } };
    expect(viewer.school?.did, 'the session on Denver’s host must be Denver’s').toBe(denver.did);
    expect(viewer.school?.name).toBe('Denver Free School');

    await page.goto(`${DENVER}/`);
    await expect(page.getByRole('link', { name: 'Denver Free School' })).toBeVisible();

    const me = await meOn(page, DENVER);
    expect(me.role, 'Maya should be a Member in Denver, not a Host').toBe(10);

    // Denver's calendar and Denver's people, and nothing of Boulder's.
    const names = await calendarNames(page, DENVER);
    expect(names).toContain(DENVER_CLASS);
    expect(names, 'a Boulder class reached Denver’s calendar').not.toContain(BOULDER_CLASS);

    const maya = await demoUser('maya');
    const wren = await demoUser('wren');
    const theo = await demoUser('theo');
    await page.goto(`${DENVER}/people`);
    await expect(memberRow(page, maya.did)).toBeVisible();
    await expect(memberRow(page, wren.did)).toBeVisible();
    await expect(memberRow(page, theo.did), 'a Boulder-only member is in Denver’s directory').toHaveCount(0);

    // The SAME person, the SAME claims, a different standing: Denver asks for one
    // attended class before hosting, and she has none here.
    await page.goto(`${DENVER}/events/new`);
    await expect(page.getByText('Hosting is unlocked by attending a few classes', { exact: false })).toBeVisible();

    // Her vouches are Denver's vouches. Boulder's are invisible here.
    await page.goto(`${DENVER}/me`);
    await expect(page.getByText('Wren vouched for', { exact: false })).toBeVisible();
    await expect(page.getByText('Sam vouched for', { exact: false })).toHaveCount(0);
  });

  test('a steward of Denver is nobody in Boulder', async ({ page }) => {
    // Wren signs in on BOULDER's host — which is also how a member joins a second school,
    // so this is the strongest form of the question: even having walked in Boulder's door,
    // Denver's stewardship does not come with him.
    await signInAsOn(page, 'wren', 'denver');
    const inDenver = await meOn(page, DENVER);
    expect(inDenver.role, 'Wren should be a Steward in Denver').toBe(40);
    await page.goto(`${DENVER}/me`);
    await expect(page.getByRole('link', { name: 'Open steward tools' })).toBeVisible();

    await signInAsOn(page, 'wren', 'boulder');
    const inBoulder = await meOn(page, BOULDER);
    expect(inBoulder.role, 'Wren must not be a steward in Boulder').toBeLessThan(40);

    // No entry to the steward tools on Me…
    await page.goto(`${BOULDER}/me`);
    await expect(page.getByRole('link', { name: 'Open steward tools' })).toHaveCount(0);
    // …and typing the address anyway is a plain notice, not a screen.
    await page.goto(`${BOULDER}/admin`);
    await expect(page.getByText('Stewards only.')).toBeVisible();
    // The API agrees, and says 403 rather than something quieter.
    expect((await page.request.get(`${BOULDER}/api/admin/policy`)).status()).toBe(403);

    // ...while the same session on Denver's host still opens Denver's steward tools.
    expect((await page.request.get(`${DENVER}/api/admin/policy`)).status()).toBe(200);

    /**
     * PUT THE FIXTURE BACK. Signing in on Boulder's host IS joining Boulder
     * (`http/session.ts#createSession`), which is the product working as designed and is
     * why the question above is the strong form of it — but it also leaves Wren in
     * Boulder's directory, which the next journey is about. Leaving is the member's own
     * one-tap action; the AppView's `POST /api/schools/:did/leave` is what the Me screen's
     * button calls.
     */
    // Boulder's DID from the session itself — the local school's LABEL is whatever
    // `create-school` last used on this box (`e2e-86269`), never something to hard-code.
    const left = await page.request.post(
      `${BOULDER}/api/schools/${encodeURIComponent(inBoulder.school)}/leave`,
    );
    expect(left.ok(), 'Wren could not leave Boulder again').toBe(true);
  });

  test('a Boulder-only member never meets Denver', async ({ page }) => {
    const theo = await signInAsOn(page, 'theo', 'boulder');
    const wren = await demoUser('wren');

    // Boulder's directory does not hold Denver's steward…
    const members = await page.request.get(`${BOULDER}/api/members`);
    expect(await members.text(), 'a Denver-only member appeared in Boulder’s directory').not.toContain(wren.did);

    // …and asking for him by DID is 404, never 403: a 403 would confirm he exists.
    const profile = await page.request.get(`${BOULDER}/api/members/${encodeURIComponent(wren.did)}`);
    expect(profile.status()).toBe(404);

    // Denver's calendar is not on Boulder's, in the app or in the printable zine.
    expect(await calendarNames(page, BOULDER)).not.toContain(DENVER_CLASS);
    const month = new Date(Date.now() + 4 * 24 * 3_600_000).toISOString().slice(0, 7);
    expect(await (await page.request.get(`${BOULDER}/api/zine/${month}`)).text()).not.toContain(DENVER_CLASS);

    /**
     * And Denver's roster is not readable from Boulder's session. On a deployment where
     * one cookie covers every city that refusal is a 403 (no membership); on this dev
     * stack the cookie is host-only, so it is a 401 (no session here at all). Both are
     * "not a roster", and it is not this journey's job to tell them apart — the
     * with-a-session shape is pinned by `apps/appview/test/tenant-isolation.test.ts`,
     * which drives both schools under one session.
     */
    const denverRoster = await page.request.get(`${DENVER}/api/members`);
    expect([401, 403]).toContain(denverRoster.status());
    expect(await denverRoster.text()).not.toContain(theo.did);
  });

  test('/schools names both cities, and counts neither', async ({ page }) => {
    await page.goto(`${BOULDER}/schools`);
    // "Schools" is the page title, the section heading and the tab label — take the first.
    await expect(page.getByRole('heading', { name: 'Schools' }).first()).toBeVisible();
    await expect(page.getByText('Boulder Free School').first()).toBeVisible();
    await expect(page.getByText('Denver Free School').first()).toBeVisible();
    // Each city links to its own origin, which locally is the host the seed made canonical.
    await expect(page.getByRole('link', { name: /denver\.localhost/ }).first()).toBeVisible();
    // Ruling 7: a directory that counts one city against another is a league table.
    await expect(page.getByText(/\d+\s+members?\b/)).toHaveCount(0);
  });

  test('leaving Denver takes Maya off Denver’s roster and leaves Boulder alone', async ({ page }) => {
    const maya = await signInAsOn(page, 'maya', 'denver');
    try {
      await page.goto(`${DENVER}/me`);
      await page.getByRole('button', { name: 'Leave this school' }).click();
      await page.getByRole('button', { name: 'Leave this school' }).last().click();
      // Leaving drops every cached answer and RELOADS the calendar (`/?left=1`), which
      // says so in a sentence. Wait for that landing before asking the app anything else,
      // or the next navigation races the one the app is already making.
      await expect(page.getByText('You’ve left this school.')).toBeVisible();

      /**
       * GONE FROM DENVER'S PEOPLE — which is what leaving DOES (ruling 10). It is
       * deliberately not a lockout: Denver's policy admits anyone with a profile
       * (`memberRequires: 'none'`), so the roster still answers her; she is simply not on
       * it. "Left" is a statement about the directory and the published role claim, not a
       * ban, and asserting a 403 here would be asserting a product this one is not.
       */
      await expect
        .poll(async () => (await page.request.get(`${DENVER}/api/members`)).text(), { timeout: 15_000 })
        .not.toContain(maya.did);
      await page.goto(`${DENVER}/people`);
      await expect(memberRow(page, maya.did)).toHaveCount(0);

      // …and still entirely herself in Boulder.
      await signInAsOn(page, 'maya', 'boulder');
      const boulder = await page.request.get(`${BOULDER}/api/members`);
      expect(boulder.status()).toBe(200);
      expect(await boulder.text()).toContain(maya.did);
      // Her Boulder class did not move and her Boulder role did not change.
      expect(await calendarNames(page, BOULDER)).toContain(BOULDER_CLASS);
      expect((await meOn(page, BOULDER)).role).toBeGreaterThanOrEqual(20);

      // Ruling 10: a class stays on the calendar it was taught on when somebody leaves.
      expect(await calendarNames(page, DENVER)).toContain(DENVER_CLASS);
    } finally {
      /**
       * PUT THE FIXTURE BACK, pass or fail. Signing in on Denver's host is walking back
       * in through the door — `joinSchool` clears `left_at`. It deliberately does NOT
       * re-list her in the directory (leaving was the stronger statement), so the listing
       * is restored through the same call the Me screen's own toggle makes. In a `finally`
       * because a half-finished run would otherwise leave the NEXT run a different
       * fixture: Maya in one school, and no switcher on her Me screen at all.
       */
      await signInAsOn(page, 'maya', 'denver');
      await page.request.put(`${DENVER}/api/me`, { data: { directoryListing: true } });
      await expect
        .poll(async () => (await page.request.get(`${DENVER}/api/members`)).text(), { timeout: 15_000 })
        .toContain(maya.did);
    }
  });
});
