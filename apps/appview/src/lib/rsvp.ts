/**
 * RSVPs, app-side (R9).
 *
 * Default: a row in `fs_rsvp` and nothing else. No public record; the only endpoint that
 * ever enumerates who RSVP'd is `GET /api/events/:id/rsvps`, the host/steward-only
 * roster (`http/routes/events.ts`, gated by `lib/events.ts#canViewRoster`) — `rsvpDidsFor`
 * below is for the notification fan-out only, never for any OTHER response body.
 *
 * Opt-in: `alsoPublicRecord` additionally writes `community.lexicon.calendar.rsvp` into
 * the MEMBER'S OWN repo (never the school's), which is the only way the protocol ever
 * learns that this person is going.
 *
 * WAITLIST: a caller never requests `'waitlisted'` directly — the route assigns it
 * instead of `'going'` when the event has a `capacity` and it is already met
 * (`resolveGoingOrWaitlist`), ordered by `createdAt`. A departure (cancelling, or
 * switching away from `'going'`) calls `promoteFromWaitlist`, which promotes the
 * earliest-by-`createdAt` waitlisted row — first come, first served, same ordering both
 * ways.
 */
import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { rsvp } from '../db/schema.js'
import { rowId } from './ids.js'

export type RsvpStatus = 'going' | 'interested' | 'notgoing' | 'waitlisted'
/** Statuses a CALLER may request. `'waitlisted'` is server-assigned only — see above. */
export const RSVP_STATUSES: Array<'going' | 'interested' | 'notgoing'> = ['going', 'interested', 'notgoing']

export interface UpsertRsvpInput {
  eventUri: string
  did: string
  status: RsvpStatus
  alsoPublicRecord?: boolean
  publicRecordUri?: string | null
}

export async function upsertRsvp(input: UpsertRsvpInput): Promise<{ id: string }> {
  const id = rowId()
  const now = new Date()
  const rows = await getDb()
    .insert(rsvp)
    .values({
      id,
      eventUri: input.eventUri,
      did: input.did,
      status: input.status,
      alsoPublicRecord: input.alsoPublicRecord ?? false,
      publicRecordUri: input.publicRecordUri ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [rsvp.eventUri, rsvp.did],
      set: {
        status: input.status,
        alsoPublicRecord: input.alsoPublicRecord ?? false,
        publicRecordUri: input.publicRecordUri ?? null,
        updatedAt: now,
      },
    })
    .returning({ id: rsvp.id })
  return { id: rows[0]?.id ?? id }
}

export async function deleteRsvp(
  eventUri: string,
  did: string,
): Promise<{ publicRecordUri: string | null; wasGoing: boolean } | null> {
  const rows = await getDb()
    .delete(rsvp)
    .where(and(eq(rsvp.eventUri, eventUri), eq(rsvp.did, did)))
    .returning({ publicRecordUri: rsvp.publicRecordUri, status: rsvp.status })
  const row = rows[0]
  return row ? { publicRecordUri: row.publicRecordUri, wasGoing: row.status === 'going' } : null
}

export async function myRsvp(eventUri: string, did: string) {
  const rows = await getDb()
    .select()
    .from(rsvp)
    .where(and(eq(rsvp.eventUri, eventUri), eq(rsvp.did, did)))
    .limit(1)
  return rows[0] ?? null
}

/** INTERNAL ONLY. Used by the notification fan-out; never serialized to a response. */
export async function rsvpDidsFor(eventUri: string, statuses: RsvpStatus[] = ['going', 'interested']): Promise<string[]> {
  const rows = await getDb()
    .select({ did: rsvp.did })
    .from(rsvp)
    .where(and(eq(rsvp.eventUri, eventUri), inArray(rsvp.status, statuses)))
  return rows.map((r) => r.did)
}

export async function rsvpCounts(eventUri: string): Promise<Record<RsvpStatus, number>> {
  const rows = await getDb().select({ status: rsvp.status }).from(rsvp).where(eq(rsvp.eventUri, eventUri))
  const out: Record<RsvpStatus, number> = { going: 0, interested: 0, notgoing: 0, waitlisted: 0 }
  for (const r of rows) {
    if (r.status === 'going' || r.status === 'interested' || r.status === 'notgoing' || r.status === 'waitlisted') {
      out[r.status]++
    }
  }
  return out
}

/** My own RSVPs, for `/api/me`. A member may always see their own rows. */
export async function myRsvps(did: string) {
  return getDb().select().from(rsvp).where(eq(rsvp.did, did))
}

/** How many `'going'` rows an event currently has, excluding one DID's own (so a member
 * re-confirming their own existing spot is never counted against themselves). */
export async function goingCount(eventUri: string, excludeDid?: string): Promise<number> {
  const rows = await getDb()
    .select({ did: rsvp.did })
    .from(rsvp)
    .where(and(eq(rsvp.eventUri, eventUri), eq(rsvp.status, 'going' satisfies RsvpStatus)))
  return rows.filter((r) => r.did !== excludeDid).length
}

/**
 * Decide whether a fresh `'going'` request gets the spot or the waitlist. `capacity`
 * undefined/null means uncapped — always `'going'`. Pure arithmetic over one COUNT
 * query, so the ordering promise ("first come, first served") reduces to "whoever's
 * `goingCount` read landed first wins a race" — acceptable for a community class sign-up,
 * not a ticketing system with adversarial demand.
 */
export async function resolveGoingOrWaitlist(
  eventUri: string,
  did: string,
  capacity: number | undefined,
): Promise<'going' | 'waitlisted'> {
  if (capacity == null) return 'going'
  const count = await goingCount(eventUri, did)
  return count < capacity ? 'going' : 'waitlisted'
}

/**
 * A spot opened up: promote the earliest-by-`createdAt` waitlisted row to `'going'`.
 * Returns the promoted DID, or `null` when nobody was waiting. Callers decide whether to
 * notify them.
 *
 * FIX (review round 1, I1): SELECT-then-UPDATE was a lost-update race — two concurrent
 * promotions could both SELECT the same earliest row before either UPDATEd it, so only
 * one person actually got promoted even though two spots opened. The UPDATE now carries
 * `status = 'waitlisted'` in its OWN `WHERE` and is checked via `.returning()`: if
 * another promotion already claimed that exact row between our SELECT and UPDATE, we
 * get zero rows back and retry against the next-earliest one instead of returning a
 * stale result.
 */
export async function promoteFromWaitlist(eventUri: string): Promise<{ did: string } | null> {
  const db = getDb()
  for (let attempt = 0; attempt < 5; attempt++) {
    const [earliest] = await db
      .select({ id: rsvp.id })
      .from(rsvp)
      .where(and(eq(rsvp.eventUri, eventUri), eq(rsvp.status, 'waitlisted' satisfies RsvpStatus)))
      .orderBy(asc(rsvp.createdAt))
      .limit(1)
    if (!earliest) return null
    const promoted = await db
      .update(rsvp)
      .set({ status: 'going', updatedAt: new Date() })
      .where(and(eq(rsvp.id, earliest.id), eq(rsvp.status, 'waitlisted' satisfies RsvpStatus)))
      .returning({ did: rsvp.did })
    if (promoted[0]) return { did: promoted[0].did }
    // Someone else promoted (or otherwise changed) this exact row first — retry against
    // whichever row is now earliest.
  }
  return null
}

/** 1-based position in the waitlist queue, or `null` if this DID is not waitlisted. */
export async function waitlistPosition(eventUri: string, did: string): Promise<number | null> {
  const mine = await myRsvp(eventUri, did)
  if (!mine || mine.status !== 'waitlisted') return null
  const ahead = await getDb()
    .select({ id: rsvp.id })
    .from(rsvp)
    .where(and(eq(rsvp.eventUri, eventUri), eq(rsvp.status, 'waitlisted' satisfies RsvpStatus), lt(rsvp.createdAt, mine.createdAt)))
  return ahead.length + 1
}

/**
 * The roster — `did`, `status`, `createdAt` for every RSVP on an event, registration
 * order. ONLY reachable through `GET /api/events/:id/rsvps` (host/steward-gated by
 * `lib/events.ts#canViewRoster`) — never returned from any other route.
 */
export async function rsvpRoster(eventUri: string): Promise<Array<{ did: string; status: RsvpStatus; createdAt: Date }>> {
  const rows = await getDb()
    .select({ did: rsvp.did, status: rsvp.status, createdAt: rsvp.createdAt })
    .from(rsvp)
    .where(eq(rsvp.eventUri, eventUri))
    .orderBy(asc(rsvp.createdAt))
  return rows.map((r) => ({ did: r.did, status: r.status as RsvpStatus, createdAt: r.createdAt }))
}
