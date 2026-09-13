/**
 * The client-facing half of the OAuth BFF. See ../oauth.ts for the client itself.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import { assertOauthUsable, clientMetadata, jwks, oauthClient, OAuthUnavailableError } from '../oauth.js'
import { createSession } from '../session.js'
import { config } from '../../config.js'
import { log } from '../../lib/logging.js'

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
    return c.redirect(`${config().APPVIEW_PUBLIC_URL}/?signed-in=1`)
  } catch (err) {
    log.warn('oauth callback failed', { detail: String(err) })
    return c.redirect(`${config().APPVIEW_PUBLIC_URL}/?oauth-error=1`)
  }
})
