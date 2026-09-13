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

export interface SubscribeResult {
  /** The plaintext unsubscribe token. Only its hash is ever stored after this call. */
  token: string
}

/** Subscribes (or re-subscribes) `did`, snapshotting `email` as `emailRef`. */
export async function subscribe(did: string, email: string): Promise<SubscribeResult> {
  const token = newToken()
  await getDb()
    .insert(newsletterSubscription)
    .values({ did, emailRef: email, tokenHash: hashToken(token), subscribedAt: new Date(), unsubscribedAt: null })
    .onConflictDoUpdate({
      target: newsletterSubscription.did,
      set: { emailRef: email, tokenHash: hashToken(token), subscribedAt: new Date(), unsubscribedAt: null },
    })
  return { token }
}

/** The viewer unsubscribing themselves directly (no token needed — they are signed in). */
export async function unsubscribeDid(did: string): Promise<void> {
  await getDb()
    .update(newsletterSubscription)
    .set({ unsubscribedAt: new Date() })
    .where(eq(newsletterSubscription.did, did))
}

export async function isSubscribed(did: string): Promise<boolean> {
  const rows = await getDb()
    .select({ unsubscribedAt: newsletterSubscription.unsubscribedAt })
    .from(newsletterSubscription)
    .where(eq(newsletterSubscription.did, did))
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

/** One row per active subscriber, oldest first, capped at `limit`. */
export async function activeSubscribers(limit: number): Promise<Array<{ did: string; emailRef: string }>> {
  return getDb()
    .select({ did: newsletterSubscription.did, emailRef: newsletterSubscription.emailRef })
    .from(newsletterSubscription)
    .where(isNull(newsletterSubscription.unsubscribedAt))
    .orderBy(newsletterSubscription.subscribedAt)
    .limit(limit)
}

/**
 * Mints a fresh unsubscribe token for `did` and persists only its hash. Called once per
 * recipient per send — see `jobs/newsletter.ts#sendNewsletterIssue`.
 */
export async function rotateUnsubscribeToken(did: string): Promise<string> {
  const token = newToken()
  await getDb().update(newsletterSubscription).set({ tokenHash: hashToken(token) }).where(eq(newsletterSubscription.did, did))
  return token
}
