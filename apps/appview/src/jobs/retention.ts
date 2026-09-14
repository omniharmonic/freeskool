/**
 * Retention as code (R9). Daily.
 *
 * The app-side tables are the subpoena target, so they are actively shrunk:
 *
 *   invites        `inviter_did` is NULLed 30 days after use. The fact that someone WAS
 *                  invited survives (it is role evidence); who invited them does not.
 *   attendance     rows collapse to counts 90 days after the event. The per-member tally
 *                  in `fs_attendance_tally` is bumped at attest time, so role derivation
 *                  keeps working without the rows.
 *   feedback       windows close: the aggregate is published once and the per-event ballot
 *                  key is DESTROYED (see lib/feedback.ts).
 *   sessions       expired rows deleted.
 *   oauth state    single-use state rows older than an hour are dead weight.
 *   notifications  delivered/failed outbox rows and read feed rows older than 90 days.
 *   ownership reveal  `fs_ownership_reveal` rows that are USED (the one-time read
 *                  already happened) or EXPIRED-and-never-used are purged — the wrapped
 *                  password blob in a used row is already nulled at read time
 *                  (`lib/custody.ts#revealOwnershipPassword`), so this is metadata
 *                  cleanup, not a second line of secret-retention defense.
 *   email verify   `fs_email_verification` rows that are USED or EXPIRED. Each one is a
 *                  (DID, magic-link hash) pair: a spent token is a permanent record that
 *                  this account was created, and verified, at this minute.
 *   invite links   `fs_invite_link` rows that are EXPIRED or EXHAUSTED. `inviter_did` is
 *                  NOT NULL on this table, so — unlike `fs_invite`, where the fact of an
 *                  invite is role evidence that must survive its inviter — there is
 *                  nothing to keep once the link is dead, and deleting the row is the
 *                  STRONGER form of the same 30-day "who invited whom is not ours to
 *                  keep" rule. A link's own TTL is days, well inside that window.
 *   hand-offs      `fs_handoff` rows ACCEPTED or EXPIRED, after 30 days. The row pairs
 *                  two steward DIDs; `fs_steward` is what actually carries the role, so
 *                  the hand-off row is only wanted while someone might still be asking
 *                  what happened, and `fs_audit` answers that afterwards.
 *
 * Every step is idempotent and bounded, so it is safe to run more than once a day and
 * safe to run on a machine that was off for a week.
 */
import { and, eq, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import {
  attendance,
  attendanceRollup,
  emailVerification,
  handoff,
  invite,
  inviteLink,
  notificationFeed,
  notificationOutbox,
  oauthState,
  ownershipReveal,
  session,
} from '../db/schema.js'
import { closeDueWindows } from '../lib/feedback.js'
import { PostgresSpaceStore } from '../spaces/postgres-store.js'
import { config } from '../config.js'
import type { Did } from '@freeschool/spaces-shim'
import { log } from '../lib/logging.js'

export const INVITER_PURGE_DAYS = 30
export const ATTENDANCE_COLLAPSE_DAYS = 90
export const NOTIFICATION_KEEP_DAYS = 90
/** Same window as `INVITER_PURGE_DAYS`, and for the same reason: it pairs two DIDs. */
export const HANDOFF_KEEP_DAYS = 30

export interface RetentionResult {
  invitersPurged: number
  attendanceCollapsed: number
  eventsCollapsed: number
  feedbackWindowsClosed: number
  sessionsPruned: number
  oauthStatesPruned: number
  notificationsPruned: number
  ownershipRevealsPurged: number
  emailVerificationsPurged: number
  inviteLinksPurged: number
  handoffsPurged: number
}

export async function runRetention(now = new Date()): Promise<RetentionResult> {
  const db = getDb()

  /* 1. inviter DIDs */
  const purged = await db
    .update(invite)
    .set({ inviterDid: null, inviterPurgedAt: now })
    .where(
      and(
        isNotNull(invite.inviterDid),
        isNull(invite.inviterPurgedAt),
        lt(invite.usedAt, new Date(now.getTime() - INVITER_PURGE_DAYS * 86_400_000)),
      ),
    )
    .returning({ code: invite.code })

  /* 2. attendance -> counts */
  const cutoff = new Date(now.getTime() - ATTENDANCE_COLLAPSE_DAYS * 86_400_000)
  const stale = await db
    .select({
      eventUri: attendance.eventUri,
      schoolDid: attendance.schoolDid,
      total: sql<number>`count(*)::int`,
      participated: sql<number>`count(*) filter (where participated)::int`,
    })
    .from(attendance)
    .where(and(isNull(attendance.voidedAt), lt(attendance.eventStartsAt, cutoff)))
    .groupBy(attendance.eventUri, attendance.schoolDid)

  let collapsedRows = 0
  for (const group of stale) {
    await db
      .insert(attendanceRollup)
      .values({
        eventUri: group.eventUri,
        // The rollup is what survives the collapse; retention runs per school (MS §4).
        schoolDid: group.schoolDid,
        participatedCount: group.participated,
        totalCount: group.total,
        collapsedAt: now,
      })
      .onConflictDoUpdate({
        target: attendanceRollup.eventUri,
        set: {
          participatedCount: sql`${attendanceRollup.participatedCount} + ${group.participated}`,
          totalCount: sql`${attendanceRollup.totalCount} + ${group.total}`,
          collapsedAt: now,
        },
      })
    const deleted = await db
      .delete(attendance)
      .where(eq(attendance.eventUri, group.eventUri))
      .returning({ id: attendance.id })
    collapsedRows += deleted.length
  }

  /**
   * 3. feedback windows + key destruction.
   *
   * NO `authority` here on purpose: `closeDueWindows` resolves each window's school from
   * its own class (`fs_event_school`), so a process serving several schools publishes
   * each aggregate under the school whose class it was — rather than all of them under
   * whichever DID happened to be in the environment.
   */
  const { closed } = await closeDueWindows(now, { store: new PostgresSpaceStore(db) })

  /* 4. sessions */
  const sessions = await db.delete(session).where(lt(session.expiresAt, now)).returning({ id: session.id })

  /* 5. oauth state */
  const states = await db
    .delete(oauthState)
    .where(lt(oauthState.createdAt, new Date(now.getTime() - 3_600_000)))
    .returning({ key: oauthState.key })

  /* 6. notifications */
  const keepCutoff = new Date(now.getTime() - NOTIFICATION_KEEP_DAYS * 86_400_000)
  const outbox = await db
    .delete(notificationOutbox)
    .where(and(lt(notificationOutbox.createdAt, keepCutoff), sql`${notificationOutbox.status} <> 'pending'`))
    .returning({ id: notificationOutbox.id })
  const feed = await db
    .delete(notificationFeed)
    .where(and(lt(notificationFeed.createdAt, keepCutoff), isNotNull(notificationFeed.readAt)))
    .returning({ id: notificationFeed.id })

  /* 7. ownership reveal rows: used, or expired-and-never-used (review round 1, I4) */
  const ownershipReveals = await db
    .delete(ownershipReveal)
    .where(or(isNotNull(ownershipReveal.usedAt), lt(ownershipReveal.expiresAt, now)))
    .returning({ tokenHash: ownershipReveal.tokenHash })

  /* 8. spent magic links: used, or expired and never used */
  const emailVerifications = await db
    .delete(emailVerification)
    .where(or(isNotNull(emailVerification.usedAt), lt(emailVerification.expiresAt, now)))
    .returning({ tokenHash: emailVerification.tokenHash })

  /* 9. dead invite LINKS: expired, or out of uses */
  const inviteLinks = await db
    .delete(inviteLink)
    .where(or(lt(inviteLink.expiresAt, now), lte(inviteLink.usesLeft, 0)))
    .returning({ id: inviteLink.id })

  /* 10. settled hand-offs, after 30 days */
  const handoffs = await db
    .delete(handoff)
    .where(
      and(
        or(isNotNull(handoff.acceptedAt), lt(handoff.expiresAt, now)),
        lt(handoff.createdAt, new Date(now.getTime() - HANDOFF_KEEP_DAYS * 86_400_000)),
      ),
    )
    .returning({ id: handoff.id })

  const result: RetentionResult = {
    invitersPurged: purged.length,
    attendanceCollapsed: collapsedRows,
    eventsCollapsed: stale.length,
    feedbackWindowsClosed: closed,
    sessionsPruned: sessions.length,
    oauthStatesPruned: states.length,
    notificationsPruned: outbox.length + feed.length,
    ownershipRevealsPurged: ownershipReveals.length,
    emailVerificationsPurged: emailVerifications.length,
    inviteLinksPurged: inviteLinks.length,
    handoffsPurged: handoffs.length,
  }
  log.info('retention pass complete', { ...result })
  return result
}
