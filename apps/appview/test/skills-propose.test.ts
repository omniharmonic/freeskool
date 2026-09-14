/**
 * `POST /api/skills` (member proposals) and the steward surface that follows
 * (`GET /api/admin/skills/proposals`, `POST /api/admin/skills/:id/deprecate|move`).
 *
 * R-6: a proposal publishes IMMEDIATELY as `status: 'proposed'` — no approval gate — and
 * a steward's only levers afterwards are deprecate and move.
 *
 * The taxonomy authority is FAKED (`setAuthorityClientForTests`): no PDS involved, so
 * these tests exercise the collision/rate-limit/tiering logic and the `fs_skill_proposal`
 * / `fs_skill_tier` writes against a REAL Postgres — same split as `test/skills.test.ts`
 * (fake indexer) and `test/admin-moderation.test.ts` (real Postgres, real
 * `AppCustodyAdapter`, faked PDS session).
 */
process.env.SCHOOL_DID ??= 'did:plc:school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'skills-propose-test-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 7).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'skills-propose-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

const AUTHORITY = 'did:plc:authority'
process.env.AUTHORITY_DID = AUTHORITY
process.env.AUTHORITY_HANDLE = 'authority.test'
process.env.AUTHORITY_PASSWORD = 'authority-app-password'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { custodialAccount, skillProposal, skillTier, steward } from '../src/db/schema.js'
import { config, resetConfig } from '../src/config.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { setAuthorityClientForTests, type AuthorityClient } from '../src/lib/authority.js'

const SCHOOL = 'did:plc:school'
const MEMBER = 'did:plc:member-a'
const STEWARD = 'did:plc:steward-a'

const root = {
  uri: `at://${AUTHORITY}/freeschool.draft.skill/root`,
  did: AUTHORITY,
  rkey: 'root',
  record: { id: 'root', label: 'Root domain', status: 'canonical', broader: [] },
}
const sibling = {
  uri: `at://${AUTHORITY}/freeschool.draft.skill/existing-sibling`,
  did: AUTHORITY,
  rkey: 'existing-sibling',
  record: { id: 'existing-sibling', label: 'Bread Baking', status: 'canonical', broader: [root.uri] },
}
const slugCollisionNode = {
  uri: `at://${AUTHORITY}/freeschool.draft.skill/garden-tools`,
  did: AUTHORITY,
  rkey: 'garden-tools',
  record: { id: 'garden-tools', label: 'Garden Tool Care (legacy name)', status: 'canonical', broader: [root.uri] },
}
const deprecatedRoot = {
  uri: `at://${AUTHORITY}/freeschool.draft.skill/deprecated-root`,
  did: AUTHORITY,
  rkey: 'deprecated-root',
  record: { id: 'deprecated-root', label: 'Deprecated Root', status: 'deprecated', broader: [] },
}

const records = [root, sibling, slugCollisionNode, deprecatedRoot]
const notified: string[] = []
const fakeDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) }

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({
    contrail: { query: async () => ({ records }) },
    db: fakeDb,
    notify: async (uris: string | string[]) => {
      notified.push(...(Array.isArray(uris) ? uris : [uris]))
    },
  }),
}))

const { createApp } = await import('../src/http/app.js')

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_skill_proposal', 'fs_skill_tier', 'fs_session', 'fs_custodial_account', 'fs_steward')
  notified.length = 0
  process.env.AUTHORITY_DID = AUTHORITY
  process.env.AUTHORITY_HANDLE = 'authority.test'
  process.env.AUTHORITY_PASSWORD = 'authority-app-password'
  resetConfig()
})

afterEach(() => {
  setAuthorityClientForTests(undefined)
})

afterAll(async () => {
  // This file is the one that turns AUTHORITY_* on; leave the environment as this
  // file found it so a suite run after it (e.g. `test/skills.test.ts`, which assumes
  // AUTHORITY_DID is unset) isn't affected by file ordering.
  delete process.env.AUTHORITY_DID
  delete process.env.AUTHORITY_HANDLE
  delete process.env.AUTHORITY_PASSWORD
  resetConfig()
  if (available) await closeTestDb()
})

/** `setCookie` only ever calls `c.header(...)` — see `test/handoff.test.ts`. */
function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function cookieFor(did: string): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

async function makeSteward(did: string): Promise<void> {
  await testDb().insert(steward).values({ did, schoolDid: SCHOOL })
  await testDb()
    .insert(custodialAccount)
    .values({ did, handle: `${did.split(':').pop()}.test`, email: `${did.split(':').pop()}@example.org`, keyVersion: 'v1' })
}

function fakeAuthority(): AuthorityClient & { puts: unknown[]; deprecated: unknown[]; moved: unknown[] } {
  const puts: unknown[] = []
  const deprecated: unknown[] = []
  const moved: unknown[] = []
  return {
    puts,
    deprecated,
    moved,
    async putSkillRecord(record) {
      puts.push(record)
      return { uri: `at://${AUTHORITY}/freeschool.draft.skill/${record.id}`, cid: 'bafyxyz' }
    },
    async deprecateSkill(uri, replacedBy) {
      deprecated.push({ uri, replacedBy })
      return { uri, cid: 'bafydep' }
    },
    async moveSkill(uri, parentUri) {
      moved.push({ uri, parentUri })
      return { uri, cid: 'bafymove' }
    },
  }
}

function post(path: string, body: unknown, cookie?: string) {
  return createApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  })
}

describe('POST /api/skills', () => {
  it('requires a signed-in viewer', async () => {
    if (!available) return
    const res = await post('/api/skills', { label: 'Bike Repair', parentUri: root.uri })
    expect(res.status).toBe(401)
  })

  it('publishes a new proposed skill under the authority', async () => {
    if (!available) return
    const authority = fakeAuthority()
    setAuthorityClientForTests(authority)
    const cookie = await cookieFor(MEMBER)
    const res = await post('/api/skills', { label: 'Bike Repair', description: 'Fixing bikes', parentUri: root.uri }, cookie)
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({ id: 'bike-repair', label: 'Bike Repair', status: 'proposed', tier: 'A' })
    expect(authority.puts).toEqual([
      expect.objectContaining({ id: 'bike-repair', label: 'Bike Repair', broader: [root.uri], status: 'proposed' }),
    ])
    expect(notified).toContain(body.uri)

    const rows = await testDb().select().from(skillProposal)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ skillUri: body.uri, proposerDid: MEMBER, status: 'published' })
  })

  it('sets Tier B and records it when the label matches a sensitive pattern', async () => {
    if (!available) return
    setAuthorityClientForTests(fakeAuthority())
    const cookie = await cookieFor(MEMBER)
    const res = await post('/api/skills', { label: 'Street Medic Basics', parentUri: root.uri }, cookie)
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.tier).toBe('B')

    const rows = await testDb().select().from(skillTier).where(eq(skillTier.skillId, body.id as string))
    expect(rows[0]?.tier).toBe('B')
  })

  it('404s when the parent does not exist', async () => {
    if (!available) return
    setAuthorityClientForTests(fakeAuthority())
    const cookie = await cookieFor(MEMBER)
    const res = await post(
      '/api/skills',
      { label: 'Whatever', parentUri: `at://${AUTHORITY}/freeschool.draft.skill/nonexistent` },
      cookie,
    )
    expect(res.status).toBe(404)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'ParentNotFound' })
  })

  it('400s when the parent is deprecated', async () => {
    if (!available) return
    setAuthorityClientForTests(fakeAuthority())
    const cookie = await cookieFor(MEMBER)
    const res = await post('/api/skills', { label: 'Whatever', parentUri: deprecatedRoot.uri }, cookie)
    expect(res.status).toBe(400)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'ParentDeprecated' })
  })

  it('409s on a slug collision against an existing record anywhere in the tree', async () => {
    if (!available) return
    setAuthorityClientForTests(fakeAuthority())
    const cookie = await cookieFor(MEMBER)
    // slugify('Garden Tools') === 'garden-tools' === slugCollisionNode.record.id, even
    // though the existing record's LABEL text differs.
    const res = await post('/api/skills', { label: 'Garden Tools', parentUri: root.uri }, cookie)
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('SkillExists')
    expect(body.existing).toMatchObject({ uri: slugCollisionNode.uri, id: 'garden-tools', children: [] })
  })

  it('409s on a sibling with the same label once case/diacritics are normalized', async () => {
    if (!available) return
    setAuthorityClientForTests(fakeAuthority())
    const cookie = await cookieFor(MEMBER)
    // Same parent as `sibling` ('Bread Baking'), different case — the slug
    // ('bread-baking') would NOT match `existing-sibling`'s id, so this exercises the
    // sibling-label path specifically, not the slug-collision path.
    const res = await post('/api/skills', { label: 'BREAD BAKING', parentUri: root.uri }, cookie)
    expect(res.status).toBe(409)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.error).toBe('SkillExists')
    expect(body.existing).toMatchObject({ uri: sibling.uri, id: 'existing-sibling' })
  })

  it('429s past 20 proposals in the last 24h', async () => {
    if (!available) return
    setAuthorityClientForTests(fakeAuthority())
    const now = new Date()
    for (let i = 0; i < 20; i++) {
      await testDb()
        .insert(skillProposal)
        .values({ id: `seed-${i}`, skillUri: `at://${AUTHORITY}/freeschool.draft.skill/seed-${i}`, proposerDid: MEMBER, createdAt: now })
    }
    const cookie = await cookieFor(MEMBER)
    const res = await post('/api/skills', { label: 'One Too Many', parentUri: root.uri }, cookie)
    expect(res.status).toBe(429)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'RateLimited' })
  })

  it('503s when the authority credential is not configured', async () => {
    if (!available) return
    setAuthorityClientForTests(fakeAuthority())
    delete process.env.AUTHORITY_HANDLE
    delete process.env.AUTHORITY_PASSWORD
    resetConfig()
    const cookie = await cookieFor(MEMBER)
    const res = await post('/api/skills', { label: 'Whatever', parentUri: root.uri }, cookie)
    expect(res.status).toBe(503)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: 'AuthorityUnavailable' })
  })
})

describe('GET /api/admin/skills/proposals', () => {
  it('requires a steward', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    const res = await createApp().request('/api/admin/skills/proposals', { headers: { cookie } })
    expect(res.status).toBe(403)
  })

  it('lists proposals with the current label/status/path and proposer handle', async () => {
    if (!available) return
    await testDb().insert(skillProposal).values({
      id: 'prop-1',
      skillUri: sibling.uri,
      proposerDid: MEMBER,
    })
    await testDb()
      .insert(custodialAccount)
      .values({ did: MEMBER, handle: 'member-a.test', email: 'member-a@example.org', keyVersion: 'v1' })
    await makeSteward(STEWARD)
    const cookie = await cookieFor(STEWARD)
    const res = await createApp().request('/api/admin/skills/proposals', { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { proposals: Array<Record<string, unknown>> }
    expect(body.proposals).toHaveLength(1)
    expect(body.proposals[0]).toMatchObject({
      id: 'existing-sibling',
      label: 'Bread Baking',
      status: 'canonical',
      path: ['Root domain', 'Bread Baking'],
      proposerHandle: 'member-a.test',
    })
  })
})

describe('POST /api/admin/skills/:id/deprecate', () => {
  it('requires a steward', async () => {
    if (!available) return
    const cookie = await cookieFor(MEMBER)
    const res = await post('/api/admin/skills/existing-sibling/deprecate', {}, cookie)
    expect(res.status).toBe(403)
  })

  it('deprecates via the authority client and marks the proposal row deprecated', async () => {
    if (!available) return
    const authority = fakeAuthority()
    setAuthorityClientForTests(authority)
    await testDb().insert(skillProposal).values({ id: 'prop-1', skillUri: sibling.uri, proposerDid: MEMBER })
    await makeSteward(STEWARD)
    const cookie = await cookieFor(STEWARD)
    const res = await post('/api/admin/skills/existing-sibling/deprecate', { replacedBy: root.uri }, cookie)
    expect(res.status).toBe(200)
    expect(authority.deprecated).toEqual([{ uri: sibling.uri, replacedBy: root.uri }])
    expect(notified).toContain(sibling.uri)

    const rows = await testDb().select().from(skillProposal).where(eq(skillProposal.id, 'prop-1'))
    expect(rows[0]?.status).toBe('deprecated')
  })
})

describe('POST /api/admin/skills/:id/move', () => {
  it('moves via the authority client', async () => {
    if (!available) return
    const authority = fakeAuthority()
    setAuthorityClientForTests(authority)
    await makeSteward(STEWARD)
    const cookie = await cookieFor(STEWARD)
    const newParent = `at://${AUTHORITY}/freeschool.draft.skill/new-parent`
    const res = await post('/api/admin/skills/existing-sibling/move', { parentUri: newParent }, cookie)
    expect(res.status).toBe(200)
    expect(authority.moved).toEqual([{ uri: sibling.uri, parentUri: newParent }])
    expect(notified).toContain(sibling.uri)
  })
})
