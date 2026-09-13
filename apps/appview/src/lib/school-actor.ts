/**
 * The ONE place the school's credential exists in this process.
 *
 * Nothing outside this module may touch `SCHOOL_APP_PASSWORD` or the school's agent
 * (R3 invariant 1). Everything that writes as the school goes through the
 * `SchoolActorPort` returned by `schoolActor()`, which is `AppCustodyAdapter` from
 * `@freeschool/school-actor` wired to:
 *
 *   RoleSource   -> `deriveRole` over indexed records + app tables (src/lib/roles.ts)
 *   PolicySource -> the school's `freeschool.draft.policy#thresholds` (src/lib/policy.ts)
 *   AuditSink    -> `fs_audit`, one row per call, allow or deny
 *   SchoolSession-> an app-password session for `SCHOOL_DID`
 *
 * When Phase 2 swaps in `ArbiterAdapter`, only this file changes.
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
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import { audit } from '../db/schema.js'
import { rowId } from './ids.js'
import { agentForAppPassword } from './pds.js'
import { getThresholds } from './policy.js'
import { roleOf } from './roles.js'
import { log } from './logging.js'

class PostgresAuditSink implements AuditSink {
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

/**
 * An app-password session for the school DID. Lazily established, re-established on a
 * 401 (app-password sessions expire), and never handed out.
 */
class AppPasswordSchoolSession implements SchoolSession {
  private agent: AtpAgent | undefined

  constructor(
    private readonly identifier: string,
    private readonly password: string,
    private readonly service: string,
  ) {}

  private async get(): Promise<AtpAgent> {
    if (this.agent) return this.agent
    if (!this.identifier || !this.password) {
      throw new Error('SCHOOL_DID / SCHOOL_APP_PASSWORD are not configured (run scripts/create-school.ts)')
    }
    const { agent } = await agentForAppPassword(this.identifier, this.password, this.service)
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

let port: SchoolActorPort | undefined

export function schoolActor(): SchoolActorPort {
  if (port) return port
  const c = config()
  port = new AppCustodyAdapter({
    roles,
    policy,
    audit: new PostgresAuditSink(),
    session: new AppPasswordSchoolSession(c.SCHOOL_HANDLE || c.SCHOOL_DID, c.SCHOOL_APP_PASSWORD, c.PDS_URL),
    pdsEndpoint: c.PDS_URL,
  })
  return port
}

/** Tests and scripts inject their own wiring. */
export function setSchoolActor(p: SchoolActorPort | undefined): void {
  port = p
}

export function schoolDid(): Did {
  const did = config().SCHOOL_DID
  if (!did.startsWith('did:')) throw new Error('SCHOOL_DID is not configured')
  return did as Did
}
