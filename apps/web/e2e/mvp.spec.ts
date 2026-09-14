/**
 * The MVP, end to end, in a browser, against the live local stack.
 *
 *   pnpm e2e            (see the root README, "Run the MVP locally")
 *
 * One story in order, as a new member would live it: sign up with an email through the
 * primary door → read the magic link out of the AppView's dev mail sink → land on the
 * needs board → ask for a class → post one with no venue yet → three other members RSVP →
 * the host checks them off → all three leave anonymous feedback → the host sees the
 * summary release at k=3 → a weekly class materializes its occurrences → the printable
 * zine and "how it works" render → a steward changes the policy and a member's derived
 * role changes with it.
 *
 * Everything here is real: real accounts on the reference PDS, real records in real repos,
 * real cookies. Nothing is stubbed. The only things it reaches for outside the browser are
 * `apps/appview/.dev-mail.log` (the dev mail sink — the magic link must never be in a log
 * line, so this is where it is) and two `tsx` one-liners in the AppView package: the
 * bootstrap steward appointment, and the series materializer, which is a pg-boss job and so
 * has no HTTP route by design (`FREESCHOOL_NO_JOBS=1` is what the README tells you to run).
 *
 * THE ONE-LINERS NEED THE APPVIEW'S ENV. Run `pnpm e2e` from the same shell you started
 * the AppView in (`DATABASE_URL`, `PDS_URL`, `SCHOOL_DID`, `SCHOOL_APP_PASSWORD`,
 * `CUSTODY_KEYS`, …) — the README's run sheet does exactly that.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Browser, type Page } from '@playwright/test';
// The dev-mail-sink reader is shared with the persona helper (Task 14) — one implementation.
import { magicLinkUrl } from './personas';

const exec = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Unique per run, so a re-run never reads the previous run's magic link. */
const TEST_IMAGE = { name: 'test-poster.png', mimeType: 'image/png', buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAoElEQVRoge2SQQkAQRDDaikyKmL92zgR9wgDhQhIQ8PraaIbsAHVK7IL9S7RDdiA6hXZhXqX6AZsQPWK7EK9S3QDNqB6RXah3iW6ARtQvSK7UO8S3YANqF6RXah3iW7ABlSvyC7Uu0Q3YAOqV2QX6l2iG7AB1SuyC/Uu0Q3YgOoV2YV6l+gGbED1iuxCvUt0AzagekV2od4lugEbUL3iHz6v8XDEtGAjnQAAAABJRU5ErkJggg==", "base64") };
const STAMP = Date.now().toString(36).slice(-5);
const addressFor = (who: string) => `e2e-${who}-${STAMP}@example.org`;

interface Member {
  page: Page;
  did: string;
  address: string;
}

/** The primary door, through the UI: email → magic link → verified session on Requests. */
async function signUp(browser: Browser, who: string): Promise<Member> {
  const page = await browser.newPage();
  const address = addressFor(who);
  await page.goto('/signin');
  await page.getByLabel('Your email').fill(address);
  await page.getByRole('button', { name: /Continue with email/ }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  const verifyUrl = await magicLinkUrl(address);
  await page.goto(verifyUrl);
  // Task 11: a brand-new member meets `/welcome` once — the handle they were
  // given, a name, a first skill. Every card is skippable, and "Finish" is the
  // way past all three; the verify screen wears the same title for a moment
  // while it signs them in, so the button is what this actually waits on.
  await expect(page.getByRole('heading', { name: 'Welcome to Free School', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  // PRD §13 constraint 2: onboarding lands on the needs board, not the calendar.
  await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();

  const me = (await (await page.request.get('/api/auth/me')).json()) as { did: string };
  expect(me.did).toMatch(/^did:/);
  return { page, did: me.did, address };
}

/** `YYYY-MM-DDTHH:mm` in the browser's own zone — what a `datetime-local` input wants. */
function localValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** One `tsx` call inside the AppView package, inheriting this shell's env. */
async function appviewEval(code: string, env: Record<string, string> = {}): Promise<string> {
  // `--input-type=module`: `tsx -e` transforms to CJS otherwise, and every line here is a
  // top-level await.
  const { stdout } = await exec('pnpm', ['--filter', '@freeschool/appview', 'exec', 'tsx', '--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** Fills the class form and submits it, returning what `POST /api/events` actually wrote. */
async function postClass(
  page: Page,
  fields: { name: string; startsAt: Date; endsAt: Date; neighborhood?: string; venueNeeded?: boolean; weekly?: boolean; image?: boolean; requestUri?: string },
): Promise<{ event: { uri: string }; series?: { uri: string }; listing?: { uri: string } }> {
  await page.goto(fields.requestUri ? `/events/new?request=${encodeURIComponent(fields.requestUri)}` : '/events/new');
  await expect(page.getByRole('heading', { name: 'Post a class', level: 1 })).toBeVisible();
  await page.getByLabel('Class title').fill(fields.name);
  await page.getByLabel('About this class', { exact: true }).fill('Bring a jar. We will talk about flour.');
  await page.getByLabel('Starts').fill(localValue(fields.startsAt));
  await page.getByLabel('Ends').fill(localValue(fields.endsAt));
  if (fields.venueNeeded) {
    await page.getByLabel("Venue needed — we don't have a room for this yet").check();
  }
  if (fields.neighborhood) {
    await page.getByLabel('Neighbourhood (shown publicly, e.g. "North Boulder")').fill(fields.neighborhood);
  }
  if (fields.image) {
    await page.getByLabel('Class cover image').setInputFiles(TEST_IMAGE);
    await page.getByLabel('Image description', { exact: true }).fill('A small test poster');
  }
  // A tag the school routes on, so the school writes a `coop.lexicon.event.listing`.
  await page.getByRole('button', { name: '+ skillshare', exact: true }).click();
  if (fields.weekly) {
    await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  }

  // Any status, so a refusal fails here with the server's own words instead of hanging.
  const created = page.waitForResponse((res) => res.url().endsWith('/api/events') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Post this class' }).click();
  const response = await created;
  const text = await response.text();
  expect(response.ok(), `POST /api/events -> ${response.status()} ${text}`).toBe(true);
  const body = JSON.parse(text) as {
    event: { uri: string };
    series?: { uri: string };
    listing?: { uri: string };
  };
  await expect(page.getByRole('heading', { name: fields.name, level: 1 })).toBeVisible();
  return body;
}

test.describe.configure({ mode: 'serial' });

test('the MVP loop: sign up, ask, post, RSVP, attest, feedback, zine, policy', async ({ browser }) => {
  let host: Member;
  let learners: Member[] = [];
  let eventUri = '';
  let requestUri = '';
  const className = `E2E sourdough (${STAMP})`;
  const requestTitle = `E2E: someone teach me to sharpen things (${STAMP})`;

  await test.step('a new member signs up with an email and lands on Requests', async () => {
    host = await signUp(browser, 'host');
  });

  await test.step('the member signs out and returns to the same identity by email', async () => {
    await host.page.goto('/me');
    await host.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await host.page.goto('/signin');
    await host.page.getByLabel('Your email').fill(host.address);
    await host.page.getByRole('button', { name: /Continue with email/ }).click();
    await expect(host.page.getByText('Check your email')).toBeVisible();
    await host.page.goto(await magicLinkUrl(host.address));
    await expect(host.page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();
    const me = await (await host.page.request.get('/api/auth/me')).json();
    expect(me.did).toBe(host.did);
  });

  await test.step('they post a request to the needs board', async () => {
    await host.page.getByRole('button', { name: 'Ask for one' }).click();
    const sheet = host.page.getByRole('dialog', { name: 'Ask for a class' });
    await sheet.getByLabel('What do you want to learn?').fill(requestTitle);
    await sheet
      .getByLabel('Anything that would help a teacher say yes')
      .fill('I own two dull knives and a stone I do not understand.');
    await sheet.getByRole('button', { name: 'Post this request' }).click();
    await expect(host.page.getByRole('dialog', { name: 'Asked' })).toBeVisible();
    await host.page.getByRole('button', { name: 'Done' }).click();
    await expect(host.page.getByRole('heading', { name: requestTitle })).toBeVisible();
    const result = await (await host.page.request.get('/api/requests')).json();
    requestUri = result.requests.find((r: {title: string}) => r.title === requestTitle).uri;
    await host.page.getByRole('article').filter({ has: host.page.getByRole('heading', { name: requestTitle }) })
      .getByRole('button', { name: 'I can teach this' }).click();
    await expect(host.page.getByRole('heading', { name: 'Post a class', level: 1 })).toBeVisible();
  });

  await test.step('they post a class with no venue yet', async () => {
    // In the recent past, so attendance and the feedback window are both open — the same
    // shape `scripts/smoke.ts` uses.
    const created = await postClass(host.page, {
      name: className,
      startsAt: new Date(Date.now() - 3 * 3_600_000),
      endsAt: new Date(Date.now() - 2 * 3_600_000),
      venueNeeded: true,
      neighborhood: 'Whittier',
      image: true,
      requestUri,
    });
    eventUri = created.event.uri;
    expect(eventUri).toContain(host.did); // the class lives in the HOST's repo
    expect(created.listing?.uri).toBeTruthy(); // tagged `skillshare` → the school lists it
    expect(created.listing?.uri).not.toContain(host.did); // …from the SCHOOL's repo
    await expect(host.page.getByText('Venue needed', { exact: true })).toBeVisible();
    await expect(host.page.getByRole('img', { name: 'A small test poster' })).toBeVisible();
    const cover = await host.page.getByRole('img', { name: 'A small test poster' }).getAttribute('src');
    const image = await host.page.request.get(cover!);
    expect(image.headers()['content-type']).toContain('image/webp');
    const requests = await (await host.page.request.get('/api/requests')).json();
    expect(requests.requests.find((r: {uri: string}) => r.uri === requestUri)).toMatchObject({
      status: 'scheduled', claims: 1, scheduledEventUri: eventUri,
    });
  });

  await test.step('a visitor can evaluate the class before signing in', async () => {
    const visitor = await browser.newPage();
    await visitor.goto(`/events/${encodeURIComponent(eventUri)}`);
    await expect(visitor.getByText('Bring a jar. We will talk about flour.')).toBeVisible();
    await expect(visitor.getByRole('img', { name: 'A small test poster' })).toBeVisible();
    await visitor.close();
  });

  await test.step('three other members RSVP', async () => {
    learners = [];
    for (const who of ['one', 'two', 'three']) {
      const learner = await signUp(browser, who);
      await learner.page.goto(`/events/${encodeURIComponent(eventUri)}`);
      await learner.page.getByRole('button', { name: "I'll be there" }).click();
      await expect(learner.page.getByRole('button', { name: "You're going" })).toBeVisible();
      learners.push(learner);
    }
    await host.page.goto(`/events/${encodeURIComponent(eventUri)}`);
    await expect(host.page.getByText('3 going')).toBeVisible();
  });

  await test.step('the host checks off who took part', async () => {
    await host.page.getByRole('link', { name: 'Check off attendance' }).click();
    const checkboxes = host.page.getByRole('checkbox');
    await expect(checkboxes).toHaveCount(3);
    for (let i = 0; i < 3; i++) await checkboxes.nth(i).check();
    await host.page.getByRole('button', { name: 'Save attendance' }).click();
    await expect(host.page.getByText('Thanks — counts updated. Feedback opens for attendees now.')).toBeVisible();
  });

  await test.step('all three leave an anonymous ballot', async () => {
    for (const [i, learner] of learners.entries()) {
      const page = learner.page;
      await page.goto(`/events/${encodeURIComponent(eventUri)}`);
      await page.getByRole('link', { name: 'Leave feedback' }).click();
      await page.getByRole('group', { name: 'Knew the material' }).getByLabel('A lot').check();
      await page.getByRole('group', { name: 'Taught it well' }).getByLabel(i === 2 ? 'Some' : 'A lot').check();
      await page.getByRole('group', { name: 'The experience' }).getByLabel('A lot').check();
      // The required yes/no. The third says no, so the summary is 2 positive / 1 negative.
      await page
        .getByRole('group', { name: 'Would you come to another class by this host?' })
        .getByLabel(i === 2 ? 'Not this time' : 'Yes')
        .check();
      await page.getByLabel('Anything else? (optional)').fill(`E2E note from learner ${i}`);
      await page.getByRole('button', { name: 'Send feedback' }).click();
      await expect(page.getByText('Thanks —')).toBeVisible();
    }
  });

  await test.step('the host sees the summary, released at k=3 and naming nobody', async () => {
    await host.page.goto(`/events/${encodeURIComponent(eventUri)}/feedback-summary`);
    await expect(host.page.getByText('3 people have left feedback.')).toBeVisible();
    await expect(host.page.getByText('2 positive, 1 negative.')).toBeVisible();
    // Free text needs k=5; at three ballots it stays sealed.
    await expect(host.page.getByText(/Written comments stay withheld/)).toBeVisible();
    const body = (await host.page.locator('body').textContent()) ?? '';
    expect(body).not.toContain('did:');
    expect(body).not.toContain('E2E note from learner');
  });

  await test.step('a weekly class materializes its occurrences', async () => {
    const weekly = await postClass(host.page, {
      name: `E2E mending circle (${STAMP})`,
      startsAt: new Date(Date.now() - 2 * 3_600_000),
      endsAt: new Date(Date.now() - 1 * 3_600_000),
      neighborhood: 'Whittier',
      weekly: true,
    });
    expect(weekly.series?.uri).toBeTruthy();

    // `materialize-series` is a pg-boss job; with FREESCHOOL_NO_JOBS=1 nothing runs it, so
    // the test runs it exactly the way the scheduler would — and then indexes what it
    // wrote, which in production is the 15-minute peer backfill's job.
    const stdout = await appviewEval(
      [
        // `materializeSeries`, not `materializeAllSeries`: the job ends each series in a
        // full peer backfill, and a local PDS with a few hundred repos takes ~2 minutes over
        // it. One series is the point here; every old series on the box is not.
        "const { materializeSeries } = await import('./src/jobs/materialize-series.js')",
        "const { getRecord } = await import('./src/lib/pds.js')",
        "const [, , did, collection, rkey] = process.env.SERIES_URI.split('/')",
        'const series = await getRecord(did, collection, rkey)',
        'const result = await materializeSeries(process.env.SERIES_URI, did, series.value)',
        "const { getDb, closeDb } = await import('./src/db/index.js')",
        "const { seriesOccurrence } = await import('./src/db/schema.js')",
        "const { eq } = await import('drizzle-orm')",
        'const rows = await getDb().select().from(seriesOccurrence).where(eq(seriesOccurrence.seriesUri, process.env.SERIES_URI))',
        // In production live sync and the 15-minute backfill index these; here, index them
        // now so the assertion below is about materialization, not about timing. The school's
        // LISTING for each occurrence has to be indexed too — `calendarInclusion` shows an
        // own-host event only when a listing or config says `listed`.
        "const { listRecords } = await import('./src/lib/pds.js')",
        "const { config } = await import('./src/config.js')",
        'const occurrences = new Set(rows.map((r) => r.eventUri))',
        "const listings = await listRecords(config().SCHOOL_DID, 'coop.lexicon.event.listing', config().PDS_URL, 100)",
        'const listed = listings.filter((l) => occurrences.has(l.value?.event?.uri)).map((l) => l.uri)',
        "const { getIndexer } = await import('./src/index/indexer.js')",
        'await (await getIndexer()).notify([...occurrences, ...listed])',
        "console.log('MATERIALIZED ' + rows.length + ' listings ' + listed.length + ' ' + JSON.stringify(result))",
        'await closeDb()',
      ].join('\n'),
      { SERIES_URI: weekly.series!.uri, FREESCHOOL_NO_JOBS: '1' },
    );
    const written = Number(/MATERIALIZED (\d+)/.exec(stdout)?.[1] ?? '0');
    expect(written, `materializer said: ${stdout.trim()}`).toBeGreaterThanOrEqual(3);

    const from = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const to = new Date(Date.now() + 120 * 86_400_000).toISOString();
    const calendar = (await (
      await host.page.request.get(`/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    ).json()) as { events: Array<{ name?: string }> };
    const instances = calendar.events.filter((e) => e.name === `E2E mending circle (${STAMP})`);
    expect(instances.length).toBeGreaterThan(1);
  });

  await test.step('the printable zine carries the class, venue call and all', async () => {
    await host.page.goto('/zine');
    // The zine opens on the current month; the class is 3 hours old, so it is only in the
    // previous one for a run within 3 hours of midnight on the 1st.
    const month = `${new Date(Date.now() - 3 * 3_600_000).getFullYear()}-${String(
      new Date(Date.now() - 3 * 3_600_000).getMonth() + 1,
    ).padStart(2, '0')}`;
    const current = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    if (month !== current) await host.page.getByRole('button', { name: 'Previous month' }).click();
    await expect(host.page.locator('.zine-sheet').getByText(className)).toBeVisible();
    await expect(host.page.locator('.zine-sheet').getByText('Venue needed — got a room?').first()).toBeVisible();
    const zine = (await host.page.locator('body').textContent()) ?? '';
    expect(zine).not.toContain('did:');
  });

  await test.step('"how it works" renders from the school’s own policy', async () => {
    await host.page.goto('/how-it-works');
    await expect(host.page.getByRole('heading', { name: 'How to post a class' })).toBeVisible();
    await expect(host.page.getByRole('heading', { name: 'Who can host' })).toBeVisible();
  });

  await test.step('a steward moves the hosting bar, and a derived role follows it', async () => {
    const before = (await (await learners[0]!.page.request.get('/api/me')).json()) as { role: number };
    expect(before.role).toBeGreaterThanOrEqual(20); // Host, under the default open policy

    // Steward is the one role that cannot be derived, so it is appointed on the host, the
    // same way the README tells an operator to appoint themselves.
    await appviewEval(
      [
        "const { appointSteward } = await import('./scripts/appoint-steward.js')",
        'await appointSteward(process.env.STEWARD_DID)',
        "const { closeDb } = await import('./src/db/index.js')",
        'await closeDb()',
      ].join('\n'),
      { STEWARD_DID: host.did },
    );

    const setHostingBar = async (classesAttended: string, why: string) => {
      await host.page.goto('/admin/policy');
      await expect(host.page.getByRole('heading', { name: 'Role ladder' })).toBeVisible();
      await host.page.getByLabel('Classes attended before someone can host').fill(classesAttended);
      const reason = host.page.getByPlaceholder('A written reason, for the audit log.');
      await reason.fill(why);
      await host.page.getByRole('button', { name: 'Save policy' }).click();
      await expect(host.page.getByText('Saved — takes effect immediately.')).toBeVisible();
      // The screen clears the reason only on a real success, so this is the second proof.
      await expect(reason).toHaveValue('');
    };
    const learnerRole = async () =>
      ((await (await learners[0]!.page.request.get('/api/me')).json()) as { role: number }).role;

    // B3: the restore (back to 0) must run even if the raised-bar assertion below fails —
    // otherwise a failed run leaves the school at `hostMinAttended: 5` for every run after it.
    try {
      await setHostingBar('5', 'E2E: raise the hosting bar');
      // The role is DERIVED, never stored: the same member, the same records, a new answer.
      await expect.poll(learnerRole, { timeout: 20_000 }).toBeLessThan(20);
    } finally {
      // Put it back, both to prove the derivation moves in both directions and so a second
      // `pnpm e2e` against this school can still post a class.
      await setHostingBar('0', 'E2E: put the hosting bar back where it was');
      await expect.poll(learnerRole, { timeout: 20_000 }).toBeGreaterThanOrEqual(20);
    }
  });

  await test.step('Me shows the host their own badges and evidence', async () => {
    await host.page.goto('/me');
    await expect(host.page.getByRole('heading', { name: 'Me', level: 1 })).toBeVisible();
    await expect(host.page.getByRole('heading', { name: 'Badges' })).toBeVisible();
    await host.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await host.page.getByLabel('Display name', { exact: true }).fill(`E2E notebook (${STAMP})`);
    await host.page.getByLabel('Bio', { exact: true }).fill('A fictional profile for testing the shared notebook.');
    await host.page.getByLabel('Share my profile publicly', { exact: true }).check();
    await host.page.getByLabel('Profile image', { exact: true }).setInputFiles(TEST_IMAGE);
    await expect(host.page.getByLabel('Image description (optional)')).toBeVisible();
    await host.page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await host.page.reload();
    await expect(host.page.getByRole('img', { name: 'Your profile image' })).toBeVisible();
    await host.page.goto(`/knowledge/new?event=${encodeURIComponent(eventUri)}`);
    await host.page.getByLabel('Title', { exact: true }).fill(`E2E field notes (${STAMP})`);
    await host.page.getByLabel('Skill', { exact: true }).selectOption({ index: 1 });
    await host.page.getByRole('button', {name:'Link another skill ＋',exact:true}).click();
    await host.page.getByLabel('Additional skill 1',{exact:true}).selectOption({index:2});
    await host.page.getByLabel('License (optional)',{exact:true}).fill('CC0');
    await host.page.getByLabel('Field notes').fill('A useful starting point from our test class.');
    await host.page.getByRole('checkbox', { name: /Publish this resource publicly/ }).check();
    await host.page.getByRole('button', { name: 'Share with the community' }).click();
    await expect(host.page.getByRole('heading', { name: `E2E field notes (${STAMP})`, exact: true })).toBeVisible();
    const resourcePath = new URL(host.page.url()).pathname;
    expect(decodeURIComponent(resourcePath)).toContain(host.did);
    await host.page.getByRole('link', { name: 'Edit these notes' }).click();
    await expect(host.page.getByLabel('License (optional)',{exact:true})).toHaveValue('CC0');
    await expect(host.page.getByLabel('Additional skill 1',{exact:true})).not.toHaveValue('');
    await host.page.getByLabel('Field notes').fill('Revised notes, preserved class connection.');
    await host.page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(host.page.getByText('Revised notes, preserved class connection.')).toBeVisible();
    await expect(host.page.getByRole('link', { name: 'From this class' })).toHaveAttribute('href', `/events/${encodeURIComponent(eventUri)}`);
    const visitor = await browser.newPage();
    await visitor.goto(`/people/${encodeURIComponent(host.did)}`);
    await expect(visitor.getByRole('heading', { name: `E2E notebook (${STAMP})`, exact: true })).toBeVisible();
    await expect(visitor.getByRole('heading', { name: `E2E field notes (${STAMP})`, exact: true })).toBeVisible();
    await host.page.goto('/me');
    await host.page.getByRole('button', { name: 'Edit', exact: true }).click();
    await host.page.getByLabel('Share my profile publicly', { exact: true }).uncheck();
    await host.page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(host.page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    await visitor.reload();
    await expect(visitor.getByRole('heading', { name: 'This profile isn’t available.' })).toBeVisible();
    await visitor.close();
    await host.page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect.poll(async () => (await (await host.page.request.get('/api/auth/me')).json()).did).toBeFalsy();
    await host.page.goto('/me');
    await expect(host.page.getByRole('img', { name: 'Your profile image' })).toHaveCount(0);
  });
});
