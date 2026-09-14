/**
 * The multi-school schema (MS §4) and its backfill (MS §9 A–C).
 *
 * Three things are worth a test here and nothing else is:
 *   1. a FRESH database migrates — the whole migration chain, on an empty database, not
 *      just the increment that happens to be pending on this developer's machine;
 *   2. the backfill actually reaches every per-school table MS §4 names. This is asserted
 *      table by table, deliberately verbosely: a table silently left out of the sweep is
 *      exactly the bug that would let Boulder's rows look like nobody's rows once a
 *      second school exists;
 *   3. running it twice changes nothing — it will be run twice, because the deployment
 *      runbook runs it and the operator will run it again to check.
 *
 * Plus the one cryptographic claim: what goes into `fs_school_credential` comes back out
 * of `unwrapSecret` as the app password the environment held.
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool_test'
process.env.SCHOOL_DID = 'did:plc:backfill-school'
process.env.SCHOOL_HANDLE = 'boulder.freeskool.test'
process.env.SCHOOL_APP_PASSWORD = 'app-password-for-the-school'
process.env.WEB_PUBLIC_URL = 'https://freeskool.test'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { closeTestDb, DATABASE_URL, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createDb } from '../src/db/index.js'
import {
  attendance,
  attendanceRollup,
  attendanceTally,
  attestation,
  audit,
  feedback,
  handoff,
  invite,
  inviteLink,
  member,
  memberPrefs,
  moderationQueue,
  newsletterIssue,
  newsletterSubscription,
  notificationFeed,
  notificationOutbox,
  notificationSent,
  policyCache,
  requestRsvp,
  rsvp,
  school,
  schoolCredential,
  schoolDomain,
  membership,
  peer,
  skillProposal,
  steward,
} from '../src/db/schema.js'
import { unwrapSecret } from '../src/lib/crypto.js'
import { getSchool, listSchools, schoolByHost } from '../src/lib/schools.js'
import { backfillSchool, STAMPED_TABLES } from '../scripts/backfill-school.js'

const SCHOOL = 'did:plc:backfill-school'
const OTHER_SCHOOL = 'did:plc:some-other-school'
const MEMBER_A = 'did:plc:backfill-member-a'
const MEMBER_B = 'did:plc:backfill-member-b'
const EVENT = 'at://did:plc:host/community.lexicon.calendar.event/abc'

const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = path.resolve(here, '../drizzle')

/** Tables that already carried `school_did` before this phase: the sweep must not touch them. */
const PRE_EXISTING = ['fs_audit', 'fs_invite_link', 'fs_policy_cache', 'fs_steward']

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate(
    'fs_school',
    'fs_school_domain',
    'fs_school_credential',
    'fs_membership',
    'fs_member',
    'fs_member_prefs',
    ...STAMPED_TABLES,
  )
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('a fresh database migrates', () => {
  it('applies the whole chain to an empty database and lands the school tables', async () => {
    if (!available) return
    const url = new URL(DATABASE_URL)
    const name = `freeschool_migrate_${Date.now()}`
    const admin = new URL(url.toString())
    admin.pathname = '/postgres'
    const client = new pg.Client({ connectionString: admin.toString() })
    await client.connect()
    await client.query(`create database "${name}"`)
    const fresh = new URL(url.toString())
    fresh.pathname = `/${name}`
    const { db, pool } = createDb(fresh.toString())
    try {
      await migrate(db, { migrationsFolder: MIGRATIONS })
      const { rows } = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.tables where table_schema = 'public' and table_name like 'fs_%'`,
      )
      const tables = new Set(rows.map((r) => r.table_name))
      for (const t of ['fs_school', 'fs_school_domain', 'fs_membership', 'fs_school_credential', 'fs_event_school']) {
        expect(tables.has(t), `${t} should exist after a fresh migration`).toBe(true)
      }
      const { rows: columns } = await db.execute<{ table_name: string }>(
        sql`select table_name from information_schema.columns
            where table_schema = 'public' and column_name = 'school_did' and table_name like 'fs_%'`,
      )
      const scoped = new Set(columns.map((r) => r.table_name))
      for (const t of STAMPED_TABLES) {
        expect(scoped.has(t), `${t} should have a school_did column`).toBe(true)
      }
    } finally {
      await pool.end()
      await client.query(`drop database "${name}"`)
      await client.end()
    }
  })
})

describe('backfillSchool', () => {
  it('writes the school, its domains, its credential and its memberships', async () => {
    if (!available) return
    const seenAt = new Date('2026-01-02T03:04:05.000Z')
    await testDb()
      .insert(member)
      .values([
        { did: MEMBER_A, door: 'custodial', firstSeenAt: seenAt, lastSeenAt: seenAt },
        { did: MEMBER_B, door: 'oauth', firstSeenAt: seenAt, lastSeenAt: seenAt },
      ])
    // MEMBER_B opted OUT of the directory: the migration must not opt them back in.
    await testDb().insert(memberPrefs).values({ did: MEMBER_B, directoryListing: false })

    const result = await backfillSchool({ db: testDb() })
    expect(result.schoolDid).toBe(SCHOOL)
    expect(result.credential).toBe('imported')
    expect(result.memberships).toBe(2)

    const row = await getSchool(SCHOOL, testDb())
    expect(row?.label).toBe('boulder')
    expect(row?.handle).toBe('boulder.freeskool.test')
    expect(row?.creationState).toBe('active')
    expect(await listSchools(testDb())).toHaveLength(1)

    const domains = await testDb().select().from(schoolDomain)
    expect(domains.map((d) => [d.host, d.kind]).sort()).toEqual([
      ['boulder.freeskool.test', 'alias'],
      ['freeskool.test', 'canonical'],
    ])
    // The host lookup is what Task 3/4 route on, port and case included.
    expect((await schoolByHost('FreeSkool.test:443', testDb()))?.did).toBe(SCHOOL)
    expect(await schoolByHost('denver.freeskool.test', testDb())).toBeUndefined()

    const memberships = await testDb().select().from(membership)
    expect(memberships.map((m) => m.schoolDid)).toEqual([SCHOOL, SCHOOL])
    expect(memberships.find((m) => m.did === MEMBER_A)?.directoryListing).toBe(true)
    expect(memberships.find((m) => m.did === MEMBER_B)?.directoryListing).toBe(false)
    expect(memberships.find((m) => m.did === MEMBER_B)?.door).toBe('oauth')
    expect(memberships.find((m) => m.did === MEMBER_A)?.leftAt).toBeNull()
  })

  it('imports SCHOOL_APP_PASSWORD so unwrapSecret gives it back', async () => {
    if (!available) return
    await backfillSchool({ db: testDb() })
    const [cred] = await testDb().select().from(schoolCredential).where(eq(schoolCredential.schoolDid, SCHOOL))
    expect(cred?.keyVersion).toBe('v1')
    expect(cred?.appPasswordWrapped).toBeTruthy()
    expect(unwrapSecret({ keyVersion: cred!.keyVersion, blob: cred!.appPasswordWrapped! })).toBe(
      'app-password-for-the-school',
    )
  })

  it('stamps school_did on every per-school table MS §4 names', async () => {
    if (!available) return
    await seedOneRowPerTable()

    const result = await backfillSchool({ db: testDb() })

    for (const table of STAMPED_TABLES) {
      const expected = PRE_EXISTING.includes(table) ? 0 : 1
      expect(result.stamped[table], `${table} should have stamped ${expected} row(s)`).toBe(expected)
      const { rows } = await testDb().execute<{ school_did: string }>(
        sql`select school_did from ${sql.raw(table)}`,
      )
      expect(rows.length, `${table} should still hold its row`).toBe(1)
      const want = PRE_EXISTING.includes(table) ? OTHER_SCHOOL : SCHOOL
      expect(rows[0]!.school_did, `${table}.school_did`).toBe(want)
    }
  })

  /**
   * `fs_peer`'s primary key CONTAINS `school_did` (migration 0012), so an unstamped row
   * cannot be updated into place when a stamped twin already holds the host — the UPDATE
   * raises a primary-key violation and aborts the whole backfill. That is what a
   * deployment looks like when the new code booted (`seedPeersFromEnv` writes the legacy
   * DID explicitly) before anybody back-filled, and it is exactly the order this project's
   * dev box ran in.
   */
  it('drops an unstamped fs_peer row that a stamped twin already shadows', async () => {
    if (!available) return
    await seedOneRowPerTable()
    await testDb().insert(peer).values({ host: 'https://pds.example', source: 'env', schoolDid: SCHOOL })

    const result = await backfillSchool({ db: testDb() })

    expect(result.shadowedPeers).toBe(1)
    const rows = await testDb().select().from(peer)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.schoolDid).toBe(SCHOOL)
    expect(rows[0]!.host).toBe('https://pds.example')
  })

  it('is idempotent: a second run writes nothing', async () => {
    if (!available) return
    await testDb().insert(member).values({ did: MEMBER_A, door: 'custodial' })
    await seedOneRowPerTable()
    await backfillSchool({ db: testDb() })

    const before = await snapshot()
    const again = await backfillSchool({ db: testDb() })

    expect(again.credential).toBe('present')
    expect(again.memberships).toBe(0)
    expect(Object.values(again.stamped).every((n) => n === 0)).toBe(true)
    expect(await snapshot()).toEqual(before)
  })
})

/** One row in each per-school table, with the pre-existing ones already owned elsewhere. */
async function seedOneRowPerTable(): Promise<void> {
  const db = testDb()
  await db.insert(attendance).values({ id: 'a1', eventUri: EVENT, attendeeDid: MEMBER_A, attestedByDid: MEMBER_B })
  await db.insert(attendanceRollup).values({ eventUri: EVENT })
  await db.insert(attendanceTally).values({ did: MEMBER_A })
  await db.insert(attestation).values({ id: 'v1', attesterDid: MEMBER_A, subjectDid: MEMBER_B, skillUri: 'at://s/1' })
  await db.insert(feedback).values({ id: 'f1', eventUri: EVENT, hostDid: MEMBER_B, direction: 'positive', day: '2026-01-02' })
  await db.insert(handoff).values({ id: 'h1', fromDid: MEMBER_A, tokenHash: 'hash-1', expiresAt: new Date() })
  await db.insert(invite).values({ code: 'code-1' })
  await db.insert(moderationQueue).values({ id: 'm1', action: 'hide-listing', reason: 'because', openedByDid: MEMBER_A })
  await db.insert(newsletterIssue).values({ id: 'n1', month: '2026-01', html: '<p/>', text: '.' })
  await db.insert(newsletterSubscription).values({ did: MEMBER_A, emailRef: 'a@example.org', tokenHash: 'hash-2' })
  await db.insert(notificationFeed).values({ id: 'nf1', did: MEMBER_A, category: 'reminder', title: 'hi' })
  await db.insert(notificationOutbox).values({ id: 'no1', did: MEMBER_A, category: 'reminder', dedupKey: 'k1', payload: {} })
  await db.insert(notificationSent).values({ dedupKey: 'k2', did: MEMBER_A, category: 'reminder' })
  await db.insert(requestRsvp).values({ requestUri: 'at://r/1', did: MEMBER_A })
  await db.insert(rsvp).values({ id: 'r1', eventUri: EVENT, did: MEMBER_A, status: 'going' })
  await db.insert(skillProposal).values({ id: 'p1', skillUri: 'at://s/2', proposerDid: MEMBER_A })
  // `fs_peer` was missing from `STAMPED_TABLES` until Task 11's privacy audit found an
  // unstamped row on the dev box: the `PEER_PDS_HOSTS` seed rows were never stamped at all.
  await db.insert(peer).values({ host: 'https://pds.example', source: 'env', schoolDid: '' })

  // Already school-scoped before this phase, and owned by ANOTHER school: the sweep is
  // guarded by `school_did = ''`, so these must come out untouched.
  await db.insert(audit).values({
    id: 'au1', callerDid: MEMBER_A, schoolDid: OTHER_SCHOOL, scope: 'calendar', nsid: 'x', action: 'hide-listing',
    decision: 'allow', reason: 'because', approvals: [], policySource: 'cache', at: new Date(),
  })
  await db.insert(inviteLink).values({
    id: 'il1', tokenHash: 'hash-3', inviterDid: MEMBER_A, schoolDid: OTHER_SCHOOL, expiresAt: new Date(),
  })
  await db.insert(policyCache).values({ schoolDid: OTHER_SCHOOL, thresholds: {} })
  await db.insert(steward).values({ did: MEMBER_A, schoolDid: OTHER_SCHOOL })
}

/** Every row of every table the backfill can write, as comparable JSON. */
async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {}
  for (const table of [...STAMPED_TABLES, 'fs_school', 'fs_school_domain', 'fs_school_credential', 'fs_membership']) {
    const { rows } = await testDb().execute(sql`select * from ${sql.raw(table)} order by 1`)
    out[table] = rows as unknown[]
  }
  return out
}
