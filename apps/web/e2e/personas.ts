/**
 * The demo cast, for Playwright.
 *
 * `pnpm --filter @freeschool/appview seed:demo` writes `apps/appview/.demo-users.json`;
 * this module reads it back and signs a browser in as any of them, through the REAL
 * primary door — `POST /api/auth/signin`, then the magic link out of the dev mail sink.
 * There is no test-only back door into a session, deliberately: a persona journey that
 * skipped the door would stop proving the door works.
 *
 *   import { loadDemoUsers, signInAs } from './personas';
 *
 *   const amir = await signInAs(page, 'amir');
 *
 * `magicLinkUrl` lives here rather than in `mvp.spec.ts` because both need it; the spec
 * imports it back from this module.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';

/** Where `apps/appview/src/lib/mail.ts` appends mail while `SMTP_URL` is unset. */
export const MAIL_LOG =
  process.env.DEV_MAIL_LOG || fileURLToPath(new URL('../../appview/.dev-mail.log', import.meta.url));

/** Written by `apps/appview/scripts/seed-demo.ts`. Gitignored — it holds addresses and DIDs. */
export const DEMO_USERS_PATH = fileURLToPath(new URL('../../appview/.demo-users.json', import.meta.url));

export type PersonaIntent = 'host' | 'learner' | 'facilitator-to-be' | 'steward';

export interface DemoUser {
  slug: string;
  did: string;
  handle: string;
  email: string;
  displayName: string;
  intent: PersonaIntent;
}

/**
 * The magic link URL, from the dev mail sink, exactly as the mail body wrote it — no
 * extracting the token and rebuilding a URL around it (B4). The mail body currently carries
 * `${WEB_PUBLIC_URL}/verify?token=…` (the web app's own `/verify` route); this only has to
 * find whatever URL is actually there and hand it back verbatim. Polled rather than slept
 * on: the signup response returns before the file write has necessarily landed.
 */
export async function magicLinkUrl(to: string, timeoutMs = 20_000): Promise<string> {
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

let cached: DemoUser[] | undefined;

/** The seeded cast. Throws with the command to run when the fixture is not there yet. */
export async function loadDemoUsers(): Promise<DemoUser[]> {
  if (cached) return cached;
  const raw = await readFile(DEMO_USERS_PATH, 'utf8').catch(() => undefined);
  if (!raw) {
    throw new Error(
      `no demo cast at ${DEMO_USERS_PATH} — run it first:\n` +
        '  set -a; . ./.env; set +a\n' +
        '  pnpm --filter @freeschool/appview seed:demo',
    );
  }
  cached = JSON.parse(raw) as DemoUser[];
  return cached;
}

export async function demoUser(slug: string): Promise<DemoUser> {
  const user = (await loadDemoUsers()).find((u) => u.slug === slug);
  if (!user) {
    const known = (await loadDemoUsers()).map((u) => u.slug).join(', ');
    throw new Error(`no seeded persona "${slug}" — the cast is: ${known}`);
  }
  return user;
}

/**
 * Sign `page` in as a seeded persona, through the primary door: `POST /api/auth/signin`
 * (the same handler `/signup` uses — it resends for a known email rather than minting a
 * second account), then the magic link. `page.request` shares the page's cookie jar, so
 * the session the link opens is the one the page then browses with.
 */
export async function signInAs(page: Page, slug: string): Promise<DemoUser> {
  const user = await demoUser(slug);
  const res = await page.request.post('/api/auth/signin', { data: { email: user.email } });
  if (!res.ok()) throw new Error(`POST /api/auth/signin for "${slug}" -> ${res.status()} ${await res.text()}`);
  await page.goto(await magicLinkUrl(user.email));
  return user;
}

/**
 * A brand-new member, not one of the cast — for the journeys that are ABOUT arriving.
 * `address` should be unique per run (the seed's own addresses are all `@freeskool.test`,
 * so keep fresh ones off that domain to avoid colliding with a persona).
 */
export async function signUpFresh(page: Page, address: string): Promise<{ did: string; address: string }> {
  const res = await page.request.post('/api/auth/signup', { data: { email: address } });
  if (!res.ok()) throw new Error(`POST /api/auth/signup for a fresh member -> ${res.status()} ${await res.text()}`);
  await page.goto(await magicLinkUrl(address));
  const me = (await (await page.request.get('/api/auth/me')).json()) as { did: string };
  if (!me.did?.startsWith('did:')) throw new Error('signed up but no session: /api/auth/me returned no DID');
  return { did: me.did, address };
}
