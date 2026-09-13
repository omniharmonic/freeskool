/**
 * RSVPs, app-side (R9).
 *
 * Default: a row in `fs_rsvp` and nothing else. No public record, and no endpoint
 * anywhere enumerates who RSVP'd — `rsvpDidsFor` is for the notification fan-out only,
 * never for a response body.
 *
 * Opt-in: `alsoPublicRecord` additionally writes `community.lexicon.calendar.rsvp` into
 * the MEMBER'S OWN repo (never the school's), which is the only way the protocol ever
 * learns that this person is going.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { rsvp } from '../db/schema.js'
import { rowId } from './ids.js'

export type RsvpStatus = 'going' | 'interested' | 'notgoing'
export const RSVP_STATUSES: RsvpStatus[] = ['going', 'interested', 'notgoing']

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

export async function deleteRsvp(eventUri: string, did: string): Promise<{ publicRecordUri: string | null } | null> {
  const rows = await getDb()
    .delete(rsvp)
    .where(and(eq(rsvp.eventUri, eventUri), eq(rsvp.did, did)))
    .returning({ publicRecordUri: rsvp.publicRecordUri })
  return rows[0] ?? null
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
  const out: Record<RsvpStatus, number> = { going: 0, interested: 0, notgoing: 0 }
  for (const r of rows) {
    if (r.status === 'going' || r.status === 'interested' || r.status === 'notgoing') out[r.status]++
  }
  return out
}

/** My own RSVPs, for `/api/me`. A member may always see their own rows. */
export async function myRsvps(did: string) {
  return getDb().select().from(rsvp).where(eq(rsvp.did, did))
}
