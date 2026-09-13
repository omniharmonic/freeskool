/**
 * SchoolActorPort — the ONE chokepoint for every write the app makes AS THE SCHOOL.
 *
 * From R3 (Arbiter review, 2026-09-12): v1 = AppCustodyAdapter (app-held school credential);
 * Phase 2 = ArbiterAdapter (`<scope>.arbiter.proxy`). Call sites only ever see this port.
 * The body of `actAs` mirrors the Arbiter proxy body 1:1 on purpose so the swap is a no-op
 * at call sites. Invariants (R3 §Recommendation): scope required; target is `{did}#{service}`;
 * one inner XRPC per call; CAS (swapRecord/swapCommit) everywhere; approvals live in a record,
 * not process state; audit row on every call.
 */
import type { Role } from '@freeschool/shared'

export type Did = `did:${string}`
export type Nsid = string
export type AtUri = `at://${string}`

export type SchoolAction =
  | 'publish-event'
  | 'curate-listing'
  | 'remove-listing'
  | 'restore-listing'
  | 'remove-resource'
  | 'restore-resource'
  | 'set-role'
  | 'suspend-role'
  | 'write-policy'
  | 'close-request'
  | 'void-attendance'
  | 'materialize-occurrence'
  /**
   * The school republishing a MEMBER'S OWN already-derived role as a public
   * `coop.lexicon.membership` claim, once that member has opted in and the policy
   * allows it (see `apps/appview/src/lib/membership-claims.ts`). The caller is the
   * subject themselves — they are consenting to their own already-qualifying role
   * being named, not asking the school to grant anything — so this sits at Host, not
   * Steward. Distinct from `set-role`, which is a STEWARD decision (e.g. a hand-off).
   */
  | 'publish-role-claim'
  /**
   * The school retracting a previously-published `coop.lexicon.membership` claim
   * (opted back out, or the role dropped below Host). Visitor-level on purpose: by the
   * time this is needed the subject's CURRENT role may itself be below Host, and
   * removing a name one already consented to naming can never need a HIGHER bar than
   * publishing it did.
   */
  | 'retract-role-claim'

/**
 * Actions that require the policy's destructiveActionStewards threshold (default 2).
 *
 * `write-policy` is deliberately NOT here: PRD F15 requires an admin to change every
 * policy default without a deploy, and the first school has exactly one steward — a
 * two-steward threshold on policy writes would make the policy unwritable. Policy writes
 * stay single-steward but remain audit-logged (every `actAs`/`putRecordAsSchool` call
 * writes an `AuditRow` regardless of threshold), and the policy record itself is public,
 * so any steward changing the threshold (or anything else) is visible to the community.
 */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<SchoolAction> = new Set<SchoolAction>([
  'remove-listing', 'remove-resource', 'suspend-role', 'void-attendance',
])

export interface Approval { stewardDid: Did; at: string; sig?: string }
export interface Audit { reason: string; approvals?: Approval[] }

export interface ActInput {
  schoolDid: Did
  callerDid: Did
  /** REQUIRED in v1 even though v1 ignores it — becomes Arbiter `trustedScopes` verbatim. */
  scope: Nsid
  target?: `${Did}#${string}`
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  nsid: Nsid
  parameters?: Record<string, unknown>
  body?: unknown
  encoding?: string
  idempotencyKey?: string
  action: SchoolAction
  audit: Audit
}

/** Deliberately the Arbiter's own envelope so v1 UI already handles policy denials. */
export type ActResult =
  | { ok: true; status: number; output: unknown; auditId: string }
  | { ok: false; status: number; error: string; message?: string; auditId: string }

export interface AuthorizeResult { allowed: boolean; role: Role; reason: string; requiresApprovals?: number }

export interface SchoolActorPort {
  describeActor(i: { schoolDid: Did }): Promise<{
    schoolDid: Did; pdsEndpoint: string; custody: 'app-owned' | 'arbiter';
    arbiterServerDid?: Did; arbiterUrl?: string; online: boolean
  }>
  actAs(i: ActInput): Promise<ActResult>
  putRecordAsSchool(i: { schoolDid: Did; callerDid: Did; scope: Nsid; action: SchoolAction; collection: Nsid; rkey: string; record: unknown; swapRecord?: string | null; audit: Audit }): Promise<{ uri: AtUri; cid: string; auditId: string }>
  deleteRecordAsSchool(i: { schoolDid: Did; callerDid: Did; scope: Nsid; action: SchoolAction; collection: Nsid; rkey: string; swapRecord?: string; audit: Audit }): Promise<{ auditId: string }>
  authorize(i: { schoolDid: Did; callerDid: Did; action: SchoolAction; subject?: AtUri | Did }): Promise<AuthorizeResult>
}

/** Minimal record-shaped inputs the authorizer needs. Pure function of records (R3 invariant 8). */
export interface RoleSource { roleOf(schoolDid: Did, did: Did): Promise<Role> }
export interface PolicySource { destructiveActionStewards(schoolDid: Did): Promise<number> }
export interface AuditSink { write(row: AuditRow): Promise<string> }
export interface AuditRow {
  callerDid: Did; schoolDid: Did; scope: Nsid; nsid: Nsid; action: SchoolAction
  decision: 'allow' | 'deny'; reason: string; approvals: Approval[]
  policySource: string; at: string
}
/** Executes the inner XRPC with the school's session. v1: app-held credential. */
export interface SchoolSession { call(i: { method: string; nsid: Nsid; parameters?: Record<string, unknown>; body?: unknown; encoding?: string }): Promise<{ status: number; output: unknown }> }
