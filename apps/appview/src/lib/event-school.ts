/**
 * WHICH SCHOOL IS THIS CLASS ON THE CALENDAR OF? — `fs_event_school` (MS §4).
 *
 * Until now calendar membership was decided by AUTHORSHIP (`http/visibility.ts#
 * calendarInclusion` over `lib/roles.ts#isOwnMember`), which worked because "our member"
 * and "our school" were the same set. With several schools a host may belong to two, so
 * authorship no longer identifies the calendar: the school is recorded at creation time,
 * from the session's current school.
 *
 * THE EVENT RECORD IS NOT TOUCHED. Sidecar composition only (CLAUDE.md): no field is
 * added to the borrowed `community.lexicon.calendar.event`, and cross-listing to another
 * school stays a `coop.lexicon.event.listing` written by that other school (MS §7).
 *
 * AN ABSENT ROW MEANS THE LEGACY SCHOOL, never "no school" (Task 2's own note on the
 * table). Event records live in contrail's index, not in `fs_*`, so there is nothing to
 * back-fill: every class published before this table existed was Boulder's.
 *
 * WHY THIS RATHER THAN THE LISTING RECORDS. `coop.lexicon.event.listing` is curation for
 * PEERS — a class with no routing tag gets no listing at all and still belongs on its own
 * school's calendar (`lib/events.ts#routeListing`). Deciding the calendar from listings
 * would therefore drop exactly the untagged classes, and would cost one indexed sidecar
 * query per event. One app-side row keyed by the event URI is both cheaper and correct.
 */
import { eq, inArray } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { eventSchool } from '../db/schema.js'
import { legacySchoolDid } from './schools.js'

/** Record which school a class was created in. Called once, at creation. */
export async function stampEventSchool(eventUri: string, schoolDid: string, db: Db = getDb()): Promise<void> {
  if (!schoolDid) return
  await db.insert(eventSchool).values({ eventUri, schoolDid }).onConflictDoNothing()
}

/** The school this class belongs to. Absent row → the legacy school. */
export async function schoolOfEvent(eventUri: string, db: Db = getDb()): Promise<string> {
  const rows = await db
    .select({ schoolDid: eventSchool.schoolDid })
    .from(eventSchool)
    .where(eq(eventSchool.eventUri, eventUri))
    .limit(1)
  return rows[0]?.schoolDid ?? legacySchoolDid()
}

/** Batched form, for a calendar page: one query, not one per event. */
export async function schoolsOfEvents(eventUris: string[], db: Db = getDb()): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(eventUris)]
  if (unique.length === 0) return out
  const rows = await db
    .select({ eventUri: eventSchool.eventUri, schoolDid: eventSchool.schoolDid })
    .from(eventSchool)
    .where(inArray(eventSchool.eventUri, unique))
  for (const r of rows) out.set(r.eventUri, r.schoolDid)
  const legacy = legacySchoolDid()
  for (const uri of unique) if (!out.has(uri)) out.set(uri, legacy)
  return out
}

/**
 * Is this class on `schoolDid`'s calendar? True also when the row is absent and this IS
 * the legacy school — the rule above, in the shape callers actually want.
 */
export async function eventBelongsTo(eventUri: string, schoolDid: string, db: Db = getDb()): Promise<boolean> {
  return (await schoolOfEvent(eventUri, db)) === schoolDid
}
