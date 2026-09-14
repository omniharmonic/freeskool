/**
 * The client-facing half of the OAuth BFF. See ../oauth.ts for the client itself.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import {
  assertOauthUsable,
  clientMetadata,
  jwks,
  oauthClient,
  oauthReturnUrl,
  OAuthUnavailableError,
  resolveOauthOrigin,
} from '../oauth.js'
import { createSession } from '../session.js'
import { describeError, log } from '../../lib/logging.js'
import { importBlueskyProfile } from '../../lib/bsky-profile.js'

export const oauthRoutes = new Hono<AppEnv>()

oauthRoutes.get('/oauth/client-metadata.json', (c) => {
  try {
    assertOauthUsable()
  } catch (err) {
    if (err instanceof OAuthUnavailableError) return c.json({ error: err.code, message: err.message }, 503)
    throw err
  }
  return c.json(clientMetadata())
})

oauthRoutes.get('/oauth/jwks.json', async (c) => {
  try {
    return c.json((await jwks()) as object)
  } catch (err) {
    if (err instanceof OAuthUnavailableError) return c.json({ error: err.code, message: err.message }, 503)
    throw err
  }
})

/**
 * THE CALLBACK RUNS ON THE APEX, ALWAYS — it is the `redirect_uri` registered in the
 * client metadata, and that is one origin for the whole network (MS §3). So it cannot
 * learn the member's school from its own Host header; it learns it from the OAuth state,
 * which `/api/auth/oauth/start` filled in with the host the member pressed the button on.
 * See `../oauth.ts#resolveOauthOrigin` for why that is safe to redirect to.
 */
oauthRoutes.get('/oauth/callback', async (c) => {
  const params = new URL(c.req.url).searchParams
  try {
    const client = await oauthClient()
    const { session, state } = await client.callback(params)
    const origin = await resolveOauthOrigin(state)
    // The session is opened for the school the member STARTED on, not for the apex they
    // are standing on right now — otherwise signing in from Denver would silently join
    // (and then show) Boulder. `schoolDid: undefined` falls back to the request's school,
    // which on the apex is the apex's own.
    await createSession(c, session.did, 'oauth', { schoolDid: origin.schoolDid })
    // Task 7: fire-and-forget. A slow or unreachable public.api.bsky.app must never delay
    // the redirect below — the member gets into the app first, and the profile (display
    // name, bio, avatar) appears whenever the import finishes. `overwrite: false`: a
    // returning member's already-edited app-side profile is left alone.
    void importBlueskyProfile(session.did, { overwrite: false }).catch(() => log.warn('bsky profile import failed'))
    // The human lands back in the PWA — on their own city's host when the state named
    // one, on the apex otherwise. The callback URL itself (registered in the client
    // metadata, and visited by the PDS) stays on APPVIEW_PUBLIC_URL — see ../oauth.ts.
    return c.redirect(oauthReturnUrl(origin.host, 'signed-in=1'))
  } catch (err) {
    log.warn('oauth callback failed', { detail: describeError(err) })
    // The error path deliberately does NOT try to recover the origin: `client.callback`
    // is what failed, so its state is exactly the thing there is no reason to trust.
    return c.redirect(oauthReturnUrl(undefined, 'oauth-error=1'))
  }
})
