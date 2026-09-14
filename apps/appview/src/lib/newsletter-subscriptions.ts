/**
 * `fs_newsletter_subscription` CRUD: consent to the monthly digest, distinct from
 * `fs_notification_target` ("tell me when my class changes" is not "send me a monthly
 * email") — see `jobs/newsletter.ts` for why this needed its own table.
 *
 * The unsubscribe token is SINGLE-USE by construction, never by convention: only its
 * hash is ever stored, it is ROTATED on every send (a stale token in an old email can
 * never be replayed against a later issue), and using it to unsubscribe sets
 * `unsubscribedAt`, which makes every subsequent presentation of that same token fail
 * the `unsubscribedAt IS NULL` lookup — a second click does nothing, rather than
 * silently "succeeding" again.
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { newsletterSubscription } from '../db/schema.js'
import { hashToken, newToken } from './crypto.js'
import { legacySchoolDid } from './schools.js'
import { schoolScope } from './school-scope.js'

export interface SubscribeResult {
  /** The plaintext unsubscribe token. Only its hash is ever stored after this call. */
  token: string
}

/**
 * Subscribes (or re-subscribes) `did` TO ONE SCHOOL's digest, snapshotting `email` as
 * `emailRef`. PK `(did, school_did)` since the federation phase: subscribing to
 * Boulder's digest is not subscribing to Denver's (MS §4).
 */
export async function subscribe(did: string, email: string, schoolDid = legacySchoolDid()): Promise<SubscribeResult> {
  const token = newToken()
  const db = getDb()
  const set = { emailRef: email, tokenHash: hashToken(token), subscribedAt: new Date(), unsubscribedAt: null }
  // UPDATE first, against `schoolScope`, so an unstamped pre-tenancy row is re-subscribed
  // rather than shadowed by a second row for the same person — see `lib/roles.ts#bumpTally`.
  const updated = await db
    .update(newsletterSubscription)
    .set(set)
    .where(and(eq(newsletterSubscription.did, did), schoolScope(newsletterSubscription.schoolDid, schoolDid)))
    .returning({ did: newsletterSubscription.did })
  if (updated.length === 0) {
    await db
      .insert(newsletterSubscription)
      .values({ did, schoolDid, ...set })
      .onConflictDoUpdate({ target: [newsletterSubscription.did, newsletterSubscription.schoolDid], set })
  }
  return { token }
}

/** The viewer unsubscribing themselves directly (no token needed — they are signed in). */
export async function unsubscribeDid(did: string, schoolDid = legacySchoolDid()): Promise<void> {
  await getDb()
    .update(newsletterSubscription)
    .set({ unsubscribedAt: new Date() })
    .where(and(eq(newsletterSubscription.did, did), schoolScope(newsletterSubscription.schoolDid, schoolDid)))
}

export async function isSubscribed(did: string, schoolDid = legacySchoolDid()): Promise<boolean> {
  const rows = await getDb()
    .select({ unsubscribedAt: newsletterSubscription.unsubscribedAt })
    .from(newsletterSubscription)
    .where(and(eq(newsletterSubscription.did, did), schoolScope(newsletterSubscription.schoolDid, schoolDid)))
    .limit(1)
  return rows.length > 0 && rows[0]!.unsubscribedAt === null
}

export type UnsubscribeResult = { ok: true } | { ok: false; status: 404; error: 'InvalidToken' }

/** Single-use by construction — see module doc. */
export async function unsubscribeByToken(token: string): Promise<UnsubscribeResult> {
  const rows = await getDb()
    .update(newsletterSubscription)
    .set({ unsubscribedAt: new Date() })
    .where(and(eq(newsletterSubscription.tokenHash, hashToken(token)), isNull(newsletterSubscription.unsubscribedAt)))
    .returning({ did: newsletterSubscription.did })
  if (rows.length === 0) return { ok: false, status: 404, error: 'InvalidToken' }
  return { ok: true }
}

/** One row per active subscriber OF THIS SCHOOL, oldest first, capped at `limit`. */
export async function activeSubscribers(
  limit: number,
  schoolDid = legacySchoolDid(),
): Promise<Array<{ did: string; emailRef: string }>> {
  return getDb()
    .select({ did: newsletterSubscription.did, emailRef: newsletterSubscription.emailRef })
    .from(newsletterSubscription)
    .where(and(isNull(newsletterSubscription.unsubscribedAt), schoolScope(newsletterSubscription.schoolDid, schoolDid)))
    .orderBy(newsletterSubscription.subscribedAt)
    .limit(limit)
}

/**
 * Mints a fresh unsubscribe token for `did` and persists only its hash. Called once per
 * recipient per send — see `jobs/newsletter.ts#sendNewsletterIssue`.
 */
export async function rotateUnsubscribeToken(did: string, schoolDid = legacySchoolDid()): Promise<string> {
  const token = newToken()
  await getDb()
    .update(newsletterSubscription)
    .set({ tokenHash: hashToken(token) })
    .where(and(eq(newsletterSubscription.did, did), schoolScope(newsletterSubscription.schoolDid, schoolDid)))
  return token
}
