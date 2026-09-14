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

/** A school as the viewer's own session knows it. Never another member's. */
export interface ViewerSchool {
  did: string;
  label: string;
  name: string;
  /** The host this school is served from — where the switcher navigates. */
  host: string;
}

/**
 * `GET /api/schools` — the public directory of the schools this AppView hosts.
 *
 * Name, city, and a host you can visit. NEVER a member count, a class count or
 * a "most active" ordering (spec ruling 7): a directory of cities is a public
 * fact, how many people are in each one is not.
 */
export interface SchoolListing {
  did: string;
  label: string;
  name: string;
  city?: string | null;
  /** Where the school is served — the link out of this page. */
  host: string;
}

export interface SchoolsResponse {
  schools: SchoolListing[];
}

/**
 * `GET /api/schools/nearby` — schools this one has named as peers, read from
 * their own published `freeschool.draft.school` records rather than from any
 * local table. Absent (404) on a deployment whose AppView predates it, which
 * `/schools` treats as "none to show" rather than as an error.
 */
export interface NearbySchool {
  did: string;
  name: string;
  city?: string | null;
  host?: string;
  tags?: string[];
  peers?: string[];
}

/** `POST /api/schools/:did/leave`. */
export interface LeaveSchoolResult {
  left: boolean;
}

export interface AuthMe {
  did: string;
  kind: 'custodial' | 'oauth';
  role: ViewerRole;
  handle?: string;
  isCustodial: boolean;
  emailVerified: boolean;
  /** Whether this member has been through `/welcome` (Task 6/11). False for
   * everyone who signed up before onboarding existed, which is the point:
   * they get the offer once, on their next verified sign-in. */
  onboarded: boolean;
  /**
   * The school THIS REQUEST resolved to — the host's, or the session's when
   * the host names none (the apex). Absent on a deployment that has not been
   * bootstrapped with a school at all.
   */
  school?: Omit<ViewerSchool, 'host'>;
  /**
   * Every school the viewer belongs to. The ONLY cross-school list in the
   * app, and it is the viewer's own membership and nobody else's (MS §10.1).
   * `SchoolSwitcher` renders when there is more than one; one school is not a
   * choice and must not look like one.
   */
  schools?: ViewerSchool[];
}

/** `POST /api/auth/switch-school`. `host` is where the PWA navigates next. */
export interface SwitchSchoolResult {
  school: Omit<ViewerSchool, 'host'>;
  host: string;
}

/**
 * `GET /api/me/handle/check?handle=<prefix>` — the prefix only, never the
 * whole handle. `reason` is present exactly when `available` is false:
 * `invalid` (fails the 3-20 lowercase/number/dash rule), `reserved` (a name
 * the school holds back) or `taken`.
 */
export interface HandleCheckResult {
  available: boolean;
  reason?: 'invalid' | 'reserved' | 'taken';
}

/** `PUT /api/me/handle` — answers with the FULL handle, prefix plus domain. */
export interface SetHandleResult {
  handle: string;
}

/** `POST /api/me/onboarded` — idempotent; the first timestamp is the one kept. */
export interface OnboardedResult {
  onboarded: true;
}

/**
 * `POST /api/auth/take-ownership` — mirrors the route's 200 body exactly
 * (`apps/appview/src/http/routes/auth.ts:126-136`). `revealUrl` is present
 * only when mail is unconfigured or the send itself failed — see
 * `lib/custody.ts#takeOwnership`'s doc comment. A 409 `RevealPending` (an
 * unused, unexpired link already exists) carries its own `expiresAt`
 * alongside the error body, not on this success shape.
 */
export interface TakeOwnershipResult {
  ok: true;
  handle: string;
  revealUrl?: string;
}

/**
 * `GET /api/auth/take-ownership/:token` — deliberately unauthenticated and
 * single-use (`apps/appview/src/http/routes/auth.ts:146-155`). 404 `NotFound`
 * / 410 `AlreadyUsed` / 410 `Expired` come back as `ApiError`, not this shape.
 */
export interface OwnershipRevealResult {
  ok: true;
  handle: string;
  password: string;
  message: string;
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
 * `apps/appview/src/http/visibility.ts` and `toCalendarEvent()` in
 * `apps/appview/src/http/routes/calendar.ts` exactly.
 *
 * `description` is the host's PUBLIC overview — it is the event record's own
 * `description` field, world-readable in the host's repo, and is sent to
 * everyone for a listed class. `locations`, `uris`, `attendeeNotes` and
 * `meetingLink` are present only when `locationRedacted` is false (the viewer
 * is the host, has RSVP'd, has confirmed attendance, or is a steward) —
 * everyone else gets the coarser public entry. Task 19c moved the notes and the
 * link off the public record precisely so that gate could be honoured.
 */
export interface ImageInput { data: string; alt: string }

export interface PublicOverview { description: string; audience?: string; accessibility?: string }

export interface CalendarEvent {
  publicOverview?: PublicOverview;
  cover?: { url: string; alt: string };
  uri: string;
  name: string;
  startsAt?: string;
  endsAt?: string;
  mode?: string;
  status?: string;
  neighborhood?: string;
  /** True when the full location was withheld from this viewer. */
  locationRedacted: boolean;
  /** The public overview. Present for any listed class, to any viewer. */
  description?: string;
  /** Present only when `locationRedacted` is false. */
  hostDid?: string;
  locations?: EventLocation[];
  uris?: EventUriRef[];
  /** App-side and attendee-only (task 19c): notes the host wrote for people
   * who RSVP'd, and the meeting link. Never on any public record. */
  attendeeNotes?: string;
  meetingLink?: string;
  /** Added by Task 2; absent until then. */
  venueNeeded?: boolean;
  tags?: string[];
  origin?: 'ours' | 'listed';
}

export interface CalendarResponse {
  truncated?: boolean;
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
  /** ≤20 items, ≤120 chars each (`apps/appview/src/http/routes/events.ts`'s
   * `createBody`). Always present — `[]` when the host listed none. */
  materials: string[];
  /** ≤300 chars. Present only when the host set one. */
  suppliesNote?: string;
  /**
   * The raw `listed|unlisted|private` enum — present ONLY for the host or a
   * steward (`canViewRoster` in `apps/appview/src/http/routes/events.ts`'s
   * `GET /api/events/:id`). Absent for everyone else; never render this as a
   * public fact.
   */
  visibility?: 'listed' | 'unlisted' | 'private';
  /**
   * Why the host called the class off. App-side on the AppView
   * (`fs_event_extra.cancel_reason`) and never on any public record — the record
   * carries only `status: …#cancelled`. Present to anyone who can see the class.
   */
  cancelledReason?: string;
  /** True when this class is part of a recurring series — so "this one, or this
   * and the ones after it?" is a question worth asking when cancelling. */
  recurring?: boolean;
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
  publicOverview?: PublicOverview;
  cover?: ImageInput | null;
  venueNeeded?: boolean;
  name: string;
  /** Attendee-only, app-side. Replaces the pre-19c `description` input, which
   * the AppView still accepts and maps onto this (`attendeeFields()` in
   * `apps/appview/src/lib/events.ts`). */
  attendeeNotes?: string;
  /** Attendee-only, app-side. Replaces the pre-19c `uris` input. */
  meetingLink?: string;
  startsAt: string;
  endsAt?: string;
  mode?: string;
  locations?: unknown[];
  timezone?: string;
  capacity?: number;
  visibility?: 'listed' | 'unlisted' | 'private';
  neighborhood?: string;
  rsvpRequired?: boolean;
  /** ≤20 items, ≤120 chars each. */
  materials?: string[];
  /** ≤300 chars. */
  suppliesNote?: string;
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

/** `POST /api/events/:id/cancel`. `reason` is app-side only; `scope: 'following'`
 * is accepted only for a class that belongs to a recurring series. */
export interface CancelEventInput {
  reason?: string;
  scope?: 'this' | 'following';
}

/** Mirrors `CancelledEvent` in `apps/appview/src/lib/events.ts`. `unlisted` is
 * false when withdrawing the school's listing needs a steward, and absent when
 * there was no listing of ours to withdraw. */
export interface CancelEventResult {
  event: { uri: string; cid: string };
  status: string;
  scope: 'this' | 'following';
  unlisted?: boolean;
  alsoCancelled: string[];
  exdatesAdded: number;
  notified: number;
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
  /** Present only when `status` resolved to `'waitlisted'` — the capacity was
   * already full when this RSVP landed. 1-indexed. The server's own
   * `waitlistPosition()` (`apps/appview/src/lib/rsvp.ts`) returns `null`
   * rather than omitting the field, so this is nullable, not just optional. */
  waitlistPosition?: number | null;
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
  rsvp: { status: string; alsoPublicRecord: boolean; waitlistPosition?: number | null } | null;
  counts: RsvpCounts;
}

/**
 * `GET /api/events/:id/rsvps` — the host's (or a steward's) own roster,
 * never public (`canViewRoster` in `apps/appview/src/http/routes/events.ts`).
 * The route returns the array directly, not wrapped in an object.
 *
 * `rsvpRoster()` (`apps/appview/src/lib/rsvp.ts:189-196`) returns EVERY row
 * for the event, including `'notgoing'` — a member who explicitly declined.
 * `AttendanceScreen.tsx` filters those out of the checklist itself; this
 * type stays honest about what the route actually sends.
 */
export interface RosterEntry {
  did: string;
  handle: string;
  displayName?: string;
  status: 'going' | 'interested' | 'waitlisted' | 'notgoing';
  createdAt: string;
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
  scheduledEventUri?: string;
  viewerClaimed?: boolean;
  uri: string;
  /** Omitted by the API for a non-asker viewer — never assume this is present. */
  askedBy?: string;
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
  /**
   * "Ask <name> to teach this" — the member this request is addressed to.
   * APP-SIDE ON THE APPVIEW: it never reaches the public request record, which
   * must not name a person who did not write it. The only one who learns of it
   * is the member asked, in their own notifications.
   */
  askedOf?: string;
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

/** 'A' (ordinary) | 'B' (sensitive/high-risk) — `apps/appview/src/lib/skill-tiers.ts`. */
export type SkillTier = 'A' | 'B';

export interface SkillNode {
  uri: string;
  id: string;
  label: string;
  description?: string;
  status: string;
  tier: SkillTier;
  alsoUnder: string[];
  children: SkillNode[];
}

export interface SkillTreeResponse {
  skills: SkillNode[];
}

/**
 * `POST /api/skills` — "I couldn't find it, here is what it's called."
 * `parentUri` is always a domain or an area (the picker only ever offers
 * those), so a proposal can never orphan itself at the root of the taxonomy.
 */
export interface SkillProposeInput {
  label: string;
  description?: string;
  parentUri: string;
}

/** The 201 body. `status` comes back `'proposed'` until a steward curates it. */
export interface SkillProposeResult {
  uri: string;
  id: string;
  label: string;
  status: string;
  tier: SkillTier;
}

/**
 * The 409 body — the taxonomy already has this skill under some name. Rides
 * on `ApiError.body`; the picker selects `existing` rather than making the
 * member retype anything. 503 `AuthorityUnavailable` (the school has no
 * curation authority configured) carries no extra fields.
 */
export interface SkillExistsBody {
  error: 'SkillExists';
  existing: SkillNode;
}

/**
 * One row of `GET /api/admin/skills/proposals` — `apps/appview/src/http/routes/admin.ts`.
 * `id` is the skill's OWN rkey (not the `fs_skill_proposal` row id) — the same id
 * `POST /api/admin/skills/:id/deprecate` and `.../move` both take. `label`/`status`
 * are absent only if the indexer hasn't caught up with a just-proposed record yet.
 */
export interface SkillProposalItem {
  id: string;
  skillUri: string;
  label?: string;
  status?: string;
  path: string[];
  proposerHandle?: string;
  proposedAt: string;
}

export interface SkillProposalsResponse {
  proposals: SkillProposalItem[];
}

export interface SkillDeprecateInput {
  replacedBy?: string;
}

export interface SkillDeprecateResult {
  uri: string;
  status: string;
}

export interface SkillMoveInput {
  parentUri: string;
}

export interface SkillMoveResult {
  uri: string;
  broader: string[];
}

export interface SkillDetail {
  uri: string;
  id: string;
  label: string;
  description?: string;
  status: string;
  tier: SkillTier;
  replacedBy?: string;
  prerequisites: string[];
  ancestors: Array<{ uri: string; label: string; tier: SkillTier }>;
  children: Array<{ uri: string; label: string; status: string; tier: SkillTier }>;
  taughtIn: Array<{ event?: string; level: number }>;
  /**
   * Who at this school holds this skill — present ONLY for a signed-in viewer
   * (`withViewer` in `apps/appview/src/http/routes/skills.ts`). Its absence is
   * what tells the skill page to show the public practitioner shelf and a
   * sign-in nudge instead of the members list.
   */
  people?: SkillPeople;
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
 * `checkPublicClaims` there. `GET /api/skills` now exposes each node's
 * `tier` (Task 12), so the UI defaults a new Tier B claim's visibility to
 * school-only up front — but the server's 400 is still the real gate (a
 * stale client-side tree, or a claim typed by URI, could still disagree),
 * so this stays a try-then-confirm flow rather than trusting the client's
 * own read of the tier.
 */
export interface SkillClaimsSetInput {
  claims: SkillClaimInput[];
  confirmTierB?: boolean;
  /** Required for an OAuth-door session to publish ANY public claim — the
   * same one-time linkage confirmation `UpdateProfileInput` carries. */
  confirmPublicLinkage?: boolean;
}

export interface SkillClaimsSetResult {
  published: Array<{ uri: string; skill: string; level: string }>;
  keptAppSide: number;
  /**
   * R1: set when the member's repo credential has lapsed. The app-side (school-only)
   * claims in this same request were still saved — `keptAppSide` reflects them — but
   * nothing could be published or retracted on the PDS. The UI should prompt a
   * re-sign-in rather than imply the whole save failed.
   */
  reauthRequired?: boolean;
  /** Public records that could not be retracted because of `reauthRequired`. */
  pendingRetractions?: number;
}

export interface SkillClaimsResponse {
  public: Array<{
    uri: string;
    value: { skill?: string; level?: string; note?: string; createdAt?: string; [key: string]: unknown };
  }>;
  school: Array<{ skill: string; level: string; note?: string }>;
}

export interface MeProfile {
  publicListing?: boolean;
  avatarUrl?: string;
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
  /** `fs_member_prefs.directory_listing` — defaults true for a member who has
   * never touched it. False means "hide me from the school directory". Sits
   * beside `profile`, not inside it: it is a member pref, not a profile field. */
  directoryListing?: boolean;
  onboarded?: boolean;
}

/** `PUT /api/me`'s body — deliberately `.strict()` server-side (`profileBody`
 * in `apps/appview/src/http/routes/me.ts`): app-side display fields only,
 * never a real-name prompt. */
export interface UpdateProfileInput {
  publicListing?: boolean;
  avatar?: ImageInput | null;
  displayName?: string;
  bio?: string;
  /** The members-directory opt-out (`fs_member_prefs`), not a profile field. */
  directoryListing?: boolean;
  /** Required alongside `publicListing: true` for an OAuth-door session, which
   * would otherwise get 400 `PublicLinkageConfirmRequired` — publishing from an
   * existing account links it to this school permanently, so it is confirmed
   * once, explicitly. */
  confirmPublicLinkage?: boolean;
}

export interface UpdateProfileResult {
  did: string;
  profile: MeProfile;
  /** Echoed back only when the request carried it. */
  directoryListing?: boolean;
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
  | 'remove-resource'
  | 'restore-resource'
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

/**
 * `POST /api/admin/handoff` (steward) — see the module doc comment on
 * `apps/appview/src/http/routes/handoff.ts`.
 */
export interface HandoffStartInput {
  /** A handle or a DID. Omitted: anyone who holds the link may accept. */
  toHandleOrDid?: string;
}

export interface HandoffStartResult {
  id: string;
  url: string;
  token: string;
  expiresAt: string;
}

/** `POST /api/handoff/:token/accept` — NOT under `/api/admin` (see the route's
 * module doc comment for why). `warning: 'single-steward'` means the school
 * still has only one active steward after this accept. */
export interface HandoffAcceptResult {
  ok: true;
  uri: string;
  auditId: string;
  warning?: 'single-steward';
}

// ── school / zine (Task 2) ───────────────────────────────────────────────

/** Mirrors `HowItWorksPayload` in `apps/appview/src/lib/how-it-works.ts`
 * exactly — rendered live from the school record + current policy. */
export interface HowItWorksSection {
  heading: string;
  body: string;
}

export interface HowItWorksResponse {
  title: string;
  school: { name: string; region?: string; description?: string };
  sections: HowItWorksSection[];
  lastUpdated: string;
  printable: true;
}

export interface ZineMonthResponse {
  truncated?: boolean;
  month: string;
  school: { name: string; region?: string };
  days: Array<{ date: string; events: CalendarEvent[] }>;
  howToPost: string;
}

export interface KnowledgeResource { libraryStatus?: 'moderated'|'class-unlisted'; id: string; title: string; description?: string; skills: string[]; uri?: string; license?: string; event?: {uri:string;cid:string}; authorDid: string; authorName: string; authorHasProfile: boolean; createdAt?: string }
export interface PublicProfile { did:string;displayName:string;bio:string;avatarUrl?:string;claims:Array<{skill:string;level:string;note?:string}>;resources:KnowledgeResource[] }

// ── members directory (Task 10) ──────────────────────────────────────────

/**
 * Mirrors `MemberSummary` in `apps/appview/src/lib/members.ts` exactly.
 * Members-only, never public (R9): every `/api/members*` route sits behind
 * `requireViewer` and answers `noindex, nofollow`.
 */
export interface MemberSummary {
  did: string;
  handle?: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  role: ViewerRole;
  roleLabel: string;
  claimCount: number;
  vouchCount: number;
  lastSeenAt: string;
}

/** `GET /api/members` — one page, `cursor` present only when more follow. */
export interface MembersResponse {
  members: MemberSummary[];
  cursor?: string;
}

/** `q` matches a display-name substring; `skill` is an exact skill AT-URI.
 * A type alias rather than an interface on purpose: `api.ts`'s `buildUrl`
 * takes a `Record<string, QueryValue>`, and only an alias gets the implicit
 * index signature that makes it assignable to one. */
export type MembersQuery = {
  q?: string;
  skill?: string;
  cursor?: string;
  limit?: number;
};

/**
 * One claim on a member's profile. `visibility` is `'school'` for claims the
 * member kept off their public records — fair to show another member here
 * (this view is already members-only), never anywhere public.
 */
export interface MemberClaim {
  skillUri: string;
  skillLabel: string;
  level: string;
  visibility: 'public' | 'school';
  vouchCount: number;
  /** True when the viewer has already vouched for this member's claim. */
  viewerVouched: boolean;
}

/** Mirrors `MemberProfile` in `apps/appview/src/lib/members.ts`. 404 when the
 * member has turned `directoryListing` off. */
export interface MemberProfileResponse extends MemberSummary {
  claims: MemberClaim[];
  /** The same `{counts, role, badges}` shape as `GET /api/me/badges`. */
  badges: MeBadgesResponse;
  hosting: Array<{ uri: string; name: string; startsAt: string }>;
  resources: Array<{ id: string; title: string }>;
}

// ── attestations / vouches (Task 10) ─────────────────────────────────────

/** `POST /api/attestations` — 400 `SelfAttestation`, 404 `SubjectNotHolding`,
 * 409 `AlreadyVouched` are all real answers, never transient failures. */
export interface AttestationInput {
  subjectDid: string;
  skillUri: string;
  contextEventUri?: string;
}

export interface AttestationCreated {
  id: string;
}

export interface AttestationGiven {
  id: string;
  subjectDid: string;
  skillUri: string;
  createdAt: string;
}

/** Carries only what it takes to show an attester — a handle and/or a display
 * name when we have one, never anything else about them (R9). */
export interface AttestationReceived {
  id: string;
  attesterDid: string;
  attesterHandle?: string;
  attesterDisplayName?: string;
  skillUri: string;
  skillLabel: string;
  createdAt: string;
}

export interface MyAttestationsResponse {
  given: AttestationGiven[];
  received: AttestationReceived[];
}

/** `people` on `GET /api/skills/:id` — present only for a signed-in viewer.
 * `count` is the full visible total even when `members` is capped at 50. */
export interface SkillPeople {
  count: number;
  members: Array<{
    did: string;
    handle?: string;
    displayName?: string;
    avatarUrl?: string;
    level: string;
    vouchCount: number;
  }>;
}

/** `POST /api/me/import-bsky-profile` — re-pulls displayName/bio/avatar from
 * Bluesky. `imported: false` with no `fields` means there was nothing to
 * import (no Bluesky profile for this DID). */
export interface ImportBskyProfileResult {
  imported: boolean;
  fields: string[];
}
