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
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { deriveRole, Role, type Evidence } from '@freeschool/shared'
import { getDb } from '../db/index.js'
import { attendanceTally, custodialAccount, invite, member, moderationQueue, steward } from '../db/schema.js'
import { getThresholds } from './policy.js'
import { config } from '../config.js'
import { getIndexer } from '../index/indexer.js'
import { describeError, log } from './logging.js'

/**
 * Does this DID belong to THIS school at all — by having EVER signed in through either
 * door, or by steward appointment? Used to decide calendar/zine inclusion by AUTHORSHIP
 * (`http/visibility.ts#calendarInclusion`), independent of any `coop.lexicon.event.listing`
 * (which exists for routing to PEERS, not for deciding what is ours).
 *
 * Reads `fs_member` (a DURABLE fact, written once at `createSession` and never deleted),
 * NOT `fs_oauth_session` — that table is the OAuth client's own token/session store and
 * `PostgresSessionStore.del` (`http/oauth.ts`) deletes a row on revocation or a failed
 * refresh, which would make an OAuth-door host's classes vanish from their own calendar
 * the moment their token needed renewing. Deliberately narrower than `hasProfile` above:
 * that function's `hasIndexedRecords` fallback counts ANY indexed record anywhere, which
 * would wrongly call a peer school's host "ours" once their events are indexed.
 *
 * Single-DID convenience wrapper around `isOwnMemberSet` — prefer the batch form when
 * checking more than one DID (calendar/zine routes do).
 */
export async function isOwnMember(did: string): Promise<boolean> {
  return (await isOwnMemberSet([did])).has(did)
}

/** Batched form of `isOwnMember`: one query per table instead of one per DID. */
export async function isOwnMemberSet(dids: string[]): Promise<Set<string>> {
  const unique = [...new Set(dids)]
  if (unique.length === 0) return new Set()
  const db = getDb()
  const [custodialRows, memberRows, stewardRows] = await Promise.all([
    db.select({ did: custodialAccount.did }).from(custodialAccount).where(inArray(custodialAccount.did, unique)),
    db.select({ did: member.did }).from(member).where(inArray(member.did, unique)),
    db.select({ did: steward.did }).from(steward).where(inArray(steward.did, unique)),
  ])
  const out = new Set<string>()
  for (const r of custodialRows) out.add(r.did)
  for (const r of memberRows) out.add(r.did)
  for (const r of stewardRows) out.add(r.did)
  return out
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
  schoolDid = config().SCHOOL_DID,
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

  // THE ROLE RE-DERIVATION PATH: evidence just changed, so the derived role may have
  // just crossed into Host+. `publishRoleClaim` itself is the gate (policy off AND/OR
  // not opted in is the common case and costs one already-warm cache read) — this is a
  // best-effort side effect, dynamically imported to avoid a module cycle
  // (roles.ts -> membership-claims.ts -> school-actor.ts -> roles.ts), and never allowed
  // to fail the attendance/hosting write it rides along with.
  if (!schoolDid) return
  try {
    const { publishRoleClaim } = await import('./membership-claims.js')
    const role = await roleOf(did, schoolDid)
    await publishRoleClaim(schoolDid as `did:${string}`, did as `did:${string}`, role)
  } catch (err) {
    log.warn('role re-derivation publish check failed', { detail: describeError(err) })
  }
}

export { Role, deriveRole }
