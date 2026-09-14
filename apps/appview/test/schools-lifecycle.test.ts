/**
 * THE SCHOOL LIFECYCLE — creating a city, listing the cities, and leaving one
 * (MS §8, spec rulings 1, 7 and 10).
 *
 * NO REAL PDS. `createSchool` takes its PDS as a seam (`setSchoolBootstrapPds`) and this
 * suite passes a fake that hands back a DID and records every `putRecord`. That is not
 * only about speed: the dev PDS mints REAL DIDs on the production PLC (CLAUDE.md), so a
 * unit test that called it would leave permanent identifiers behind on every run.
 *
 * What each part pins:
 *   - create   the rows (`fs_school` + the MS §4 columns, `fs_school_domain`,
 *              `fs_school_credential`), the two founding RECORDS in the right order, the
 *              founder's stewardship, and that the stored credential actually decrypts;
 *   - refuse   a reserved infrastructure label, a duplicate label, and a handle that is
 *              already on the PDS;
 *   - list     name, city, host — and NO counts (ruling 7);
 *   - create   403 without the operator token, 201 with it (ruling 1);
 *   - leave    gone from `/api/members`, the published role claim retracted, and the
 *              class they taught STILL on the calendar (ruling 10);
 *   - rejoin   clears `left_at`.
 */
process.env.MULTI_SCHOOL = '1'
// Deliberately neither of this suite's schools: `lib/school-scope.ts` widens unstamped
// rows into the LEGACY school, and a pass here should say something about the lifecycle
// rather than about that transition rule.
process.env.SCHOOL_DID = 'did:plc:t5-legacy'
process.env.SCHOOL_HANDLE = 'legacy.test'
process.env.SCHOOL_CREATION = 'closed'
process.env.OPERATOR_TOKEN = 'operator-token-under-test'
process.env.SCHOOL_DOMAIN_SUFFIX = 'freeskool.test'
process.env.AUTHORITY_DID = 'did:plc:t5-taxonomy'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'schools-lifecycle-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 19).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'schools-lifecycle-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const DENVER = 'did:plc:t5-denver'
const FOUNDER = 'did:plc:t5-founder'
const LEAVER = 'did:plc:t5-quitting'
const STAYER = 'did:plc:t5-staying'
const STRANGER = 'did:plc:t5-stranger'
const HOST = 'denver.freeskool.test'
const EVENT = `at://${LEAVER}/community.lexicon.calendar.event/taught-here`

/* ─────────────────────────── the fake contrail index ─────────────────────────── */

const { eventRecords, eventConfigs } = vi.hoisted(() => ({
  eventRecords: [] as Array<Record<string, unknown>>,
  eventConfigs: [] as Array<{ uri: string; did: string; eventUri: string }>,
}))

vi.mock('../src/index/indexer.js', () => ({
  resetIndexer: () => {},
  getIndexer: async () => ({
    contrail: {
      async query(short: string) {
        return { records: short === 'event' ? eventRecords : [] }
      },
    },
    db: {
      prepare(sqlText: string) {
        const short = /records_([A-Za-z0-9_]+)/.exec(sqlText)?.[1]
        return {
          bind(arg: string) {
            return {
              all: async () => {
                if (short !== 'eventConfig') return { results: [] }
                const rows = eventConfigs.filter((r) => r.eventUri === arg)
                return {
                  results: rows.map((r) => ({
                    uri: r.uri,
                    did: r.did,
                    rkey: r.uri.split('/').pop(),
                    cid: 'bafy',
                    record: JSON.stringify({ event: { uri: r.eventUri }, visibility: 'listed', tags: ['skillshare'] }),
                    time_us: 1,
                    indexed_at: 1,
                  })),
                }
              },
              first: async () => null,
            }
          },
        }
      },
    },
    async notify() {},
  }),
}))

// No network: an absent school record is "a school that has not written a policy yet",
// which `refreshPolicyCache` caches as the defaults.
vi.mock('../src/lib/pds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pds.js')>()),
  getRecord: async () => null,
}))

import { and, eq } from 'drizzle-orm'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createApp } from '../src/http/app.js'
import { config } from '../src/config.js'
import { newSessionId, signSessionId, unwrapSecret } from '../src/lib/crypto.js'
import { resetSchoolContextCache } from '../src/http/school-context.js'
import {
  custodialAccount,
  eventSchool,
  invite,
  member,
  membership,
  school,
  schoolCredential,
  schoolDomain,
  session,
  steward,
} from '../src/db/schema.js'
import {
  createSchool,
  setSchoolBootstrapPds,
  SchoolCreationError,
  type SchoolBootstrapPds,
} from '../src/lib/schools.js'
import { isMemberOf, joinSchool } from '../src/lib/membership.js'
import { setSchoolActor } from '../src/lib/school-actors.js'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'
import { rowId } from '../src/lib/ids.js'

/* ──────────────────────────────── the fake PDS ───────────────────────────────── */

interface PutCall {
  repo: string
  collection: string
  rkey: string
  record: Record<string, unknown>
}

const puts: PutCall[] = []
const appPasswords: string[] = []
/** Handles the fake PDS already knows about — the "this account exists" case. */
const registered = new Map<string, string>()
let invites = 0

function fakePds(): SchoolBootstrapPds {
  return {
    async resolveHandle(handle) {
      return registered.get(handle) ?? null
    },
    async createInviteCode() {
      invites += 1
      return `invite-${invites}`
    },
    async createAccount({ handle }) {
      const did = `did:plc:t5-${handle.split('.')[0]}`
      registered.set(handle, did)
      return { did }
    },
    async login(identifier) {
      const repo = registered.get(identifier)
      if (!repo) throw new Error(`fake PDS: no account for ${identifier}`)
      return {
        async createAppPassword(name) {
          const pw = `app-pw-${name}`
          appPasswords.push(pw)
          return pw
        },
        async putRecord(input) {
          puts.push(input as PutCall)
          return { uri: `at://${input.repo}/${input.collection}/${input.rkey}`, cid: 'bafy' }
        },
      }
    },
  }
}

/** Which schools a role claim was retracted from — the leave assertion reads this. */
const retractions: string[] = []

function fakePort(): SchoolActorPort {
  return {
    async describeActor(i: { schoolDid: Did }) {
      return { schoolDid: i.schoolDid, pdsEndpoint: 'http://pds.test', custody: 'app-owned' as const, online: true }
    },
    async authorize() {
      return { allowed: true as const, auditId: 'audit' }
    },
    async putRecordAsSchool(i: { schoolDid: Did; collection: string; rkey: string }) {
      return { uri: `at://${i.schoolDid}/${i.collection}/${i.rkey}`, cid: 'bafy', auditId: 'audit' }
    },
    async deleteRecordAsSchool(i: { schoolDid: Did }) {
      retractions.push(i.schoolDid)
      return { auditId: 'audit' }
    },
  } as unknown as SchoolActorPort
}

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

afterAll(async () => {
  setSchoolActor(undefined)
  setSchoolBootstrapPds(undefined)
  if (available) await closeTestDb()
})

async function cookieFor(did: string): Promise<string> {
  const id = newSessionId()
  await testDb()
    .insert(session)
    .values({ id, did, kind: 'custodial', expiresAt: new Date(Date.now() + 86_400_000) })
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

beforeEach(async () => {
  if (!available) return
  await truncate(
    'fs_school',
    'fs_school_domain',
    'fs_school_credential',
    'fs_membership',
    'fs_member',
    'fs_member_prefs',
    'fs_session',
    'fs_steward',
    'fs_custodial_account',
    'fs_invite',
    'fs_event_school',
    'fs_policy_cache',
    'fs_app_meta',
  )
  resetSchoolContextCache()
  setSchoolActor(fakePort())
  setSchoolBootstrapPds(fakePds())
  puts.length = 0
  appPasswords.length = 0
  retractions.length = 0
  eventRecords.length = 0
  eventConfigs.length = 0
  registered.clear()
  invites = 0
})

const newCity = {
  label: 'denver',
  name: 'Denver Free School',
  city: 'Denver, Colorado',
  operator: 'test',
  seedTiers: false,
} as const

describe('creating a school (MS §8)', () => {
  it('writes the rows, the records and the founder stewardship', async () => {
    if (!available) return
    const db = testDb()
    const created = await createSchool({ ...newCity, founderDid: FOUNDER })

    expect(created.handle).toBe('denver.test')
    expect(created.host).toBe(HOST)
    expect(created.reused).toBe(false)

    const [row] = await db.select().from(school).where(eq(school.did, created.did))
    expect(row).toMatchObject({
      label: 'denver',
      name: 'Denver Free School',
      city: 'Denver, Colorado',
      handle: 'denver.test',
      // MS §4/§5 columns, added by this task's migration.
      pdsUrl: config().PDS_URL,
      custody: 'app',
      createdByDid: FOUNDER,
      creationState: 'active',
    })

    const [domain] = await db.select().from(schoolDomain).where(eq(schoolDomain.host, HOST))
    expect(domain?.schoolDid).toBe(created.did)
    expect(domain?.kind).toBe('canonical')
    // Minted under our own suffix: there is nobody else's DNS to wait for.
    expect(domain?.verifiedAt).toBeTruthy()

    // The policy record FIRST, then the school record pointing at it — the school record
    // cannot reference a policy that does not exist yet.
    expect(puts.map((p) => p.collection)).toEqual([
      'freeschool.draft.policy',
      'freeschool.draft.school',
    ])
    const [policyPut, schoolPut] = puts
    expect(policyPut!.repo).toBe(created.did)
    expect(policyPut!.record.thresholds).toBeTruthy()
    expect(schoolPut!.rkey).toBe('self')
    expect(schoolPut!.record).toMatchObject({
      name: 'Denver Free School',
      region: 'Denver, Colorado',
      handleDomain: 'test',
      policy: created.policyUri,
      peers: [],
    })

    // The founder is the first steward (MS §8 step 5) and a member of the city.
    const stewards = await db.select().from(steward).where(eq(steward.schoolDid, created.did))
    expect(stewards.map((s) => s.did)).toEqual([FOUNDER])
    expect(await isMemberOf(FOUNDER, created.did)).toBe(true)

    // The school DID itself is a global presence row — it never has a session.
    const members = await db.select().from(member).where(eq(member.did, created.did))
    expect(members).toHaveLength(1)
  })

  it('wraps the app password into fs_school_credential, and it decrypts', async () => {
    if (!available) return
    const created = await createSchool(newCity)
    const [cred] = await testDb()
      .select()
      .from(schoolCredential)
      .where(eq(schoolCredential.schoolDid, created.did))
    expect(cred?.identifier).toBe('denver.test')
    expect(cred?.appPasswordWrapped).toBeTruthy()
    expect(
      unwrapSecret({ keyVersion: cred!.keyVersion, blob: Buffer.from(cred!.appPasswordWrapped!) }),
    ).toBe(created.appPassword)
    // Never the account password, always the app password we just minted.
    expect(appPasswords).toContain(created.appPassword)
  })

  it('refuses a reserved infrastructure label, but not a city held for a school', async () => {
    if (!available) return
    await expect(createSchool({ ...newCity, label: 'admin' })).rejects.toMatchObject({
      code: 'ReservedLabel',
      status: 400,
    })
    await expect(createSchool({ ...newCity, label: 'pds' })).rejects.toBeInstanceOf(SchoolCreationError)
    // `denver` and `boulder` are in RESERVED_LABELS precisely so a SCHOOL can have them.
    await expect(createSchool(newCity)).resolves.toMatchObject({ label: 'denver' })
  })

  it('refuses a malformed label', async () => {
    if (!available) return
    await expect(createSchool({ ...newCity, label: 'Not A Label' })).rejects.toMatchObject({
      code: 'InvalidLabel',
    })
  })

  it('refuses a duplicate label, and a handle already registered on the PDS', async () => {
    if (!available) return
    await createSchool(newCity)
    await expect(createSchool(newCity)).rejects.toMatchObject({ code: 'SchoolExists', status: 409 })

    // A label with no row, whose handle nevertheless exists: never silently fork it.
    registered.set('portland.test', 'did:plc:t5-someone-else')
    await expect(createSchool({ ...newCity, label: 'portland' })).rejects.toMatchObject({
      code: 'SchoolExists',
    })
  })
})

describe('GET /api/schools', () => {
  it('is public and says name, city and host — and nothing that counts people', async () => {
    if (!available) return
    const created = await createSchool({ ...newCity, founderDid: FOUNDER })
    const app = createApp()
    const res = await app.request('http://denver.freeskool.test/api/schools')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { schools: Array<Record<string, unknown>> }
    expect(body.schools).toHaveLength(1)
    const [entry] = body.schools
    expect(entry).toEqual({
      did: created.did,
      label: 'denver',
      name: 'Denver Free School',
      city: 'Denver, Colorado',
      host: HOST,
    })
    // Ruling 7: no cross-school aggregates. A roster size is not a public record.
    const text = JSON.stringify(body)
    for (const forbidden of ['count', 'members', 'stewards', 'classes']) {
      expect(text.toLowerCase()).not.toContain(forbidden)
    }
  })
})

describe('POST /api/schools (ruling 1: operator only)', () => {
  it('403s without the operator token and 201s with it', async () => {
    if (!available) return
    const app = createApp()
    const body = JSON.stringify({ label: 'denver', name: 'Denver Free School', city: 'Denver, Colorado' })
    const headers = { 'content-type': 'application/json' }

    const anon = await app.request('http://legacy.test/api/schools', { method: 'POST', headers, body })
    expect(anon.status).toBe(403)
    expect(await testDb().select().from(school)).toHaveLength(0)

    const wrong = await app.request('http://legacy.test/api/schools', {
      method: 'POST',
      headers: { ...headers, 'x-operator-token': 'not-the-token' },
      body,
    })
    expect(wrong.status).toBe(403)

    const ok = await app.request('http://legacy.test/api/schools', {
      method: 'POST',
      headers: { ...headers, 'x-operator-token': process.env.OPERATOR_TOKEN! },
      body,
    })
    expect(ok.status).toBe(201)
    const created = (await ok.json()) as Record<string, unknown>
    expect(created).toMatchObject({ label: 'denver', host: HOST, handle: 'denver.test' })
    // The credential never leaves the process.
    expect(JSON.stringify(created)).not.toContain('app-pw')
    expect(await testDb().select().from(school)).toHaveLength(1)
  })

  it('409s on a repeat and 400s on a reserved label, with the token', async () => {
    if (!available) return
    const app = createApp()
    const headers = { 'content-type': 'application/json', 'x-operator-token': process.env.OPERATOR_TOKEN! }
    const post = (label: string) =>
      app.request('http://legacy.test/api/schools', {
        method: 'POST',
        headers,
        body: JSON.stringify({ label, name: `${label} Free School` }),
      })

    expect((await post('denver')).status).toBe(201)
    const again = await post('denver')
    expect(again.status).toBe(409)
    expect((await again.json() as { error: string }).error).toBe('SchoolExists')
    expect((await post('admin')).status).toBe(400)
  })

  it('501s when SCHOOL_CREATION is anything else', async () => {
    if (!available) return
    process.env.SCHOOL_CREATION = 'open'
    try {
      const res = await createApp().request('http://legacy.test/api/schools', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-operator-token': process.env.OPERATOR_TOKEN! },
        body: JSON.stringify({ label: 'denver', name: 'Denver Free School' }),
      })
      expect(res.status).toBe(501)
    } finally {
      process.env.SCHOOL_CREATION = 'closed'
    }
  })
})

describe('leaving a school (ruling 10)', () => {
  async function seedCity(): Promise<string> {
    const db = testDb()
    const created = await createSchool({ ...newCity, founderDid: FOUNDER })
    for (const [did, handle] of [
      [LEAVER, 'quitting.test'],
      [STAYER, 'staying.test'],
    ] as const) {
      await db.insert(custodialAccount).values({ did, handle, email: `${handle}@example.org`, keyVersion: 'v1' })
      await db
        .insert(invite)
        .values({ code: rowId(), schoolDid: created.did, inviterDid: FOUNDER, usedByDid: did, usedAt: new Date() })
      await joinSchool(did, created.did, 'custodial')
    }

    // One class, taught here by the member who is about to leave.
    eventRecords.push({
      uri: EVENT,
      did: LEAVER,
      collection: 'community.lexicon.calendar.event',
      rkey: 'taught-here',
      cid: 'bafy',
      record: { name: 'Bike repair basics', startsAt: new Date(Date.now() + 86_400_000).toISOString() },
    })
    eventConfigs.push({ uri: `${EVENT}-cfg`, did: LEAVER, eventUri: EVENT })
    await db.insert(eventSchool).values({ eventUri: EVENT, schoolDid: created.did })
    return created.did
  }

  it('hides the member, retracts the claim, and leaves their class on the calendar', async () => {
    if (!available) return
    const db = testDb()
    const schoolDid = await seedCity()
    const app = createApp()
    const stayer = await cookieFor(STAYER)
    const leaver = await cookieFor(LEAVER)

    const before = await app.request(`http://${HOST}/api/members`, { headers: { cookie: stayer } })
    expect(await before.text()).toContain(LEAVER)
    const calendarBefore = await app.request(`http://${HOST}/api/calendar`)
    expect(await calendarBefore.text()).toContain(EVENT)

    const res = await app.request(`http://${HOST}/api/schools/${encodeURIComponent(schoolDid)}/leave`, {
      method: 'POST',
      headers: { cookie: leaver },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ left: true })

    // The published `coop.lexicon.membership` claim is retracted for THIS school.
    expect(retractions).toEqual([schoolDid])

    const [row] = await db
      .select()
      .from(membership)
      .where(and(eq(membership.did, LEAVER), eq(membership.schoolDid, schoolDid)))
    expect(row?.leftAt).toBeTruthy()
    expect(row?.directoryListing).toBe(false)

    const after = await app.request(`http://${HOST}/api/members`, { headers: { cookie: stayer } })
    expect(await after.text()).not.toContain(LEAVER)

    // THE CLASS STAYS. It is a public record they wrote about a class that happened here.
    const calendarAfter = await app.request(`http://${HOST}/api/calendar`)
    expect(await calendarAfter.text()).toContain(EVENT)
  })

  it('404s — never 403 — for a school the viewer is not a member of', async () => {
    if (!available) return
    const schoolDid = await seedCity()
    const app = createApp()
    const stranger = await cookieFor(STRANGER)

    const notMine = await app.request(`http://${HOST}/api/schools/${encodeURIComponent(schoolDid)}/leave`, {
      method: 'POST',
      headers: { cookie: stranger },
    })
    expect(notMine.status).toBe(404)

    const nowhere = await app.request(`http://${HOST}/api/schools/did:plc:t5-nowhere/leave`, {
      method: 'POST',
      headers: { cookie: await cookieFor(STAYER) },
    })
    expect(nowhere.status).toBe(404)
  })

  it('requires a session', async () => {
    if (!available) return
    const schoolDid = await seedCity()
    const res = await createApp().request(
      `http://${HOST}/api/schools/${encodeURIComponent(schoolDid)}/leave`,
      { method: 'POST' },
    )
    expect(res.status).toBe(401)
  })

  it('re-joining later clears left_at', async () => {
    if (!available) return
    const db = testDb()
    const schoolDid = await seedCity()
    const app = createApp()
    await app.request(`http://${HOST}/api/schools/${encodeURIComponent(schoolDid)}/leave`, {
      method: 'POST',
      headers: { cookie: await cookieFor(LEAVER) },
    })
    expect(await isMemberOf(LEAVER, schoolDid)).toBe(false)

    // What a new session on that host does (`http/session.ts#createSession`).
    await joinSchool(LEAVER, schoolDid, 'custodial')
    expect(await isMemberOf(LEAVER, schoolDid)).toBe(true)
    const [row] = await db
      .select()
      .from(membership)
      .where(and(eq(membership.did, LEAVER), eq(membership.schoolDid, schoolDid)))
    expect(row?.leftAt).toBeNull()
    // Still hidden, on purpose: leaving was the stronger statement, and re-publishing
    // somebody's name because they came back is the R9 failure mode. Their toggle is one tap.
    expect(row?.directoryListing).toBe(false)
  })
})
