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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Browser, type Page } from '@playwright/test';

const exec = promisify(execFile);

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** Where `apps/appview/src/lib/mail.ts` appends mail while `SMTP_URL` is unset. */
const MAIL_LOG = process.env.DEV_MAIL_LOG || fileURLToPath(new URL('../../appview/.dev-mail.log', import.meta.url));

/** Unique per run, so a re-run never reads the previous run's magic link. */
const STAMP = Date.now().toString(36).slice(-5);
const addressFor = (who: string) => `e2e-${who}-${STAMP}@example.org`;

interface Member {
  page: Page;
  did: string;
  address: string;
}

/**
 * The magic link URL, from the dev mail sink, exactly as the mail body wrote it — no
 * extracting the token and rebuilding a URL around it (B4). The mail body currently carries
 * `${APPVIEW_PUBLIC_URL}/api/auth/verify?token=…`; once the backend change lands it will
 * carry `${WEB_PUBLIC_URL}/verify?token=…` (the web app's own `/verify` route) instead — this
 * only has to find whatever URL is actually there and hand it back verbatim. Polled rather
 * than slept on: the signup response returns before the file write has necessarily landed.
 */
async function magicLinkUrl(to: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(MAIL_LOG, 'utf8').catch(() => '');
    // Newest first: a re-verification for the same address supersedes the older link.
    for (const line of text.split('\n').reverse()) {
      if (!line.trim()) continue;
      let mail: { to?: string; body?: string };
      try {
        mail = JSON.parse(line) as { to?: string; body?: string };
      } catch {
        continue;
      }
      if (mail.to !== to) continue;
      const url = /(\S+\/verify\?token=\S+)/.exec(mail.body ?? '')?.[1];
      if (url) return url;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `no magic link for this run's address in ${MAIL_LOG} after ${timeoutMs}ms — ` +
          'is the AppView running with SMTP_URL unset?',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The primary door, through the UI: email → magic link → verified session on Requests. */
async function signUp(browser: Browser, who: string): Promise<Member> {
  const page = await browser.newPage();
  const address = addressFor(who);
  await page.goto('/signin');
  await page.getByLabel('Your email').fill(address);
  await page.getByRole('button', { name: /Create a new Free School identity/ }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  const verifyUrl = await magicLinkUrl(address);
  await page.goto(verifyUrl);
  // PRD §13 constraint 2: verification lands on the needs board, not the calendar.
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
  fields: { name: string; startsAt: Date; endsAt: Date; neighborhood?: string; venueNeeded?: boolean; weekly?: boolean },
): Promise<{ event: { uri: string }; series?: { uri: string }; listing?: { uri: string } }> {
  await page.goto('/events/new');
  await expect(page.getByRole('heading', { name: 'Post a class', level: 1 })).toBeVisible();
  await page.getByLabel('Class title').fill(fields.name);
  await page.getByLabel('Description').fill('Bring a jar. We will talk about flour.');
  await page.getByLabel('Starts').fill(localValue(fields.startsAt));
  await page.getByLabel('Ends').fill(localValue(fields.endsAt));
  if (fields.venueNeeded) {
    await page.getByLabel("Venue needed — we don't have a room for this yet").check();
  }
  if (fields.neighborhood) {
    await page.getByLabel('Neighbourhood (shown publicly, e.g. "North Boulder")').fill(fields.neighborhood);
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
  const className = `E2E sourdough (${STAMP})`;
  const requestTitle = `E2E: someone teach me to sharpen things (${STAMP})`;

  await test.step('a new member signs up with an email and lands on Requests', async () => {
    host = await signUp(browser, 'host');
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
  });

  await test.step('they post a class with no venue yet', async () => {
    // In the recent past, so attendance and the feedback window are both open — the same
    // shape `scripts/smoke.ts` uses.
    // NO neighbourhood, deliberately: `venueNeeded` is derived as "no address AND no
    // neighbourhood" (`isVenueNeeded`, apps/appview/src/http/visibility.ts), so a class with
    // a neighbourhood is never flagged venue-needed even with the editor's box ticked.
    const created = await postClass(host.page, {
      name: className,
      startsAt: new Date(Date.now() - 3 * 3_600_000),
      endsAt: new Date(Date.now() - 2 * 3_600_000),
      venueNeeded: true,
    });
    eventUri = created.event.uri;
    expect(eventUri).toContain(host.did); // the class lives in the HOST's repo
    expect(created.listing?.uri).toBeTruthy(); // tagged `skillshare` → the school lists it
    expect(created.listing?.uri).not.toContain(host.did); // …from the SCHOOL's repo
    await expect(host.page.getByText('Venue needed', { exact: true })).toBeVisible();
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
    await expect(host.page.getByText(className)).toBeVisible();
    await expect(host.page.getByText('Venue needed — got a room?').first()).toBeVisible();
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
  });
});
