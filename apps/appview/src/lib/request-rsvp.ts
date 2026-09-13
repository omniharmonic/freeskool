/**
 * "I'm interested" on a needs-board request — app-side (R9: no public roster of who
 * wants a class), mirroring the shape of `lib/rsvp.ts`. The count this produces is what
 * a request's own `threshold` is checked against before a host may claim it.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { requestRsvp } from '../db/schema.js'

export interface ToggleResult {
  interested: boolean
  count: number
}

/** Toggles the viewer's interest; returns the new state and the total count. Never a roster. */
export async function toggleInterest(requestUri: string, did: string): Promise<ToggleResult> {
  const db = getDb()
  const existing = await db
    .select({ did: requestRsvp.did })
    .from(requestRsvp)
    .where(and(eq(requestRsvp.requestUri, requestUri), eq(requestRsvp.did, did)))
    .limit(1)

  if (existing.length > 0) {
    await db.delete(requestRsvp).where(and(eq(requestRsvp.requestUri, requestUri), eq(requestRsvp.did, did)))
    return { interested: false, count: await countInterested(requestUri) }
  }
  await db.insert(requestRsvp).values({ requestUri, did }).onConflictDoNothing()
  return { interested: true, count: await countInterested(requestUri) }
}

export async function countInterested(requestUri: string): Promise<number> {
  const rows = await getDb().select({ did: requestRsvp.did }).from(requestRsvp).where(eq(requestRsvp.requestUri, requestUri))
  return rows.length
}

export async function isInterested(requestUri: string, did: string): Promise<boolean> {
  const rows = await getDb()
    .select({ did: requestRsvp.did })
    .from(requestRsvp)
    .where(and(eq(requestRsvp.requestUri, requestUri), eq(requestRsvp.did, did)))
    .limit(1)
  return rows.length > 0
}

/** A request with no threshold is always claimable; otherwise interest must meet it. */
export function meetsThreshold(count: number, threshold: number | undefined): boolean {
  if (typeof threshold !== 'number') return true
  return count >= threshold
}
