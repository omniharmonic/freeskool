/**
 * THE SCHOOL ACTOR REGISTRY — one `SchoolActorPort` per school, and the ONE place any
 * school's credential exists in this process (R3 invariant 1, CLAUDE.md).
 *
 * `SchoolActorPort` was always multi-school: every method takes `schoolDid`
 * (`packages/school-actor/src/port.ts`). What was single-school was the wiring — one
 * module-scoped port built from one `SCHOOL_APP_PASSWORD`. This module replaces that
 * with `actorFor(schoolDid)` (MS §5):
 *
 *   - credentials come from `fs_school_credential`, AES-256-GCM wrapped under the
 *     versioned `CUSTODY_KEYS` exactly as a custodial member's password is, so rotation
 *     re-wraps rather than resets and there is no second key-management story;
 *   - the ENV credential (`SCHOOL_HANDLE`/`SCHOOL_APP_PASSWORD`) remains the fallback for
 *     the LEGACY school alone, which is what makes Boulder's migration a no-op for the
 *     operator and what keeps every existing test — none of which seed a credential row —
 *     behaving exactly as before;
 *   - ports are cached per school (TTL + an LRU cap: an unbounded map is still a leak)
 *     and evicted on rotation with `evictSchoolActor`;
 *   - ISOLATION: the credential is resolved LAZILY, inside the session, so a school whose
 *     credential is missing or revoked fails only its own writes. Building the port never
 *     touches the database or the PDS.
 *
 * `setSchoolActor(port)` overrides EVERY school — it is the test/script injection seam
 * (`test/handoff.test.ts` wires a real `AppCustodyAdapter` against the real `fs_audit`
 * and fakes only the PDS session), and a single override is right there precisely because
 * those suites have exactly one school.
 */
import type { AtpAgent } from '@atproto/api'
import {
  AppCustodyAdapter,
  type AuditRow,
  type AuditSink,
  type Did,
  type PolicySource,
  type RoleSource,
  type SchoolActorPort,
  type SchoolSession,
} from '@freeschool/school-actor'
import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { audit, school, schoolCredential } from '../db/schema.js'
import { unwrapSecret } from './crypto.js'
import { rowId } from './ids.js'
import { agentForAppPassword } from './pds.js'
import { getThresholds } from './policy.js'
import { roleOf } from './roles.js'
import { legacySchoolDid } from './schools.js'
import { log } from './logging.js'

/** Exported so tests can wire a REAL `AppCustodyAdapter` against the real `fs_audit`
 * table while faking only the PDS session — see `test/handoff.test.ts`. */
export class PostgresAuditSink implements AuditSink {
  async write(row: AuditRow): Promise<string> {
    const id = rowId()
    await getDb().insert(audit).values({
      id,
      callerDid: row.callerDid,
      schoolDid: row.schoolDid,
      scope: row.scope,
      nsid: row.nsid,
      action: row.action,
      decision: row.decision,
      reason: row.reason,
      approvals: row.approvals,
      policySource: row.policySource,
      at: new Date(row.at),
    })
    // The audit row holds DIDs; the log line never does.
    log.info('school action', { action: row.action, decision: row.decision, nsid: row.nsid })
    return id
  }
}

const roles: RoleSource = {
  async roleOf(schoolDid, did) {
    return roleOf(did, schoolDid)
  },
}

const policy: PolicySource = {
  async destructiveActionStewards(schoolDid) {
    return (await getThresholds(schoolDid)).destructiveActionStewards
  },
}

export interface SchoolCredential {
  identifier: string
  password: string
  service: string
}

/**
 * The credential this school acts with: its `fs_school_credential` row, unwrapped; or,
 * for the LEGACY school only, the env values it was bootstrapped from. Throws when a
 * school has neither, which the session surfaces at the moment of a write and never at
 * boot — one school's revoked credential must not take the process's other schools down.
 */
export async function credentialFor(schoolDid: string): Promise<SchoolCredential> {
  const c = config()
  try {
    const [row] = await getDb()
      .select({
        keyVersion: schoolCredential.keyVersion,
        blob: schoolCredential.appPasswordWrapped,
        handle: school.handle,
      })
      .from(schoolCredential)
      .leftJoin(school, eq(school.did, schoolCredential.schoolDid))
      .where(eq(schoolCredential.schoolDid, schoolDid))
      .limit(1)
    if (row?.blob) {
      return {
        identifier: row.handle || schoolDid,
        password: unwrapSecret({ keyVersion: row.keyVersion, blob: Buffer.from(row.blob) }),
        service: c.PDS_URL,
      }
    }
  } catch (err) {
    // A missing table (a deployment mid-migration) or an unreadable row is the same
    // situation as no row: fall through to the env credential, then to the error below.
    log.warn('school credential lookup failed; falling back to the environment', {
      detail: err instanceof Error ? err.name : 'unknown',
    })
  }

  if (schoolDid === legacySchoolDid() && c.SCHOOL_APP_PASSWORD) {
    return { identifier: c.SCHOOL_HANDLE || schoolDid, password: c.SCHOOL_APP_PASSWORD, service: c.PDS_URL }
  }
  throw new Error(
    `no credential for school ${schoolDid}: no fs_school_credential row, and it is not the env-configured school ` +
      '(run scripts/create-school.ts, or scripts/backfill-school.ts to import the env credential)',
  )
}

/**
 * An app-password session for ONE school. Lazily established, re-established on a 401
 * (app-password sessions expire), and never handed out.
 */
class AppPasswordSchoolSession implements SchoolSession {
  private agent: AtpAgent | undefined

  constructor(private readonly resolve: () => Promise<SchoolCredential>) {}

  private async get(): Promise<AtpAgent> {
    if (this.agent) return this.agent
    const cred = await this.resolve()
    if (!cred.identifier || !cred.password) {
      throw new Error('SCHOOL_DID / SCHOOL_APP_PASSWORD are not configured (run scripts/create-school.ts)')
    }
    const { agent } = await agentForAppPassword(cred.identifier, cred.password, cred.service)
    this.agent = agent
    return agent
  }

  async call(i: {
    method: string
    nsid: string
    parameters?: Record<string, unknown>
    body?: unknown
    encoding?: string
  }): Promise<{ status: number; output: unknown }> {
    const run = async () => {
      const agent = await this.get()
      const res = await agent.call(
        i.nsid,
        i.parameters as Record<string, string> | undefined,
        i.method === 'GET' ? undefined : i.body,
        i.method === 'GET' ? undefined : { encoding: i.encoding ?? 'application/json' },
      )
      return { status: res.success ? 200 : 500, output: res.data as unknown }
    }
    try {
      return await run()
    } catch (err) {
      if (isAuthExpired(err)) {
        this.agent = undefined
        return run()
      }
      throw err
    }
  }
}

function isAuthExpired(err: unknown): boolean {
  const e = err as { status?: number; error?: string }
  return e?.status === 400 || e?.status === 401 || e?.error === 'ExpiredToken'
}

/** Process-wide override: when set, EVERY school uses it. Tests and scripts only. */
let override: SchoolActorPort | undefined

const ports = new Map<string, { port: SchoolActorPort; at: number }>()
/** MS §5: bounded alongside the TTL — an unbounded map keyed by a growing set is a leak. */
const CACHE_CAP = 64

function buildPort(schoolDid: string): SchoolActorPort {
  return new AppCustodyAdapter({
    roles,
    policy,
    audit: new PostgresAuditSink(),
    session: new AppPasswordSchoolSession(() => credentialFor(schoolDid)),
    pdsEndpoint: config().PDS_URL,
  })
}

/**
 * The port this school writes through. Every write as a school goes through the port for
 * THAT school — there is no other path, and `schoolDid` is not a parameter a caller may
 * disagree with the port about (the adapter stamps it on the audit row).
 */
export async function actorFor(schoolDid: string): Promise<SchoolActorPort> {
  if (override) return override
  const ttl = config().SCHOOL_ACTOR_CACHE_TTL_MS
  const hit = ports.get(schoolDid)
  if (hit && Date.now() - hit.at < ttl) {
    // Touch on a HIT: delete-then-set moves the entry to the back of the Map's insertion
    // order, which is what makes the eviction below least-RECENTLY-used rather than
    // merely oldest-created. Without this a busy school built early would be evicted
    // ahead of an idle one built late.
    ports.delete(schoolDid)
    ports.set(schoolDid, hit)
    return hit.port
  }
  const port = buildPort(schoolDid)
  ports.delete(schoolDid)
  if (ports.size >= CACHE_CAP) {
    const lru = ports.keys().next().value
    if (lru !== undefined) ports.delete(lru)
  }
  ports.set(schoolDid, { port, at: Date.now() })
  return port
}

/** Drop one school's cached port — credential rotation, archival, persistent auth failure. */
export function evictSchoolActor(schoolDid: string): void {
  ports.delete(schoolDid)
}

export function evictAllSchoolActors(): void {
  ports.clear()
}

/** Tests and scripts inject their own wiring, for every school at once. */
export function setSchoolActor(p: SchoolActorPort | undefined): void {
  override = p
  ports.clear()
}

/** The env-configured school's DID, as a `Did`. Only scripts and the legacy path use it. */
export function schoolDid(): Did {
  const did = legacySchoolDid()
  if (!did.startsWith('did:')) throw new Error('SCHOOL_DID is not configured')
  return did as Did
}

/** Narrowing helper: `currentSchool(c).did` is a string; the port wants a `Did`. */
export function asDid(did: string): Did {
  if (!did.startsWith('did:')) throw new Error('not a DID')
  return did as Did
}
