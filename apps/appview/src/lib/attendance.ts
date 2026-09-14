/**
 * The host attests participation. App-side only: `freeschool.draft.attendance` exists as
 * a lexicon, but writing one publishes "this person was in this room", which is exactly
 * what R9 says not to do by default.
 *
 * Factored out of `http/routes/events.ts`'s `POST /events/:id/attendance` so the route
 * and `scripts/seed-demo.ts` share one implementation of the tally rules below.
 */
import { and, eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { attendance } from '../db/schema.js'
import { rowId } from './ids.js'
import { bumpTally } from './roles.js'

export type AttendeeRole = 'attendee' | 'assistant' | 'co-host'

export interface AttendeeInput {
  did: string
  participated: boolean
  role: AttendeeRole
}

export interface RecordAttendanceInput {
  eventUri: string
  /** The host doing the attesting; never attests themselves. */
  hostDid: string
  attendees: AttendeeInput[]
  /** The class's own start, stored on each row so retention can collapse by age. */
  eventStartsAt?: Date | null
}

/**
 * A5: THE TALLY FOLLOWS THE TRANSITION, NOT THE WRITE.
 *
 * The upsert is idempotent; the tally bump was not. A host who opened the attendance
 * sheet, saved, noticed one more name and saved again gave everybody on the list a
 * second attended-class credit — and the sheet is precisely the screen people re-save.
 * `fs_attendance` is collapsed to counts after 90 days, so the tally is the only
 * surviving evidence and the inflation was permanent.
 *
 * So: read the row's current state first, then bump only when `participated` genuinely
 * flips. "Currently participated" means `participated AND NOT voided`.
 *
 * R3: A VOID IS A STEWARD DECISION, NOT THE HOST'S TO REVERSE. `voidedAt` is set only by
 * the steward-approved `void-attendance` action (`http/routes/admin.ts`). This path never
 * clears it — it is left out of `onConflictDoUpdate`'s `set` entirely — and a voided row
 * never counts towards the tally from here even if the host's sheet still shows the
 * attendee ticked: `wasVoided` short-circuits the bump in both directions, so re-saving
 * the sheet can neither re-credit a voided attendance nor double-debit it.
 *
 * `recorded` is who is on the sheet as having taken part (stable across re-saves);
 * `tallyChanged` is what this particular save actually moved.
 */
export async function recordAttendance(input: RecordAttendanceInput): Promise<{ recorded: number; tallyChanged: number }> {
  const db = getDb()
  let recorded = 0
  let tallyChanged = 0

  for (const a of input.attendees) {
    if (a.did === input.hostDid) continue // a host does not attest themselves

    const existing = await db
      .select({ participated: attendance.participated, voidedAt: attendance.voidedAt })
      .from(attendance)
      .where(and(eq(attendance.eventUri, input.eventUri), eq(attendance.attendeeDid, a.did)))
      .limit(1)
    const wasVoided = existing.length > 0 && existing[0]!.voidedAt !== null
    const wasCounted = existing.length > 0 && existing[0]!.participated && !wasVoided

    await db
      .insert(attendance)
      .values({
        id: rowId(),
        eventUri: input.eventUri,
        attendeeDid: a.did,
        attestedByDid: input.hostDid,
        participated: a.participated,
        role: a.role,
        eventStartsAt: input.eventStartsAt ?? null,
      })
      .onConflictDoUpdate({
        target: [attendance.eventUri, attendance.attendeeDid],
        // `voidedAt` deliberately absent: the host path never un-voids a row.
        set: { participated: a.participated, role: a.role, attestedByDid: input.hostDid },
      })

    if (wasVoided) {
      // No tally movement for a voided row, regardless of what the sheet says now.
    } else if (a.participated && !wasCounted) {
      await bumpTally(a.did, { attendedConfirmed: 1 })
      tallyChanged++
    } else if (!a.participated && wasCounted) {
      // The host un-ticked somebody. Take the credit back, floored at 0 by `bumpTally`.
      await bumpTally(a.did, { attendedConfirmed: -1 })
      tallyChanged--
    }
    if (a.participated) recorded++
  }

  return { recorded, tallyChanged }
}
