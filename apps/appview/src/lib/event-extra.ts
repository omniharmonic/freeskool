/**
 * Materials and a supplies note for a class (task-5 spec gap). `coop.lexicon.event.config`
 * (our ASSUMED shape — `lexicons/coop.ts`) has no room for either field, so they live
 * app-side in `fs_event_extra`, one row per event, keyed by the event's own AT-URI.
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
}

export async function getEventExtra(eventUri: string): Promise<EventExtra> {
  const rows = await getDb().select().from(eventExtra).where(eq(eventExtra.eventUri, eventUri)).limit(1)
  const row = rows[0]
  return {
    materials: Array.isArray(row?.materials) ? (row.materials as string[]) : [],
    ...(row?.suppliesNote ? { suppliesNote: row.suppliesNote } : {}),
  }
}

export async function setEventExtra(eventUri: string, materials: string[], suppliesNote?: string): Promise<void> {
  const now = new Date()
  await getDb()
    .insert(eventExtra)
    .values({ eventUri, materials, suppliesNote: suppliesNote ?? null, updatedAt: now })
    .onConflictDoUpdate({
      target: eventExtra.eventUri,
      set: { materials, suppliesNote: suppliesNote ?? null, updatedAt: now },
    })
}
