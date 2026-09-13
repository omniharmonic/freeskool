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

/**
 * Mirrors `ViewerRelation` in `apps/appview/src/http/visibility.ts` exactly —
 * these are the literal strings `viewerRelation()` (`../relation.ts`) returns,
 * in the order it checks them. No `| string` escape hatch: a value outside
 * this set means the server changed and this type needs updating too.
 */
export type ViewerRelation = 'public' | 'rsvp' | 'attendee' | 'host' | 'steward';

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

/**
 * Mirrors `PublicCalendarEntry`/`FullCalendarEntry` from `projectEvent()` in
 * `apps/appview/src/http/visibility.ts:87-110` and `toCalendarEvent()` in
 * `apps/appview/src/http/routes/calendar.ts:63-76` exactly: `hostDid`,
 * `description`, `locations`, and `uris` are present only when
 * `locationRedacted` is false (the viewer is the host, has RSVP'd, has
 * confirmed attendance, or is a steward) — everyone else gets the coarser
 * public entry.
 */
export interface CalendarEvent {
  uri: string;
  name: string;
  startsAt?: string;
  endsAt?: string;
  mode?: string;
  status?: string;
  neighborhood?: string;
  /** True when the full location was withheld from this viewer. */
  locationRedacted: boolean;
  /** Present only when `locationRedacted` is false. */
  hostDid?: string;
  description?: string;
  locations?: EventLocation[];
  uris?: EventUriRef[];
  /** Added by Task 2; absent until then. */
  venueNeeded?: boolean;
  tags?: string[];
  origin?: 'ours' | 'listed';
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

/**
 * Mirrors `CreatedEvent` in `apps/appview/src/lib/events.ts` exactly —
 * `createEventAsHost`'s return shape, not a flat `{uri, cid}` (the earlier,
 * wrong guess from Task 1; see the Task 4 carry-forward note in
 * `.superpowers/sdd/mvp-plan/progress.md`). `series`/`listing` are present
 * only when the request had a `series`/routed on its tags.
 */
export interface CreateEventResult {
  event: { uri: string; cid: string };
  config: { uri: string; cid: string };
  skillLevels: Array<{ uri: string; cid: string }>;
  series?: { uri: string; cid: string };
  listing?: { uri: string; cid: string };
}

/**
 * Mirrors `UpdatedEvent` in `apps/appview/src/lib/events.ts` — `PUT
 * /api/events/:id`'s return shape. `skillLevels` is present only when the
 * request carried `skills`; `unlisted` only when a retag tried to drop the
 * school's curation listing.
 */
export interface UpdateEventResult {
  event: { uri: string; cid: string };
  config: { uri: string; cid: string };
  listing?: { uri: string; cid: string };
  skillLevels?: Array<{ uri: string; cid: string }>;
  unlisted?: boolean;
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

/**
 * `GET /api/rsvp?eventUri=` (`apps/appview/src/http/routes/rsvp.ts`) — the
 * viewer's own RSVP for one event, or `null` if they have none. Added for
 * Task 4 (`api.ts` had no binding for this route yet); see the file header
 * there.
 */
export interface RsvpGetResult {
  rsvp: { status: string; alsoPublicRecord: boolean } | null;
  counts: RsvpCounts;
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
  /** "I'm interested" count — app-side, never a roster. What `threshold` gates a claim against. */
  rsvpCount: number;
  /** Whether the viewer is one of the people counted in `rsvpCount`. */
  viewerInterested: boolean;
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

/**
 * `POST /api/requests/:id/rsvp` — mirrors `ToggleResult` in
 * `apps/appview/src/lib/request-rsvp.ts` exactly: the new state of the
 * viewer's own interest and the total count, never a roster.
 */
export interface RequestRsvpResult {
  interested: boolean;
  count: number;
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

export type SkillClaimLevel = 'learning' | 'practicing' | 'proficient' | 'teaching';

export interface SkillClaimInput {
  skill: string;
  level: SkillClaimLevel;
  note?: string;
  visibility?: 'public' | 'school';
}

/**
 * `PUT /api/me/skill-claims`'s body (`apps/appview/src/http/routes/me.ts`'s
 * `claimsBody`). `confirmTierB` is required on a resend after the server
 * refuses a Tier B public claim with 400 `TierBConfirmRequired` — see
 * `checkPublicClaims` there. The client has no way to know a skill's tier up
 * front (`GET /api/skills` does not expose it), so this is always a
 * try-then-confirm flow, never a client-side guess.
 */
export interface SkillClaimsSetInput {
  claims: SkillClaimInput[];
  confirmTierB?: boolean;
}

export interface SkillClaimsSetResult {
  published: Array<{ uri: string; skill: string; level: string }>;
  keptAppSide: number;
}

export interface SkillClaimsResponse {
  public: Array<{
    uri: string;
    value: { skill?: string; level?: string; note?: string; createdAt?: string; [key: string]: unknown };
  }>;
  school: Array<{ skill: string; level: string; note?: string }>;
}

export interface MeProfile {
  displayName?: string;
  bio?: string;
}

export interface MeResponse {
  did: string;
  role: ViewerRole;
  evidence: unknown;
  thresholds: unknown;
  rsvps: MyRsvp[];
  profile: MeProfile;
}

/** `PUT /api/me`'s body — deliberately `.strict()` server-side (`profileBody`
 * in `apps/appview/src/http/routes/me.ts`): app-side display fields only,
 * never a real-name prompt. */
export interface UpdateProfileInput {
  displayName?: string;
  bio?: string;
}

export interface UpdateProfileResult {
  did: string;
  profile: MeProfile;
}

/** `GET /api/me/visibility-defaults` — what this session is allowed to make
 * public, and why. `oauthDoor` true means the session can NEVER set a skill
 * claim `visibility: 'public'` in v1 (403 `PublicTogglesLocked` if it tries). */
export interface VisibilityDefaults {
  oauthDoor: boolean;
  tierBConfirmRequired: true;
}

/** `GET /api/me/badges` — plain-language sentences derived from counts and
 * role. Counts only, never an average or a star rating. */
export interface MeBadgesResponse {
  counts: { hosted: number; attended: number; vouched: number };
  role: ViewerRole;
  badges: string[];
}

export interface PublicRoleResponse {
  publicRole: boolean;
}

export interface SetPublicRoleInput {
  publicRole: boolean;
}

/** `PUT /api/me/newsletter` — member-facing consent for the monthly digest
 * (distinct from `/api/admin/newsletter*`, the steward compose/send surface).
 * `NoEmailOnFile` (409) is a real response, not a guess: a custodial session
 * with no email on file cannot be subscribed. */
export interface SetNewsletterInput {
  subscribed: boolean;
}

export interface NewsletterSubscriptionResult {
  subscribed: boolean;
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
  aspects?: Partial<Record<'knowledge' | 'teaching' | 'experience', { mean: number; n: number }>>;
  textK?: number;
  /** Free text needs a higher k than the numeric aggregate before it is shown at all. */
  textReleased?: boolean;
  /** Only present once `textReleased` is true. */
  texts?: string[];
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
  /**
   * True when the redeemer already satisfied the invite-or-vouch member gate
   * (`apps/appview/src/http/routes/invites.ts`'s class-deep-link case) —
   * redemption still succeeds, it just consumed no use and wrote no new
   * evidence. Not an error: `AlreadyInvited` is not a real response code.
   */
  alreadyMember?: boolean;
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

/**
 * Mirrors `freeschool.draft.policy#thresholds` (`packages/lexicons/lexicons/
 * freeschool/draft/policy.json`) and `Thresholds` in
 * `packages/shared/src/roles.ts` exactly. The web app has no dependency on
 * `@freeschool/shared`, so the shape is duplicated here rather than imported.
 */
export interface PolicyThresholds {
  memberRequires: 'none' | 'invite-or-vouch' | 'attended-one';
  hostMinAttended: number;
  facilitatorMinHosted: number;
  firstEventApproval: boolean;
  feedbackK: number;
  destructiveActionStewards: number;
  /** Off by default; publishing a given member's role additionally needs that member's own opt-in. */
  publishRoles?: boolean;
}

/** The `freeschool.draft.policy` record itself, as returned in `record`. */
export interface PolicyRecordValue {
  title: string;
  text: string;
  version: string;
  effectiveAt: string;
  thresholds?: PolicyThresholds;
  createdAt: string;
  [key: string]: unknown;
}

/** `GET /api/admin/policy` — `thresholds` always merges in server-side
 * defaults (`mergeThresholds` in `apps/appview/src/lib/policy.ts`), so it is
 * never partial even when `record` is still `null` (no policy written yet). */
export interface AdminPolicyResponse {
  uri?: string | null;
  thresholds: PolicyThresholds;
  record: PolicyRecordValue | null;
}

export interface AdminPolicyInput {
  title: string;
  text: string;
  version: string;
  effectiveAt?: string;
  thresholds?: Partial<PolicyThresholds>;
  /** MANDATORY — `policyBody` on the server refuses a write without one. */
  reason: string;
  /** Co-signing stewards. Writing policy is a destructive action
   * (`DESTRUCTIVE_ACTIONS` in `packages/school-actor/src/port.ts`), so a
   * lone steward's PUT needs this threshold met or the server answers 403
   * `ErrThresholdNotMet` — see the doc comment on `PolicyScreen`. */
  approvals?: Array<{ stewardDid: string; at: string }>;
}

export interface AdminPolicyWriteResult {
  uri: string;
  cid: string;
  auditId?: string;
}

/** Mirrors `moderationBody`'s `action` enum on the server exactly
 * (`apps/appview/src/http/routes/admin.ts`). */
export type ModerationAction =
  | 'curate-listing'
  | 'remove-listing'
  | 'restore-listing'
  | 'set-role'
  | 'suspend-role'
  | 'close-request'
  | 'void-attendance';

/** Mirrors `Approval` in `packages/school-actor/src/port.ts`. */
export interface ModerationApproval {
  stewardDid: string;
  at: string;
  sig?: string;
}

export interface ModerationItem {
  id: string;
  action: ModerationAction;
  subjectUri?: string | null;
  subjectDid?: string | null;
  reason: string;
  status: string;
  approvals: ModerationApproval[];
  createdAt: string;
}

export interface ModerationQueueResponse {
  requiredApprovals: number;
  items: ModerationItem[];
}

export interface ModerationProposeInput {
  action: ModerationAction;
  subjectUri?: string;
  subjectDid?: string;
  /** MANDATORY — there is no code path on the server that acts without one. */
  reason: string;
}

export interface ModerationProposeResult {
  id: string;
  status: string;
}

export interface ModerationApproveResult {
  approvals: ModerationApproval[];
  required: number;
}

export interface ModerationExecuteResult {
  ok: boolean;
  uri: string;
  auditId?: string;
}

/** Mirrors `listPeers()`'s row shape in `apps/appview/src/index/peers.ts`. */
export interface PeerRecord {
  host: string;
  source: string;
  schoolDid: string | null;
}

/** Mirrors `probePeer()`'s return shape — present only when the request
 * carried `?probe=1`. There is no last-sync timestamp on a peer row; this is
 * the closest live signal the API exposes (see `PeersScreen`'s doc comment). */
export interface PeerProbe {
  host: string;
  listReposByCollection: boolean;
  listRepos: boolean;
}

export interface PeersResponse {
  peers: PeerRecord[];
  probed?: PeerProbe[];
}

export interface PeersInput {
  add?: string[];
  remove?: string[];
}

/** `POST /api/admin/newsletter` merges `{subject, body}` with the draft row
 * itself (`id`, `month`, `html`, `text`, `status`) — see the route in
 * `apps/appview/src/http/routes/admin.ts`. `body` and `text` are therefore
 * the same string under two names; `subject` is synthesized, not stored. */
export interface NewsletterDraft {
  id: string;
  month: string;
  subject: string;
  body: string;
  text: string;
  html: string;
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
