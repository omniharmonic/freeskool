/**
 * Create a school account on the PDS and write its founding records.
 *
 *   pnpm --filter @freeschool/appview create-school
 *
 * THE FLOW ITSELF LIVES IN `src/lib/schools.ts#createSchool` (MS §8): this script and
 * `POST /api/schools` are two doors onto the same code, and ruling 1 (`SCHOOL_CREATION=
 * closed`) means this one is the door an operator actually uses. What stays here is the
 * CLI's environment contract and what it prints.
 *
 * Idempotent in the same way it always was: if `SCHOOL_HANDLE` already resolves on the
 * PDS, set `SCHOOL_ACCOUNT_PASSWORD` to that account's password and the existing DID is
 * adopted — a fresh app password is minted and the records are rewritten. Without it, an
 * existing handle is refused rather than silently forked.
 *
 * Env: `SCHOOL_HANDLE` (the handle, whose first label is the school's label),
 * `SCHOOL_NAME`, `SCHOOL_REGION`, `SCHOOL_EMAIL`, `FOUNDER_DID`,
 * `SCHOOL_ACCOUNT_PASSWORD` (adoption only).
 *
 * The credential is now WRAPPED INTO `fs_school_credential` as well as printed: a new
 * deployment no longer needs the `.env` paste at all, and the printed lines are there for
 * the legacy single-school path and for a human who wants a copy.
 */
import { config } from '../src/config.js'
import { createSchool as createSchoolLib, type CreateSchoolResult } from '../src/lib/schools.js'
import { getDb, closeDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { isMain } from '../src/lib/is-main.js'

export type { CreateSchoolResult }

/**
 * The label and handle domain both come from `SCHOOL_HANDLE` (`boulder.freeskool.xyz` →
 * label `boulder`, domain `freeskool.xyz`), falling back to `<label>.<PDS_HANDLE_DOMAIN>`
 * the way this script always built it.
 */
function splitHandle(handle: string): { label: string; handleDomain: string } {
  const [label, ...rest] = handle.trim().toLowerCase().split('.')
  return { label: label ?? '', handleDomain: rest.join('.') }
}

export async function createSchool(options?: {
  name?: string
  region?: string
  email?: string
  stewardDid?: string
}): Promise<CreateSchoolResult> {
  const c = config()
  const handle = c.SCHOOL_HANDLE || `boulder.${c.handleDomain}`
  const { label, handleDomain } = splitHandle(handle)

  // `fs_*` may not have been migrated yet at this point in the documented run order
  // (README step 3 runs before step 4's `db:migrate`), so this stays defensive.
  await runMigrations().catch(() => {})

  return createSchoolLib({
    label,
    name: options?.name ?? 'Boulder Free School',
    city: options?.region ?? 'Boulder, Colorado',
    handleDomain: handleDomain || c.handleDomain,
    email: options?.email,
    founderDid: options?.stewardDid,
    operator: 'script:create-school',
    accountPassword: process.env.SCHOOL_ACCOUNT_PASSWORD || undefined,
    db: getDb(),
  })
}

if (isMain(import.meta.url)) {
  const result = await createSchool({
    name: process.env.SCHOOL_NAME || undefined,
    region: process.env.SCHOOL_REGION || undefined,
    email: process.env.SCHOOL_EMAIL || undefined,
    stewardDid: process.env.FOUNDER_DID,
  })
  console.log(result.reused ? '\nReused the existing school account.\n' : '\nCreated the school account.\n')
  console.log('Paste these into .env:\n')
  console.log(`SCHOOL_DID=${result.did}`)
  console.log(`SCHOOL_HANDLE=${result.handle}`)
  console.log(`SCHOOL_APP_PASSWORD=${result.appPassword}`)
  console.log(`\nschool record: ${result.schoolUri}`)
  console.log(`policy record: ${result.policyUri}`)
  console.log(`served at:     https://${result.host}\n`)
  await closeDb()
}
