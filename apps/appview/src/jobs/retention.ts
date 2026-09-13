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
 *
 * Every step is idempotent and bounded, so it is safe to run more than once a day and
 * safe to run on a machine that was off for a week.
 */
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import {
  attendance,
  attendanceRollup,
  invite,
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

export interface RetentionResult {
  invitersPurged: number
  attendanceCollapsed: number
  eventsCollapsed: number
  feedbackWindowsClosed: number
  sessionsPruned: number
  oauthStatesPruned: number
  notificationsPruned: number
  ownershipRevealsPurged: number
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
      total: sql<number>`count(*)::int`,
      participated: sql<number>`count(*) filter (where participated)::int`,
    })
    .from(attendance)
    .where(and(isNull(attendance.voidedAt), lt(attendance.eventStartsAt, cutoff)))
    .groupBy(attendance.eventUri)

  let collapsedRows = 0
  for (const group of stale) {
    await db
      .insert(attendanceRollup)
      .values({
        eventUri: group.eventUri,
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

  /* 3. feedback windows + key destruction */
  const authority = config().SCHOOL_DID
  const { closed } = await closeDueWindows(
    now,
    authority.startsWith('did:')
      ? { store: new PostgresSpaceStore(db), authority: authority as Did }
      : undefined,
  )

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

  const result: RetentionResult = {
    invitersPurged: purged.length,
    attendanceCollapsed: collapsedRows,
    eventsCollapsed: stale.length,
    feedbackWindowsClosed: closed,
    sessionsPruned: sessions.length,
    oauthStatesPruned: states.length,
    notificationsPruned: outbox.length + feed.length,
    ownershipRevealsPurged: ownershipReveals.length,
  }
  log.info('retention pass complete', { ...result })
  return result
}
