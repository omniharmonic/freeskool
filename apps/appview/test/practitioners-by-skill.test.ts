/**
 * Interop gap 10 (P2). `GET /api/practitioners?skill=` used to pull the FIRST 1000
 * `freeschool.draft.skillClaim` records in the whole index and filter them in memory —
 * so the moment the index holds more than a thousand claims, a public skill page
 * silently starts showing the wrong people (and eventually nobody at all).
 *
 * The index can answer the question directly: `skillClaim` declares `skill` queryable
 * (`contrail.config.ts`), exactly as `me.ts` filters attestations by `subject`. The
 * fake index below answers ONLY filtered queries the way contrail does, so a route that
 * forgets the filter sees a page of unrelated claims and returns nobody.
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'practitioners-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'practitioners-test-pepper'

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { appMeta, membership } from '../src/db/schema.js'

const SKILL = 'at://did:plc:school/freeschool.draft.skill/bike-repair'
const OTHER = 'at://did:plc:school/freeschool.draft.skill/sourdough'
const PRACTITIONER = 'did:plc:practitioner-1200'

/** Every query contrail was asked, so the test can assert the filter was pushed down. */
const asked = vi.hoisted(() => [] as Array<{ short: string; options: Record<string, unknown> }>)

/**
 * 1200 claims. The one that matters is LAST, well past the old 1000-record scan — and
 * this fake, like contrail, clamps a page to 200 rows and only narrows on `filters`.
 */
const claims = vi.hoisted(() => {
  const rows: Array<{ uri: string; did: string; rkey: string; cid: string; record: Record<string, unknown> }> = []
  for (let i = 0; i < 1199; i++) {
    const did = `did:plc:noise-${i}`
    rows.push({ uri: `at://${did}/freeschool.draft.skillClaim/${i}`, did, rkey: String(i), cid: 'bafyclaim', record: { skill: 'at://did:plc:school/freeschool.draft.skill/sourdough', level: 'practicing' } })
  }
  rows.push({
    uri: `at://did:plc:practitioner-1200/freeschool.draft.skillClaim/last`,
    did: 'did:plc:practitioner-1200',
    rkey: 'last',
    cid: 'bafyclaim',
    record: { skill: 'at://did:plc:school/freeschool.draft.skill/bike-repair', level: 'teaching' },
  })
  return rows
})

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({
    contrail: {
      async query(short: string, options: Record<string, unknown> = {}) {
        asked.push({ short, options })
        if (short !== 'skillClaim') return { records: [] }
        const filters = (options.filters ?? {}) as Record<string, unknown>
        const matching = claims.filter((r) => !filters.skill || r.record.skill === filters.skill)
        // Contrail clamps every page to 200 rows, whatever the caller asked for.
        const start = Number(options.cursor ?? 0)
        const page = matching.slice(start, start + 200)
        const next = start + page.length
        return { records: page, ...(next < matching.length ? { cursor: String(next) } : {}) }
      },
    },
    notify: async () => {},
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
  await truncate('fs_app_meta', 'fs_membership')
  asked.length = 0
  await testDb()
    .insert(appMeta)
    .values({
      key: `profile:${PRACTITIONER}`,
      value: { displayName: 'A neighbor who fixes bikes', bio: 'Tuesdays at the shop.', publicListing: true },
      updatedAt: new Date(),
    })
  // `GET /api/practitioners` scopes to `currentSchool`'s membership (MS §10); SCHOOL_DID
  // is unset in this file, so that's the legacy `''` school.
  await testDb().insert(membership).values({ did: PRACTITIONER, schoolDid: '', door: 'custodial' })
})

afterAll(async () => {
  if (available) await closeTestDb()
})

it('finds a practitioner whose claim is the 1200th in the index, by asking the index for the skill', async () => {
  if (!available) return
  const res = await createApp().request(`/api/practitioners?skill=${encodeURIComponent(SKILL)}`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { profiles: Array<{ did: string; displayName: string; level?: string }> }
  expect(body.profiles).toHaveLength(1)
  expect(body.profiles[0]).toMatchObject({ did: PRACTITIONER, level: 'teaching' })

  // The filter was pushed into the index rather than applied after a bounded scan.
  const claimQueries = asked.filter((q) => q.short === 'skillClaim')
  expect(claimQueries.length).toBeGreaterThan(0)
  for (const q of claimQueries) expect(q.options.filters).toMatchObject({ skill: SKILL })
})

it('returns nobody for a skill nobody has claimed publicly, without scanning the collection', async () => {
  if (!available) return
  const res = await createApp().request(`/api/practitioners?skill=${encodeURIComponent(OTHER)}`)
  expect(((await res.json()) as { profiles: unknown[] }).profiles).toEqual([])
})
