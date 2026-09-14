/**
 * Server-side sessions.
 *
 * The cookie is `<id>.<hmac>` and nothing else: `HttpOnly; Secure; SameSite=Lax; Path=/`.
 * All the state — which DID, which door, when it expires — lives in `fs_session`, so a
 * logout is a DELETE and a compromise of the cookie secret still leaks no identity.
 *
 * `SameSite=Lax` rather than `Strict` because the OAuth callback is a top-level
 * cross-site GET and `Strict` would drop the cookie on exactly that request.
 *
 * TWO THINGS THE FEDERATION PHASE ADDS (MS §3):
 *
 * 1. `current_school_did` — WHICH SCHOOL this browser is looking at, recorded on the row
 *    at sign-in and moved by `POST /api/auth/switch-school`. It is a server-side session
 *    field on purpose: never a cookie, never a URL parameter, so nothing a member can
 *    edit decides which tenant's data they are served. The HOST still wins when it names
 *    a school (`http/school-context.ts`); the session's value is what answers on the apex,
 *    which serves no city of its own.
 * 2. `SESSION_COOKIE_DOMAIN` — empty by default (a host-only cookie, exactly as before);
 *    production sets `.freeskool.xyz` so one sign-in is one identity across every city.
 *    Set and cleared in the SAME place, because a cookie deleted without the `Domain` it
 *    was written with is not deleted at all — the browser keeps the wider one and the
 *    member stays signed in after pressing sign out.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { eq, lt } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { member, session } from '../db/schema.js'
import { config } from '../config.js'
import { newSessionId, signSessionId, verifySessionCookie } from '../lib/crypto.js'
import { roleOf } from '../lib/roles.js'
import { Role } from '@freeschool/shared'
import type { School } from '../lib/schools.js'
import { legacySchoolDid } from '../lib/schools.js'
import { joinSchool } from '../lib/membership.js'

export type SessionKind = 'custodial' | 'oauth'

export interface Viewer {
  did: string
  kind: SessionKind
  sessionId: string
  /**
   * The school this session last resolved to, or `undefined` for a session created before
   * this column was written. Read by `http/school-context.ts` as the fallback when the
   * request's host names no school (the apex).
   */
  currentSchoolDid?: string
}

/**
 * `school` is set by `http/school-context.ts#withSchool` on every request; read it with
 * `currentSchool(c)` (which 404s when it is absent) rather than off the context directly.
 */
export type AppEnv = { Variables: { viewer?: Viewer; school?: School } }

/**
 * The school this context resolved to, or the legacy one. Deliberately defensive: the
 * scripts and unit suites that call `createSession` with a stub Context have no `var`,
 * and a sign-in must never fail because the tenancy middleware was not in the chain.
 */
function schoolOf(c: Context): string {
  const school = (c as Context<AppEnv>).var?.school
  return school?.did || legacySchoolDid()
}

export interface CreateSessionOptions {
  /**
   * The school this session belongs to, overriding `c.var.school`. Exactly one caller
   * needs it: the OAuth callback, which always runs on the APEX (the client_id is one
   * origin — MS §3) but must open the session for the city the member started from,
   * carried through the OAuth state.
   */
  schoolDid?: string
}

export async function createSession(
  c: Context,
  did: string,
  kind: SessionKind,
  options: CreateSessionOptions = {},
): Promise<string> {
  const id = newSessionId()
  const ttlMs = config().SESSION_TTL_DAYS * 86_400_000
  const schoolDid = options.schoolDid ?? schoolOf(c)
  await getDb()
    .insert(session)
    // `|| null` and not `?? null`: `legacySchoolDid()` is `''` on a deployment that has
    // never run `create-school`, and an empty string in this column would look like a
    // school to every reader of it.
    .values({ id, did, kind, currentSchoolDid: schoolDid || null, expiresAt: new Date(Date.now() + ttlMs) })
  // DURABLE membership fact, never deleted on logout/expiry (unlike `fs_session` and
  // `fs_oauth_session`, both of which are session-store rows) — see `fs_member`'s doc
  // comment in db/schema.ts and `lib/roles.ts#isOwnMember`. This is the ONE chokepoint
  // both doors' login flows share (auth.ts's /verify, oauth.ts's /callback).
  const now = new Date()
  await getDb()
    .insert(member)
    .values({ did, door: kind, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: member.did, set: { door: kind, lastSeenAt: now } })
  // AND the per-school fact. Signing in on a school's host IS joining that school
  // (MS §4): `fs_member` above stays the GLOBAL presence row, `fs_membership` is what
  // every roster, directory and skill page reads. Same chokepoint, same call.
  await joinSchool(did, schoolDid, kind)
  setCookie(c, config().SESSION_COOKIE, signSessionId(id), {
    httpOnly: true,
    secure: config().isProd,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
    ...cookieDomain(),
  })
  return id
}

/**
 * `{ domain }` when `SESSION_COOKIE_DOMAIN` is set, `{}` when it is not — spread into
 * BOTH `setCookie` and `deleteCookie`, since a cookie deleted on a narrower scope than it
 * was written on survives.
 */
function cookieDomain(): { domain?: string } {
  const domain = config().sessionCookieDomain
  return domain ? { domain } : {}
}

export async function destroySession(c: Context): Promise<void> {
  const raw = getCookie(c, config().SESSION_COOKIE)
  const id = raw ? verifySessionCookie(raw) : null
  if (id) await getDb().delete(session).where(eq(session.id, id))
  deleteCookie(c, config().SESSION_COOKIE, { path: '/', ...cookieDomain() })
}

/**
 * Move this session to another school — `POST /api/auth/switch-school`'s write. The route
 * is what checks membership; this only records the answer.
 */
export async function setSessionSchool(sessionId: string, schoolDid: string): Promise<void> {
  await getDb().update(session).set({ currentSchoolDid: schoolDid }).where(eq(session.id, sessionId))
}

export async function readViewer(c: Context): Promise<Viewer | undefined> {
  const raw = getCookie(c, config().SESSION_COOKIE)
  if (!raw) return undefined
  const id = verifySessionCookie(raw)
  if (!id) return undefined
  const rows = await getDb().select().from(session).where(eq(session.id, id)).limit(1)
  const row = rows[0]
  if (!row) return undefined
  if (row.expiresAt.getTime() <= Date.now()) {
    await getDb().delete(session).where(eq(session.id, id))
    return undefined
  }
  return {
    did: row.did,
    kind: row.kind as SessionKind,
    sessionId: row.id,
    currentSchoolDid: row.currentSchoolDid ?? undefined,
  }
}

/** Populates `c.var.viewer` when a session exists. Never rejects. */
export const withViewer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const viewer = await readViewer(c)
  if (viewer) c.set('viewer', viewer)
  await next()
}

export const requireViewer: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.viewer) return c.json({ error: 'AuthRequired' }, 401)
  await next()
}

/**
 * A role is a role IN ONE SCHOOL (MS §2): a steward of Denver has no steward power on
 * Boulder, and the gate is where that becomes true. 404 — not 403 — when the request
 * resolves to no school at all, so a probe cannot tell "no school here" from "a school
 * you may not act in" (MS §10).
 */
export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const viewer = c.var.viewer
    if (!viewer) return c.json({ error: 'AuthRequired' }, 401)
    const school = c.var.school
    if (!school) return c.json({ error: 'UnknownSchool' }, 404)
    const role = await roleOf(viewer.did, school.did)
    if (role < min) return c.json({ error: 'PermissionDenied', need: min, have: role }, 403)
    await next()
  }
}

export async function pruneExpiredSessions(now = new Date()): Promise<number> {
  const rows = await getDb().delete(session).where(lt(session.expiresAt, now)).returning({ id: session.id })
  return rows.length
}
