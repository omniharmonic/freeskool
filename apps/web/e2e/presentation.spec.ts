import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Rendering acceptance against the built/deployed frontend, with explicitly
// synthetic API responses. Nothing is published to the production PDS.
const skill = 'at://did:plc:fixture/freeschool.draft.skill/bicycle';
const author = 'did:plc:presentationfixture';
const noteId = `at://${author}/freeschool.draft.resource/note`;
const eventId = `at://${author}/community.lexicon.calendar.event/class`;
const note = { id: noteId, title: 'A repair table anyone can join', description: 'Start with a warm welcome, a clear work surface and a little patience. Leave what you learn for the next person.', skills: [skill], authorDid: author, authorName: 'The courtyard notebook · test fixture', authorHasProfile: true, license: 'CC0-1.0', createdAt: '2026-09-13T12:00:00Z', event: { uri: eventId, cid: '' } };

for (const width of [390, 1440]) test(`artwork, event details and linked notebooks at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.route('**/api/auth/me', r => r.fulfill({ status: 401, json: { error: 'Unauthorized' } }));
  await page.route('**/api/presentation-fixture/*', async r => {
    const filename = new URL(r.request().url()).pathname.split('/').pop()!;
    if (filename === 'missing.webp') return r.fulfill({ status: 404, body: '' });
    return r.fulfill({ contentType: 'image/webp', body: await readFile(path.resolve('../../fixtures/artwork', filename)) });
  });
  await page.route('**/api/resources*', r => r.fulfill({ json: { resources: [note] } }));
  await page.route('**/api/resources/*', r => r.fulfill({ json: note }));
  await page.route('**/api/skills', r => r.fulfill({ json: { skills: [{ uri: skill, id: 'bicycle', label: 'Bicycle mechanics', tier: 'A', children: [] }] } }));
  await page.route('**/api/skills/*', r => r.fulfill({ json: { uri: skill, id: 'bicycle', label: 'Bicycle mechanics', description: 'Small repairs that keep us moving.', tier: 'A', ancestors: [], children: [], taughtIn: [] } }));
  await page.route('**/api/profiles/*', r => r.fulfill({ json: { did: author, displayName: note.authorName, bio: 'Fictional workshop notebook for visual acceptance testing.', avatarUrl: '/api/presentation-fixture/botanical-square.webp', claims: [{ skill, level: 'teaching', note: 'Learning together around a repair table.' }], resources: [note] } }));
  const images = ['mushroom-flyer.webp', 'repair-photo.webp', 'botanical-square.webp', 'rough-phone-photo-240px.webp', 'missing.webp', ''];
  const events = images.map((image, i) => ({
    uri: `${eventId}${i}`, name: `Community workshop · ${image || 'no image'}`, startsAt: '2026-09-14T16:00:00Z', endsAt: '2026-09-14T18:00:00Z',
    ...(image ? { cover: { url: `/api/presentation-fixture/${image}`, alt: `Workshop artwork: ${image}` } } : {}),
    tags: ['skillshare'], neighborhood: 'The neighborhood', locationRedacted: true, listed: true, viewerRelation: 'none',
    rsvps: { going: 3, interested: 2 }, skills: [{ skill, level: 1, prerequisites: 'No experience needed.' }], materials: ['A notebook', 'Something you would like to repair'],
    publicOverview: { description: 'Learn a practical skill around a shared table. We will begin with a demonstration, then try it together.', audience: 'Beginners and curious neighbors of all ages.', accessibility: 'Step-free entry. Seated workspaces and quiet breaks available.' },
  }));
  await page.route('**/api/calendar*', r => r.fulfill({ json: { events } }));
  await page.route('**/api/events/*', r => {
    const uri = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()!);
    return r.fulfill({ json: events.find(e => e.uri === uri) ?? events[0] });
  });
  await page.goto('/?view=day&date=2026-09-14');
  await expect(page.locator('.calendar-single-day .content-card')).toHaveCount(6);
  await page.locator('.calendar-single-day .content-card').nth(3).scrollIntoViewIfNeeded();
  await expect(page.locator('.calendar-single-day .class-artwork-card.is-small-image')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('compositions.png'), fullPage: true });
  for (const [i, event] of events.entries()) {
    await page.goto(`/events/${encodeURIComponent(event.uri)}`);
    await expect(page.getByRole('heading', { name: 'About this class' })).toBeVisible();
    for (const title of ['Who it’s for', 'Access & comfort', 'What you’ll learn', 'What to bring']) await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByText('The exact address shows up here once you RSVP.', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
    const hero = page.locator('.class-artwork-hero');
    if (i < 4) {
      await expect.poll(() => hero.locator('img').evaluate((e: HTMLImageElement) => e.naturalWidth)).toBeGreaterThan(0);
      expect(await hero.locator('img').evaluate(e => getComputedStyle(e).objectFit)).toBe('contain');
      if (i === 0) await expect(hero).toHaveClass(/is-portrait/);
      if (i === 3) await expect(hero).toHaveClass(/is-small-image/);
      await page.getByRole('button', { name: `View full image for ${event.name}` }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Fit image' })).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
    } else await expect(hero.locator('.card-poster')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`event-${i}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  }
  await page.goto(`/knowledge/${encodeURIComponent(noteId)}`);
  await expect(page.getByRole('heading', { name: note.title, exact: true })).toBeVisible();
  await expect(page.getByText('License: CC0-1.0')).toBeVisible();
  await page.getByRole('link', { name: note.authorName, exact: true }).click();
  await expect(page.locator('.public-profile-intro')).toBeVisible();
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, nofollow');
  await expect(page.locator('.public-skills')).toContainText('Bicycle mechanics');
  await page.screenshot({ path: info.outputPath('public-profile.png'), fullPage: true });
  await page.getByRole('link', { name: note.title, exact: true }).click();
  await expect(page.getByRole('heading', { name: note.title, exact: true })).toBeVisible();
});
