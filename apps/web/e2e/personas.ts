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
 * The magic link for a door response that has already been read.
 *
 * In development the AppView hands the link straight back to whoever posted the form
 * (`verifyUrl` in `POST /api/auth/{signin,signup}`'s 201 — withheld the moment SMTP is
 * configured, and always in production), and that is the SAME one-time token the mail
 * carries. Preferring it over the sink is not a back door: it is the same door, read from
 * the response instead of from a file that every other process on this machine also
 * writes to. The dev sink is truncated at boot (`resetDevMailSink`), so a concurrent
 * `pnpm --filter @freeschool/appview test` run erases the line this test is waiting for —
 * that race is what this avoids. The sink stays the fallback, so a stack that has stopped
 * echoing the link still works.
 */
export async function verifyUrlFrom(body: unknown, to: string): Promise<string> {
  const url = (body as { verifyUrl?: unknown } | null)?.verifyUrl;
  if (typeof url === 'string' && url.includes('/verify?token=')) return url;
  return magicLinkUrl(to);
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
  await openMagicLink(page, await verifyUrlFrom(await res.json().catch(() => null), user.email));
  return user;
}

/**
 * Open a magic link and WAIT FOR THE SESSION, not just for the page.
 *
 * `/verify` sets the cookie from inside the browser (`api.auth.verify`, then a navigation
 * to `/welcome` or wherever the member was headed), so `page.goto()` resolving means the
 * verify screen has mounted — not that it has finished. A caller that went straight on to
 * `page.request.get('/api/auth/me')` was racing that fetch, and won or lost it depending
 * on how long the magic link took to find. Leaving `/verify` is the observable end of it.
 */
export async function openMagicLink(page: Page, url: string): Promise<void> {
  // Opened RELATIVE to the suite's own `baseURL`, token and query untouched: the AppView
  // builds the link from its `WEB_PUBLIC_URL`, which names whichever PWA that AppView
  // thinks is in front of it — not necessarily the one this run was pointed at
  // (`E2E_BASE_URL`, and the `APPVIEW_PROXY_TARGET` escape hatch in `vite.config.ts`).
  // Following the host verbatim there signs a DIFFERENT app in and leaves this page
  // signed out, which reads as a broken door rather than as a mismatched stack.
  const link = new URL(url);
  await page.goto(`${link.pathname}${link.search}`);
  await page.waitForURL((current) => !current.pathname.startsWith('/verify'), { timeout: 30_000 });
}

/** One node of `GET /api/skills`' tree, as much of it as these journeys read. */
interface SkillTreeNode {
  uri: string;
  id: string;
  label: string;
  children?: SkillTreeNode[];
}

/**
 * The stable `at://` URI of a taxonomy skill, by its seed id
 * (`infra/seed/skills/skills-seed.jsonl`) — every skill-shaped URL in the app is that
 * URI, percent-encoded, and no test should hard-code the authority DID to build one.
 */
export async function skillUriFor(page: Page, id: string): Promise<string> {
  const res = await page.request.get('/api/skills');
  if (!res.ok()) throw new Error(`GET /api/skills -> ${res.status()}`);
  const { skills } = (await res.json()) as { skills: SkillTreeNode[] };
  const stack = [...skills];
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.id === id) return node.uri;
    stack.push(...(node.children ?? []));
  }
  throw new Error(`no skill "${id}" in the taxonomy — has the seed been loaded?`);
}

/**
 * A brand-new member, not one of the cast — for the journeys that are ABOUT arriving.
 * `address` should be unique per run (the seed's own addresses are all `@freeskool.test`,
 * so keep fresh ones off that domain to avoid colliding with a persona).
 */
export async function signUpFresh(page: Page, address: string): Promise<{ did: string; address: string }> {
  const res = await page.request.post('/api/auth/signup', { data: { email: address } });
  if (!res.ok()) throw new Error(`POST /api/auth/signup for a fresh member -> ${res.status()} ${await res.text()}`);
  await openMagicLink(page, await verifyUrlFrom(await res.json().catch(() => null), address));
  const me = (await (await page.request.get('/api/auth/me')).json()) as { did: string };
  if (!me.did?.startsWith('did:')) throw new Error('signed up but no session: /api/auth/me returned no DID');
  return { did: me.did, address };
}
