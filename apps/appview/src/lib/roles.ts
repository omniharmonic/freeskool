/**
 * Role derivation. Roles are a DERIVED VIEW, never a stored token: this module gathers
 * `Evidence` from indexed public records plus app-side tables, and hands it straight to
 * `deriveRole` from `@freeschool/shared` with the school's policy thresholds. The only
 * thing that is ever *stored* is the `coop.lexicon.membership` claim the school writes,
 * and that is a consequence of this function, not an input to it.
 *
 * Evidence sources, field by field:
 *
 *   hasProfile              a custodial account row, OR any record indexed for the DID
 *   inviteOrVouch           `fs_invite` used by the DID (survives inviter-DID purge)
 *   attendedConfirmed       `fs_attendance_tally` (maintained at attest time so it
 *                           survives the 90-day collapse of the attendance rows)
 *   hostedEvents            `fs_attendance_tally`
 *   upheldNegativeFeedback  resolved `fs_moderation_queue` rows against the DID
 *   stewardAppointed        `fs_steward`
 */
import { and, eq, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { deriveRole, Role, type Evidence } from '@freeschool/shared'
import { getDb } from '../db/index.js'
import { attendanceTally, custodialAccount, invite, moderationQueue, oauthSession, steward } from '../db/schema.js'
import { getThresholds } from './policy.js'
import { config } from '../config.js'
import { getIndexer } from '../index/indexer.js'

/**
 * Does this DID belong to THIS school at all — by signing in through either door, or by
 * steward appointment? Used to decide calendar/zine inclusion by AUTHORSHIP
 * (`http/visibility.ts#calendarInclusion`), independent of any `coop.lexicon.event.listing`
 * (which exists for routing to PEERS, not for deciding what is ours). Deliberately
 * narrower than `hasProfile` above: `hasIndexedRecords` counts ANY indexed record
 * anywhere, which would wrongly call a peer school's host "ours" once their events are
 * indexed; these three tables are specifically OUR OWN accounts.
 */
export async function isOwnMember(did: string): Promise<boolean> {
  const db = getDb()
  const [custodial, oauth, stewardRow] = await Promise.all([
    db.select({ did: custodialAccount.did }).from(custodialAccount).where(eq(custodialAccount.did, did)).limit(1),
    db.select({ sub: oauthSession.sub }).from(oauthSession).where(eq(oauthSession.sub, did)).limit(1),
    db.select({ did: steward.did }).from(steward).where(eq(steward.did, did)).limit(1),
  ])
  return custodial.length > 0 || oauth.length > 0 || stewardRow.length > 0
}

export async function evidenceFor(did: string, schoolDid = config().SCHOOL_DID): Promise<Evidence> {
  const db = getDb()

  const [custodial, invited, tally, upheld, stewardRow] = await Promise.all([
    db.select({ did: custodialAccount.did }).from(custodialAccount).where(eq(custodialAccount.did, did)).limit(1),
    db
      .select({ code: invite.code })
      .from(invite)
      .where(
        and(
          eq(invite.usedByDid, did),
          or(isNotNull(invite.inviterDid), isNotNull(invite.inviterPurgedAt)),
        ),
      )
      .limit(1),
    db.select().from(attendanceTally).where(eq(attendanceTally.did, did)).limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(moderationQueue)
      .where(
        and(
          eq(moderationQueue.subjectDid, did),
          eq(moderationQueue.status, 'resolved'),
          eq(moderationQueue.action, 'suspend-role'),
        ),
      ),
    db
      .select({ did: steward.did })
      .from(steward)
      .where(and(eq(steward.did, did), eq(steward.schoolDid, schoolDid || ''), isNull(steward.suspendedAt)))
      .limit(1),
  ])

  const hasProfile = custodial.length > 0 || (await hasIndexedRecords(did))

  return {
    hasProfile,
    inviteOrVouch: invited.length > 0,
    attendedConfirmed: tally[0]?.attendedConfirmed ?? 0,
    hostedEvents: tally[0]?.hostedEvents ?? 0,
    upheldNegativeFeedback: upheld[0]?.n ?? 0,
    stewardAppointed: stewardRow.length > 0,
  }
}

/** Any indexed record at all is enough to count as "present in this network". */
async function hasIndexedRecords(did: string): Promise<boolean> {
  try {
    const indexer = await getIndexer()
    const row = await indexer.db
      .prepare('SELECT 1 AS present FROM identities WHERE did = ? LIMIT 1')
      .bind(did)
      .first<{ present: number }>()
    return Boolean(row)
  } catch {
    // Index not yet initialized: fall back to "no public evidence".
    return false
  }
}

export async function roleOf(did: string, schoolDid = config().SCHOOL_DID): Promise<Role> {
  const [evidence, thresholds] = await Promise.all([evidenceFor(did, schoolDid), getThresholds(schoolDid)])
  return deriveRole(evidence, thresholds)
}

export async function bumpTally(
  did: string,
  delta: { attendedConfirmed?: number; hostedEvents?: number },
): Promise<void> {
  await getDb()
    .insert(attendanceTally)
    .values({
      did,
      attendedConfirmed: delta.attendedConfirmed ?? 0,
      hostedEvents: delta.hostedEvents ?? 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: attendanceTally.did,
      set: {
        attendedConfirmed: sql`${attendanceTally.attendedConfirmed} + ${delta.attendedConfirmed ?? 0}`,
        hostedEvents: sql`${attendanceTally.hostedEvents} + ${delta.hostedEvents ?? 0}`,
        updatedAt: new Date(),
      },
    })
}

export { Role, deriveRole }
