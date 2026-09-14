/**
 * The SECONDARY door: sign in with an existing ATProto account.
 *
 * Server-side (BFF) confidential client. The browser never sees a token: the whole
 * OAuth dance happens here and ends in an `HttpOnly` session cookie. That is why the
 * client is confidential (`token_endpoint_auth_method: private_key_jwt`) with a private
 * key we generate once and keep in `fs_oauth_client_key`, and why
 * `application_type: web`.
 *
 * Routes:
 *   GET /oauth/client-metadata.json   the client_id document (client_id IS this URL)
 *   GET /oauth/jwks.json              the public half of the signing key
 *   GET /api/auth/oauth/start         begin; REQUIRES ?confirm=1 (see below)
 *   GET /oauth/callback               finish, mint a session, redirect
 *
 * Why `confirm=1` is mandatory: bringing an existing Bluesky identity into Free School
 * means every class you host is permanently, publicly attached to that identity. The PWA
 * shows a hard confirm before it ever links here; this endpoint refuses to start without
 * the flag so the dangerous door cannot be walked through by accident (or by a link in
 * someone else's email).
 */
import { JoseKey } from '@atproto/jwk-jose'
import { requestLocalLock } from '@atproto/oauth-client'
import {
  NodeOAuthClient,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  type NodeSavedStateStore,
} from '@atproto/oauth-client-node'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { oauthClientKey, oauthSession, oauthState } from '../db/schema.js'
import { config } from '../config.js'
import { normalizeHost, schoolByHost } from '../lib/schools.js'

const KID = 'freeschool-appview-1'

class PostgresStateStore implements NodeSavedStateStore {
  async get(key: string): Promise<NodeSavedState | undefined> {
    const rows = await getDb().select().from(oauthState).where(eq(oauthState.key, key)).limit(1)
    return (rows[0]?.state as NodeSavedState | undefined) ?? undefined
  }
  async set(key: string, state: NodeSavedState): Promise<void> {
    await getDb()
      .insert(oauthState)
      .values({ key, state })
      .onConflictDoUpdate({ target: oauthState.key, set: { state } })
  }
  async del(key: string): Promise<void> {
    await getDb().delete(oauthState).where(eq(oauthState.key, key))
  }
}

class PostgresSessionStore implements NodeSavedSessionStore {
  async get(sub: string): Promise<NodeSavedSession | undefined> {
    const rows = await getDb().select().from(oauthSession).where(eq(oauthSession.sub, sub)).limit(1)
    return (rows[0]?.session as NodeSavedSession | undefined) ?? undefined
  }
  async set(sub: string, session: NodeSavedSession): Promise<void> {
    await getDb()
      .insert(oauthSession)
      .values({ sub, session, updatedAt: new Date() })
      .onConflictDoUpdate({ target: oauthSession.sub, set: { session, updatedAt: new Date() } })
  }
  async del(sub: string): Promise<void> {
    await getDb().delete(oauthSession).where(eq(oauthSession.sub, sub))
  }
}

/** Generated once and stored, so restarts do not invalidate every in-flight session. */
async function loadOrCreateKey(): Promise<JoseKey> {
  const configured = config().OAUTH_PRIVATE_JWK
  if (configured) return JoseKey.fromImportable(JSON.parse(configured), KID)
  const rows = await getDb().select().from(oauthClientKey).where(eq(oauthClientKey.kid, KID)).limit(1)
  if (rows[0]) return JoseKey.fromImportable(rows[0].jwk as Record<string, unknown> as never, KID)
  const key = await JoseKey.generate(['ES256'], KID)
  await getDb().insert(oauthClientKey).values({ kid: KID, jwk: key.privateJwk as object }).onConflictDoNothing()
  return key
}

export class OAuthUnavailableError extends Error {
  readonly status = 503
  readonly code = 'OAuthNotConfigured'
  constructor(publicUrl: string) {
    super(
      `Signing in with an existing account needs this AppView to be served over https on a ` +
        `real hostname: a confidential ATProto OAuth client cannot have an http, IP-literal, ` +
        `or localhost client_id. APPVIEW_PUBLIC_URL is ${publicUrl}. The primary door ` +
        `(POST /api/auth/signup) works regardless.`,
    )
    this.name = 'OAuthUnavailableError'
  }
}

export function assertOauthUsable(): void {
  const c = config()
  if (!c.oauthUsable) throw new OAuthUnavailableError(c.APPVIEW_PUBLIC_URL)
}

export function clientMetadata(): Record<string, unknown> {
  const base = config().APPVIEW_PUBLIC_URL
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: 'Free School',
    client_uri: base,
    redirect_uris: [`${base}/oauth/callback`],
    // `transition:generic` is what lets us write records in the member's own repo
    // (their events, their skillClaims). `atproto` is mandatory.
    scope: 'atproto transition:generic',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}/oauth/jwks.json`,
  }
}

let client: NodeOAuthClient | undefined

export async function oauthClient(): Promise<NodeOAuthClient> {
  if (client) return client
  assertOauthUsable()
  const key = await loadOrCreateKey()
  client = new NodeOAuthClient({
    clientMetadata: clientMetadata() as never,
    keyset: [key],
    stateStore: new PostgresStateStore(),
    sessionStore: new PostgresSessionStore(),
    // Single-process deployment: an in-process lock is the correct one, and passing it
    // explicitly is also how the library stops warning "credentials might get revoked".
    // A multi-instance deployment must swap this for a Postgres advisory-lock implementation.
    requestLock: requestLocalLock,
  })
  return client
}

export async function jwks(): Promise<unknown> {
  return (await oauthClient()).jwks
}

/** Reset for tests. */
export function resetOauthClient(): void {
  client = undefined
}

/* ─────────────────── the host the member came from (MS §3) ─────────────────── */

/**
 * OAUTH LIVES ON ONE ORIGIN. A confidential client's `client_id` IS its metadata URL and
 * its `redirect_uri` must sit on the same origin, so one client per city would mean N
 * metadata documents, N key registrations and a consent screen that names a different
 * thing each time. The apex is therefore the front door for the whole network: the dance
 * starts and ends on `APPVIEW_PUBLIC_URL`.
 *
 * Which leaves one thing to carry: the city the member was looking at when they pressed
 * the button. It rides in the OAuth `state` — the library's own `appState`, stored
 * server-side in `fs_oauth_state` alongside the PKCE verifier and handed back by
 * `client.callback()`, so no new column is needed and nothing about it is visible to, or
 * writable by, the browser.
 *
 * ON THE WAY BACK IT IS NEVER REFLECTED RAW. The host must parse as a hostname and must
 * name a school in `fs_school_domain`; anything else lands on the apex. An open redirect
 * here would be a session-fixation gift, since the response that follows sets the session
 * cookie.
 */
export function oauthOriginState(host: string): string | undefined {
  const normalized = (host ?? '').trim().toLowerCase()
  return HOST_RE.test(normalized) ? normalized : undefined
}

/** A hostname, optionally with a port. Deliberately no scheme, no path, no userinfo. */
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/

/**
 * Where the callback sends the member, and which school their session belongs to.
 *
 * One lookup answers both questions, because they are the same question: the state names
 * a school host or it does not. `{ schoolDid: undefined }` means the apex — a member who
 * started there, or a state this deployment cannot vouch for.
 */
export async function resolveOauthOrigin(
  state: string | null | undefined,
): Promise<{ host?: string; schoolDid?: string }> {
  const host = oauthOriginState(state ?? '')
  if (!host) return {}
  const school = await schoolByHost(normalizeHost(host)).catch(() => undefined)
  if (!school) return {}
  return { host, schoolDid: school.did }
}

/**
 * `https://<school host>/?<query>`, or the apex when no school host was resolved. The
 * apex URL is taken whole from `webPublicUrl` because in development it carries a port
 * (`http://localhost:5173`); a school host carries its own, so only the scheme is
 * borrowed.
 */
export function oauthReturnUrl(host: string | undefined, query: string): string {
  if (!host) return `${config().webPublicUrl}/?${query}`
  const scheme = config().webPublicUrl.startsWith('http://') ? 'http' : 'https'
  return `${scheme}://${host}/?${query}`
}
