/**
 * TASK 19c — WHERE THE HOST'S WORDS GO.
 *
 * The bug this suite pins down: the class form offered the host a field described as
 * "Extra notes for people attending. Shown after RSVP on this school's pages." and a
 * meeting link "available to attendees after they RSVP", and then wrote both into
 * `community.lexicon.calendar.event` — a PUBLIC record in the host's own repo, readable
 * by anyone with the PDS host. At the same time the text the host wrote FOR the public
 * (`publicOverview.description`) was app-side only, so a peer AppView or a calendar
 * client saw a class with no description at all. Both directions were wrong.
 *
 * The rule now, asserted below: the record's `description` is the PUBLIC overview and
 * nothing else, the record has no `uris`, and the notes and the link are rows in
 * `fs_event_extra` (`lib/event-extra.ts`), revealed by the same gate as the address.
 */
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'event-notes-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'event-notes-test-pepper'
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'

const HOST = 'did:plc:notes-host'
const VIEWER = { did: HOST, kind: 'custodial' as const, sessionId: 'event-notes-test' }

/** Every record this run wrote, newest last, keyed by collection. */
const written = vi.hoisted(() => [] as Array<{ collection: string; rkey: string; record: Record<string, unknown> }>)
/** What the index currently believes the event record says (the update path reads it). */
const indexed = vi.hoisted(() => ({ value: {} as Record<string, unknown>, uri: '' }))

vi.mock('../src/lib/actor-agent.js', () => ({
  NoActorCredentialError: class extends Error {},
  actorAgent: async () => ({
    com: {
      atproto: {
        repo: {
          putRecord: async ({ collection, rkey, record }: { collection: string; rkey: string; record: Record<string, unknown> }) => {
            written.push({ collection, rkey, record })
            return { data: { uri: `at://${HOST}/${collection}/${rkey}`, cid: `bafy-${rkey}` } }
          },
          deleteRecord: async () => ({}),
        },
      },
    },
  }),
}))

vi.mock('../src/index/indexer.js', () => ({ getIndexer: async () => ({ notify: async () => {} }) }))

vi.mock('../src/lib/pds.js', async () => ({
  ...(await vi.importActual('../src/lib/pds.js')),
  // `schoolRoutingTags()` reads the school record; nothing here routes, but it must not
  // reach the network to find that out.
  getRecord: async () => ({ uri: 'at://did:plc:school/freeschool.draft.school/self', cid: 'bafyschool', value: { tags: ['skillshare'] } }),
}))

vi.mock('../src/index/queries.js', async () => {
  const actual = await vi.importActual<typeof import('../src/index/queries.js')>('../src/index/queries.js')
  return {
    ...actual,
    getRecordByUri: async (_i: unknown, _short: string, uri: string) =>
      uri === indexed.uri ? { uri, did: HOST, collection: 'community.lexicon.calendar.event', rkey: uri.split('/').pop()!, cid: 'bafyevent', value: indexed.value } : null,
    sidecarsForEvent: async () => [],
  }
})

import { createEventAsHost, updateEventAsHost, attendeeFields } from '../src/lib/events.js'
import { getEventExtra } from '../src/lib/event-extra.js'
import { getPresentation } from '../src/lib/event-presentation.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_event_extra', 'fs_app_meta', 'fs_attendance_tally', 'fs_feedback_window', 'fs_series_occurrence')
  written.length = 0
})

afterAll(async () => {
  if (available) await closeTestDb()
})

const INPUT = {
  name: 'Growing mushrooms at home',
  startsAt: '2026-10-01T18:00:00.000Z',
  endsAt: '2026-10-01T20:00:00.000Z',
  publicOverview: { description: 'Learn to grow oyster mushrooms.', audience: 'Beginners', accessibility: 'Seating available' },
  attendeeNotes: 'Come to the side door; the code is 1234.',
  meetingLink: 'https://meet.example.org/mushrooms',
}

function lastEvent() {
  return [...written].reverse().find((w) => w.collection === 'community.lexicon.calendar.event')!.record
}

describe('createEventAsHost — what reaches the public record', () => {
  it('writes the PUBLIC overview as the record’s description, and neither the notes nor the link', async () => {
    if (!available) return
    const created = await createEventAsHost(VIEWER, INPUT)
    const record = lastEvent()
    expect(record.description).toBe('Learn to grow oyster mushrooms.')
    expect(record.uris).toBeUndefined()
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('side door')
    expect(serialized).not.toContain('code is 1234')
    expect(serialized).not.toContain('meet.example.org')
    // `audience` / `accessibility` have no home on the borrowed record and stay app-side.
    expect(serialized).not.toContain('Seating available')
    expect((await getPresentation(created.event.uri)).publicOverview).toEqual(INPUT.publicOverview)
  })

  it('puts the notes and the link in fs_event_extra instead', async () => {
    if (!available) return
    const created = await createEventAsHost(VIEWER, { ...INPUT, materials: ['A jar'] })
    expect(await getEventExtra(created.event.uri)).toEqual({
      materials: ['A jar'],
      attendeeNotes: 'Come to the side door; the code is 1234.',
      meetingLink: 'https://meet.example.org/mushrooms',
    })
  })

  it('a class with no public overview publishes a record with no description at all', async () => {
    if (!available) return
    const created = await createEventAsHost(VIEWER, { ...INPUT, publicOverview: undefined })
    expect(lastEvent().description).toBeUndefined()
    expect((await getEventExtra(created.event.uri)).attendeeNotes).toBe('Come to the side door; the code is 1234.')
  })

  it('accepts the DEPRECATED `description` / `uris` body fields and routes them app-side', async () => {
    if (!available) return
    const created = await createEventAsHost(VIEWER, {
      name: INPUT.name,
      startsAt: INPUT.startsAt,
      publicOverview: INPUT.publicOverview,
      description: 'Come to the side door.',
      uris: [{ uri: 'https://meet.example.org/legacy', name: 'Class meeting link' }],
    })
    expect(lastEvent().description).toBe('Learn to grow oyster mushrooms.')
    expect(lastEvent().uris).toBeUndefined()
    expect(await getEventExtra(created.event.uri)).toEqual({
      materials: [],
      attendeeNotes: 'Come to the side door.',
      meetingLink: 'https://meet.example.org/legacy',
    })
  })
})

describe('attendeeFields — the deprecated-name mapping (pure)', () => {
  it('prefers the new names and treats an omitted key as "leave alone"', () => {
    expect(attendeeFields({})).toEqual({})
    expect(attendeeFields({ description: 'notes' })).toEqual({ attendeeNotes: 'notes' })
    expect(attendeeFields({ attendeeNotes: 'new', description: 'old' })).toEqual({ attendeeNotes: 'new' })
    expect(attendeeFields({ uris: [{ uri: 'https://x.example' }] })).toEqual({ meetingLink: 'https://x.example' })
  })

  it('an EXPLICIT empty `uris` clears the link rather than leaving it alone', () => {
    expect(attendeeFields({ uris: [] })).toEqual({ meetingLink: '' })
  })
})

describe('updateEventAsHost — the edit path repairs a class published before 19c', () => {
  it('rewrites the record’s description from the app-side overview and drops the legacy uris', async () => {
    if (!available) return
    // A class as it exists TODAY on a pre-19c deployment: notes in `description`, the
    // meeting link in `uris`, the real public text app-side only.
    const created = await createEventAsHost(VIEWER, INPUT)
    indexed.uri = created.event.uri
    indexed.value = {
      $type: 'community.lexicon.calendar.event',
      name: INPUT.name,
      description: 'Come to the side door; the code is 1234.',
      uris: [{ uri: 'https://meet.example.org/mushrooms', name: 'Class meeting link' }],
      startsAt: INPUT.startsAt,
      rsvpExpected: true,
    }
    written.length = 0

    await updateEventAsHost(VIEWER, created.event.uri, { name: 'Growing mushrooms at home, again' })
    const record = lastEvent()
    expect(record.name).toBe('Growing mushrooms at home, again')
    expect(record.description).toBe('Learn to grow oyster mushrooms.')
    expect(record.uris).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain('code is 1234')
    // Omitting both keys means "leave alone": the app-side row is untouched.
    expect(await getEventExtra(created.event.uri)).toEqual({
      materials: [],
      attendeeNotes: 'Come to the side door; the code is 1234.',
      meetingLink: 'https://meet.example.org/mushrooms',
    })
  })

  it('an explicitly empty meeting link clears the row without ever touching the record', async () => {
    if (!available) return
    const created = await createEventAsHost(VIEWER, INPUT)
    indexed.uri = created.event.uri
    indexed.value = { $type: 'community.lexicon.calendar.event', name: INPUT.name, startsAt: INPUT.startsAt }
    written.length = 0
    await updateEventAsHost(VIEWER, created.event.uri, { meetingLink: '', attendeeNotes: '' })
    expect(await getEventExtra(created.event.uri)).toEqual({ materials: [] })
    expect(lastEvent().uris).toBeUndefined()
  })
})
