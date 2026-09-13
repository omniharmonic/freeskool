/**
 * The client-facing half of the OAuth BFF. See ../oauth.ts for the client itself.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import { assertOauthUsable, clientMetadata, jwks, oauthClient, OAuthUnavailableError } from '../oauth.js'
import { createSession } from '../session.js'
import { config } from '../../config.js'
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

oauthRoutes.get('/oauth/callback', async (c) => {
  const params = new URL(c.req.url).searchParams
  try {
    const client = await oauthClient()
    const { session } = await client.callback(params)
    await createSession(c, session.did, 'oauth')
    // Task 7: fire-and-forget. A slow or unreachable public.api.bsky.app must never delay
    // the redirect below — the member gets into the app first, and the profile (display
    // name, bio, avatar) appears whenever the import finishes. `overwrite: false`: a
    // returning member's already-edited app-side profile is left alone.
    void importBlueskyProfile(session.did, { overwrite: false }).catch(() => log.warn('bsky profile import failed'))
    // The human lands back in the PWA. The callback URL itself (registered in the client
    // metadata, and visited by the PDS) stays on APPVIEW_PUBLIC_URL — see ../oauth.ts.
    return c.redirect(`${config().webPublicUrl}/?signed-in=1`)
  } catch (err) {
    log.warn('oauth callback failed', { detail: describeError(err) })
    return c.redirect(`${config().webPublicUrl}/?oauth-error=1`)
  }
})
