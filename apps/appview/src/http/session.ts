/**
 * Server-side sessions.
 *
 * The cookie is `<id>.<hmac>` and nothing else: `HttpOnly; Secure; SameSite=Lax; Path=/`.
 * All the state — which DID, which door, when it expires — lives in `fs_session`, so a
 * logout is a DELETE and a compromise of the cookie secret still leaks no identity.
 *
 * `SameSite=Lax` rather than `Strict` because the OAuth callback is a top-level
 * cross-site GET and `Strict` would drop the cookie on exactly that request.
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

export type SessionKind = 'custodial' | 'oauth'

export interface Viewer {
  did: string
  kind: SessionKind
  sessionId: string
}

export type AppEnv = { Variables: { viewer?: Viewer } }

export async function createSession(c: Context, did: string, kind: SessionKind): Promise<string> {
  const id = newSessionId()
  const ttlMs = config().SESSION_TTL_DAYS * 86_400_000
  await getDb().insert(session).values({ id, did, kind, expiresAt: new Date(Date.now() + ttlMs) })
  // DURABLE membership fact, never deleted on logout/expiry (unlike `fs_session` and
  // `fs_oauth_session`, both of which are session-store rows) — see `fs_member`'s doc
  // comment in db/schema.ts and `lib/roles.ts#isOwnMember`. This is the ONE chokepoint
  // both doors' login flows share (auth.ts's /verify, oauth.ts's /callback).
  const now = new Date()
  await getDb()
    .insert(member)
    .values({ did, door: kind, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: member.did, set: { door: kind, lastSeenAt: now } })
  setCookie(c, config().SESSION_COOKIE, signSessionId(id), {
    httpOnly: true,
    secure: config().isProd,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(ttlMs / 1000),
  })
  return id
}

export async function destroySession(c: Context): Promise<void> {
  const raw = getCookie(c, config().SESSION_COOKIE)
  const id = raw ? verifySessionCookie(raw) : null
  if (id) await getDb().delete(session).where(eq(session.id, id))
  deleteCookie(c, config().SESSION_COOKIE, { path: '/' })
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
  return { did: row.did, kind: row.kind as SessionKind, sessionId: row.id }
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

export function requireRole(min: Role): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const viewer = c.var.viewer
    if (!viewer) return c.json({ error: 'AuthRequired' }, 401)
    const role = await roleOf(viewer.did)
    if (role < min) return c.json({ error: 'PermissionDenied', need: min, have: role }, 403)
    await next()
  }
}

export async function pruneExpiredSessions(now = new Date()): Promise<number> {
  const rows = await getDb().delete(session).where(lt(session.expiresAt, now)).returning({ id: session.id })
  return rows.length
}
