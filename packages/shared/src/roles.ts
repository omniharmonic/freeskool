/**
 * Role ladder. Roles are DERIVED VIEWS over attestation records, never stored tokens.
 * The AppView computes a role with this function and then writes a coop.lexicon.membership
 * claim {subject, role} as the school; the protocol only ever sees the claim.
 * Integer values match coop.lexicon.membership's open registry (10/20/30/40).
 */
export enum Role {
  Visitor = 0,
  Member = 10,
  Host = 20,
  Facilitator = 30,
  Steward = 40,
}

export type MemberGate = 'none' | 'invite-or-vouch' | 'attended-one'

/** Per-school policy parameters; mirrors freeschool.draft.policy#thresholds. */
export interface Thresholds {
  memberRequires: MemberGate
  hostMinAttended: number
  facilitatorMinHosted: number
  firstEventApproval: boolean
  feedbackK: number
  destructiveActionStewards: number
  /**
   * A steward's explicit choice to let a qualifying member's DERIVED role reach the
   * protocol as a `coop.lexicon.membership` claim (see
   * `apps/appview/src/lib/membership-claims.ts`). OFF by default: publishing is also
   * gated per-member on an opt-in, so this alone never names anyone.
   */
  publishRoles?: boolean
}

/** Lex's defaults: "if you say you're part of Free School, you're part of Free School." */
export const defaultThresholds: Thresholds = {
  memberRequires: 'none',
  hostMinAttended: 0,
  facilitatorMinHosted: 3,
  firstEventApproval: false,
  feedbackK: 3,
  destructiveActionStewards: 2,
  publishRoles: false,
}

/** Evidence the AppView derives from public records (and the steward list). */
export interface Evidence {
  hasProfile: boolean
  inviteOrVouch: boolean
  /** attendance records with participated=true written by a host other than the subject */
  attendedConfirmed: number
  /** events the subject hosted that have at least one attendance record */
  hostedEvents: number
  /** negative hostFeedback upheld by a moderation action */
  upheldNegativeFeedback: number
  /** founder-appointed during bootstrap or elected afterwards */
  stewardAppointed: boolean
}

export function deriveRole(e: Evidence, t: Thresholds): Role {
  if (!e.hasProfile) return Role.Visitor
  const admitted =
    t.memberRequires === 'none' ||
    (t.memberRequires === 'invite-or-vouch' && e.inviteOrVouch) ||
    (t.memberRequires === 'attended-one' && e.attendedConfirmed >= 1)
  if (!admitted) return Role.Visitor
  if (e.stewardAppointed) return Role.Steward
  if (e.attendedConfirmed < t.hostMinAttended) return Role.Member
  if (e.hostedEvents >= t.facilitatorMinHosted && e.upheldNegativeFeedback === 0) return Role.Facilitator
  return Role.Host
}

export function canHost(role: Role): boolean { return role >= Role.Host }
export function canModerate(role: Role): boolean { return role >= Role.Steward }

const ROLE_LABELS: Record<Role, string> = {
  [Role.Visitor]: 'Visitor',
  [Role.Member]: 'Member',
  [Role.Host]: 'Host',
  [Role.Facilitator]: 'Facilitator',
  [Role.Steward]: 'Steward',
}

/** Plain-language label for a derived role — for the members directory and profile UI. */
export function roleLabel(role: Role): string {
  return ROLE_LABELS[role] ?? 'Member'
}
