/**
 * The one predicate every per-school query filters by, and the one value every
 * per-school write stamps.
 *
 * WHY THIS IS NOT JUST `eq(col, schoolDid)`. `school_did` was added to sixteen tables as
 * `NOT NULL DEFAULT ''` (Task 2, MS §9 A–C), and `''` means "written before this
 * deployment knew there was more than one school". `scripts/backfill-school.ts` replaces
 * those with the legacy DID, but a deployment that has not run it yet — and every unit
 * suite, which inserts rows directly — still has `''` rows that are, in fact, the legacy
 * school's.
 *
 * So: an unstamped row belongs to the LEGACY school and to no other. That is the same
 * rule `fs_event_school` states for an absent row (see its doc comment), and it is safe
 * in the direction that matters: a second school can never see an unstamped row, because
 * the widened predicate is only ever built for the legacy school itself.
 *
 * Use `schoolScope(column, schoolDid)` in every `where`, and `stampSchool(schoolDid)`'s
 * value in every insert. A scoped `db.select()` with neither is a tenancy bug — see the
 * lint rule MS §11 asks for.
 */
import { eq, or, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { legacySchoolDid } from './schools.js'

/**
 * `school_did = <did>`, widened to include the unstamped `''` rows when — and only when —
 * `<did>` IS the legacy school.
 */
export function schoolScope(column: AnyPgColumn, schoolDid: string): SQL {
  if (schoolDid && schoolDid === legacySchoolDid()) {
    return or(eq(column, schoolDid), eq(column, ''))!
  }
  // An empty `schoolDid` (a deployment with no school configured) matches the unstamped
  // rows and nothing else, which is exactly what "no school yet" should see.
  return eq(column, schoolDid)
}

/**
 * The value to write. Always the school's real DID — new rows are never unstamped, which
 * is what lets the `''` widening above shrink to nothing once the backfill has run.
 */
export function stampSchool(schoolDid: string): string {
  return schoolDid
}
