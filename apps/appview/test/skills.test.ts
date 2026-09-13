/**
 * `/api/skills` visibility and authority scoping (refinement Task 1):
 *
 *   - `proposed` skill nodes are included in the tree by default (production was
 *     hiding 306 of 525 seeded skills); `?includeProposed=0` restores the old,
 *     hidden behavior for anyone who wants it.
 *   - `deprecated` nodes stay out of the tree unless `?includeDeprecated=1`, but
 *     `GET /skills/:id` must still resolve a deprecated node directly (an existing
 *     claim against it must keep working).
 *   - When `AUTHORITY_DID` is configured, both routes ignore any skill record
 *     written by a different DID — this is how a dev index with two duplicate
 *     taxonomy authorities gets scoped down to one.
 *
 * `getIndexer` is mocked to hand the route a fixed, in-memory `skill` collection —
 * no contrail/Postgres indexing needed for this. `tiersFor` (`lib/skill-tiers.ts`)
 * still hits the real, already-running Postgres and defaults every unseeded id to
 * Tier A, which is fine here: tiering isn't what this suite is about.
 */
process.env.SCHOOL_DID ??= 'did:plc:skills-test-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'skills-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 5).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'skills-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'
// A developer shell that exported the repo .env carries AUTHORITY_DID; these tests own it.
delete process.env.AUTHORITY_DID

import { afterEach, describe, expect, it, vi } from 'vitest'
import { config, resetConfig } from '../src/config.js'

const AUTHORITY = 'did:plc:authority'
const OTHER = 'did:plc:other-school'

const root = {
  uri: `at://${AUTHORITY}/freeschool.draft.skill/root`,
  did: AUTHORITY,
  rkey: 'root',
  record: { id: 'root', label: 'Root domain', status: 'canonical', broader: [] },
}
const proposedChild = {
  uri: `at://${AUTHORITY}/freeschool.draft.skill/proposed-child`,
  did: AUTHORITY,
  rkey: 'proposed-child',
  record: { id: 'proposed-child', label: 'Proposed Child', status: 'proposed', broader: [root.uri] },
}
const deprecatedChild = {
  uri: `at://${AUTHORITY}/freeschool.draft.skill/deprecated-child`,
  did: AUTHORITY,
  rkey: 'deprecated-child',
  record: { id: 'deprecated-child', label: 'Deprecated Child', status: 'deprecated', broader: [root.uri] },
}
const foreignRoot = {
  uri: `at://${OTHER}/freeschool.draft.skill/foreign-root`,
  did: OTHER,
  rkey: 'foreign-root',
  record: { id: 'foreign-root', label: 'Foreign Root', status: 'canonical', broader: [] },
}

const allRecords = [root, proposedChild, deprecatedChild, foreignRoot]

// `GET /skills/:id` also looks up `skillLevel` sidecars via `indexer.db.prepare(...)`
// (`sidecarsForEvent`, `index/queries.ts`) — a plain SQL path contrail's `.query()`
// mock above doesn't cover, so it needs its own tiny stub returning no rows.
const fakeDb = { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) }

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({ contrail: { query: async () => ({ records: allRecords }) }, db: fakeDb }),
}))

const { createApp } = await import('../src/http/app.js')

afterEach(() => {
  delete process.env.AUTHORITY_DID
  resetConfig()
})

async function tree(qs = '') {
  const res = await createApp().request(`/api/skills${qs}`)
  expect(res.status).toBe(200)
  return (await res.json()) as { skills: Array<Record<string, unknown>> }
}

function labels(body: { skills: Array<Record<string, unknown>> }): string[] {
  const out: string[] = []
  const walk = (nodes: Array<Record<string, unknown>>) => {
    for (const n of nodes) {
      out.push(n.label as string)
      walk((n.children as Array<Record<string, unknown>>) ?? [])
    }
  }
  walk(body.skills)
  return out
}

describe('GET /api/skills — proposed visibility', () => {
  it('includes a proposed node in the tree by default', async () => {
    expect(labels(await tree())).toContain('Proposed Child')
  })

  it('hides the proposed node when includeProposed=0', async () => {
    expect(labels(await tree('?includeProposed=0'))).not.toContain('Proposed Child')
  })
})

describe('GET /api/skills — deprecated visibility', () => {
  it('excludes a deprecated node from the tree by default', async () => {
    expect(labels(await tree())).not.toContain('Deprecated Child')
  })

  it('includes a deprecated node when includeDeprecated=1', async () => {
    expect(labels(await tree('?includeDeprecated=1'))).toContain('Deprecated Child')
  })
})

describe('GET /api/skills/:id — deprecated nodes still resolve', () => {
  it('resolves a deprecated node directly even though it is hidden from the tree', async () => {
    const res = await createApp().request(`/api/skills/${encodeURIComponent(deprecatedChild.uri)}`)
    expect(res.status).toBe(200)
    expect((await res.json()).label).toBe('Deprecated Child')
  })
})

describe('authority scoping (AUTHORITY_DID)', () => {
  it('with no AUTHORITY_DID configured, a record from any DID appears in the tree', async () => {
    expect(labels(await tree())).toContain('Foreign Root')
  })

  it('once AUTHORITY_DID is set, a record from another DID is excluded from the tree', async () => {
    process.env.AUTHORITY_DID = AUTHORITY
    resetConfig()
    expect(config().AUTHORITY_DID).toBe(AUTHORITY)
    expect(labels(await tree())).not.toContain('Foreign Root')
    expect(labels(await tree())).toContain('Root domain')
  })

  it('once AUTHORITY_DID is set, the detail route 404s for a record from another DID', async () => {
    process.env.AUTHORITY_DID = AUTHORITY
    resetConfig()
    const res = await createApp().request(`/api/skills/${encodeURIComponent(foreignRoot.uri)}`)
    expect(res.status).toBe(404)
  })
})
