/**
 * THE MIGRATION TEST (MS §11, "Migration test").
 *
 * A fixture database at the PRE-FEDERATION schema — migrations 0000..0010, the day before
 * `fs_school`, `fs_membership` and the `school_did` columns existed — with a real
 * deployment's worth of rows in it. Then 0011..HEAD, then `scripts/backfill-school.ts`,
 * then the assertions: every scoped row stamped, every member's own answers carried
 * across, the existing suites' key invariants still true, and `MULTI_SCHOOL=0` behaving
 * exactly as it did before any of this.
 *
 * WHY THE SCHEMA COMES FROM THE JOURNAL AND THE ROWS FROM A FILE. A checked-in `pg_dump`
 * of the old schema is a second copy of the migrations, and it rots the first time
 * somebody adds a column to one of them. Replaying `drizzle/meta/_journal.json` up to
 * `0010` IS the pre-federation schema, by construction, and it cannot drift. The DATA a
 * real Boulder had is what a file is good for: `test/fixtures/pre-federation-rows.sql`.
 *
 * A DATABASE OF ITS OWN. Everything here runs against `<test db>_fixture0010`, dropped
 * and recreated per run, so nothing this file does can be confused with the state the
 * other DB-backed suites truncate. `DATABASE_URL` is repointed at it for the duration and
 * restored in `afterAll` (vitest runs test FILES sequentially here —
 * `vitest.config.ts#fileParallelism: false` — so the restore lands before the next file).
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const here = path.dirname(fileURLToPath(import.meta.url))
const DRIZZLE = path.resolve(here, '../drizzle')

/** The last migration before the federation phase. 0011 is where `fs_school` appears. */
const PRE_FEDERATION_TAG = '0010_lowly_glorian'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://freeschool:freeschool@localhost:5434/freeschool_test'
const FIXTURE_URL = (() => {
  const url = new URL(BASE_URL)
  url.pathname = `${url.pathname.replace(/^\//, '')}_fixture0010`
  return url.toString()
})()

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL
/**
 * Set BEFORE the modules below are imported: `config()` is memoised on first read, and
 * `getDb()` builds its pool from it. The env values the suite needs are pinned here for
 * the same reason `test/tenant-isolation.test.ts` pins its own.
 */
process.env.DATABASE_URL = FIXTURE_URL
process.env.SCHOOL_DID = 'did:plc:legacy-school'
process.env.SCHOOL_HANDLE = 'boulder.test'
process.env.SCHOOL_APP_PASSWORD = 'aaaa-bbbb-cccc-dddd'
process.env.WEB_PUBLIC_URL = 'http://boulder.test'
process.env.AUTHORITY_DID = 'did:plc:legacy-taxonomy'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'migration-fixture-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 17).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'migration-fixture-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// No network: the school record and its policy are simply absent, which is what a
// fixture database restored onto a machine with no PDS looks like.
vi.mock('../src/lib/pds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pds.js')>()),
  getRecord: async () => null,
}))
vi.mock('../src/index/indexer.js', () => ({
  resetIndexer: () => {},
  getIndexer: async () => ({
    contrail: { async query() { return { records: [] } } },
    db: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => null }) }) },
    async notify() {},
  }),
}))

import { sql } from 'drizzle-orm'
import { createDb, closeDb, type Db } from '../src/db/index.js'
import { config, resetConfig } from '../src/config.js'
import { backfillSchool, STAMPED_TABLES } from '../scripts/backfill-school.js'
import { resetSchoolContextCache } from '../src/http/school-context.js'
import { createApp } from '../src/http/app.js'
import { evidenceFor, roleOf } from '../src/lib/roles.js'
import { listMembers } from '../src/lib/members.js'
import { publicRoleOptIn } from '../src/lib/membership.js'
import { Role } from '@freeschool/shared'

const SCHOOL = 'did:plc:legacy-school'
const AMIRA = 'did:plc:legacy-amira'
const BO = 'did:plc:legacy-bo'
const CYRUS = 'did:plc:legacy-cyrus'

let fixture: { db: Db; pool: pg.Pool } | undefined
let available = false

/** Migration tags in journal order, up to and including `upTo` (or from just after it). */
async function journalTags(): Promise<string[]> {
  const raw = await readFile(path.join(DRIZZLE, 'meta/_journal.json'), 'utf8')
  const journal = JSON.parse(raw) as { entries: Array<{ idx: number; tag: string }> }
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag)
}

async function applyMigrations(client: pg.Client, tags: string[]): Promise<void> {
  for (const tag of tags) {
    const body = await readFile(path.join(DRIZZLE, `${tag}.sql`), 'utf8')
    for (const statement of body.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue
      await client.query(statement)
    }
  }
}

/** Counts, by `school_did`, for one table. */
async function bySchool(table: string): Promise<Record<string, number>> {
  const result = await fixture!.db.execute(
    sql.raw(`select school_did, count(*)::int as n from ${table} group by school_did`),
  )
  const rows = (result.rows ?? result) as Array<{ school_did: string; n: number }>
  return Object.fromEntries(rows.map((r) => [r.school_did, Number(r.n)]))
}

beforeAll(async () => {
  const admin = new URL(FIXTURE_URL)
  const dbName = admin.pathname.replace(/^\//, '')
  admin.pathname = '/postgres'
  const root = new pg.Client({ connectionString: admin.toString() })
  try {
    await root.connect()
  } catch {
    console.warn('Postgres is unreachable — skipping the migration-fixture suite')
    return
  }
  await root.query(`drop database if exists "${dbName}" with (force)`)
  await root.query(`create database "${dbName}"`)
  await root.end()

  const tags = await journalTags()
  const cut = tags.indexOf(PRE_FEDERATION_TAG)
  expect(cut, `${PRE_FEDERATION_TAG} is missing from the drizzle journal`).toBeGreaterThanOrEqual(0)

  const client = new pg.Client({ connectionString: FIXTURE_URL })
  await client.connect()
  // 1. The pre-federation schema, replayed from the journal.
  await applyMigrations(client, tags.slice(0, cut + 1))
  // 2. The rows a real single-school deployment had.
  await client.query(await readFile(path.join(here, 'fixtures/pre-federation-rows.sql'), 'utf8'))
  // 3. Everything the federation phase added.
  await applyMigrations(client, tags.slice(cut + 1))
  /**
   * 4. AND WHAT THE NEW CODE WRITES BEFORE ANYBODY BACK-FILLS. `index/peers.ts#
   * seedPeersFromEnv` runs at boot and writes `PEER_PDS_HOSTS` with the legacy DID
   * explicitly, so a host that already had an unstamped row now has a stamped twin. Since
   * 0012 put `school_did` into `fs_peer`'s primary key, stamping the unstamped one then
   * collides — which aborted the whole backfill until `dropShadowedPeers` existed.
   */
  await client.query(
    `insert into fs_peer (host, source, school_did) values ('https://pds.shadowed.example', 'env', 'did:plc:legacy-school')`,
  )
  await client.end()

  fixture = createDb(FIXTURE_URL)
  available = true
}, 120_000)

afterAll(async () => {
  await fixture?.pool.end().catch(() => undefined)
  await closeDb().catch(() => undefined)
  // Leave the worker exactly as it was found: the next test file must not inherit this
  // database, and `config()` must not stay memoised on it.
  if (ORIGINAL_DATABASE_URL === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
  resetConfig()
})

describe('a pre-federation database, migrated', () => {
  it('arrives with every scoped column present and UNSTAMPED', async () => {
    if (!available) return
    // 0011 adds the columns with `DEFAULT ''`, so an existing row is "not yet stamped"
    // rather than NULL — `lib/school-scope.ts` is what makes that mean "the legacy
    // school" until the backfill runs.
    expect(await bySchool('fs_rsvp')).toEqual({ '': 1 })
    expect(await bySchool('fs_attendance_tally')).toEqual({ '': 2 })
    expect(await bySchool('fs_moderation_queue')).toEqual({ '': 1 })
    // 0012 fills `fs_peer`'s NULLs before making the column NOT NULL — and one of the
    // three rows was already stamped, which is the collision `dropShadowedPeers` exists for.
    expect(await bySchool('fs_peer')).toEqual({ '': 2, [SCHOOL]: 1 })
    // The four that already carried a real DID are untouched by the migration.
    expect(await bySchool('fs_steward')).toEqual({ [SCHOOL]: 1 })
    expect(await bySchool('fs_audit')).toEqual({ [SCHOOL]: 1 })
    expect(await bySchool('fs_invite_link')).toEqual({ [SCHOOL]: 1 })
    expect(await bySchool('fs_policy_cache')).toEqual({ [SCHOOL]: 1 })
    // And nothing has been made a member of anything yet.
    const before = await fixture!.db.execute(sql`select count(*)::int as n from fs_membership`)
    expect(Number(((before.rows ?? before) as Array<{ n: number }>)[0]!.n)).toBe(0)
  })

  it('backfills: one school row, its hosts, its credential, and a membership per member', async () => {
    if (!available) return
    const result = await backfillSchool({ db: fixture!.db })
    expect(result.schoolDid).toBe(SCHOOL)
    expect(result.credential).toBe('imported')
    expect(result.memberships).toBe(3)
    /**
     * The unstamped `fs_peer` row that a stamped twin already shadowed. Before this was
     * handled the whole backfill aborted here with a primary-key violation — found on the
     * dev box while running the two-school seed, and the reason `fs_peer` is in
     * `STAMPED_TABLES` at all.
     */
    expect(result.shadowedPeers).toBe(1)
    const peers = await bySchool('fs_peer')
    expect(peers).toEqual({ [SCHOOL]: 2 })

    const schools = await fixture!.db.execute(sql`select did, label, handle from fs_school`)
    expect((schools.rows ?? schools) as unknown[]).toHaveLength(1)

    const hosts = await fixture!.db.execute(sql`select host, kind from fs_school_domain order by host`)
    // `WEB_PUBLIC_URL` is `http://boulder.test`, and the label comes from `SCHOOL_HANDLE`
    // (`boulder.test`) — so the apex IS `<label>.<…>` already and there is one row, not two.
    expect(((hosts.rows ?? hosts) as Array<{ host: string; kind: string }>).map((r) => r.host)).toEqual(['boulder.test'])
  })

  it('stamps every scoped table, and only the unstamped rows', async () => {
    if (!available) return
    for (const table of STAMPED_TABLES) {
      const counts = await bySchool(table)
      expect(counts[''] ?? 0, `${table} still holds unstamped rows`).toBe(0)
      // Nothing acquired a school that is not this one.
      for (const key of Object.keys(counts)) expect(key, `${table} names a foreign school`).toBe(SCHOOL)
    }
    // `fs_event_school` has no default-'' rows to stamp (it is new in 0011) and is not in
    // STAMPED_TABLES for that reason; assert it is empty rather than assume it.
    const events = await fixture!.db.execute(sql`select count(*)::int as n from fs_event_school`)
    expect(Number(((events.rows ?? events) as Array<{ n: number }>)[0]!.n)).toBe(0)
  })

  it("carries each member's OWN answers across, and invents none", async () => {
    if (!available) return
    const rows = (
      await fixture!.db.execute(
        sql`select did, door, directory_listing, public_role, left_at from fs_membership order by did`,
      )
    ).rows as Array<{ did: string; door: string; directory_listing: boolean; public_role: boolean; left_at: unknown }>
    expect(rows.map((r) => r.did)).toEqual([AMIRA, BO, CYRUS])
    // Bo opted OUT of the directory and IN to a published role. Migrating somebody back
    // INTO a directory, or losing a consent they gave, are the two failure modes here.
    const bo = rows.find((r) => r.did === BO)!
    expect(bo.directory_listing).toBe(false)
    expect(bo.public_role).toBe(true)
    // Everyone else keeps the default the API already reported for them: listed, not published.
    for (const did of [AMIRA, CYRUS]) {
      const row = rows.find((r) => r.did === did)!
      expect(row.directory_listing).toBe(true)
      expect(row.public_role).toBe(false)
    }
    // The door is preserved, not guessed.
    expect(rows.find((r) => r.did === CYRUS)!.door).toBe('oauth')
    // Nobody has left.
    for (const row of rows) expect(row.left_at).toBeNull()
    // ...and the per-school read agrees with the column.
    expect(await publicRoleOptIn(BO, SCHOOL)).toBe(true)
    expect(await publicRoleOptIn(AMIRA, SCHOOL)).toBe(false)
  })

  it('is idempotent: a second run stamps nothing and adds nobody', async () => {
    if (!available) return
    const again = await backfillSchool({ db: fixture!.db })
    expect(again.memberships).toBe(0)
    expect(again.credential).toBe('present')
    for (const [table, n] of Object.entries(again.stamped)) expect(n, `${table} was re-stamped`).toBe(0)
  })
})

describe('the existing suites’ invariants, on the migrated database', () => {
  it('derives the same roles from the migrated evidence', async () => {
    if (!available) return
    // `fs_policy_cache` carries `invite-or-vouch` + `hostMinAttended: 2` from the fixture.
    // Amira: invited, four attendances, AND the pre-0011 `fs_steward` row (which already
    // named this school) -> Steward. Bo: invited, one attendance, under a bar of two ->
    // Member. Cyrus: an account and nothing else -> Visitor, because the gate is not met.
    expect(await roleOf(AMIRA, SCHOOL)).toBe(Role.Steward)
    expect(await roleOf(BO, SCHOOL)).toBe(Role.Member)
    expect(await roleOf(CYRUS, SCHOOL)).toBe(Role.Visitor)

    const evidence = await evidenceFor(AMIRA, SCHOOL)
    expect(evidence.inviteOrVouch).toBe(true)
    expect(evidence.attendedConfirmed).toBe(4)
    // The steward row survived, and it is a steward row for THIS school.
    expect((await evidenceFor(AMIRA, SCHOOL)).stewardAppointed).toBe(true)
  })

  it('lists the directory from fs_membership, honouring the opt-out that came across', async () => {
    if (!available) return
    const { members } = await listMembers({}, SCHOOL)
    const dids = members.map((m) => m.did)
    expect(dids).toContain(AMIRA)
    // Bo's `directory_listing = false` migrated, so Bo is not in the directory.
    expect(dids).not.toContain(BO)
  })

  it('scopes a vouch to the school it was given in', async () => {
    if (!available) return
    expect(await bySchool('fs_attestation')).toEqual({ [SCHOOL]: 1 })
    // A second school could never see it: the predicate is `= schoolDid`, widened to the
    // unstamped rows only for the legacy school — and there are none left.
    const evidence = await evidenceFor(AMIRA, 'did:plc:some-other-school')
    expect(evidence.inviteOrVouch).toBe(false)
    expect(evidence.attendedConfirmed).toBe(0)
  })
})

/**
 * THE ROLLBACK (MS §11, "a rollback test with the flag back at 0").
 *
 * The migration is one-way — you do not un-add a column — so "rolling back" means turning
 * `MULTI_SCHOOL` off again and getting the single-school behaviour back on the MIGRATED
 * database. That is the promise the flag makes, and this is the test of it.
 */
describe('MULTI_SCHOOL=0 on the migrated database', () => {
  async function get(path: string, host: string): Promise<{ status: number; text: string }> {
    resetSchoolContextCache()
    const res = await createApp().request(`http://${host}${path}`, { headers: { Host: host } })
    return { status: res.status, text: await res.text() }
  }

  async function withFlag<T>(value: '0' | '1', fn: () => Promise<T>): Promise<T> {
    process.env.MULTI_SCHOOL = value
    resetConfig()
    try {
      return await fn()
    } finally {
      delete process.env.MULTI_SCHOOL
      resetConfig()
    }
  }

  it('serves the legacy school on ANY host, exactly as it did before the migration', async () => {
    if (!available) return
    await withFlag('0', async () => {
      expect(config().MULTI_SCHOOL).toBe(false)
      // A host with no `fs_school_domain` row at all. With the flag off the Host header is
      // never consulted, so this is the legacy school and a 200 — the pre-federation answer.
      const res = await get('/api/school/how-it-works', 'nowhere.example')
      expect(res.status).toBe(200)
      const known = await get('/api/school/how-it-works', 'boulder.test')
      expect(known.status).toBe(200)
      expect(known.text).toBe(res.text)
    })
  })

  it('flips ON safely while there is still only one school', async () => {
    if (!available) return
    await withFlag('1', async () => {
      // MS §3 resolution rule 3: with exactly one school, a host that names none still
      // resolves to it. That is what makes the flip a non-event for a city that has not
      // got a neighbour yet — the flag can go on before the second school exists.
      expect((await get('/api/school/how-it-works', 'nowhere.example')).status).toBe(200)
      expect((await get('/api/school/how-it-works', 'boulder.test')).status).toBe(200)
    })
  })

  it('becomes strict the moment a SECOND school exists — 404 UnknownSchool, never 403', async () => {
    if (!available) return
    await fixture!.db.execute(
      sql`insert into fs_school (did, label, name, handle) values ('did:plc:legacy-second', 'denver', 'Denver Free School', 'denver.test')`,
    )
    try {
      await withFlag('1', async () => {
        const res = await get('/api/school/how-it-works', 'nowhere.example')
        expect(res.status).toBe(404)
        expect(JSON.parse(res.text).error).toBe('UnknownSchool')
        // ...while the host the backfill wrote still resolves to Boulder.
        expect((await get('/api/school/how-it-works', 'boulder.test')).status).toBe(200)
      })
      // And with the flag back OFF, the unknown host is Boulder again: the rollback is
      // available AFTER a second school row exists, which is the point of a flag.
      await withFlag('0', async () => {
        expect((await get('/api/school/how-it-works', 'nowhere.example')).status).toBe(200)
      })
    } finally {
      await fixture!.db.execute(sql`delete from fs_school where did = 'did:plc:legacy-second'`)
    }
  })
})
