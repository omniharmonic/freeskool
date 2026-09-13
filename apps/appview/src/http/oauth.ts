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
  const key = await loadOrCreateKey()
  client = new NodeOAuthClient({
    clientMetadata: clientMetadata() as never,
    keyset: [key],
    stateStore: new PostgresStateStore(),
    sessionStore: new PostgresSessionStore(),
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
