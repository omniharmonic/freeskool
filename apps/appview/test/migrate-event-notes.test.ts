/**
 * TASK 19c, the one-off repair (`scripts/migrate-event-notes.ts`).
 *
 * Every class published before 19c has the host's attendee notes sitting in the PUBLIC
 * record's `description` and their meeting link in `uris` — the two fields the class form
 * promised were "shown after RSVP". The script moves both app-side and rewrites the
 * record's `description` from the app-side public overview.
 *
 * What is asserted here is the DRY RUN: which records it considers affected, what it would
 * move, and — the part that matters for R9 — that its output is counts only. The rewrite
 * itself goes through `actorAgent` + `putInActorRepo`, the same path a host's own edit
 * uses, which `event-notes-placement.test.ts` covers.
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'migrate-notes-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 11).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'migrate-notes-test-pepper'
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'

const CUSTODIAL = 'did:plc:migrate-custodial-host'
const OAUTH = 'did:plc:migrate-oauth-host'

interface Indexed { uri: string; did: string; value: Record<string, unknown> }
const records = vi.hoisted(() => [] as Indexed[])

vi.mock('../src/index/indexer.js', () => ({ getIndexer: async () => ({ notify: async () => {} }) }))

vi.mock('../src/index/queries.js', async () => {
  const actual = await vi.importActual<typeof import('../src/index/queries.js')>('../src/index/queries.js')
  return {
    ...actual,
    listCollection: async () => ({
      records: records.map((r) => ({ ...r, collection: 'community.lexicon.calendar.event', rkey: r.uri.split('/').pop()!, cid: 'bafy' })),
    }),
  }
})

import { custodialAccount } from '../src/db/schema.js'
import { savePresentation } from '../src/lib/event-presentation.js'
import { setEventExtra } from '../src/lib/event-extra.js'
import { isKnownMeetingHost, looksLikeMeetingLink, migrateEventNotes } from '../scripts/migrate-event-notes.js'

const uriFor = (did: string, rkey: string) => `at://${did}/community.lexicon.calendar.event/${rkey}`

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_event_extra', 'fs_app_meta', 'fs_custodial_account')
  records.length = 0
  await testDb().insert(custodialAccount).values({ did: CUSTODIAL, handle: 'host.test', email: 'h@example.org', keyVersion: 'v1' })
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('the meeting-link heuristic (pure)', () => {
  it('takes any http(s) URL — the field had exactly one producer, the class form', () => {
    expect(looksLikeMeetingLink('https://zoom.us/j/123')).toBe(true)
    expect(looksLikeMeetingLink('http://meet.example.org/x')).toBe(true)
    expect(looksLikeMeetingLink('mailto:someone@example.org')).toBe(false)
    expect(looksLikeMeetingLink('at://did:plc:x/y/z')).toBe(false)
    expect(looksLikeMeetingLink('side door, code 1234')).toBe(false)
    expect(looksLikeMeetingLink(undefined)).toBe(false)
  })

  it('reports the obvious services separately, without narrowing what is moved', () => {
    expect(isKnownMeetingHost('https://us02web.zoom.us/j/123')).toBe(true)
    expect(isKnownMeetingHost('https://meet.google.com/abc-defg')).toBe(true)
    expect(isKnownMeetingHost('https://meet.jit.si/freeschool')).toBe(true)
    expect(isKnownMeetingHost('https://example.org/room')).toBe(false)
  })
})

describe('migrateEventNotes --dry-run', () => {
  it('counts a legacy class and moves nothing', async () => {
    if (!available) return
    const uri = uriFor(CUSTODIAL, 'legacy')
    records.push({ uri, did: CUSTODIAL, value: { description: 'Side door, code 1234', uris: [{ uri: 'https://us02web.zoom.us/j/123' }] } })
    await savePresentation(uri, { publicOverview: { description: 'Learn to grow oyster mushrooms.' } })

    const counts = await migrateEventNotes({ dryRun: true })
    expect(counts).toMatchObject({ scanned: 1, affected: 1, repaired: 0, notesMoved: 1, linksMoved: 1, linksOnKnownHosts: 1, skippedNoCredential: 0, failed: 0 })
    // Dry: the app-side row is still empty.
    const { getEventExtra } = await import('../src/lib/event-extra.js')
    expect(await getEventExtra(uri)).toEqual({ materials: [] })
  })

  it('leaves an already-repaired class alone — the run is idempotent by construction', async () => {
    if (!available) return
    const uri = uriFor(CUSTODIAL, 'repaired')
    records.push({ uri, did: CUSTODIAL, value: { description: 'Learn to grow oyster mushrooms.' } })
    await savePresentation(uri, { publicOverview: { description: 'Learn to grow oyster mushrooms.' } })
    await setEventExtra(uri, { materials: [], attendeeNotes: 'Side door, code 1234' })

    expect(await migrateEventNotes({ dryRun: true })).toMatchObject({ scanned: 1, affected: 0, notesMoved: 0, linksMoved: 0 })
  })

  it('ignores a class with no app-side overview — without that pair it is a guess, not a fact', async () => {
    if (!available) return
    records.push({ uri: uriFor(CUSTODIAL, 'no-overview'), did: CUSTODIAL, value: { description: 'Bring a jar.' } })
    expect(await migrateEventNotes({ dryRun: true })).toMatchObject({ scanned: 1, affected: 0 })
  })

  it('counts, and never rewrites, a repo we hold no credential for (the OAuth door, the school)', async () => {
    if (!available) return
    const uri = uriFor(OAUTH, 'legacy')
    records.push({ uri, did: OAUTH, value: { description: 'Side door, code 1234' } })
    await savePresentation(uri, { publicOverview: { description: 'Learn to grow oyster mushrooms.' } })

    const counts = await migrateEventNotes({ dryRun: true })
    expect(counts).toMatchObject({ scanned: 1, affected: 1, skippedNoCredential: 1, notesMoved: 0, repaired: 0 })
  })

  it('reports only numbers — no DID, no handle, no note text (R9)', async () => {
    if (!available) return
    const uri = uriFor(CUSTODIAL, 'legacy')
    records.push({ uri, did: CUSTODIAL, value: { description: 'Side door, code 1234', uris: [{ uri: 'https://us02web.zoom.us/j/123' }] } })
    await savePresentation(uri, { publicOverview: { description: 'Learn to grow oyster mushrooms.' } })
    const counts = await migrateEventNotes({ dryRun: true })
    for (const value of Object.values(counts)) expect(typeof value).toBe('number')
    const serialized = JSON.stringify(counts)
    expect(serialized).not.toContain('did:plc')
    expect(serialized).not.toContain('code 1234')
    expect(serialized).not.toContain('zoom')
  })
})
