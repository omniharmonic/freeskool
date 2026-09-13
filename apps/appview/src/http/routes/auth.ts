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
import {
  signup,
  verifyEmailToken,
  getCustodialAccount,
  takeOwnership,
  revealOwnershipPassword,
  RevealPendingError,
  SignupError,
} from '../../lib/custody.js'
import { oauthClient, OAuthUnavailableError } from '../oauth.js'
import { config } from '../../config.js'
import { roleOf } from '../../lib/roles.js'
import { getDb } from '../../db/index.js'
import { custodialAccount } from '../../db/schema.js'
import { describeError, log } from '../../lib/logging.js'

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
    //
    // `verifyUrl` is a MAGIC LINK and is a development affordance only: `lib/custody.ts`
    // already withholds it once SMTP is configured, and this is the second, independent
    // gate — in production the link is only ever delivered to the address that asked for
    // it, never echoed to whoever posted the form. (`config().isProd` && no SMTP cannot
    // happen: `loadConfig` refuses to boot.)
    return c.json(
      { did: result.did, handle: result.handle, ...(config().isProd ? {} : { verifyUrl: result.verifyUrl }) },
      201,
    )
  } catch (err) {
    if (err instanceof SignupError) return c.json({ error: err.code, message: err.message }, err.status as 400)
    log.error('signup failed', { detail: describeError(err) })
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
    return c.redirect(`${config().webPublicUrl}/?verified=1`)
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
    log.warn('oauth start failed', { detail: describeError(err) })
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

/**
 * The exit from custody. The viewer must be signed in AS the custodial account (the
 * session check here IS "verify the session belongs to the custodial account" —
 * `requireViewer` already refused anyone without a session). See `lib/custody.ts` for
 * the full transactional flow, including the re-issue path for a missed first link and
 * the 502-and-retry path for a PDS rotation failure.
 */
auth.post('/take-ownership', requireViewer, async (c) => {
  const viewer = c.var.viewer!
  try {
    const result = await takeOwnership(viewer.did)
    return c.json({ ok: true, handle: result.handle, ...(result.revealUrl ? { revealUrl: result.revealUrl } : {}) })
  } catch (err) {
    if (err instanceof RevealPendingError) {
      return c.json({ error: err.code, message: err.message, expiresAt: err.expiresAt.toISOString() }, 409)
    }
    if (err instanceof SignupError) return c.json({ error: err.code, message: err.message }, err.status as 404 | 502)
    throw err
  }
})

/**
 * The one-time reveal. Deliberately UNAUTHENTICATED — the token itself, single-use and
 * 24h-TTL, is the credential (same shape as `/verify`'s magic link); requiring a session
 * here would just mean "whoever is signed in as this DID", which the PDS password rotation
 * in step 2 has already made impossible to fake.
 */
auth.get('/take-ownership/:token', async (c) => {
  const token = c.req.param('token')
  const result = await revealOwnershipPassword(token)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 404 | 410)
  return c.json({
    ok: true,
    handle: result.handle,
    password: result.password,
    message: 'This is shown once. Sign in at your PDS with it, then change it to a password of your own.',
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
