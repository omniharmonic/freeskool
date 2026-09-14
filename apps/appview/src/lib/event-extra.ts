/**
 * Everything a host wrote for the people who are COMING to their class, app-side.
 *
 * `materials` / `suppliesNote` (task-5 spec gap) have no home on our ASSUMED
 * `coop.lexicon.event.config` shape (`lexicons/coop.ts`). `attendeeNotes` and
 * `meetingLink` (task 19c) have one on `community.lexicon.calendar.event` — `description`
 * and `uris` — and that is exactly the problem: the PWA's class form promised both were
 * "shown after RSVP", and then wrote them into a world-readable record in the host's own
 * repo. They live here instead, and `http/visibility.ts` reveals them through the SAME
 * gate as the precise location (host, steward, RSVP'd, attended).
 *
 * `setEventExtra` always writes the FULL resolved value — callers (`lib/events.ts`'s
 * create/update) do the "omit means leave alone" merge against the existing row
 * themselves, the same convention every other field in that file already follows.
 */
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { eventExtra } from '../db/schema.js'

export interface EventExtra {
  materials: string[]
  suppliesNote?: string
  /** Shown only to the host, a steward, or someone who has RSVP'd. */
  attendeeNotes?: string
  /** Shown only to the host, a steward, or someone who has RSVP'd. */
  meetingLink?: string
  /**
   * Why the host called the class off. Shown to EVERYONE who can see the class — a
   * cancellation nobody can read the reason for sends people to a locked door — but it
   * never reaches a record: the public record says `status: #cancelled` and no more.
   */
  cancelReason?: string
}

export async function getEventExtra(eventUri: string): Promise<EventExtra> {
  const rows = await getDb().select().from(eventExtra).where(eq(eventExtra.eventUri, eventUri)).limit(1)
  const row = rows[0]
  return {
    materials: Array.isArray(row?.materials) ? (row.materials as string[]) : [],
    ...(row?.suppliesNote ? { suppliesNote: row.suppliesNote } : {}),
    ...(row?.attendeeNotes ? { attendeeNotes: row.attendeeNotes } : {}),
    ...(row?.meetingLink ? { meetingLink: row.meetingLink } : {}),
    ...(row?.cancelReason ? { cancelReason: row.cancelReason } : {}),
  }
}

/** Writes the FULL resolved row — anything absent from `value` is CLEARED, not kept. */
export async function setEventExtra(eventUri: string, value: EventExtra): Promise<void> {
  const now = new Date()
  const row = {
    materials: value.materials,
    suppliesNote: value.suppliesNote ?? null,
    attendeeNotes: value.attendeeNotes ?? null,
    meetingLink: value.meetingLink ?? null,
    cancelReason: value.cancelReason ?? null,
  }
  await getDb()
    .insert(eventExtra)
    .values({ eventUri, ...row, updatedAt: now })
    .onConflictDoUpdate({ target: eventExtra.eventUri, set: { ...row, updatedAt: now } })
}
