/**
 * WHICH SCHOOL IS THIS REQUEST FOR?
 *
 * One middleware (`withSchool`, mounted once in `http/app.ts` ahead of every router) and
 * one accessor (`currentSchool(c)`). Between them they replace every
 * `config().SCHOOL_DID` read in the HTTP layer (MS Appendix A): a route never asks the
 * environment which school it is serving, it asks the request.
 *
 * Resolution order (MS §3, §5):
 *
 *   MULTI_SCHOOL=0 (the default)  the legacy, env-configured school, always. The Host
 *                                 header is not consulted and the session is not read,
 *                                 so a single-school deployment behaves EXACTLY as it
 *                                 did before this file existed.
 *   MULTI_SCHOOL=1                1. the request host (`fs_school_domain`), honouring
 *                                    `X-Forwarded-Host` because the edge terminates TLS
 *                                    and the app only ever sees its own origin otherwise;
 *                                 2. the session's `current_school_did` (Task 4 writes
 *                                    it — read defensively, since a deployment mid-
 *                                    migration may not have the column yet);
 *                                 3. the only school, when there is exactly one (a
 *                                    deployment that flipped the flag before it had a
 *                                    second city, and the apex front door of MS ruling 2);
 *                                 4. otherwise nothing — and `currentSchool` 404s.
 *
 * 404 `UnknownSchool`, never 403: a host that names no school must not be able to tell
 * the difference between "no school here" and "a school you may not see" (MS §10).
 *
 * THE LEGACY FALLBACK IS SYNTHETIC WHEN IT HAS TO BE. `ensureLegacySchoolRow()` writes
 * the `fs_school` row at boot, but unit suites build the app without booting; rather
 * than make every one of them seed a row, an absent row for the env-configured DID is
 * answered with a School object built from the same env values the row would have held.
 * Nothing downstream can tell, because everything downstream only ever uses `.did`.
 */
import type { Context, MiddlewareHandler } from 'hono'
import { config } from '../config.js'
import {
  getSchool,
  legacySchoolDid,
  legacySchoolLabel,
  listSchools,
  normalizeHost,
  schoolByHost,
  type School,
} from '../lib/schools.js'
import { getDb } from '../db/index.js'
import { session } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import type { AppEnv } from './session.js'

/** Thrown by `currentSchool` when nothing resolved. `http/app.ts#onError` renders it. */
export class UnknownSchoolError extends Error {
  readonly status = 404
  readonly code = 'UnknownSchool'
  constructor() {
    super('no school is served on this host')
    this.name = 'UnknownSchoolError'
  }
}

/** The legacy school, memoised: one row read per process rather than one per request. */
let legacyCache: { at: number; school: School | undefined } | undefined
const LEGACY_TTL_MS = 60_000

export function resetSchoolContextCache(): void {
  legacyCache = undefined
}

/**
 * The env-configured school as a row, or as a synthetic stand-in when `fs_school` has no
 * row for it yet (see the module doc). `undefined` only when `SCHOOL_DID` is unset.
 */
export async function legacySchool(): Promise<School | undefined> {
  const did = legacySchoolDid()
  if (!did) return undefined
  if (legacyCache && Date.now() - legacyCache.at < LEGACY_TTL_MS && legacyCache.school?.did === did) {
    return legacyCache.school
  }
  const row = await getSchool(did).catch(() => undefined)
  const school = row ?? syntheticLegacySchool(did)
  legacyCache = { at: Date.now(), school }
  return school
}

function syntheticLegacySchool(did: string): School {
  const label = legacySchoolLabel()
  return {
    did,
    label,
    name: `${label.charAt(0).toUpperCase()}${label.slice(1)} Free School`,
    city: null,
    handle: config().SCHOOL_HANDLE || label,
    createdAt: new Date(0),
    creationState: 'active',
  }
}

/**
 * The host this request was made to. `X-Forwarded-Host` first (Caddy sets it; the app
 * never faces the internet directly in production), then `Host`, then the URL — the last
 * so a test that calls `app.request('http://denver.localhost/api/x')` resolves without
 * having to set a header.
 */
export function requestHost(c: Context): string {
  const forwarded = c.req.header('x-forwarded-host')
  if (forwarded) return normalizeHost(forwarded.split(',')[0] ?? '')
  const host = c.req.header('host')
  if (host) return normalizeHost(host)
  try {
    return normalizeHost(new URL(c.req.url).host)
  } catch {
    return ''
  }
}

/** The session's `current_school_did`, or undefined. Never throws — the column is Task 4's. */
async function sessionSchool(c: Context<AppEnv>): Promise<School | undefined> {
  const viewer = c.var.viewer
  if (!viewer) return undefined
  try {
    const rows = await getDb()
      .select({ did: session.currentSchoolDid })
      .from(session)
      .where(eq(session.id, viewer.sessionId))
      .limit(1)
    const did = rows[0]?.did
    return did ? await getSchool(did) : undefined
  } catch {
    return undefined
  }
}

export async function resolveSchool(c: Context<AppEnv>): Promise<School | undefined> {
  if (!config().MULTI_SCHOOL) return legacySchool()

  const host = requestHost(c)
  if (host) {
    const byHost = await schoolByHost(host).catch(() => undefined)
    if (byHost) return byHost
  }

  const fromSession = await sessionSchool(c)
  if (fromSession) return fromSession

  const all = await listSchools().catch(() => [] as School[])
  if (all.length === 1) return all[0]
  return undefined
}

/**
 * Mounted once, before every router. Resolves and stashes; NEVER rejects — a request to
 * an unknown host that touches no per-school data (the health check, the OAuth metadata,
 * `/internal/tls-check`) must still work.
 */
export const withSchool: MiddlewareHandler<AppEnv> = async (c, next) => {
  const school = await resolveSchool(c)
  if (school) c.set('school', school)
  await next()
}

/** The school this request is for. Throws 404 `UnknownSchool` when nothing resolved. */
export function currentSchool(c: Context<AppEnv>): School {
  const school = c.var.school
  if (!school) throw new UnknownSchoolError()
  return school
}

/** `currentSchool(c).did`, the form nine call sites in ten actually want. */
export function currentSchoolDid(c: Context<AppEnv>): string {
  return currentSchool(c).did
}

/** The school, or `undefined` — for the handful of routes that degrade instead of 404ing. */
export function optionalSchool(c: Context<AppEnv>): School | undefined {
  return c.var.school
}
