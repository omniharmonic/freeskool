/**
 * Five journeys through the whole product, as five different people, against the seeded
 * dev stack (`pnpm --filter @freeschool/appview seed:demo`).
 *
 *   pnpm --filter @freeschool/web exec playwright test e2e/personas.spec.ts
 *
 * Spec §4.6 items 1-5, one `describe.serial` each, in the order a school actually works:
 * somebody arrives, somebody asks for a class, somebody teaches one, a steward tends the
 * commons, and somebody comes back a second time.
 *
 * EVERY ASSERTION IS SOMETHING A PERSON CAN SEE — a heading, a button's label, a count in
 * a sentence. Nothing here reads the database, and nothing reaches for an id the screen
 * does not already carry. Where a journey needs a fixture the seed has no opinion about
 * (a class in the past hosted by Amir, a skill proposed this minute), the test MAKES it
 * the way a member would, through the same screens, and says so in the step name.
 *
 * RE-RUNNABLE. Names carry a per-run `STAMP`, and the two steps that toggle something
 * (an RSVP, a vouch) read the current state first and drive it to a known one, so a
 * second run against the same stack asserts the same movement rather than a no-op.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { demoUser, openMagicLink, signInAs, skillUriFor, verifyUrlFrom } from './personas';

/** Unique per run: a name typed into a form must never collide with the last run's. */
const STAMP = Date.now().toString(36).slice(-5);

/** `YYYY-MM-DDTHH:mm` in the browser's own zone — what a `datetime-local` wants. */
function localValue(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The class page's own address, found the way the calendar finds it: by name. */
async function eventUrlByName(page: Page, name: string): Promise<string> {
  const from = new Date(Date.now() - 90 * 24 * 3_600_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 200 * 24 * 3_600_000).toISOString().slice(0, 10);
  const res = await page.request.get(`/api/calendar?from=${from}&to=${to}`);
  const { events } = (await res.json()) as { events: Array<{ uri: string; name: string }> };
  const found = events.find((event) => event.name === name);
  if (!found) throw new Error(`no class named "${name}" on the calendar — has the demo seed been run?`);
  return `/events/${encodeURIComponent(found.uri)}`;
}

/** Type into a `SkillPicker` and take the offered match. */
async function pickSkill(scope: Locator, typed: string, label: string) {
  await scope.getByRole('combobox').fill(typed);
  await scope.getByRole('option').filter({ hasText: label }).first().click();
}

/** "3 vouches" / "1 vouch" / "No vouches yet", as a number. */
function readVouches(text: string | null): number {
  if (!text) return 0;
  const match = /(\d+)\s+vouch/.exec(text);
  return match ? Number(match[1]) : 0;
}

/* ------------------------------------------------------------------------- *
 * 1. The newcomer
 * ------------------------------------------------------------------------- */

test.describe.serial('1. A newcomer arrives, chooses a handle, and turns up in the directory', () => {
  let page: Page;
  const address = `newcomer-${STAMP}@example.org`;
  const prefix = `wren${STAMP}`;
  const name = `Wren ${STAMP}`;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('the email door lands a brand-new member on /welcome', async () => {
    await page.goto('/signin');
    await page.getByLabel('Your email').fill(address);
    const door = page.waitForResponse((res) => res.url().includes('/api/auth/signin'));
    await page.getByRole('button', { name: /Continue with email/ }).click();
    const sent = await door;
    expect(sent.ok(), `the door answered ${sent.status()}`).toBe(true);
    await expect(page.getByText('Check your email')).toBeVisible();

    await openMagicLink(page, await verifyUrlFrom(await sent.json().catch(() => null), address));
    await expect(page.getByRole('heading', { name: 'Welcome to Free School', level: 1 })).toBeVisible();
    await expect(page.getByText('Step 1 of 3')).toBeVisible();
  });

  test('a taken handle is refused by name and a free one saves', async () => {
    await page.getByRole('button', { name: 'Choose my own' }).click();
    // `maya.test` belongs to a seeded persona, so the prefix is gone.
    await page.getByLabel('Your handle').fill('maya');
    await expect(page.getByText('That handle is taken. Try another.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save this handle' })).toBeDisabled();

    await page.getByLabel('Your handle').fill(prefix);
    await expect(page.getByText(`${prefix}.test is free`)).toBeVisible();
    await page.getByRole('button', { name: 'Save this handle' }).click();
    await expect(page.getByText(`${prefix}.test`, { exact: true })).toBeVisible();
  });

  test('a name and a line about themselves save', async () => {
    await page.getByLabel('Display name').fill(name);
    await page.getByLabel('A line about you').fill('Just moved here. Mostly here for the bread.');
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(page.getByRole('button', { name: 'Save and continue' })).toBeVisible();
    await expect(page.getByText('Step 3 of 3')).toBeVisible();
  });

  test('two skills are found by typing, and Finish lands on the requests board', async () => {
    const card = page.locator('section').filter({ hasText: 'What could you share?' });
    await pickSkill(card, 'sourdough', 'Bake sourdough bread');
    await pickSkill(card, 'bicycle', 'Bicycle mechanics');
    await expect(card.getByRole('button', { name: 'Remove Bake sourdough bread' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Remove Bicycle mechanics' })).toBeVisible();
    await page.getByRole('button', { name: 'Save these skills' }).click();

    await page.getByRole('button', { name: 'Finish' }).click();
    await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible();
  });

  test('they are in People, and on both of the skill pages they chose', async () => {
    await page.goto('/people');
    await page.getByLabel('Search people by name').fill(name);
    await expect(page.getByRole('link', { name: new RegExp(name) })).toBeVisible();

    for (const id of ['bake-sourdough-bread', 'bicycle-mechanics']) {
      await page.goto(`/skills/${encodeURIComponent(await skillUriFor(page, id))}`);
      const people = page.locator('section').filter({ has: page.getByRole('heading', { name: 'People with this skill' }) });
      await expect(people.getByRole('link', { name: new RegExp(name) })).toBeVisible();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * 2. The learner
 * ------------------------------------------------------------------------- */

test.describe.serial('2. A learner asks for a class, RSVPs, and vouches for the host', () => {
  let page: Page;
  const requestTitle = `Fermenting without fear (${STAMP})`;
  const className = 'Three chords and a singalong';
  const guitar = 'Learn guitar chords and strumming';
  let guitarSkillUrl = '';
  let jonahRow: Locator;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signInAs(page, 'rosa');
    guitarSkillUrl = `/skills/${encodeURIComponent(await skillUriFor(page, 'learn-guitar-chords-and-strumming'))}`;
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('she asks for a class by typing "ferment" and taking the match', async () => {
    await page.goto('/requests');
    await page.getByRole('button', { name: 'Ask for one' }).click();
    const sheet = page.getByRole('dialog', { name: 'Ask for a class' });
    await sheet.getByLabel('What do you want to learn?').fill(requestTitle);
    await sheet.getByLabel('Anything that would help a teacher say yes').fill('I have three jars and no idea.');
    await pickSkill(sheet, 'ferment', 'Ferment vegetables');
    await sheet.getByRole('button', { name: 'Post this request' }).click();
    await expect(page.getByRole('dialog', { name: 'Asked' })).toBeVisible();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: requestTitle })).toBeVisible();
  });

  test('she RSVPs to a class on the calendar', async () => {
    await page.goto(await eventUrlByName(page, className));
    await expect(page.getByRole('heading', { name: className, level: 1 })).toBeVisible();
    // A re-run starts where the last one finished: withdraw, then RSVP for real.
    const going = page.getByRole('button', { name: "You're going" });
    if (await going.isVisible().catch(() => false)) {
      await going.click();
      await expect(page.getByRole('button', { name: "I'll be there" })).toBeVisible();
    }
    await page.getByRole('button', { name: "I'll be there" }).click();
    await expect(page.getByRole('button', { name: "You're going" })).toBeVisible();
  });

  test('the class names its host, and the name opens their profile', async () => {
    await expect(page.getByRole('heading', { name: "Who's teaching" })).toBeVisible();
    await page.getByRole('link', { name: 'Jonah' }).click();
    await expect(page.getByRole('heading', { name: 'Jonah', level: 1 })).toBeVisible();
    // Scoped to the claims section: a badge in the header says the same words.
    const claims = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'What they say they can do' }) });
    jonahRow = claims.getByRole('listitem').filter({ hasText: guitar });
    await expect(jonahRow.getByRole('link', { name: guitar })).toBeVisible();
  });

  test('her vouch raises the count on his profile and on the skill page', async () => {
    // Drive to "not vouched" first, so the movement below is real on a re-run.
    const vouched = jonahRow.getByRole('button', { name: 'Vouched ✓' });
    if (await vouched.isVisible().catch(() => false)) {
      await vouched.click();
      await expect(jonahRow.getByRole('button', { name: 'Vouch', exact: true })).toBeVisible();
    }
    const before = readVouches(await jonahRow.textContent());

    await jonahRow.getByRole('button', { name: 'Vouch', exact: true }).click();
    await expect(jonahRow.getByRole('button', { name: 'Vouched ✓' })).toBeVisible();
    await expect(jonahRow).toContainText(`${before + 1} ${before + 1 === 1 ? 'vouch' : 'vouches'}`);

    await page.goto(guitarSkillUrl);
    const people = page.locator('section').filter({ has: page.getByRole('heading', { name: 'People with this skill' }) });
    await expect(people.getByRole('link', { name: /Jonah/ })).toContainText(
      `${before + 1} ${before + 1 === 1 ? 'vouch' : 'vouches'}`,
    );
  });
});

/* ------------------------------------------------------------------------- *
 * 3. The host
 * ------------------------------------------------------------------------- */

test.describe.serial('3. A host posts a class, checks attendance, and reads the summary', () => {
  let host: Page;
  let learner: Page;
  const className = `Bike clinic (${STAMP})`;
  let classUrl = '';

  test.beforeAll(async ({ browser }) => {
    host = await browser.newPage();
    learner = await browser.newPage();
    await signInAs(host, 'amir');
    await signInAs(learner, 'theo');
  });
  test.afterAll(async () => {
    await host.close();
    await learner.close();
  });

  test('he posts a class and finds its skill by typing', async () => {
    // In the RECENT PAST, because the seed gives Amir no past class and the two
    // steps after this one (attendance, feedback) only exist once a class is over.
    const startsAt = new Date(Date.now() - 3 * 3_600_000);
    const endsAt = new Date(Date.now() - 2 * 3_600_000);
    await host.goto('/events/new');
    await expect(host.getByRole('heading', { name: 'Post a class', level: 1 })).toBeVisible();
    await host.getByLabel('Class title').fill(className);
    await host.getByLabel('About this class', { exact: true }).fill('Bring the bike that makes the noise.');
    await host.getByLabel('Starts').fill(localValue(startsAt));
    await host.getByLabel('Ends').fill(localValue(endsAt));
    const skill = host.locator('#class-skill');
    await pickSkill(skill, 'bicycle', 'Bicycle mechanics');
    await expect(skill.getByText('Bicycle mechanics')).toBeVisible();
    await host.getByRole('button', { name: '+ skillshare', exact: true }).click();

    await host.getByRole('button', { name: 'Post this class' }).click();
    await expect(host.getByRole('heading', { name: className, level: 1 })).toBeVisible();
    classUrl = new URL(host.url()).pathname;
    await expect(host.getByRole('link', { name: 'Bicycle mechanics ↗' })).toBeVisible();
  });

  test('a learner RSVPs and the host sees the count', async () => {
    await learner.goto(classUrl);
    await learner.getByRole('button', { name: "I'll be there" }).click();
    await expect(learner.getByRole('button', { name: "You're going" })).toBeVisible();

    await host.goto(classUrl);
    await expect(host.getByText('1 going')).toBeVisible();
  });

  test('he checks off who took part', async () => {
    await host.getByRole('link', { name: 'Check off attendance' }).click();
    const box = host.getByRole('checkbox', { name: /participated$/ });
    await expect(box).toHaveCount(1);
    await box.check();
    await host.getByRole('button', { name: 'Save attendance' }).click();
    await expect(host.getByText('Thanks — counts updated. Feedback opens for attendees now.')).toBeVisible();
  });

  test('the attendee leaves anonymous feedback and the host reads the summary', async () => {
    await learner.goto(classUrl);
    await learner.getByRole('link', { name: 'Leave feedback' }).click();
    await learner.getByRole('group', { name: 'Knew the material' }).getByLabel('A lot').check();
    await learner.getByRole('group', { name: 'Taught it well' }).getByLabel('A lot').check();
    await learner.getByRole('group', { name: 'The experience' }).getByLabel('A lot').check();
    await learner
      .getByRole('group', { name: 'Would you come to another class by this host?' })
      .getByLabel('Yes')
      .check();
    await learner.getByRole('button', { name: 'Send feedback' }).click();
    await expect(learner.getByText('Thanks —')).toBeVisible();

    await host.goto(`${classUrl}/feedback-summary`);
    await expect(host.getByText('1 person has left feedback.')).toBeVisible();
    // Nothing about who: one ballot is under every k in the policy.
    const body = (await host.locator('body').textContent()) ?? '';
    expect(body).not.toContain('did:');
  });

  test('"Who vouched" on his own page names Rosa', async () => {
    const amir = await demoUser('amir');
    await host.goto(`/people/${encodeURIComponent(amir.did)}`);
    const row = host.getByRole('listitem').filter({ hasText: 'Bicycle mechanics' });
    await row.getByRole('button', { name: /Who vouched/ }).click();
    await expect(row.getByText('Rosa')).toBeVisible();
  });
});

/* ------------------------------------------------------------------------- *
 * 4. The steward
 * ------------------------------------------------------------------------- */

test.describe.serial('4. A steward proposes a skill, retires it, and walks the admin screens', () => {
  let page: Page;
  const proposed = `Scythe sharpening ${STAMP}`;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await signInAs(page, 'steward');
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('the overview lists every steward tool', async () => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Steward tools', level: 1 })).toBeVisible();
    for (const tool of ['Policy', 'Moderation', 'Peers', 'Proposed skills', 'Newsletter', 'Hand-off']) {
      await expect(page.getByRole('heading', { name: tool, exact: true })).toBeVisible();
    }
  });

  test('she proposes a skill the taxonomy is missing, from inside a picker', async () => {
    await page.goto('/requests');
    await page.getByRole('button', { name: 'Ask for one' }).click();
    const sheet = page.getByRole('dialog', { name: 'Ask for a class' });
    await sheet.getByRole('combobox').fill(proposed);
    await sheet.getByRole('option', { name: "Can't find it? Propose a skill" }).click();

    const proposeSheet = page.getByRole('dialog', { name: 'Propose a skill' });
    await expect(proposeSheet.getByLabel('What is it called?')).toHaveValue(proposed);
    await proposeSheet.getByLabel('A line about it (optional)').fill('Peening and honing a scythe blade.');
    await pickSkill(proposeSheet, 'Practical', 'Practical trades');
    await proposeSheet.getByRole('button', { name: 'Propose this skill' }).click();
    await expect(proposeSheet).toBeHidden();
    // The calling picker now holds the new skill, under the name she typed.
    await expect(sheet.getByText(proposed)).toBeVisible();
  });

  test('she retires it from /admin/skills', async () => {
    await page.goto('/admin/skills');
    const row = page.getByRole('listitem').filter({ hasText: proposed });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Deprecate' }).click();
    const confirm = page.getByRole('dialog', { name: 'Deprecate this skill?' });
    await confirm.getByRole('button', { name: 'Deprecate' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByRole('listitem').filter({ hasText: proposed })).toContainText('Deprecated.');
  });

  test('moderation, policy, newsletter and hand-off all render', async () => {
    await page.goto('/admin/moderation');
    await expect(page.getByRole('heading', { name: 'Moderation', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open an item' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Queue' })).toBeVisible();

    await page.goto('/admin/policy');
    await expect(page.getByRole('heading', { name: 'Policy', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Role ladder' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Policy text' })).toBeVisible();

    // Composing is the whole of the newsletter screen; sending is deliberately not done
    // here — it would mail every member of the demo school.
    await page.goto('/admin/newsletter');
    await expect(page.getByRole('heading', { name: 'Newsletter', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Compose draft' }).click();
    await expect(page.getByRole('heading', { name: 'Preview' })).toBeVisible();

    await page.goto('/admin/handoff');
    await expect(page.getByRole('heading', { name: 'Hand-off', level: 1 })).toBeVisible();
  });
});

/* ------------------------------------------------------------------------- *
 * 5. The returning member
 * ------------------------------------------------------------------------- */

test.describe.serial('5. A member comes back through a second link and finds herself intact', () => {
  test('Rosa signs in again and her profile is still hers', async ({ browser }) => {
    const page = await browser.newPage();
    const rosa = await signInAs(page, 'rosa');
    await page.goto('/me');
    await expect(page.getByRole('heading', { name: 'Me', level: 1 })).toBeVisible();
    const card = page.locator('#my-profile');
    await expect(card.getByText(rosa.displayName, { exact: true })).toBeVisible();
    await expect(card.getByText(rosa.handle, { exact: true })).toBeVisible();
    await expect(card.getByText(/New to the neighbourhood/)).toBeVisible();
    await page.close();
  });
});
