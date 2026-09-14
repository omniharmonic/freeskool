/**
 * TASK 9 — gap 6 of `docs/interop-audit.md`: "nothing validates our borrowed records."
 *
 * We write five record types we do not own — `community.lexicon.calendar.event`,
 * `community.lexicon.calendar.rsvp` (opt-in), `coop.lexicon.event.config`,
 * `coop.lexicon.event.listing`, `coop.lexicon.membership` — all with `validate: false`,
 * because our own PDS cannot resolve lexicons it was never given. `validate: false`
 * meant a schema drift in our writer would ship silently forever. This suite calls the
 * REAL builders (never re-typed literals) and validates every record they produce with
 * `@atproto/lexicon` against the lexicons vendored in `packages/lexicons/vendor/`
 * (`community.lexicon.*`: a verbatim clone of the canonical source; `coop.lexicon.*`: our
 * own documented ASSUMPTION, reconstructed from our code — see `vendor/README.md` and
 * `src/lexicons/coop.ts`).
 *
 * A note on `@atproto/lexicon` itself: `apps/appview`'s own `package.json` is out of
 * scope for this task, and it does not declare `@atproto/lexicon` as a dependency.
 * `packages/lexicons` does. We reach it by a relative path into that package's own
 * `node_modules` (a real file on disk, not a phantom bare-specifier dependency) rather
 * than adding a dependency line to a file we do not own.
 */
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- see the module doc above
import { Lexicons, type LexiconDoc } from '../../../packages/lexicons/node_modules/@atproto/lexicon/dist/index.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.SCHOOL_DID = 'did:plc:borrowed-records-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'borrowed-records-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 11).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'borrowed-records-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import { defaultThresholds, Role } from '@freeschool/shared'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'

const HOST_DID = 'did:plc:borrowed-records-host'
const SCHOOL_DID = 'did:plc:borrowed-records-school'
const EVENT_RKEY = 'borrowed-records-event'
const EVENT_URI = `at://${HOST_DID}/community.lexicon.calendar.event/${EVENT_RKEY}`

/** Every record a host-scoped `actorAgent.com.atproto.repo.putRecord` call wrote.
 * `FAKE_CID` is a syntactically real CIDv1 (the `cid` lexicon format is a real parser,
 * not a pattern match) — every strongRef below needs one that actually parses; both are
 * `vi.hoisted` because the `vi.mock` factories below run before ordinary top-level
 * `const`s are initialized. */
const { written, FAKE_CID } = vi.hoisted(() => ({
  written: [] as Array<{ collection: string; rkey: string; record: Record<string, unknown> }>,
  FAKE_CID: 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe',
}))

vi.mock('../src/lib/actor-agent.js', () => ({
  NoActorCredentialError: class extends Error {},
  actorAgent: async () => ({
    com: {
      atproto: {
        repo: {
          putRecord: async ({ collection, rkey, record }: { collection: string; rkey: string; record: Record<string, unknown> }) => {
            written.push({ collection, rkey, record })
            return { data: { uri: `at://${HOST_DID}/${collection}/${rkey}`, cid: FAKE_CID } }
          },
          deleteRecord: async () => ({}),
        },
      },
    },
  }),
}))

vi.mock('../src/index/indexer.js', async () => ({
  getIndexer: async () => ({
    contrail: {
      async query(short: string, opts: { did?: string }) {
        if (short === 'event' && opts.did === HOST_DID) {
          return { records: [{ uri: EVENT_URI, did: HOST_DID, collection: 'community.lexicon.calendar.event', rkey: EVENT_RKEY, cid: FAKE_CID, record: {} }] }
        }
        return { records: [] }
      },
    },
    db: {
      prepare() {
        return {
          bind() {
            return { all: async () => ({ results: [] }), first: async () => null }
          },
        }
      },
    },
    async notify() {},
  }),
}))

// `schoolRoutingTags()` (called from `routeListing`, itself called from
// `createEventAsHost`) reads the school's own record for its routing tags; this test
// must not reach a real network to learn that, so `lib/pds.js#getRecord` is faked —
// same pattern as `test/event-notes-placement.test.ts`.
vi.mock('../src/lib/pds.js', async () => ({
  ...(await vi.importActual('../src/lib/pds.js')),
  getRecord: async () => ({ uri: `at://${SCHOOL_DID}/freeschool.draft.school/self`, cid: 'bafy-school', value: { tags: ['skillshare'] } }),
}))

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { setSchoolActor } from '../src/lib/school-actor.js'
import { clearPolicyMemo } from '../src/lib/policy.js'
import { policyCache } from '../src/db/schema.js'
import { createEventAsHost } from '../src/lib/events.js'
import { publishRoleClaim, setPublicRoleOptIn } from '../src/lib/membership-claims.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'

/** A fake `SchoolActorPort` — this IS the "fake agent capturing putRecord arguments"
 * the brief calls for, for every write the SCHOOL makes (never the host's own repo):
 * `coop.lexicon.event.listing` (via `routeListing`) and `coop.lexicon.membership` (via
 * `publishRoleClaim`). Same pattern as `test/tag-routing.test.ts` and
 * `test/membership-claims.test.ts`. */
function fakeSchoolPort(calls: Array<{ collection: string; record: unknown }>): SchoolActorPort {
  return {
    async describeActor() {
      throw new Error('not used by this test')
    },
    async actAs() {
      throw new Error('not used by this test')
    },
    async putRecordAsSchool(i) {
      calls.push({ collection: i.collection, record: i.record })
      return { uri: `at://${i.schoolDid}/${i.collection}/${i.rkey}`, cid: 'bafy-school-write', auditId: 'audit-1' }
    },
    async deleteRecordAsSchool() {
      throw new Error('not used by this test')
    },
    async authorize() {
      return { allowed: true, role: Role.Steward, reason: 'ok' }
    },
  }
}

// ---------------------------------------------------------------------------
// The Lexicons registry: CANONICAL community.lexicon.* (verbatim clone) + ASSUMED
// coop.lexicon.* (reconstructed from our own code) + our own freeschool.draft.*.
// See packages/lexicons/vendor/README.md for source/commit/date per file.
// ---------------------------------------------------------------------------
const STRONG_REF: LexiconDoc = {
  lexicon: 1,
  id: 'com.atproto.repo.strongRef',
  defs: {
    main: {
      type: 'object',
      required: ['uri', 'cid'],
      properties: {
        uri: { type: 'string', format: 'at-uri' },
        cid: { type: 'string', format: 'cid' },
      },
    },
  },
}

function loadJson(relativeToThisFile: string): LexiconDoc {
  const path = fileURLToPath(new URL(relativeToThisFile, import.meta.url))
  return JSON.parse(readFileSync(path, 'utf8')) as LexiconDoc
}

const VENDOR = '../../../packages/lexicons/vendor/'
const DRAFT = '../../../packages/lexicons/lexicons/freeschool/draft/'

const borrowedLexicons = new Lexicons([
  STRONG_REF,
  loadJson(`${VENDOR}community.lexicon.calendar.event.json`),
  loadJson(`${VENDOR}community.lexicon.calendar.rsvp.json`),
  loadJson(`${VENDOR}community.lexicon.location.address.json`),
  loadJson(`${VENDOR}community.lexicon.location.geo.json`),
  loadJson(`${VENDOR}community.lexicon.location.fsq.json`),
  loadJson(`${VENDOR}community.lexicon.location.hthree.json`),
  loadJson(`${VENDOR}coop.lexicon.event.config.json`),
  loadJson(`${VENDOR}coop.lexicon.event.listing.json`),
  loadJson(`${VENDOR}coop.lexicon.membership.json`),
  loadJson(`${DRAFT}skillLevel.json`),
  loadJson(`${DRAFT}series.json`),
])

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_event_extra', 'fs_app_meta', 'fs_attendance_tally', 'fs_feedback_window', 'fs_series_occurrence', 'fs_member_prefs', 'fs_policy_cache')
  clearPolicyMemo()
  written.length = 0
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

function lastWritten(collection: string): Record<string, unknown> {
  const row = [...written].reverse().find((w) => w.collection === collection)
  if (!row) throw new Error(`no ${collection} record was written`)
  return row.record
}

describe('community.lexicon.calendar.event — built by createEventAsHost, validated against the CANONICAL vendored lexicon', () => {
  it('a full class (locations, series, skills) validates', async () => {
    if (!available) return
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakeSchoolPort(calls))
    await createEventAsHost(
      { did: HOST_DID, kind: 'custodial', sessionId: 'borrowed-records-test' },
      {
        name: 'Bicycle repair basics',
        startsAt: '2026-10-01T18:00:00.000Z',
        endsAt: '2026-10-01T20:00:00.000Z',
        publicOverview: { description: 'Bring your own bike and tools.' },
        locations: [{ $type: 'community.lexicon.location.address', country: 'US', locality: 'Boulder' }],
        tags: ['skillshare'],
        capacity: 12,
        visibility: 'listed',
        skills: [{ skill: 'at://did:plc:abc/freeschool.draft.skill/bicycle-repair', level: 2 }],
        series: { rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TH;COUNT=8', freq: 'weekly', byDay: ['TH'], count: 8, timezone: 'America/Denver' },
      },
    )
    const record = { ...lastWritten('community.lexicon.calendar.event') }
    expect(() => borrowedLexicons.assertValidRecord('community.lexicon.calendar.event', record)).not.toThrow()
    expect(record.mode).toBe('community.lexicon.calendar.event#inperson')
    expect(record.status).toBe('community.lexicon.calendar.event#scheduled')
  })

  it('a minimal class (no description, no locations, no series) also validates', async () => {
    if (!available) return
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakeSchoolPort(calls))
    await createEventAsHost(
      { did: HOST_DID, kind: 'custodial', sessionId: 'borrowed-records-test' },
      { name: 'A minimal class', startsAt: '2026-10-02T18:00:00.000Z' },
    )
    expect(() => borrowedLexicons.assertValidRecord('community.lexicon.calendar.event', lastWritten('community.lexicon.calendar.event'))).not.toThrow()
  })
})

describe('coop.lexicon.event.config — built by createEventAsHost, validated against our ASSUMED vendored lexicon', () => {
  it('validates, with every optional field present', async () => {
    if (!available) return
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakeSchoolPort(calls))
    await createEventAsHost(
      { did: HOST_DID, kind: 'custodial', sessionId: 'borrowed-records-test' },
      {
        name: 'Bicycle repair basics',
        startsAt: '2026-10-01T18:00:00.000Z',
        timezone: 'America/Denver',
        capacity: 12,
        visibility: 'listed',
        neighborhood: 'North Boulder',
        rsvpRequired: true,
        tags: ['skillshare'],
      },
    )
    expect(() => borrowedLexicons.assertValidRecord('coop.lexicon.event.config', lastWritten('coop.lexicon.event.config'))).not.toThrow()
  })

  it('validates with only the required field (event)', async () => {
    if (!available) return
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakeSchoolPort(calls))
    await createEventAsHost({ did: HOST_DID, kind: 'custodial', sessionId: 'borrowed-records-test' }, { name: 'Bare class', startsAt: '2026-10-03T18:00:00.000Z' })
    expect(() => borrowedLexicons.assertValidRecord('coop.lexicon.event.config', lastWritten('coop.lexicon.event.config'))).not.toThrow()
  })
})

describe('coop.lexicon.event.listing — built by routeListing (the SCHOOL\'s write), validated against our ASSUMED vendored lexicon', () => {
  it('validates', async () => {
    if (!available) return
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakeSchoolPort(calls))
    await createEventAsHost(
      { did: HOST_DID, kind: 'custodial', sessionId: 'borrowed-records-test' },
      { name: 'Bicycle repair basics', startsAt: '2026-10-01T18:00:00.000Z', tags: ['skillshare'], visibility: 'listed' },
    )
    const listing = calls.find((c) => c.collection === 'coop.lexicon.event.listing')
    expect(listing).toBeDefined()
    expect(() => borrowedLexicons.assertValidRecord('coop.lexicon.event.listing', listing!.record)).not.toThrow()
  })
})

describe('coop.lexicon.membership — built by publishRoleClaim (the SCHOOL\'s write), validated against our ASSUMED vendored lexicon', () => {
  const SUBJECT = 'did:plc:borrowed-records-subject' as Did

  async function allowPublishing(): Promise<void> {
    const thresholds = { ...defaultThresholds, publishRoles: true }
    await testDb()
      .insert(policyCache)
      .values({ schoolDid: SCHOOL_DID, thresholds, fetchedAt: new Date() })
      .onConflictDoUpdate({ target: policyCache.schoolDid, set: { thresholds, fetchedAt: new Date() } })
    clearPolicyMemo()
    await setPublicRoleOptIn(SUBJECT, true, SCHOOL_DID as Did)
  }

  it('validates, for a qualifying, opted-in Host', async () => {
    if (!available) return
    await allowPublishing()
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakeSchoolPort(calls))
    const res = await publishRoleClaim(SCHOOL_DID as Did, SUBJECT, Role.Host, { fetchExistingCid: async () => undefined })
    expect(res.published).toBe(true)
    const claim = calls.find((c) => c.collection === 'coop.lexicon.membership')
    expect(claim).toBeDefined()
    expect(() => borrowedLexicons.assertValidRecord('coop.lexicon.membership', claim!.record)).not.toThrow()
  })
})

describe('community.lexicon.calendar.rsvp (opt-in) — built by POST /api/rsvp, validated against the CANONICAL vendored lexicon', () => {
  /** `setCookie` only ever calls `c.header(...)` on this — see `test/handoff.test.ts`. */
  function fakeContext(): Context {
    return { header: () => undefined } as unknown as Context
  }
  async function cookieFor(did: string): Promise<string> {
    const id = await createSession(fakeContext(), did, 'custodial')
    return `${config().SESSION_COOKIE}=${signSessionId(id)}`
  }

  it('writes community.lexicon.calendar.rsvp into the MEMBER\'s own repo, and it validates', async () => {
    if (!available) return
    await truncate('fs_rsvp', 'fs_custodial_account', 'fs_session')
    const memberDid = 'did:plc:borrowed-records-rsvp-member'
    const cookie = await cookieFor(memberDid)
    const app = createApp()
    const res = await app.request('/api/rsvp', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventUri: EVENT_URI, status: 'going', alsoPublicRecord: true }),
    })
    expect(res.status).toBe(200)
    const rsvpWrite = [...written].reverse().find((w) => w.collection === 'community.lexicon.calendar.rsvp')
    expect(rsvpWrite).toBeDefined()
    expect(() => borrowedLexicons.assertValidRecord('community.lexicon.calendar.rsvp', rsvpWrite!.record)).not.toThrow()
    expect(rsvpWrite!.record.status).toBe('community.lexicon.calendar.rsvp#going')
  })
})

describe('freeschool.draft.* sidecars built alongside a borrowed event — validated against our OWN lexicons (packages/lexicons/lexicons/**)', () => {
  it('freeschool.draft.skillLevel and freeschool.draft.series both validate', async () => {
    if (!available) return
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakeSchoolPort(calls))
    await createEventAsHost(
      { did: HOST_DID, kind: 'custodial', sessionId: 'borrowed-records-test' },
      {
        name: 'Bicycle repair basics',
        startsAt: '2026-10-01T18:00:00.000Z',
        skills: [{ skill: 'at://did:plc:abc/freeschool.draft.skill/bicycle-repair', level: 2, prerequisites: 'Bring your own bike.' }],
        series: { rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TH;COUNT=8', freq: 'weekly', byDay: ['TH'], count: 8, timezone: 'America/Denver' },
      },
    )
    expect(() => borrowedLexicons.assertValidRecord('freeschool.draft.skillLevel', lastWritten('freeschool.draft.skillLevel'))).not.toThrow()
    expect(() => borrowedLexicons.assertValidRecord('freeschool.draft.series', lastWritten('freeschool.draft.series'))).not.toThrow()
  })
})

describe('a deliberately broken record names the field it failed on', () => {
  it('demonstrates the failure mode the brief requires: the thrown error names the bad field', async () => {
    if (!available) return
    const broken = {
      $type: 'community.lexicon.calendar.event',
      // missing `name`, the one other required field besides createdAt
      createdAt: new Date().toISOString(),
    }
    expect(() => borrowedLexicons.assertValidRecord('community.lexicon.calendar.event', broken)).toThrowError(/name/)
  })
})
