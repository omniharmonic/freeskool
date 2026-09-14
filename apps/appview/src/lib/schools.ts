/**
 * The school registry: one row per school this AppView hosts (`fs_school`), the hosts
 * that resolve to it (`fs_school_domain`), and the wrapped app password it acts with
 * (`fs_school_credential`).
 *
 * v1 has exactly one school — Boulder — and it is configured in the environment
 * (`SCHOOL_DID`, `SCHOOL_HANDLE`, `SCHOOL_APP_PASSWORD`), not in the database. This
 * module is the bridge: `ensureLegacySchoolRow()` puts that env-configured school into
 * the table at every boot, so from Task 3 onwards the TABLE is what code reads and the
 * env vars are only the legacy fallback. `legacySchoolDid()` is the single place that
 * still reads `config().SCHOOL_DID`, so Appendix A's read sites have exactly one thing
 * left to point at.
 *
 * Nothing here changes behaviour on its own: with `MULTI_SCHOOL=0` the one row this
 * writes is the school every request already meant.
 */
import { eq } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { school, schoolDomain } from '../db/schema.js'
import { config } from '../config.js'

export type School = typeof school.$inferSelect
export type SchoolDomain = typeof schoolDomain.$inferSelect

/** The env-configured school. `''` when this deployment has not been bootstrapped yet. */
export function legacySchoolDid(): string {
  return config().SCHOOL_DID
}

export async function getSchool(did: string, db: Db = getDb()): Promise<School | undefined> {
  if (!did) return undefined
  const [row] = await db.select().from(school).where(eq(school.did, did)).limit(1)
  return row
}

/** Every school this AppView hosts, oldest first. Public-safe fields only — see MS §8. */
export async function listSchools(db: Db = getDb()): Promise<School[]> {
  return db.select().from(school).orderBy(school.createdAt)
}

/**
 * Host → school. The `Host` header is case-insensitive and may carry a port; both are
 * normalised away before the lookup, so `Boulder.Freeskool.xyz:443` finds the row
 * written as `boulder.freeskool.xyz`.
 */
export async function schoolByHost(host: string, db: Db = getDb()): Promise<School | undefined> {
  const normalized = normalizeHost(host)
  if (!normalized) return undefined
  const [row] = await db
    .select({ school })
    .from(schoolDomain)
    .innerJoin(school, eq(school.did, schoolDomain.schoolDid))
    .where(eq(schoolDomain.host, normalized))
    .limit(1)
  return row?.school
}

export function normalizeHost(host: string): string {
  const trimmed = (host ?? '').trim().toLowerCase()
  if (!trimmed) return ''
  // Strip a port, but not the colons of a bracketed IPv6 literal.
  if (trimmed.startsWith('[')) return trimmed.replace(/\]:\d+$/, ']')
  return trimmed.replace(/:\d+$/, '')
}

/**
 * The subdomain label the legacy school is (or would be) served from: the first label of
 * its handle, `boulder` in `boulder.freeskool.xyz`. This is the value the reserved-label
 * list protects and the one `<label>.<suffix>` alias is built from.
 */
export function legacySchoolLabel(handle = config().SCHOOL_HANDLE): string {
  const first = normalizeHost(handle).split('.')[0] ?? ''
  return /^[a-z0-9][a-z0-9-]*$/.test(first) ? first : 'school'
}

/**
 * The host this deployment is served from — the canonical domain of the legacy school.
 * Taken from `webPublicUrl` rather than a new env var, because that URL is already the
 * one invite links, the OAuth client id and the newsletter are built from.
 */
export function legacyCanonicalHost(): string {
  try {
    return normalizeHost(new URL(config().webPublicUrl).hostname)
  } catch {
    return ''
  }
}

/**
 * Both hosts the legacy school answers on: the apex it is served from today (canonical —
 * "the apex IS Boulder, for now", MS §9 B) and the `<label>.<apex>` subdomain the
 * federation phase moves it to (alias). Deduplicated, so a deployment already served
 * from `boulder.freeskool.xyz` gets one row, not two.
 */
export function legacySchoolHosts(): { host: string; kind: 'canonical' | 'alias' }[] {
  const canonical = legacyCanonicalHost()
  if (!canonical) return []
  const out: { host: string; kind: 'canonical' | 'alias' }[] = [{ host: canonical, kind: 'canonical' }]
  const alias = `${legacySchoolLabel()}.${canonical}`
  if (alias !== canonical && !canonical.startsWith(`${legacySchoolLabel()}.`)) {
    out.push({ host: alias, kind: 'alias' })
  }
  return out
}

export interface EnsureLegacySchoolOptions {
  name?: string
  city?: string
}

/**
 * Put the env-configured school into `fs_school` (and its hosts into `fs_school_domain`)
 * if it is not already there. Called at boot right after the migrations, and by
 * `scripts/backfill-school.ts`.
 *
 * Idempotent by construction: every write is `ON CONFLICT DO NOTHING`, so a second run —
 * or a row a steward has since edited — is left exactly as it is. Returns the DID it
 * ensured, or `undefined` when `SCHOOL_DID` is unset (a deployment that has not run
 * `create-school` yet: nothing to do, and no reason to fail the boot).
 */
export async function ensureLegacySchoolRow(
  options: EnsureLegacySchoolOptions = {},
  db: Db = getDb(),
): Promise<string | undefined> {
  const did = legacySchoolDid()
  if (!did) return undefined
  const label = legacySchoolLabel()
  await db
    .insert(school)
    .values({
      did,
      label,
      name: options.name || defaultSchoolName(label),
      city: options.city || null,
      handle: config().SCHOOL_HANDLE || label,
      creationState: 'active',
    })
    .onConflictDoNothing()

  const hosts = legacySchoolHosts()
  if (hosts.length > 0) {
    await db
      .insert(schoolDomain)
      .values(hosts.map((h) => ({ host: h.host, schoolDid: did, kind: h.kind })))
      .onConflictDoNothing()
  }
  return did
}

function defaultSchoolName(label: string): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} Free School`
}
