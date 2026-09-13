/**
 * App-side tables. Everything here is the PRIVACY BOUNDARY (R9): it is the subpoena
 * target, so it holds as little as possible and is aggressively retained down.
 * Indexed public records live in contrail's own tables (`records_*`, `identities`, …) —
 * never duplicated here.
 *
 * All our tables are prefixed `fs_` so `drizzle-kit`'s `tablesFilter` can never
 * propose a migration against contrail's schema.
 */
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  customType,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
})

const ts = (n: string) => timestamp(n, { withTimezone: true })

/* ───────────────────────────── sessions & identity ───────────────────────────── */

/**
 * Server-side session rows. The cookie carries only `<id>.<hmac>` — never a DID,
 * never a token. Deleting the row logs the browser out everywhere.
 */
export const session = pgTable(
  'fs_session',
  {
    id: text('id').primaryKey(),
    did: text('did').notNull(),
    /** 'custodial' = our PDS account; 'oauth' = existing account via the secondary door. */
    kind: text('kind').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('fs_session_did_idx').on(t.did), index('fs_session_expires_idx').on(t.expiresAt)],
)

/** @atproto/oauth-client-node NodeSavedStateStore. */
export const oauthState = pgTable('fs_oauth_state', {
  key: text('key').primaryKey(),
  state: jsonb('state').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
})

/** @atproto/oauth-client-node NodeSavedSessionStore (holds DPoP + refresh material). */
export const oauthSession = pgTable('fs_oauth_session', {
  sub: text('sub').primaryKey(),
  session: jsonb('session').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** The confidential client's private signing key, generated once and reused. */
export const oauthClientKey = pgTable('fs_oauth_client_key', {
  kid: text('kid').primaryKey(),
  jwk: jsonb('jwk').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
})

/**
 * Custodial accounts minted by the primary door. The account password is random
 * 32 bytes, AES-256-GCM encrypted under a VERSIONED key (OpenMeet's pattern), so a
 * key rotation re-wraps rather than resets.
 *
 * `takeOwnership` flips `isCustodial` to false and clears the wrapped secret —
 * see src/lib/custody.ts (stubbed).
 */
export const custodialAccount = pgTable(
  'fs_custodial_account',
  {
    did: text('did').primaryKey(),
    handle: text('handle').notNull(),
    /** Needed for the magic link and for transactional mail; never logged. */
    email: text('email').notNull(),
    isCustodial: boolean('is_custodial').notNull().default(true),
    keyVersion: text('key_version').notNull(),
    /** AES-256-GCM: 12-byte iv || ciphertext || 16-byte tag. */
    wrappedPassword: bytea('wrapped_password'),
    createdAt: ts('created_at').notNull().defaultNow(),
    verifiedAt: ts('verified_at'),
    ownedAt: ts('owned_at'),
  },
  (t) => [uniqueIndex('fs_custodial_handle_idx').on(t.handle)],
)

/** Magic-link email verification. Only the token HASH is stored. */
export const emailVerification = pgTable(
  'fs_email_verification',
  {
    tokenHash: text('token_hash').primaryKey(),
    did: text('did').notNull(),
    purpose: text('purpose').notNull().default('verify-email'),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('fs_email_verification_did_idx').on(t.did)],
)

/**
 * `takeOwnership`'s one-time reveal. The PDS account password is rotated IMMEDIATELY
 * (`com.atproto.admin.updateAccountPassword`) when the member requests this, and the
 * new password is held here, wrapped under the same versioned custody key as
 * `fs_custodial_account.wrapped_password`, ONLY long enough for the member to open the
 * single-use link we email them — `GET /api/auth/take-ownership/:token` nulls
 * `wrapped_password` the moment it is read, and `used_at` makes a second read 410
 * regardless. 24 h TTL. See `lib/custody.ts#takeOwnership`.
 */
export const ownershipReveal = pgTable(
  'fs_ownership_reveal',
  {
    tokenHash: text('token_hash').primaryKey(),
    did: text('did').notNull(),
    keyVersion: text('key_version').notNull(),
    wrappedPassword: bytea('wrapped_password'),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('fs_ownership_reveal_did_idx').on(t.did)],
)

/**
 * Invite codes. `inviterDid` is evidence for the `invite-or-vouch` member gate, and
 * is PURGED 30 days after use by the retention job — the social graph of who invited
 * whom is not something we keep.
 */
export const invite = pgTable(
  'fs_invite',
  {
    code: text('code').primaryKey(),
    inviterDid: text('inviter_did'),
    usedByDid: text('used_by_did'),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    inviterPurgedAt: ts('inviter_purged_at'),
  },
  (t) => [index('fs_invite_used_by_idx').on(t.usedByDid)],
)

/**
 * Shareable invite LINKS (distinct from `fs_invite`, the signup-invite-code evidence
 * table above). Anyone signed in can mint one; only its SHA-256 is ever stored, so a
 * stolen database row cannot be replayed as a working link. `inviterDid` never leaves
 * this table — it is not returned from the mint endpoint's URL, nor to the redeemer.
 */
export const inviteLink = pgTable(
  'fs_invite_link',
  {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),
    inviterDid: text('inviter_did').notNull(),
    schoolDid: text('school_did').notNull(),
    eventUri: text('event_uri'),
    usesLeft: integer('uses_left').notNull().default(1),
    expiresAt: ts('expires_at').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    redeemedAt: ts('redeemed_at'),
  },
  (t) => [uniqueIndex('fs_invite_link_token_hash_idx').on(t.tokenHash)],
)

/**
 * Tier B marks a skill as sensitive/high-risk (security culture, legal support, street
 * medicine, ...): its claims default to app-side-only and a public claim needs an
 * explicit confirmation. App-side, not a lexicon field — see src/lib/skill-tiers.ts.
 */
export const skillTier = pgTable('fs_skill_tier', {
  skillId: text('skill_id').primaryKey(),
  /** 'A' | 'B' */
  tier: text('tier').notNull().default('A'),
  reason: text('reason'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/**
 * "I'm interested" on a needs-board request — app-side (R9: no roster), and the count
 * a request's own `threshold` is checked against before a host may claim it.
 */
export const requestRsvp = pgTable(
  'fs_request_rsvp',
  {
    requestUri: text('request_uri').notNull(),
    did: text('did').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.requestUri, t.did] }), index('fs_request_rsvp_req_idx').on(t.requestUri)],
)

/**
 * A DURABLE record that this DID has ever authenticated with THIS school, through either
 * door. Written on every successful `createSession` call (see `http/session.ts`) and by
 * `create-school` for the school/steward DIDs. Deliberately NEVER deleted on logout or
 * session expiry — `fs_oauth_session` and `fs_session` are ephemeral session-store rows
 * that get cleared on revocation/expiry, and `lib/roles.ts#isOwnMember` (calendar/zine
 * inclusion by authorship) needs a fact that outlives those.
 */
export const member = pgTable('fs_member', {
  did: text('did').primaryKey(),
  /** 'custodial' | 'oauth' — the door most recently used; presence is what matters. */
  door: text('door').notNull(),
  firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
})

/* ───────────────────────────────── RSVP & attendance ───────────────────────────── */

/**
 * RSVPs are APP-SIDE (R9) — the default is that who is coming to a class is not a
 * public record. `alsoPublicRecord` is a per-event opt-in that additionally writes
 * `community.lexicon.calendar.rsvp` into the member's own repo.
 */
export const rsvp = pgTable(
  'fs_rsvp',
  {
    id: text('id').primaryKey(),
    eventUri: text('event_uri').notNull(),
    did: text('did').notNull(),
    /**
     * 'going' | 'interested' | 'notgoing' | 'waitlisted'. `waitlisted` is never what a
     * caller requests — the server assigns it instead of 'going' when `capacity` is set
     * and already met (`lib/rsvp.ts#resolveGoingOrWaitlist`); a departure promotes the
     * earliest-by-`createdAt` waitlisted row (`promoteFromWaitlist`).
     */
    status: text('status').notNull(),
    alsoPublicRecord: boolean('also_public_record').notNull().default(false),
    publicRecordUri: text('public_record_uri'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fs_rsvp_event_did_idx').on(t.eventUri, t.did),
    index('fs_rsvp_did_idx').on(t.did),
  ],
)

/**
 * Attendance attestations, app-side. Rows COLLAPSE to `attendanceRollup` counts 90
 * days after the event (retention job); role derivation reads the rollup afterwards.
 */
export const attendance = pgTable(
  'fs_attendance',
  {
    id: text('id').primaryKey(),
    eventUri: text('event_uri').notNull(),
    attendeeDid: text('attendee_did').notNull(),
    attestedByDid: text('attested_by_did').notNull(),
    participated: boolean('participated').notNull().default(true),
    /** 'attendee' | 'assistant' | 'co-host' */
    role: text('role').notNull().default('attendee'),
    eventStartsAt: ts('event_starts_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    voidedAt: ts('voided_at'),
  },
  (t) => [
    uniqueIndex('fs_attendance_event_attendee_idx').on(t.eventUri, t.attendeeDid),
    index('fs_attendance_attendee_idx').on(t.attendeeDid),
  ],
)

/** What survives the 90-day collapse: counts, plus a per-DID tally with no event link. */
export const attendanceRollup = pgTable(
  'fs_attendance_rollup',
  {
    eventUri: text('event_uri').primaryKey(),
    participatedCount: integer('participated_count').notNull().default(0),
    totalCount: integer('total_count').notNull().default(0),
    collapsedAt: ts('collapsed_at').notNull().defaultNow(),
  },
)

/** Per-member lifetime tallies, the only attendance evidence that outlives 90 days. */
export const attendanceTally = pgTable('fs_attendance_tally', {
  did: text('did').primaryKey(),
  attendedConfirmed: integer('attended_confirmed').notNull().default(0),
  hostedEvents: integer('hosted_events').notNull().default(0),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/* ─────────────────────────────────── feedback ─────────────────────────────────── */

/**
 * Per-event feedback window. `ballotKey` is a random 32-byte per-event HMAC key used
 * ONLY to derive the un-linkable ballot token; it is DESTROYED at window close, after
 * which no ballot can ever be attributed to a DID even with the database in hand.
 */
export const feedbackWindow = pgTable('fs_feedback_window', {
  eventUri: text('event_uri').primaryKey(),
  opensAt: ts('opens_at').notNull().defaultNow(),
  closesAt: ts('closes_at').notNull(),
  ballotKey: bytea('ballot_key'),
  keyDestroyedAt: ts('key_destroyed_at'),
  publishedAt: ts('published_at'),
  /** aggregateFeedback() output, published once per window. */
  summary: jsonb('summary'),
})

/**
 * One row per eligible voter who has voted. Holds ONLY hmac(perEventKey, did) — no
 * DID, no content, and NO link to a `feedback` row. Double-voting is prevented by the
 * unique index; authorship is not recoverable.
 */
export const feedbackBallot = pgTable(
  'fs_feedback_ballot',
  {
    eventUri: text('event_uri').notNull(),
    ballot: text('ballot').notNull(),
    castAt: ts('cast_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.eventUri, t.ballot] })],
)

/**
 * The feedback content. Deliberately has NO author column and no foreign key to a
 * ballot, and stores a DATE (not a timestamp) so write-order cannot re-link a row to
 * the ballot cast at the same instant.
 */
export const feedback = pgTable(
  'fs_feedback',
  {
    id: text('id').primaryKey(),
    eventUri: text('event_uri').notNull(),
    /** Denormalized so the summary can be computed without touching the index. */
    hostDid: text('host_did').notNull(),
    /** 'positive' | 'negative' */
    direction: text('direction').notNull(),
    aspects: jsonb('aspects'),
    text: text('text'),
    /** DATE ONLY — see above. */
    day: date('day').notNull(),
  },
  (t) => [index('fs_feedback_event_idx').on(t.eventUri), index('fs_feedback_host_idx').on(t.hostDid)],
)

/* ───────────────────────────── moderation, audit, policy ──────────────────────── */

/** Every SchoolActorPort call, allow or deny. Reason is mandatory. */
export const audit = pgTable(
  'fs_audit',
  {
    id: text('id').primaryKey(),
    callerDid: text('caller_did').notNull(),
    schoolDid: text('school_did').notNull(),
    scope: text('scope').notNull(),
    nsid: text('nsid').notNull(),
    action: text('action').notNull(),
    decision: text('decision').notNull(),
    reason: text('reason').notNull(),
    approvals: jsonb('approvals').notNull(),
    policySource: text('policy_source').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [index('fs_audit_at_idx').on(t.at), index('fs_audit_action_idx').on(t.action)],
)

export const moderationQueue = pgTable(
  'fs_moderation_queue',
  {
    id: text('id').primaryKey(),
    subjectUri: text('subject_uri'),
    subjectDid: text('subject_did'),
    /** the SchoolAction the steward is proposing */
    action: text('action').notNull(),
    /** MANDATORY free-text reason; no action without one. */
    reason: text('reason').notNull(),
    status: text('status').notNull().default('open'),
    /** [{stewardDid, at}] — approvals live in the row, not process state. */
    approvals: jsonb('approvals').notNull().default([]),
    openedByDid: text('opened_by_did').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    resolvedAt: ts('resolved_at'),
    resultUri: text('result_uri'),
  },
  (t) => [index('fs_moderation_status_idx').on(t.status)],
)

/** Founder-appointed (bootstrap) or elected stewards — the one role not derivable. */
export const steward = pgTable('fs_steward', {
  did: text('did').primaryKey(),
  schoolDid: text('school_did').notNull(),
  appointedAt: ts('appointed_at').notNull().defaultNow(),
  appointedByDid: text('appointed_by_did'),
  suspendedAt: ts('suspended_at'),
})

/** Cache of the school's current freeschool.draft.policy thresholds. */
export const policyCache = pgTable('fs_policy_cache', {
  schoolDid: text('school_did').primaryKey(),
  policyUri: text('policy_uri'),
  thresholds: jsonb('thresholds').notNull(),
  fetchedAt: ts('fetched_at').notNull().defaultNow(),
})

/** Peer registry = contrail's `relays`. Seeded from env, extended by the school record. */
export const peer = pgTable('fs_peer', {
  host: text('host').primaryKey(),
  /** 'env' | 'school-record' | 'admin' */
  source: text('source').notNull(),
  schoolDid: text('school_did'),
  addedAt: ts('added_at').notNull().defaultNow(),
  disabledAt: ts('disabled_at'),
})

/**
 * Materials and a supplies note for a class — `coop.lexicon.event.config` (our ASSUMED
 * shape, `lexicons/coop.ts`) has no fields for either, so they live here, app-side, one
 * row per event. `suppliesNote` is free text the host writes ("bring a lock and cable");
 * it is never auto-linkified or rendered as a payment affordance by this API — that is a
 * client rendering rule, not something enforced by storage.
 */
export const eventExtra = pgTable('fs_event_extra', {
  eventUri: text('event_uri').primaryKey(),
  /** string[], ≤ 20 items of ≤ 120 chars — enforced by the route's zod schema. */
  materials: jsonb('materials').notNull().default([]),
  suppliesNote: text('supplies_note'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/* ───────────────────────────────── recurrence ─────────────────────────────────── */

/** Idempotency ledger for the materializer: one row per materialized slot. */
export const seriesOccurrence = pgTable(
  'fs_series_occurrence',
  {
    seriesUri: text('series_uri').notNull(),
    /** deterministic rkey = hash(series rkey + originalStartsAt) */
    occurrenceRkey: text('occurrence_rkey').notNull(),
    originalStartsAt: ts('original_starts_at').notNull(),
    eventUri: text('event_uri'),
    sequence: integer('sequence'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.seriesUri, t.occurrenceRkey] })],
)

/* ──────────────────────────────── notifications ───────────────────────────────── */

export const notificationTarget = pgTable(
  'fs_notification_target',
  {
    id: text('id').primaryKey(),
    did: text('did').notNull(),
    /** 'web-push' | 'email' */
    transport: text('transport').notNull(),
    /** push endpoint URL, or the email address */
    address: text('address').notNull(),
    /** web-push p256dh/auth keys */
    keys: jsonb('keys'),
    createdAt: ts('created_at').notNull().defaultNow(),
    disabledAt: ts('disabled_at'),
    failures: integer('failures').notNull().default(0),
  },
  (t) => [
    uniqueIndex('fs_notification_target_addr_idx').on(t.did, t.transport, t.address),
    index('fs_notification_target_did_idx').on(t.did),
  ],
)

export const notificationPref = pgTable(
  'fs_notification_pref',
  {
    did: text('did').notNull(),
    category: text('category').notNull(),
    transport: text('transport').notNull(),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.did, t.category, t.transport] })],
)

/** Dedup ledger. The unique key IS the claim: insert-or-nothing decides the winner. */
export const notificationSent = pgTable(
  'fs_notification_sent',
  {
    dedupKey: text('dedup_key').primaryKey(),
    did: text('did').notNull(),
    category: text('category').notNull(),
    claimedAt: ts('claimed_at').notNull().defaultNow(),
    sentAt: ts('sent_at'),
  },
  (t) => [index('fs_notification_sent_did_idx').on(t.did)],
)

export const notificationOutbox = pgTable(
  'fs_notification_outbox',
  {
    id: text('id').primaryKey(),
    did: text('did').notNull(),
    category: text('category').notNull(),
    dedupKey: text('dedup_key').notNull(),
    /** Declarative Web Push / email payload. Never contains an actor for feedback.*. */
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at').notNull().defaultNow(),
    createdAt: ts('created_at').notNull().defaultNow(),
    deliveredAt: ts('delivered_at'),
    /** Bounded failure category only — never a raw transport error. */
    failureCode: text('failure_code'),
  },
  (t) => [
    index('fs_notification_outbox_due_idx').on(t.status, t.nextAttemptAt),
    index('fs_notification_outbox_did_idx').on(t.did),
  ],
)

/** The in-app notification list (`GET /api/notifications`). */
export const notificationFeed = pgTable(
  'fs_notification_feed',
  {
    id: text('id').primaryKey(),
    did: text('did').notNull(),
    category: text('category').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    navigate: text('navigate'),
    createdAt: ts('created_at').notNull().defaultNow(),
    readAt: ts('read_at'),
  },
  (t) => [index('fs_notification_feed_did_idx').on(t.did, t.createdAt)],
)

/**
 * Monthly digest issues: composed by `jobs/newsletter.ts#composeNewsletterIssue`,
 * sent by `sendNewsletterIssue` once a steward calls `POST
 * /api/admin/newsletter/:id/send`. `html`/`text` are the BASE digest content, with no
 * unsubscribe link baked in — each send appends a per-recipient one-click unsubscribe
 * footer built from that subscriber's own (freshly rotated) token.
 */
export const newsletterIssue = pgTable('fs_newsletter_issue', {
  id: text('id').primaryKey(),
  month: text('month').notNull(),
  html: text('html').notNull(),
  text: text('text').notNull(),
  /** 'draft' | 'sent' */
  status: text('status').notNull().default('draft'),
  sentAt: ts('sent_at'),
  recipientCount: integer('recipient_count'),
  /** Per-recipient sends are isolated (one throwing send must not abort the rest). */
  failedCount: integer('failed_count'),
})

/**
 * Newsletter consent, ONE row per DID. `emailRef` is a snapshot of the account email at
 * subscribe time (not a foreign key) — the same address a custodial signup already
 * holds. `tokenHash` is the hash of the CURRENT one-click unsubscribe token; it is
 * ROTATED on every send (`lib/newsletter-subscriptions.ts#rotateUnsubscribeToken`), so a
 * token in any one email works exactly once, ever — only its hash is ever stored.
 */
export const newsletterSubscription = pgTable(
  'fs_newsletter_subscription',
  {
    did: text('did').primaryKey(),
    emailRef: text('email_ref').notNull(),
    subscribedAt: ts('subscribed_at').notNull().defaultNow(),
    unsubscribedAt: ts('unsubscribed_at'),
    tokenHash: text('token_hash').notNull(),
  },
  (t) => [uniqueIndex('fs_newsletter_subscription_token_idx').on(t.tokenHash)],
)

/**
 * Opt-in to having one's DERIVED role published as a public `coop.lexicon.membership`
 * claim (`lib/membership-claims.ts`). OFF by default — R9: no public record may name a
 * DID its holder did not choose to.
 */
export const memberPrefs = pgTable('fs_member_prefs', {
  did: text('did').primaryKey(),
  publicRole: boolean('public_role').notNull().default(false),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  // Members directory (R9-adjacent): ON by default, so a member has to opt OUT rather
  // than opt in to being found by other members. No row for a `did` means "default",
  // i.e. listed — see `directoryListing` in `GET /api/me`.
  directoryListing: boolean('directory_listing').notNull().default(true),
  // Set once, the first time a member completes onboarding (propose-a-skill / directory
  // intro flow). Never cleared. `onboarded` in `GET /api/me` is just `onboardedAt != null`.
  onboardedAt: ts('onboarded_at'),
})

/**
 * A query-only projection of members' OWN skill claims (public repo records AND
 * app-side 'school'-visibility ones), rebuilt wholesale from `PUT /api/me/skill-claims`
 * in the same transaction as the app-side write. Lets the directory and vouching UI
 * search "who claims skill X" without re-walking every member's repo or the contrail
 * index. Never a source of truth: the repo record (public) or `fs_app_meta` blob
 * (school) is authoritative, and a `did` is fully replaced on every save.
 */
export const skillClaimIndex = pgTable(
  'fs_skill_claim_index',
  {
    did: text('did').notNull(),
    skillUri: text('skill_uri').notNull(),
    level: text('level').notNull(), // learning|practicing|proficient|teaching
    visibility: text('visibility').notNull(), // public|school
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.did, t.skillUri] }), index('fs_skill_claim_index_skill_idx').on(t.skillUri)],
)

/**
 * A member vouching that another member has a skill — "skill vouching" in the directory.
 * `contextEventUri` is optional provenance (a class where the vouch happened), never
 * required. One vouch per (attester, subject, skill): re-vouching is a no-op, not a pile-up.
 */
export const attestation = pgTable(
  'fs_attestation',
  {
    id: text('id').primaryKey(), // rowId() from lib/ids.ts
    attesterDid: text('attester_did').notNull(),
    subjectDid: text('subject_did').notNull(),
    skillUri: text('skill_uri').notNull(),
    contextEventUri: text('context_event_uri'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fs_attestation_unique').on(t.attesterDid, t.subjectDid, t.skillUri),
    index('fs_attestation_subject_idx').on(t.subjectDid),
  ],
)

/** A member-proposed addition to the skill taxonomy, pending or already in use. */
export const skillProposal = pgTable('fs_skill_proposal', {
  id: text('id').primaryKey(), // rowId() from lib/ids.ts
  skillUri: text('skill_uri').notNull(),
  proposerDid: text('proposer_did').notNull(),
  status: text('status').notNull().default('published'), // published|deprecated
  createdAt: ts('created_at').notNull().defaultNow(),
})

/**
 * A steward-to-successor hand-off token (7-day TTL, single use). `toDid` is nullable:
 * an open link accepted by whoever redeems it first, or a link addressed to one named
 * successor. See `http/routes/handoff.ts`.
 */
export const handoff = pgTable(
  'fs_handoff',
  {
    id: text('id').primaryKey(),
    fromDid: text('from_did').notNull(),
    toDid: text('to_did'),
    tokenHash: text('token_hash').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
    acceptedAt: ts('accepted_at'),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [uniqueIndex('fs_handoff_token_idx').on(t.tokenHash)],
)

/* ───────────────────────────── spaces-shim (Postgres) ─────────────────────────── */

export const space = pgTable('fs_space', {
  uri: text('uri').primaryKey(),
  authority: text('authority').notNull(),
  spaceType: text('space_type').notNull(),
  skey: text('skey').notNull(),
  policy: jsonb('policy').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
})

export const spaceMember = pgTable(
  'fs_space_member',
  {
    spaceUri: text('space_uri').notNull(),
    did: text('did').notNull(),
    role: text('role').notNull(),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.spaceUri, t.did] })],
)

export const spaceRecord = pgTable(
  'fs_space_record',
  {
    uri: text('uri').primaryKey(),
    spaceUri: text('space_uri').notNull(),
    author: text('author').notNull(),
    collection: text('collection').notNull(),
    rkey: text('rkey').notNull(),
    value: jsonb('value').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('fs_space_record_lookup_idx').on(t.spaceUri, t.collection)],
)

/* ──────────────────────────────── misc app state ──────────────────────────────── */

/** Small key/value for indexer bookkeeping we own (not contrail's cursors). */
export const appMeta = pgTable('fs_app_meta', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const schema = {
  session,
  oauthState,
  oauthSession,
  oauthClientKey,
  custodialAccount,
  emailVerification,
  ownershipReveal,
  invite,
  inviteLink,
  skillTier,
  requestRsvp,
  member,
  rsvp,
  eventExtra,
  attendance,
  attendanceRollup,
  attendanceTally,
  feedbackWindow,
  feedbackBallot,
  feedback,
  audit,
  moderationQueue,
  steward,
  policyCache,
  peer,
  seriesOccurrence,
  notificationTarget,
  notificationPref,
  notificationSent,
  notificationOutbox,
  notificationFeed,
  newsletterIssue,
  newsletterSubscription,
  memberPrefs,
  skillClaimIndex,
  attestation,
  skillProposal,
  handoff,
  space,
  spaceMember,
  spaceRecord,
  appMeta,
}