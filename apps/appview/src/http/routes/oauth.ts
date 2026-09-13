/**
 * The client-facing half of the OAuth BFF. See ../oauth.ts for the client itself.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import { assertOauthUsable, clientMetadata, jwks, oauthClient, OAuthUnavailableError } from '../oauth.js'
import { createSession } from '../session.js'
import { config } from '../../config.js'
import { describeError, log } from '../../lib/logging.js'

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
    // The human lands back in the PWA. The callback URL itself (registered in the client
    // metadata, and visited by the PDS) stays on APPVIEW_PUBLIC_URL — see ../oauth.ts.
    return c.redirect(`${config().webPublicUrl}/?signed-in=1`)
  } catch (err) {
    log.warn('oauth callback failed', { detail: describeError(err) })
    return c.redirect(`${config().webPublicUrl}/?oauth-error=1`)
  }
})
