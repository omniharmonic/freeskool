/**
 * COMPATIBILITY SHIM. The school actor moved to `lib/school-actors.ts` (plural) when it
 * became a REGISTRY — one port per school, credentials from `fs_school_credential` — in
 * the federation phase (MS §5). This file is what the suites that inject a fake port
 * import; everything in `src/` uses `school-actors.js` directly.
 *
 * Nothing lives here. Adding anything here would be adding a second path to the school's
 * credential, which is the one thing this module has never allowed (R3 invariant 1).
 */
export {
  PostgresAuditSink,
  actorFor,
  asDid,
  credentialFor,
  evictAllSchoolActors,
  evictSchoolActor,
  schoolActor,
  schoolDid,
  setSchoolActor,
} from './school-actors.js'
export type { SchoolCredential } from './school-actors.js'
