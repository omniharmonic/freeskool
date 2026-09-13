/**
 * Response shapes returned by the AppView (`apps/appview/src/http/routes/*.ts`).
 *
 * These mirror the JSON the server actually sends, read directly from the
 * route handlers — not the ATProto lexicons, which are broader than any one
 * projection. Where a route is not implemented yet (see `api.ts` for the
 * list), the shape here is a best-effort guess that a later task may need to
 * adjust once the real route exists.
 */

export type ViewerRole = number;

export type ViewerRelation = 'public' | 'rsvped' | 'attended' | 'host' | 'steward' | string;

// ── auth ──────────────────────────────────────────────────────────────────

export interface SignupResult {
  did: string;
  handle: string;
  verifyUrl: string;
}

export interface VerifyResult {
  ok: boolean;
  did: string;
}

export interface AuthMe {
  did: string;
  kind: 'custodial' | 'oauth';
  role: ViewerRole;
  handle?: string;
  isCustodial: boolean;
  emailVerified: boolean;
}

// ── calendar / events ────────────────────────────────────────────────────

export interface EventLocation {
  name?: string;
  locality?: string;
  [key: string]: unknown;
}

export interface EventUriRef {
  uri: string;
  name?: string;
}

export interface CalendarEvent {
  uri: string;
  hostDid: string;
  name?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  mode?: string;
  status?: string;
  locations?: EventLocation[];
  uris?: EventUriRef[];
  /** Added by Task 2; absent until then. */
  venueNeeded?: boolean;
  tags?: string[];
  origin?: 'ours' | 'listed';
  [key: string]: unknown;
}

export interface CalendarResponse {
  from: string;
  to: string;
  events: CalendarEvent[];
}

export interface RsvpCounts {
  going: number;
  interested: number;
  [key: string]: number;
}

export interface SkillLevelRef {
  skill: string;
  level: 1 | 2 | 3;
  prerequisites?: string;
}

export interface EventDetail extends CalendarEvent {
  listed: boolean;
  skills: SkillLevelRef[];
  rsvps: RsvpCounts;
  viewerRelation: ViewerRelation;
}

export interface EventSeriesInput {
  rrule: string;
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  byDay?: string[];
  until?: string;
  count?: number;
  exdates?: string[];
  timezone: string;
  materializeAhead?: number;
}

export interface CreateEventInput {
  name: string;
  description?: string;
  startsAt: string;
  endsAt?: string;
  mode?: string;
  locations?: unknown[];
  uris?: EventUriRef[];
  timezone?: string;
  capacity?: number;
  visibility?: 'listed' | 'unlisted' | 'private';
  neighborhood?: string;
  rsvpRequired?: boolean;
  tags?: string[];
  skills?: SkillLevelRef[];
  series?: EventSeriesInput;
}

export interface CreateEventResult {
  uri: string;
  cid: string;
  [key: string]: unknown;
}

// ── rsvp ─────────────────────────────────────────────────────────────────

export interface RsvpSetInput {
  status: 'going' | 'interested' | 'notgoing';
  alsoPublicRecord?: boolean;
}

export interface RsvpSetResult {
  ok: boolean;
  status: string;
  alsoPublicRecord: boolean;
  counts: RsvpCounts;
}

export interface RsvpClearResult {
  ok: boolean;
  counts: RsvpCounts;
}

export interface MyRsvp {
  eventUri: string;
  status: string;
  alsoPublicRecord: boolean;
}

// ── attendance ───────────────────────────────────────────────────────────

export interface AttendanceRow {
  did: string;
  participated?: boolean;
  role?: 'attendee' | 'assistant' | 'co-host';
}

export interface AttendanceSetResult {
  ok: boolean;
  recorded: number;
}

export interface AttendanceSummary {
  total: number;
  participated: number;
  collapsed: boolean;
}

// ── requests ─────────────────────────────────────────────────────────────

export interface RequestItem {
  uri: string;
  askedBy: string;
  title: string;
  description?: string;
  skill?: string;
  threshold?: number;
  status: 'open' | 'claimed' | 'scheduled' | 'closed';
  claims: number;
}

export interface RequestsResponse {
  cursor?: string;
  requests: RequestItem[];
}

export interface CreateRequestInput {
  title: string;
  description?: string;
  skill?: string;
  threshold?: number;
}

export interface RequestClaimInput {
  note?: string;
  eventUri?: string;
}

export interface RequestMutationResult {
  uri: string;
  cid: string;
}

// ── skills ───────────────────────────────────────────────────────────────

export interface SkillNode {
  uri: string;
  id: string;
  label: string;
  description?: string;
  status: string;
  alsoUnder: string[];
  children: SkillNode[];
}

export interface SkillTreeResponse {
  skills: SkillNode[];
}

export interface SkillDetail {
  uri: string;
  id: string;
  label: string;
  description?: string;
  status: string;
  replacedBy?: string;
  prerequisites: string[];
  ancestors: Array<{ uri: string; label: string }>;
  children: Array<{ uri: string; label: string; status: string }>;
  taughtIn: Array<{ event?: string; level: number }>;
}

// ── me ───────────────────────────────────────────────────────────────────

export interface SkillClaimInput {
  skill: string;
  level: 'learning' | 'practicing' | 'proficient' | 'teaching';
  note?: string;
  visibility?: 'public' | 'school';
}

export interface SkillClaimsSetResult {
  published: Array<{ uri: string; skill: string; level: string }>;
  keptAppSide: number;
}

export interface SkillClaimsResponse {
  public: Array<{ uri: string; value: unknown }>;
  school: Array<{ skill: string; level: string; note?: string }>;
}

export interface MeResponse {
  did: string;
  role: ViewerRole;
  evidence: unknown;
  thresholds: unknown;
  rsvps: MyRsvp[];
}

/** Shape guessed for the not-yet-implemented `PUT /api/me` (see api.ts). */
export interface UpdateProfileInput {
  [key: string]: unknown;
}

// ── feedback ─────────────────────────────────────────────────────────────

export interface FeedbackInput {
  eventUri: string;
  direction: 'positive' | 'negative';
  aspects?: { knowledge?: number; teaching?: number; experience?: number };
  text?: string;
}

export interface FeedbackSummary {
  count: number;
  released: boolean;
  positive?: number;
  negative?: number;
  aspects?: Record<string, { mean: number }>;
  textK?: number;
  [key: string]: unknown;
}

// ── invites (Task 2) ─────────────────────────────────────────────────────

export interface InviteMintInput {
  eventUri?: string;
  uses?: number;
  ttlDays?: number;
}

export interface InviteMintResult {
  url: string;
  token: string;
  expiresAt: string;
}

export interface InviteRedeemResult {
  ok: boolean;
  eventUri?: string;
}

// ── push / notifications ────────────────────────────────────────────────

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushSubscribeResult {
  id: string;
  categories: string[];
}

export interface NotificationItem {
  id: string;
  category: string;
  title: string;
  body?: string;
  navigate?: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationsResponse {
  notifications: NotificationItem[];
}

export interface NotificationPref {
  category: string;
  transport: 'web-push' | 'email';
  enabled: boolean;
}

export interface NotificationPrefsResponse {
  categories: string[];
  prefs: NotificationPref[];
}

// ── admin ────────────────────────────────────────────────────────────────

export interface AdminPolicyResponse {
  uri?: string;
  thresholds: unknown;
  record: unknown;
}

export interface AdminPolicyInput {
  title: string;
  text: string;
  version: string;
  effectiveAt?: string;
  thresholds?: Record<string, unknown>;
  reason: string;
  approvals?: Array<{ stewardDid: string; at: string }>;
}

export interface AdminPolicyWriteResult {
  uri: string;
  cid: string;
  auditId?: string;
}

export interface ModerationItem {
  id: string;
  action: string;
  subjectUri?: string;
  subjectDid?: string;
  reason: string;
  status: string;
  approvals: unknown;
  createdAt: string;
}

export interface ModerationQueueResponse {
  requiredApprovals: number;
  items: ModerationItem[];
}

export interface ModerationProposeInput {
  action: string;
  subjectUri?: string;
  subjectDid?: string;
  reason: string;
}

export interface ModerationProposeResult {
  id: string;
  status: string;
}

export interface ModerationApproveResult {
  approvals: unknown;
  required: number;
}

export interface ModerationExecuteResult {
  ok: boolean;
  uri: string;
  auditId?: string;
}

export interface PeerRecord {
  host: string;
  [key: string]: unknown;
}

export interface PeersResponse {
  peers: PeerRecord[];
  probed?: unknown;
}

export interface PeersInput {
  add?: string[];
  remove?: string[];
}

export interface NewsletterDraft {
  id: string;
  subject: string;
  body: string;
  status: string;
  [key: string]: unknown;
}

/** Stubs — Task 2/9 fix the real shape once `POST /api/admin/handoff*` exist. */
export interface HandoffStartInput {
  [key: string]: unknown;
}

export interface HandoffResult {
  [key: string]: unknown;
}

// ── school / zine (Task 2) ───────────────────────────────────────────────

export interface HowItWorksResponse {
  [key: string]: unknown;
}

export interface ZineMonthResponse {
  month: string;
  school: { name: string; region?: string };
  days: Array<{ date: string; events: CalendarEvent[] }>;
  howToPost: string;
}
