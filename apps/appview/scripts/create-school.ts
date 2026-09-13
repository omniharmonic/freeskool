/**
 * Create the school account on the local PDS and write its founding records.
 *
 *   pnpm --filter @freeschool/appview create-school
 *
 * Idempotent: if `SCHOOL_HANDLE` already resolves, it reuses that DID and only creates a
 * fresh app password. Prints the three lines to paste into `.env`.
 *
 * What it writes, as the school:
 *   freeschool.draft.school   rkey `self`  — name, region, handleDomain, peers, policy ref
 *   freeschool.draft.policy   rkey <tid>   — a default policy with Lex's open thresholds
 *
 * These two are written with the school's own session DIRECTLY rather than through
 * `SchoolActorPort`, and that is the one deliberate exception in the codebase: the port
 * authorizes against the school's policy record, which does not exist yet. Bootstrap is
 * the only moment that is true. Everything after this goes through the port.
 */
import { AtpAgent } from '@atproto/api'
import { config } from '../src/config.js'
import { createAccount, createInviteCode, resolveHandle } from '../src/lib/pds.js'
import { randomPassword } from '../src/lib/crypto.js'
import { tid } from '../src/lib/ids.js'
import { NSID } from '../src/lexicons/nsids.js'
import { defaultThresholds } from '@freeschool/shared'
import { getDb, closeDb } from '../src/db/index.js'
import { member, steward } from '../src/db/schema.js'
import { runMigrations } from '../src/db/migrate.js'
import { seedSkillTiers } from '../src/lib/skill-tiers.js'
import { isMain } from '../src/lib/is-main.js'
import { describeError, log } from '../src/lib/logging.js'

export interface CreateSchoolResult {
  did: string
  handle: string
  appPassword: string
  schoolUri: string
  policyUri: string
  reused: boolean
}

const DEFAULT_POLICY_TEXT = `Free School is free. Anyone can teach, anyone can learn, nobody pays.

If you say you are part of Free School, you are part of Free School. Hosting is open from
day one: you do not need permission, a credential, or a vouch to offer a class.

What we ask:
  - Say what you actually know. "I am still learning this too" is a fine thing to write.
  - Show up, or tell people you cannot.
  - Do not use a class to sell, recruit, or proselytise.
  - Somebody's home is not a public address. Share a location only with people who are coming.

Stewards can remove a listing from the calendar, and two of them must agree to do it. They
cannot edit or delete anything in your repository — what you wrote stays yours.`

export async function createSchool(options?: {
  name?: string
  region?: string
  email?: string
  stewardDid?: string
}): Promise<CreateSchoolResult> {
  const c = config()
  const handle = c.SCHOOL_HANDLE || `boulder.${c.handleDomain}`
  const name = options?.name ?? 'Boulder Free School'
  const region = options?.region ?? 'Boulder, Colorado'
  const password = randomPassword(24)

  let did = await resolveHandle(handle)
  let reused = Boolean(did)

  if (!did) {
    const code = await createInviteCode(1)
    const account = await createAccount({
      // The PDS rejects unroutable email domains, so the default is a real reserved one.
      email: options?.email ?? `${handle.replace(/\./g, '-')}@example.org`,
      handle,
      password,
      inviteCode: code,
    })
    did = account.did
    reused = false
  }

  // An app password is what the AppView actually holds (never the account password).
  const agent = new AtpAgent({ service: c.PDS_URL })
  await agent.login({ identifier: handle, password: reused ? requireExistingPassword() : password })
  const appPw = await agent.com.atproto.server.createAppPassword({ name: `appview-${Date.now()}` })

  const now = new Date().toISOString()
  const policyRkey = tid()
  const policy = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: NSID.policy,
    rkey: policyRkey,
    record: {
      $type: NSID.policy,
      title: `${name} — how this works`,
      text: DEFAULT_POLICY_TEXT,
      version: '1',
      effectiveAt: now,
      thresholds: defaultThresholds,
      createdAt: now,
    },
    validate: false,
  })

  const school = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: NSID.school,
    rkey: 'self',
    record: {
      $type: NSID.school,
      name,
      description: 'A free, open skill-sharing school. Anyone can teach, anyone can learn.',
      region,
      policy: policy.data.uri,
      handleDomain: c.handleDomain,
      peers: [],
      tags: ['skillshare', 'free-school'],
      createdAt: now,
    },
    validate: false,
  })

  // `fs_*` may not have been migrated yet at this point in the documented run order
  // (README step 3 runs before step 4's `db:migrate`), so this is defensive everywhere
  // it is needed, not just for the steward row.
  await runMigrations().catch(() => {})

  // The school DID (and the steward, if any) are `isOwnMember` facts too — they never go
  // through `createSession` (the school is never a browser session), so they need a
  // durable `fs_member` row written explicitly here.
  const seenAt = new Date()
  await getDb()
    .insert(member)
    .values({ did, door: 'custodial', firstSeenAt: seenAt, lastSeenAt: seenAt })
    .onConflictDoUpdate({ target: member.did, set: { lastSeenAt: seenAt } })
    .catch((err) => log.warn('could not record the school as fs_member', { detail: describeError(err) }))

  // The founder is the bootstrap steward: the one role that cannot be derived.
  if (options?.stewardDid) {
    await getDb()
      .insert(steward)
      .values({ did: options.stewardDid, schoolDid: did, appointedAt: new Date() })
      .onConflictDoNothing()
    await getDb()
      .insert(member)
      .values({ did: options.stewardDid, door: 'custodial', firstSeenAt: seenAt, lastSeenAt: seenAt })
      .onConflictDoUpdate({ target: member.did, set: { lastSeenAt: seenAt } })
      .catch((err) => log.warn('could not record the steward as fs_member', { detail: describeError(err) }))
  }

  // A fresh deploy enforces the Tier B gate from the moment the school exists.
  await seedSkillTiers().catch((err) => log.warn('skill-tier seed failed during create-school', { detail: describeError(err) }))

  return {
    did,
    handle,
    appPassword: appPw.data.password,
    schoolUri: school.data.uri,
    policyUri: policy.data.uri,
    reused,
  }
}

function requireExistingPassword(): string {
  const pw = process.env.SCHOOL_ACCOUNT_PASSWORD
  if (!pw) {
    throw new Error(
      `${config().SCHOOL_HANDLE || 'the school handle'} already exists on the PDS. ` +
        'Set SCHOOL_ACCOUNT_PASSWORD to its account password to mint a new app password, ' +
        'or delete the account and re-run.',
    )
  }
  return pw
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
  console.log(`policy record: ${result.policyUri}\n`)
  await closeDb()
}
