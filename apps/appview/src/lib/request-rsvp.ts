/**
 * "I'm interested" on a needs-board request — app-side (R9: no public roster of who
 * wants a class), mirroring the shape of `lib/rsvp.ts`. The count this produces is what
 * a request's own `threshold` is checked against before a host may claim it — and that
 * count is PER SCHOOL (MS §4): a threshold has to be met within one city, not by adding
 * up interest in two.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { requestRsvp } from '../db/schema.js'
import { legacySchoolDid } from './schools.js'
import { schoolScope } from './school-scope.js'

export interface ToggleResult {
  interested: boolean
  count: number
}

/** Toggles the viewer's interest; returns the new state and the total count. Never a roster. */
export async function toggleInterest(
  requestUri: string,
  did: string,
  schoolDid = legacySchoolDid(),
): Promise<ToggleResult> {
  const db = getDb()
  const mine = and(
    eq(requestRsvp.requestUri, requestUri),
    eq(requestRsvp.did, did),
    schoolScope(requestRsvp.schoolDid, schoolDid),
  )
  const existing = await db.select({ did: requestRsvp.did }).from(requestRsvp).where(mine).limit(1)

  if (existing.length > 0) {
    await db.delete(requestRsvp).where(mine)
    return { interested: false, count: await countInterested(requestUri, schoolDid) }
  }
  await db.insert(requestRsvp).values({ requestUri, did, schoolDid }).onConflictDoNothing()
  return { interested: true, count: await countInterested(requestUri, schoolDid) }
}

export async function countInterested(requestUri: string, schoolDid = legacySchoolDid()): Promise<number> {
  const rows = await getDb()
    .select({ did: requestRsvp.did })
    .from(requestRsvp)
    .where(and(eq(requestRsvp.requestUri, requestUri), schoolScope(requestRsvp.schoolDid, schoolDid)))
  return rows.length
}

export async function isInterested(requestUri: string, did: string, schoolDid = legacySchoolDid()): Promise<boolean> {
  const rows = await getDb()
    .select({ did: requestRsvp.did })
    .from(requestRsvp)
    .where(
      and(
        eq(requestRsvp.requestUri, requestUri),
        eq(requestRsvp.did, did),
        schoolScope(requestRsvp.schoolDid, schoolDid),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/** A request with no threshold is always claimable; otherwise interest must meet it. */
export function meetsThreshold(count: number, threshold: number | undefined): boolean {
  if (typeof threshold !== 'number') return true
  return count >= threshold
}
