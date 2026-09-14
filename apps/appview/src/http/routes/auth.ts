/**
 * `/api/auth/*`
 *
 *   POST /signup            primary door: mint a Free School identity from an email
 *   POST /signin             same door, same handler — "Continue with email" on the
 *                            PWA works whether the person is new or returning
 *                            (`lib/custody.ts#signup` already resends the link for a
 *                            known email, and now self-heals an orphaned PDS account)
 *   GET  /verify?token=     consume the magic link, open a session
 *   GET  /oauth/start       SECONDARY door. Requires ?confirm=1 — see ../oauth.ts
 *   POST /logout
 *   GET  /me
 *   POST /switch-school     move this session to another school the viewer belongs to
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { createSession, destroySession, requireViewer, sessionSpansHost, setSessionSchool } from '../session.js'
import { legacySchool, requestHost, schoolDidOrLegacy } from '../school-context.js'
import {
  signup,
  verifyEmailToken,
  getCustodialAccount,
  takeOwnership,
  revealOwnershipPassword,
  RevealPendingError,
  SignupError,
} from '../../lib/custody.js'
import { oauthClient, oauthOriginState, OAuthUnavailableError } from '../oauth.js'
import { config } from '../../config.js'
import { roleOf } from '../../lib/roles.js'
import { getDb } from '../../db/index.js'
import { custodialAccount, membership, school as schoolTable } from '../../db/schema.js'
import { loadDirectoryPrefs } from '../../lib/profile.js'
import { canonicalHostsFor, getSchool, schoolHostFor } from '../../lib/schools.js'
import { isMemberOf } from '../../lib/membership.js'
import { describeError, log } from '../../lib/logging.js'

export const auth = new Hono<AppEnv>()

const signupBody = z.object({
  email: z.string().email(),
  /** Optional invite, used only as `invite-or-vouch` evidence. */
  inviterDid: z.string().startsWith('did:').optional(),
  /** The signup form's own newsletter checkbox. Default false — opt-in, not opt-out. */
  newsletter: z.boolean().optional(),
})

/**
 * Shared by `/signup` and `/signin` — one door, "Continue with email", for both a new
 * member and one coming back (`lib/custody.ts#signup` already tells the two apart by
 * whether an `fs_custodial_account` row exists for the email). Response shape unchanged.
 */
async function signupHandler(c: Context<AppEnv>) {
  const parsed = signupBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest', message: 'email is required' }, 400)
  try {
    // Signing up on a school's host joins THAT school (`lib/membership.ts#joinSchool`
    // does the rest, on the first session).
    const result = await signup({ ...parsed.data, schoolDid: schoolDidOrLegacy(c) })
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
}

auth.post('/signup', signupHandler)
auth.post('/signin', signupHandler)

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
    /**
     * The one thing the apex-only callback cannot work out for itself: which city the
     * member pressed this button on. `state` is the library's `appState` — stored
     * server-side in `fs_oauth_state`, handed back by `client.callback()`, never
     * writable by the browser. `../oauth.ts` documents the round trip and the
     * validation that happens on the way back.
     */
    const url = await client.authorize(handle, {
      scope: 'atproto transition:generic',
      state: oauthOriginState(requestHost(c)),
    })
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

/**
 * WHO THE VIEWER IS, AND WHERE THEY ARE.
 *
 * `school` is the school THIS REQUEST resolved to (the host's, or the session's on the
 * apex) — the name the PWA prints in its headers. `schools` is every school the viewer
 * belongs to, with the host each is served from, which is the school picker's whole data
 * source.
 *
 * `schools` is the ONE place a cross-school list is served (MS §10.1: "a member's Me
 * screen may know its own schools; no other view may"). It is the viewer's own membership
 * and nobody else's, it names no other member, and it is behind `requireViewer`.
 */
auth.get('/me', requireViewer, async (c) => {
  const viewer = c.var.viewer!
  const here = c.var.school ?? (await legacySchool())
  const [role, custodial, prefs, schools] = await Promise.all([
    roleOf(viewer.did, schoolDidOrLegacy(c)),
    getCustodialAccount(viewer.did),
    // The SHARED loader, not a second copy of the query (final-review nit 7): `GET /api/me`
    // reads `onboarded` through `loadDirectoryPrefs` and these two must never drift.
    loadDirectoryPrefs(viewer.did, schoolDidOrLegacy(c)),
    schoolsForViewer(viewer.did),
  ])
  return c.json({
    did: viewer.did,
    kind: viewer.kind,
    role,
    handle: custodial?.handle,
    isCustodial: custodial?.isCustodial ?? false,
    emailVerified: Boolean(custodial?.verifiedAt),
    onboarded: prefs.onboarded,
    ...(here?.did ? { school: { did: here.did, label: here.label, name: here.name } } : {}),
    schools,
  })
})

export interface ViewerSchool {
  did: string
  label: string
  name: string
  /** Where this school is served — what the PWA navigates to when the member picks it. */
  host: string
}

/** Every school the viewer has not left, oldest membership first, each with its host. */
async function schoolsForViewer(did: string): Promise<ViewerSchool[]> {
  const rows = await getDb()
    .select({ did: schoolTable.did, label: schoolTable.label, name: schoolTable.name })
    .from(membership)
    .innerJoin(schoolTable, eq(schoolTable.did, membership.schoolDid))
    .where(and(eq(membership.did, did), isNull(membership.leftAt)))
    .orderBy(membership.joinedAt)
  const hosts = await canonicalHostsFor(rows.map((r) => r.did))
  return rows.map((r) => ({ ...r, host: hosts.get(r.did) ?? '' }))
}

const switchSchoolBody = z.object({ schoolDid: z.string().startsWith('did:') })

/**
 * MOVE THIS SESSION TO ANOTHER SCHOOL.
 *
 * 403 unless the viewer is a member of it — and a 403 rather than a 404 is right HERE,
 * unusually, because the picker only ever offers schools `GET /me` already listed, so a
 * refusal confirms nothing the caller did not already know. (`GET /api/members/:did` and
 * the per-school reads keep their 404s; those ARE probes.)
 *
 * The response carries the school's canonical host: switching is a NAVIGATION, not a
 * state change the current page can render. The session field is what makes the apex
 * agree, and the host is what makes `boulder.freeskool.xyz` stop being Denver.
 *
 * …and `sessionSpansHosts`, which says whether the member's cookie actually TRAVELS to
 * that host. With `SESSION_COOKIE_DOMAIN` empty — the dev stack, and production before
 * the cutover — it does not: the session row moves, the cookie stays behind, and the
 * browser lands in the new city signed out with nothing said. The PWA uses this to send
 * them to that city's own sign-in door with a line explaining why, instead of a blank
 * screen (Task 4 report, concern 5).
 */
auth.post('/switch-school', requireViewer, async (c) => {
  const viewer = c.var.viewer!
  const parsed = switchSchoolBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest', message: 'schoolDid is required' }, 400)
  const { schoolDid } = parsed.data
  if (!(await isMemberOf(viewer.did, schoolDid))) {
    return c.json({ error: 'NotAMember', message: 'you are not a member of that school' }, 403)
  }
  const target = await getSchool(schoolDid)
  // A membership row for a school that no longer exists is not a school to switch to.
  if (!target) return c.json({ error: 'NotAMember', message: 'you are not a member of that school' }, 403)
  await setSessionSchool(viewer.sessionId, schoolDid)
  const host = await schoolHostFor(schoolDid)
  return c.json({
    school: { did: target.did, label: target.label, name: target.name },
    host,
    sessionSpansHosts: sessionSpansHost(host),
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
  // The re-sent link lands on the school this request is for, same rule as the first one.
  await sendVerificationEmail(viewer.did, email, await schoolHostFor(schoolDidOrLegacy(c)).catch(() => ''))
  return c.json({ ok: true })
})
