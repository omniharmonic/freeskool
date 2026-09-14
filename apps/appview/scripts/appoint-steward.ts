/**
 * Appoint a bootstrap steward for an EXISTING school.
 *
 *   STEWARD_DID=did:plc:... pnpm --filter @freeschool/appview appoint-steward
 *   STEWARD_DID=did:plc:... SCHOOL_DID=did:plc:... pnpm … appoint-steward   # a second city
 *
 * Steward is the one role that cannot be derived from records (`src/lib/roles.ts` reads
 * `fs_steward` directly), so it has to start somewhere. `createSchool` does it for the
 * founder at creation time (MS §8 step 5) — but the founder usually does not have a DID
 * yet at that point: they sign up through the app's primary door AFTER the school exists.
 * This is that second moment, and it is the only other way in: there is no endpoint that
 * grants the first steward (`POST /api/admin/moderation` with `set-role`, and the hand-off
 * flow, both already require a steward), which is the point — the first one is an operator
 * action on the host.
 *
 * The appointment itself lives in `src/lib/membership.ts#appointSteward`; this file is the
 * CLI around it. Idempotent. Prints a truncated DID only (R9: no DIDs in output).
 */
import { config } from '../src/config.js'
import { getDb, closeDb } from '../src/db/index.js'
import { appointSteward as appointStewardLib } from '../src/lib/membership.js'
import { runMigrations } from '../src/db/migrate.js'
import { isMain } from '../src/lib/is-main.js'

export async function appointSteward(did: string, schoolDid = config().SCHOOL_DID): Promise<void> {
  if (!did.startsWith('did:')) throw new Error('STEWARD_DID must be a DID')
  if (!schoolDid) throw new Error('SCHOOL_DID is not set; run create-school first')
  await appointStewardLib(did, schoolDid, getDb())
}

if (isMain(import.meta.url)) {
  const did = process.env.STEWARD_DID ?? ''
  await runMigrations().catch(() => {})
  await appointSteward(did)
  console.log(`appointed ${did.slice(0, 12)}… as a steward of this school`)
  await closeDb()
}
