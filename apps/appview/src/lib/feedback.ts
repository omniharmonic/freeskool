/**
 * Anonymous feedback, app-side, behind the Spaces-shaped interface.
 *
 * The separation that makes it anonymous:
 *
 *   fs_feedback_window  per event: a random 32-byte `ballotKey`, DESTROYED at close.
 *   fs_feedback_ballot  (eventUri, hmac(ballotKey, did)) — proves "this person voted,
 *                       once", and nothing else. No DID. No link to content.
 *   fs_feedback         (eventUri, hostDid, direction, aspects, text, DAY) — the content.
 *                       NO author column, NO ballot column, and a DATE rather than a
 *                       timestamp so two rows written a second apart cannot be re-paired
 *                       with two ballots cast a second apart.
 *
 * Once `ballotKey` is destroyed the mapping did -> ballot is unrecoverable even with the
 * whole database, because the key was the only thing that ever existed to compute it.
 *
 * The spaces shim (`PostgresSpaceStore`) carries the PUBLISHED AGGREGATE, authored by the
 * school — see `publishAggregateToSpace` below. The raw rows are deliberately never put
 * into a space: the shim stores an `author` beside every record, which is exactly the link
 * the ballot tables exist to destroy. The shim's policy is `hostMayRead: false` either way,
 * so a host can only ever read the k-anonymous aggregate.
 */
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { aggregateFeedback, type Aspect, type FeedbackAggregate, type FeedbackRow } from '@freeschool/shared'
import { getDb } from '../db/index.js'
import { feedback, feedbackBallot, feedbackWindow } from '../db/schema.js'
import { ballotToken, newBallotKey } from './crypto.js'
import { rowId } from './ids.js'
import { getThresholds } from './policy.js'
import type { Did, SpaceStore } from '@freeschool/spaces-shim'
import { FEEDBACK_SPACE_POLICY, FEEDBACK_SPACE_TYPE } from '../spaces/postgres-store.js'

/** How long after an event ends feedback may be left. */
export const FEEDBACK_WINDOW_DAYS = 14

export class FeedbackError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'FeedbackError'
  }
}

export async function openFeedbackWindow(eventUri: string, eventEndsAt: string): Promise<void> {
  const ends = new Date(eventEndsAt)
  if (Number.isNaN(ends.getTime())) return
  const closesAt = new Date(ends.getTime() + FEEDBACK_WINDOW_DAYS * 86_400_000)
  await getDb()
    .insert(feedbackWindow)
    .values({ eventUri, opensAt: ends, closesAt, ballotKey: newBallotKey() })
    // Never regenerate the key for an existing window: that would let someone vote twice.
    .onConflictDoNothing()
}

export async function getWindow(eventUri: string) {
  const rows = await getDb().select().from(feedbackWindow).where(eq(feedbackWindow.eventUri, eventUri)).limit(1)
  return rows[0] ?? null
}

export interface SubmitFeedbackInput {
  eventUri: string
  hostDid: string
  authorDid: string
  direction: 'positive' | 'negative'
  aspects?: Partial<Record<Aspect, number>>
  text?: string
  now?: Date
}

/**
 * Cast a ballot and store the content, as two writes in one transaction but with no
 * column joining them. The ballot insert is the gate: a conflict means "already voted".
 */
export async function submitFeedback(input: SubmitFeedbackInput): Promise<{ accepted: true }> {
  const now = input.now ?? new Date()
  const db = getDb()
  const win = await getWindow(input.eventUri)
  if (!win) throw new FeedbackError('feedback is not open for this event', 409, 'WindowNotOpen')
  if (now > win.closesAt) throw new FeedbackError('the feedback window has closed', 409, 'WindowClosed')
  if (!win.ballotKey) throw new FeedbackError('the feedback window has been finalized', 409, 'WindowFinalized')
  if (input.authorDid === input.hostDid) {
    throw new FeedbackError('a host cannot leave feedback on their own class', 403, 'SelfFeedback')
  }

  const ballot = ballotToken(Buffer.from(win.ballotKey), input.authorDid)

  await db.transaction(async (tx) => {
    const claimed = await tx
      .insert(feedbackBallot)
      .values({ eventUri: input.eventUri, ballot, castAt: now })
      .onConflictDoNothing()
      .returning({ ballot: feedbackBallot.ballot })
    if (claimed.length === 0) {
      throw new FeedbackError('you have already left feedback for this class', 409, 'AlreadyVoted')
    }
    await tx.insert(feedback).values({
      id: rowId(),
      eventUri: input.eventUri,
      hostDid: input.hostDid,
      direction: input.direction,
      aspects: input.aspects ?? null,
      text: input.text?.trim() ? input.text.trim() : null,
      day: now.toISOString().slice(0, 10),
    })
  })
  return { accepted: true }
}

export interface FeedbackSummary extends FeedbackAggregate {
  /** Numeric aggregates need k; free text needs a higher k (5) before it is shown at all. */
  k: number
  textK: number
  textReleased: boolean
  /** Text is only ever released verbatim when textK distinct ballots exist. */
  texts?: string[]
  windowClosesAt?: string
  publishedAt?: string
}

export const TEXT_K = 5

/**
 * The only feedback view a host ever gets. `aggregateFeedback` enforces numeric k; we
 * enforce a separate, higher k for free text, because one sentence can identify its
 * author in a way that a mean of three numbers cannot.
 */
export async function feedbackSummary(eventUri: string): Promise<FeedbackSummary> {
  const thresholds = await getThresholds()
  const k = thresholds.feedbackK
  const win = await getWindow(eventUri)
  if (win?.publishedAt && win.summary) {
    const published = win.summary as FeedbackSummary
    return { ...published, windowClosesAt: win.closesAt.toISOString(), publishedAt: win.publishedAt.toISOString() }
  }
  const summary = await computeSummary(eventUri, k)
  return {
    ...summary,
    windowClosesAt: win?.closesAt.toISOString(),
  }
}

async function computeSummary(eventUri: string, k: number): Promise<FeedbackSummary> {
  const db = getDb()
  const [rows, ballots] = await Promise.all([
    db.select().from(feedback).where(eq(feedback.eventUri, eventUri)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(feedbackBallot)
      .where(eq(feedbackBallot.eventUri, eventUri)),
  ])
  const distinct = ballots[0]?.n ?? 0
  /**
   * `aggregateFeedback` counts distinct `author`s — which we deliberately do not have.
   * The ballot table IS the distinct-author count, so we feed it synthetic author keys
   * of exactly that cardinality. This is the one place the two tables meet, and they
   * meet only as a NUMBER.
   */
  const synthetic: FeedbackRow[] = rows.map((r, i) => ({
    author: `ballot:${i % Math.max(distinct, 1)}`,
    direction: r.direction === 'negative' ? 'negative' : 'positive',
    aspects: (r.aspects ?? undefined) as Partial<Record<Aspect, number>> | undefined,
    text: r.text ?? undefined,
  }))
  const agg = aggregateFeedback(synthetic, k)
  const textReleased = agg.released && distinct >= TEXT_K
  return {
    ...agg,
    k,
    textK: TEXT_K,
    textReleased,
    ...(textReleased ? { texts: rows.map((r) => r.text).filter((t): t is string => Boolean(t)) } : {}),
  }
}

/**
 * Publish the aggregate through the Spaces-shaped interface, authored by the SCHOOL.
 *
 * This is the only thing about feedback that goes into a space. The raw rows never do:
 * the shim keeps an `author` beside every record, which is precisely the link the ballot
 * tables exist to destroy. An aggregate has no author but the school, so it is safe there
 * and it keeps the migration path to real Spaces on the live code path.
 */
export async function publishAggregateToSpace(
  store: SpaceStore,
  authority: Did,
  eventUri: string,
  summary: FeedbackSummary,
): Promise<void> {
  const space =
    (await store.getSpace(`at://${authority}/${FEEDBACK_SPACE_TYPE}/default`)) ??
    (await store.createSpace({
      authority,
      spaceType: FEEDBACK_SPACE_TYPE,
      skey: 'default',
      policy: FEEDBACK_SPACE_POLICY,
    }))
  await store.putRecord(
    space.uri,
    authority,
    'freeschool.draft.feedbackSummary',
    { event: { uri: eventUri }, ...summary, publishedAt: new Date().toISOString() },
    // One summary per event, ever: the rkey is the event's rkey.
    eventUri.split('/').pop() ?? 'self',
  )
}

/**
 * Close every due window: compute the aggregate once, publish it, and DESTROY the
 * per-event key. Idempotent — a window with no key is already finalized.
 */
export async function closeDueWindows(
  now = new Date(),
  space?: { store: SpaceStore; authority: Did },
): Promise<{ closed: number }> {
  const db = getDb()
  const due = await db
    .select({ eventUri: feedbackWindow.eventUri })
    .from(feedbackWindow)
    .where(and(lte(feedbackWindow.closesAt, now), isNotNull(feedbackWindow.ballotKey)))
  const thresholds = await getThresholds()
  let closed = 0
  for (const row of due) {
    const summary = await computeSummary(row.eventUri, thresholds.feedbackK)
    await db
      .update(feedbackWindow)
      .set({ ballotKey: null, keyDestroyedAt: now, publishedAt: now, summary })
      .where(eq(feedbackWindow.eventUri, row.eventUri))
    if (space) {
      await publishAggregateToSpace(space.store, space.authority, row.eventUri, summary)
    }
    closed++
  }
  return { closed }
}
