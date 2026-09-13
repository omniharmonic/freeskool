import { test, expect, type Page } from '@playwright/test';

// Public live checks have no request interception. Fixture-heavy print and author
// scenarios stay in design.spec.ts / knowledge.spec.ts and are reported separately.
async function fits(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { page: root.scrollWidth - root.clientWidth, body: document.body.scrollWidth - root.clientWidth };
  });
  expect(overflow.page, 'Page must fit the viewport').toBeLessThanOrEqual(1);
  expect(overflow.body, 'Body must fit the viewport').toBeLessThanOrEqual(1);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`); });
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy|Refused to|Failed to fetch dynamically imported module/i.test(m.text())) errors.push(m.text()); });
  (page as Page & { acceptanceErrors: string[] }).acceptanceErrors = errors;
});
test.afterEach(async ({ page }) => {
  expect((page as Page & { acceptanceErrors: string[] }).acceptanceErrors).toEqual([]);
});

test('public pages load directly, render live data and fit the viewport', async ({ page }, info) => {
  const screens: Array<[string, string]> = [
    ['/', '.calendar-list:not([hidden])'],
    ['/skills', '.skill-directory'],
    ['/knowledge', '.section-title-row'],
    ['/requests', '.request-board'],
    ['/how-it-works', '.reading-sections section'],
    ['/signin', 'input[type=email]'],
    ['/oauth/confirm', 'input'],
  ];
  for (const [path, ready] of screens) {
    await test.step(path, async () => {
      expect((await page.goto(path))?.status()).toBe(200);
      await expect(page.locator(ready).first()).toBeVisible();
      if (path === '/') await expect(page.locator('.calendar-list')).toHaveAttribute('aria-busy', 'false');
      if (path === '/requests') await expect(page.getByRole('link', { name: 'Sign in to ask for a class' })).toBeVisible();
      if (path === '/skills') await expect(page.locator('.skill-folder').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Something didn’t load' })).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      await fits(page);
      await page.screenshot({ path: info.outputPath(`${path.replaceAll('/', '') || 'calendar'}.png`), fullPage: true });
    });
  }
});

test('calendar view controls, next/previous, search and reload preserve their state', async ({ page }) => {
  await page.goto('/?view=month&date=2026-09-14');
  await expect(page.locator('.month-grid')).toBeVisible();
  await expect(page.locator('.month-grid .calendar-cell')).toHaveCount(35);
  await fits(page);
  await page.getByRole('button', { name: 'View Monday, September 14, 2026', exact: true }).click();
  await expect(page.locator('.calendar-single-day')).toBeVisible();
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await page.reload();
  await expect(page).toHaveURL(/date=2026-09-15/);
  await expect(page.locator('.calendar-single-day')).toBeVisible();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(page).toHaveURL(/date=2026-09-14/);
  await page.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(page.locator('.week-grid .calendar-cell')).toHaveCount(7);
  await fits(page);
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Search classes' }).fill('no-such-acceptance-class-84639');
  await expect(page.getByRole('heading', { name: 'No classes match your search.' })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search classes' }).fill('');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('.calendar-list')).toHaveAttribute('aria-busy', 'false');
});

test('taxonomy search leads to a real skill, ancestry and linked knowledge', async ({ page }) => {
  await page.goto('/skills');
  await expect(page.locator('.library-count')).toContainText('skills to explore')
  expect(parseInt(await page.locator('.library-count').innerText(), 10)).toBeGreaterThanOrEqual(219);
  const input = page.getByRole('searchbox', { name: 'Search skills' });
  await input.fill('bicycle');
  const link = page.locator('.skill-results .skill-link').first();
  await expect(link).toBeVisible();
  const label = await link.innerText();
  await link.click();
  await expect(page.locator('.skill-detail-intro')).toBeVisible();
  await expect(page.getByRole('heading', { name: label.trim(), exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Skill ancestry' })).toBeVisible();
  await expect(page.locator('.knowledge-shelf')).toHaveCount(2);
  await fits(page);
  await page.reload();
  await expect(page.locator('.skill-detail-intro')).toBeVisible();
  await page.getByRole('navigation', { name: 'Skill ancestry' }).getByRole('link', { name: 'Skills', exact: true }).click();
  await expect(input).toBeVisible();
  await input.fill('no-such-skill-84639');
  await expect(page.getByRole('heading', { name: 'No skills match that search.' })).toBeVisible();
});

test('signed-out personal, author and steward pages offer sign-in without leaking controls', async ({ page }) => {
  for (const path of ['/me', '/me/settings', '/events/new', '/knowledge/new', '/admin', '/admin/policy', '/admin/moderation', '/admin/peers', '/admin/newsletter', '/admin/handoff']) {
    await test.step(path, async () => {
      await page.goto(path);
      await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
      await expect(page.locator('input[type=password], textarea')).toHaveCount(0);
      await fits(page);
    });
  }
  await page.goto('/events/new');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Your email')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create a new Free School identity (recommended)' })).toBeDisabled();
  await page.getByLabel('Your email').fill('invalid-email');
  expect(await page.getByLabel('Your email').evaluate((e: HTMLInputElement) => e.validity.valid)).toBe(false);
  await page.getByRole('link', { name: 'Use an existing AT Protocol account' }).click();
  await expect(page.getByRole('button', { name: 'Continue anyway' })).toBeDisabled();
  await expect(page.getByText(/anyone on the internet will be able to see/)).toBeVisible();
});

test('missing records and incomplete verification links recover gracefully', async ({ page }) => {
  const states: Array<[string, string]> = [
    ['/unknown-acceptance-page', 'This page wandered off'],
    ['/skills/missing-acceptance-skill', 'Skill not found'],
    ['/events/missing-acceptance-event', 'Class not found'],
    ['/knowledge/missing-acceptance-note', 'Resource unavailable'],
    ['/people/did%3Aplc%3Amissingacceptanceprofile', 'Profile unavailable'],
    ['/verify', "That link didn't work"],
  ];
  for (const [path, title] of states) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await fits(page);
  }
});

test('the actual live zine prints both paper sizes and navigates months', async ({ page, browserName }, info) => {
  await page.goto('/zine');
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
  await expect(page.locator('.zine-sheet').first()).toBeVisible();
  for (const trim of ['Letter', 'A4']) {
    await page.getByRole('button', { name: trim, exact: true }).click();
    await expect(page.getByRole('button', { name: trim, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await fits(page);
    if (browserName === 'chromium') {
    const pdf = await page.pdf({ path: info.outputPath(`live-${trim}.pdf`), preferCSSPageSize: true, printBackground: true });
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length).toBe(await page.locator('.zine-sheet').count());
    }
  }
  await page.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Month', exact: true })).toContainText('October 2026');
  await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeEnabled();
  await page.getByRole('link', { name: 'Back to the calendar' }).click();
  await expect(page.locator('.calendar-toolbar')).toBeVisible();
});

test('PWA caches the live calendar and explains offline mode', async ({ page, context, browserName }) => {
  // Playwright 1.63 / WebKit 2359 fails offline top-level navigation even for an
  // independent, minimal cache-first service worker (verified September 13, 2026).
  // Keep this gap visible rather than claiming an emulated pass proves iOS offline.
  test.fixme(browserName === 'webkit' && process.env.E2E_FORCE_WEBKIT_OFFLINE !== '1', 'WebKit offline navigation fails in an independent minimal reproduction; verify on a physical iPhone.');
  await page.goto('/');
  await expect(page.locator('.calendar-list')).toHaveAttribute('aria-busy', 'false');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('.calendar-list')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => page.evaluate(async () => (await caches.open('fs-calendar-public-v2')).keys().then(keys => keys.length))).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  try {
    await expect(page.getByText('No connection. Showing the classes saved on this phone.')).toBeVisible();
    await page.goto(`${page.url()}&offline-check=1`);
    await expect(page.getByText('No connection. Showing the classes saved on this phone.')).toBeVisible();
    await expect(page.locator('.calendar-list')).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByRole('heading', { name: 'The calendar couldn’t load.' })).toHaveCount(0);
  } finally { await context.setOffline(false); }
});
