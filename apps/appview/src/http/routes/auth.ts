/**
 * `/api/auth/*`
 *
 *   POST /signup            primary door: mint a Free School identity from an email
 *   GET  /verify?token=     consume the magic link, open a session
 *   GET  /oauth/start       SECONDARY door. Requires ?confirm=1 — see ../oauth.ts
 *   POST /logout
 *   GET  /me
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { createSession, destroySession, requireViewer } from '../session.js'
import { signup, verifyEmailToken, getCustodialAccount, SignupError } from '../../lib/custody.js'
import { oauthClient, OAuthUnavailableError } from '../oauth.js'
import { config } from '../../config.js'
import { roleOf } from '../../lib/roles.js'
import { getDb } from '../../db/index.js'
import { custodialAccount } from '../../db/schema.js'
import { log } from '../../lib/logging.js'

export const auth = new Hono<AppEnv>()

const signupBody = z.object({
  email: z.string().email(),
  /** Optional invite, used only as `invite-or-vouch` evidence. */
  inviterDid: z.string().startsWith('did:').optional(),
  /** The signup form's own newsletter checkbox. Default false — opt-in, not opt-out. */
  newsletter: z.boolean().optional(),
})

auth.post('/signup', async (c) => {
  const parsed = signupBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest', message: 'email is required' }, 400)
  try {
    const result = await signup(parsed.data)
    // The DID and handle go back to the caller (they are about to be public anyway);
    // the email, the password and the invite code never do.
    return c.json({ did: result.did, handle: result.handle, verifyUrl: result.verifyUrl }, 201)
  } catch (err) {
    if (err instanceof SignupError) return c.json({ error: err.code, message: err.message }, err.status as 400)
    log.error('signup failed', { detail: String(err) })
    return c.json({ error: 'SignupFailed', message: 'could not create the account' }, 502)
  }
})

auth.get('/verify', async (c) => {
  const token = c.req.query('token')
  if (!token) return c.json({ error: 'InvalidRequest' }, 400)
  try {
    const { did } = await verifyEmailToken(token)
    await createSession(c, did, 'custodial')
    const accept = c.req.header('accept') ?? ''
    if (accept.includes('application/json')) return c.json({ ok: true, did })
    return c.redirect(`${config().APPVIEW_PUBLIC_URL}/?verified=1`)
  } catch (err) {
    if (err instanceof SignupError) return c.json({ error: err.code, message: err.message }, err.status as 400)
    throw err
  }
})

/**
 * The secondary door. `confirm=1` is REQUIRED: linking an existing identity is
 * irreversible in the sense that matters (everything you then host is publicly tied to
 * it), so the PWA shows a hard confirmation and passes the flag. Without it this
 * endpoint refuses rather than redirecting.
 */
auth.get('/oauth/start', async (c) => {
  if (c.req.query('confirm') !== '1') {
    return c.json(
      {
        error: 'ConfirmationRequired',
        message:
          'Signing in with an existing account permanently links that public identity to everything you host here. Re-request with ?confirm=1 after the user has confirmed.',
      },
      428,
    )
  }
  const handle = c.req.query('handle') ?? c.req.query('did')
  if (!handle) return c.json({ error: 'InvalidRequest', message: 'handle or did is required' }, 400)
  try {
    const client = await oauthClient()
    const url = await client.authorize(handle, { scope: 'atproto transition:generic' })
    return c.redirect(url.toString())
  } catch (err) {
    if (err instanceof OAuthUnavailableError) return c.json({ error: err.code, message: err.message }, 503)
    log.warn('oauth start failed', { detail: String(err) })
    return c.json({ error: 'OAuthStartFailed', message: 'could not start authorization' }, 502)
  }
})

auth.post('/logout', async (c) => {
  await destroySession(c)
  return c.json({ ok: true })
})

auth.get('/me', requireViewer, async (c) => {
  const viewer = c.var.viewer!
  const [role, custodial] = await Promise.all([roleOf(viewer.did), getCustodialAccount(viewer.did)])
  return c.json({
    did: viewer.did,
    kind: viewer.kind,
    role,
    handle: custodial?.handle,
    isCustodial: custodial?.isCustodial ?? false,
    emailVerified: Boolean(custodial?.verifiedAt),
  })
})

/** Re-send the magic link. Rate-limiting is the reverse proxy's job, not ours. */
auth.post('/resend-verification', requireViewer, async (c) => {
  const viewer = c.var.viewer!
  const rows = await getDb()
    .select({ email: custodialAccount.email })
    .from(custodialAccount)
    .where(eq(custodialAccount.did, viewer.did))
    .limit(1)
  const email = rows[0]?.email
  if (!email) return c.json({ error: 'NotCustodial' }, 409)
  const { sendVerificationEmail } = await import('../../lib/custody.js')
  await sendVerificationEmail(viewer.did, email)
  return c.json({ ok: true })
})
