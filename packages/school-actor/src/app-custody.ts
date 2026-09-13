import { Role } from '@freeschool/shared'
import { DESTRUCTIVE_ACTIONS, type ActInput, type ActResult, type AtUri, type AuditSink, type AuthorizeResult, type Did, type PolicySource, type RoleSource, type SchoolAction, type SchoolActorPort, type SchoolSession } from './port.js'

const MIN_ROLE: Record<SchoolAction, Role> = {
  'publish-event': Role.Host,
  'materialize-occurrence': Role.Host,
  'curate-listing': Role.Facilitator,
  'close-request': Role.Facilitator,
  'remove-listing': Role.Steward,
  'restore-listing': Role.Steward,
  'set-role': Role.Steward,
  'suspend-role': Role.Steward,
  'write-policy': Role.Steward,
  'void-attendance': Role.Steward,
}

/**
 * v1 adapter: the app holds the school's credential. Every call is authorized against
 * membership role claims, threshold-checked for destructive actions, audit-logged, then
 * executed once. Nothing else in the codebase may touch the school session (R3 invariant 1).
 */
export class AppCustodyAdapter implements SchoolActorPort {
  constructor(private deps: { roles: RoleSource; policy: PolicySource; audit: AuditSink; session: SchoolSession; pdsEndpoint: string; now?: () => string }) {}

  async describeActor(i: { schoolDid: Did }) {
    return { schoolDid: i.schoolDid, pdsEndpoint: this.deps.pdsEndpoint, custody: 'app-owned' as const, online: true }
  }

  async authorize(i: { schoolDid: Did; callerDid: Did; action: SchoolAction }): Promise<AuthorizeResult> {
    const role = await this.deps.roles.roleOf(i.schoolDid, i.callerDid)
    const needed = MIN_ROLE[i.action]
    if (role < needed) return { allowed: false, role, reason: `requires role >= ${needed}, caller has ${role}` }
    const requiresApprovals = DESTRUCTIVE_ACTIONS.has(i.action) ? await this.deps.policy.destructiveActionStewards(i.schoolDid) : undefined
    return { allowed: true, role, reason: 'ok', requiresApprovals }
  }

  async actAs(i: ActInput): Promise<ActResult> {
    if (!i.scope) throw new Error('scope is required (R3 invariant 2)')
    if (!i.audit?.reason?.trim()) throw new Error('a written reason is mandatory')
    const at = (this.deps.now ?? (() => new Date().toISOString()))()
    const authz = await this.authorize(i)
    const deny = async (status: number, error: string, message: string): Promise<ActResult> => {
      const auditId = await this.deps.audit.write({ callerDid: i.callerDid, schoolDid: i.schoolDid, scope: i.scope, nsid: i.nsid, action: i.action, decision: 'deny', reason: message, approvals: i.audit.approvals ?? [], policySource: 'app:v1', at })
      return { ok: false, status, error, message, auditId }
    }
    if (!authz.allowed) return deny(403, 'ErrPermissionDenied', authz.reason)
    if (authz.requiresApprovals) {
      const approvers = new Set((i.audit.approvals ?? []).map((a) => a.stewardDid))
      approvers.add(i.callerDid)
      // every approver must themselves be a steward
      for (const did of approvers) {
        if ((await this.deps.roles.roleOf(i.schoolDid, did)) < Role.Steward) return deny(403, 'ErrPermissionDenied', `approver ${did} is not a steward`)
      }
      if (approvers.size < authz.requiresApprovals) return deny(403, 'ErrThresholdNotMet', `destructive action needs ${authz.requiresApprovals} stewards, have ${approvers.size}`)
    }
    const auditId = await this.deps.audit.write({ callerDid: i.callerDid, schoolDid: i.schoolDid, scope: i.scope, nsid: i.nsid, action: i.action, decision: 'allow', reason: i.audit.reason, approvals: i.audit.approvals ?? [], policySource: 'app:v1', at })
    const res = await this.deps.session.call({ method: i.method, nsid: i.nsid, parameters: i.parameters, body: i.body, encoding: i.encoding })
    return { ok: true, status: res.status, output: res.output, auditId }
  }

  async putRecordAsSchool(i: { schoolDid: Did; callerDid: Did; scope: string; action: SchoolAction; collection: string; rkey: string; record: unknown; swapRecord?: string | null; audit: ActInput['audit'] }) {
    const r = await this.actAs({ ...i, method: 'POST', nsid: 'com.atproto.repo.putRecord', body: { repo: i.schoolDid, collection: i.collection, rkey: i.rkey, record: i.record, swapRecord: i.swapRecord ?? null } })
    if (!r.ok) throw new SchoolActError(r)
    const out = r.output as { uri: AtUri; cid: string }
    return { uri: out.uri, cid: out.cid, auditId: r.auditId }
  }

  async deleteRecordAsSchool(i: { schoolDid: Did; callerDid: Did; scope: string; action: SchoolAction; collection: string; rkey: string; swapRecord?: string; audit: ActInput['audit'] }) {
    const r = await this.actAs({ ...i, method: 'POST', nsid: 'com.atproto.repo.deleteRecord', body: { repo: i.schoolDid, collection: i.collection, rkey: i.rkey, swapRecord: i.swapRecord } })
    if (!r.ok) throw new SchoolActError(r)
    return { auditId: r.auditId }
  }
}

export class SchoolActError extends Error {
  constructor(public result: Extract<ActResult, { ok: false }>) { super(result.message ?? result.error); this.name = 'SchoolActError' }
}
