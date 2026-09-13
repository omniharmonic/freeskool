/**
 * Appoint a bootstrap steward for an EXISTING school.
 *
 *   STEWARD_DID=did:plc:... pnpm --filter @freeschool/appview appoint-steward
 *
 * Steward is the one role that cannot be derived from records (`src/lib/roles.ts` reads
 * `fs_steward` directly), so it has to start somewhere. `scripts/create-school.ts` does it
 * with `FOUNDER_DID` at bootstrap — but the founder usually does not have a DID yet at that
 * point: they sign up through the app's primary door AFTER the school exists. This is that
 * second moment, and it is the only other way in: there is no endpoint that grants the first
 * steward (`POST /api/admin/moderation` with `set-role`, and the hand-off flow, both already
 * require a steward), which is the point — the first one is an operator action on the host.
 *
 * Idempotent. Prints a truncated DID only (R9: no DIDs in output).
 */
import { config } from '../src/config.js'
import { getDb, closeDb } from '../src/db/index.js'
import { member, steward } from '../src/db/schema.js'
import { runMigrations } from '../src/db/migrate.js'
import { isMain } from '../src/lib/is-main.js'

export async function appointSteward(did: string, schoolDid = config().SCHOOL_DID): Promise<void> {
  if (!did.startsWith('did:')) throw new Error('STEWARD_DID must be a DID')
  if (!schoolDid) throw new Error('SCHOOL_DID is not set; run create-school first')
  const db = getDb()
  await db.insert(steward).values({ did, schoolDid, appointedAt: new Date() }).onConflictDoNothing()
  // `roleOf` also wants the steward to be a known member (`isOwnMember`), which is true for
  // anyone who signed in, but not for a DID appointed before their first session.
  const seenAt = new Date()
  await db
    .insert(member)
    .values({ did, door: 'custodial', firstSeenAt: seenAt, lastSeenAt: seenAt })
    .onConflictDoUpdate({ target: member.did, set: { lastSeenAt: seenAt } })
}

if (isMain(import.meta.url)) {
  const did = process.env.STEWARD_DID ?? ''
  await runMigrations().catch(() => {})
  await appointSteward(did)
  console.log(`appointed ${did.slice(0, 12)}… as a steward of this school`)
  await closeDb()
}
