/**
 * Env parsing. Everything the AppView needs is declared here and nowhere else.
 *
 * Privacy note (R9): nothing in this file is ever logged. `redactedConfig()` is the
 * only thing allowed near a log line.
 */
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const csv = (s: string) =>
  s.split(',').map((x) => x.trim()).filter(Boolean)

const b64key = z
  .string()
  .refine((s) => {
    try {
      return Buffer.from(s, 'base64').length === 32
    } catch {
      return false
    }
  }, 'must be base64 of exactly 32 bytes')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().default('postgres://freeschool:freeschool@localhost:5434/freeschool'),
  APPVIEW_PORT: z.coerce.number().int().positive().default(4000),
  APPVIEW_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
  /** The PWA's own origin. Invite links point here. Falls back to APPVIEW_PUBLIC_URL. */
  WEB_PUBLIC_URL: z.string().url().optional(),

  /** Our reference PDS — the primary door mints accounts here. */
  PDS_URL: z.string().url().default('http://localhost:3000'),
  PDS_ADMIN_PASSWORD: z.string().default(''),
  /**
   * Handle domain for generated handles, WITHOUT a leading dot, e.g. `test`
   * produces `calm-otter-417.test`. Must be one of the PDS's
   * PDS_SERVICE_HANDLE_DOMAINS and must not be a reserved TLD
   * (`.localhost` IS reserved — see README "Local PDS handle domain").
   */
  PDS_HANDLE_DOMAIN: z.string().default('test'),

  /** The school DID the hosted service custodies in v1. */
  SCHOOL_DID: z.string().default(''),
  SCHOOL_HANDLE: z.string().default(''),
  SCHOOL_APP_PASSWORD: z.string().default(''),

  /** Taxonomy authority DID: when set, the skill tree/detail routes ignore skill records from any other DID. */
  AUTHORITY_DID: z.string().default(''),
  /** Handle for the taxonomy authority account (ops/documentation use only). */
  AUTHORITY_HANDLE: z.string().default(''),
  /** App password for the taxonomy authority account (used by seed/admin scripts, never logged). */
  AUTHORITY_PASSWORD: z.string().default(''),

  /** Peer registry seed. The school record's `peers` field adds more at runtime. */
  PEER_PDS_HOSTS: z.string().default('http://localhost:3000').transform(csv),

  /** Hosts allowed past contrail's SSRF guard (local/private PDSes). */
  ALLOWED_PRIVATE_PDS_HOSTS: z.string().default('localhost,127.0.0.1,host.docker.internal').transform(csv),

  /**
   * Live indexing from peer PDS hosts over `com.atproto.sync.subscribeRepos`
   * (src/sync/README.md). On by default — the 15-minute `backfillFromPeers` job is
   * the safety net beneath it, not the primary path. Set `PEER_LIVE_SYNC=0` to run
   * on the backfill alone.
   */
  PEER_LIVE_SYNC: z.stringbool().default(true),

  CONTRAIL_NAMESPACE: z.string().default('org.freeschool.appview'),
  /** Jetstream live ingest only makes sense on the public network; off locally. */
  CONTRAIL_LIVE_INGEST: z.stringbool().default(false),
  CONTRAIL_ORDERED_SOURCE_EPOCH: z.string().default('freeschool-dev-1'),

  /** Signed-cookie session secret. Sessions themselves live in Postgres. */
  SESSION_SECRET: z.string().min(16).default('dev-only-session-secret-change-me'),
  SESSION_COOKIE: z.string().default('fs_session'),
  SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /** Versioned AES-256-GCM keys for custodial account passwords: `v1:<base64>,v2:<base64>`. */
  CUSTODY_KEYS: z
    .string()
    .default('v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=')
    .transform((s, ctx) => {
      const out = new Map<string, Buffer>()
      for (const part of csv(s)) {
        const i = part.indexOf(':')
        const version = part.slice(0, i)
        const raw = part.slice(i + 1)
        if (!version || !b64key.safeParse(raw).success) {
          ctx.addIssue({ code: 'custom', message: `CUSTODY_KEYS entry "${version}" is not v<n>:<base64 32 bytes>` })
          continue
        }
        out.set(version, Buffer.from(raw, 'base64'))
      }
      if (out.size === 0) ctx.addIssue({ code: 'custom', message: 'CUSTODY_KEYS must contain at least one key' })
      return out
    }),
  CUSTODY_KEY_VERSION: z.string().default('v1'),

  /** Pepper mixed into each per-event feedback ballot key before it is derived. */
  FEEDBACK_BALLOT_PEPPER: z.string().default('dev-only-ballot-pepper'),

  /** Confidential OAuth client private key (JWK JSON). Generated at boot if absent. */
  OAUTH_PRIVATE_JWK: z.string().optional(),

  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default('mailto:hello@example.org'),

  SMTP_URL: z.string().default(''),
  MAIL_FROM: z.string().default('Free School <no-reply@localhost>'),
  /**
   * DEV ONLY. With `SMTP_URL` unset, every outgoing mail is appended as one JSON line to
   * this file (`{to, subject, body, at}`) so a local run — and the Playwright e2e, which
   * reads the magic link from it — can see a link that must never reach a log line.
   * Defaults to `apps/appview/.dev-mail.log` (gitignored). Ignored once SMTP is configured.
   */
  DEV_MAIL_LOG: z.string().default(''),
})

export type Config = z.infer<typeof schema> & {
  /** `<word><word><3 digits>.<handleDomain>` */
  handleDomain: string
  /**
   * Whether the SECONDARY door (sign in with an existing account) can work at all on this
   * origin. A CONFIDENTIAL ATProto OAuth client — which a BFF must be, since it holds a
   * private signing key — requires a `client_id` over `https:` with a real hostname:
   * `@atproto/oauth-types` rejects `http:` ("URL must use the https: protocol"), rejects an
   * IP literal ("ClientID hostname must not be an IP address"), and RFC 8252 rejects the
   * `localhost` hostname. The `http://localhost?redirect_uri=...` development form is a
   * PUBLIC client and cannot carry a keyset.
   *
   * So on `http://localhost:4000` the OAuth routes answer 503 with that explanation rather
   * than a validation dump. The primary door (a new Free School identity) is unaffected and
   * is what local development uses.
   */
  oauthUsable: boolean
  oauthClientId: string
  isProd: boolean
  /** WEB_PUBLIC_URL, or APPVIEW_PUBLIC_URL when the PWA is not given its own origin. */
  webPublicUrl: string
  /** Resolved `DEV_MAIL_LOG`: where `lib/mail.ts` appends mail when SMTP is unset. */
  devMailLog: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env)
  const publicUrl = parsed.APPVIEW_PUBLIC_URL.replace(/\/$/, '')
  if (!parsed.CUSTODY_KEYS.has(parsed.CUSTODY_KEY_VERSION)) {
    throw new Error(`CUSTODY_KEY_VERSION ${parsed.CUSTODY_KEY_VERSION} is not present in CUSTODY_KEYS`)
  }
  /**
   * A production deployment with no SMTP transport cannot sign ANYBODY in: the primary
   * door is a magic link, and the dev fallback appends it to a FILE on the server — which
   * in production is both useless to the member and a plaintext magic-link log. Refuse at
   * boot rather than accept signups nobody can complete. (`DEV_MAIL_LOG` is ignored once
   * SMTP is set; there is no production use for it.)
   */
  if (parsed.NODE_ENV === 'production' && !parsed.SMTP_URL) {
    throw new Error(
      'SMTP_URL is required when NODE_ENV=production: the magic-link door cannot work without a mail ' +
        'transport, and the dev file sink would write magic links to disk instead of sending them.',
    )
  }
  return {
    ...parsed,
    APPVIEW_PUBLIC_URL: publicUrl,
    handleDomain: parsed.PDS_HANDLE_DOMAIN.replace(/^\./, ''),
    oauthUsable: isConfidentialClientOrigin(publicUrl),
    // A confidential client's client_id IS the metadata URL.
    oauthClientId: `${publicUrl}/oauth/client-metadata.json`,
    isProd: parsed.NODE_ENV === 'production',
    webPublicUrl: (parsed.WEB_PUBLIC_URL ?? publicUrl).replace(/\/$/, ''),
    // `src/config.ts` -> `apps/appview/.dev-mail.log`.
    devMailLog: parsed.DEV_MAIL_LOG || fileURLToPath(new URL('../.dev-mail.log', import.meta.url)),
  }
}

const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^\[/

function isConfidentialClientOrigin(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname !== 'localhost' && !IP_LITERAL.test(u.hostname)
  } catch {
    return false
  }
}

/** The ONLY config shape allowed near a log line. */
export function redactedConfig(c: Config) {
  return {
    env: c.NODE_ENV,
    port: c.APPVIEW_PORT,
    publicUrl: c.APPVIEW_PUBLIC_URL,
    oauthUsable: c.oauthUsable,
    pds: c.PDS_URL,
    handleDomain: c.handleDomain,
    peers: c.PEER_PDS_HOSTS.length,
    schoolConfigured: Boolean(c.SCHOOL_DID && c.SCHOOL_APP_PASSWORD),
    liveIngest: c.CONTRAIL_LIVE_INGEST,
    peerLiveSync: c.PEER_LIVE_SYNC,
    custodyKeyVersion: c.CUSTODY_KEY_VERSION,
    push: Boolean(c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY),
    smtp: Boolean(c.SMTP_URL),
  }
}

let cached: Config | undefined
export function config(): Config {
  return (cached ??= loadConfig())
}

/**
 * Drop the memoized config. Only scripts that mint the school call this: `SCHOOL_DID` and
 * `SCHOOL_APP_PASSWORD` do not exist until the school account has been created, so the
 * bootstrap path has to re-read the environment once mid-process.
 */
export function resetConfig(): void {
  cached = undefined
}
