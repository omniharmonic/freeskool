/**
 * Task 12's event-spec gaps, all app-side (R9: no roster, no lexicon change needed):
 *
 *   - materials / suppliesNote  — `fs_event_extra`, one row per event (`lib/event-extra.ts`)
 *   - waitlist                  — `fs_rsvp.status = 'waitlisted'`, ordered by `createdAt`
 *                                  (`lib/rsvp.ts#resolveGoingOrWaitlist` / `promoteFromWaitlist`
 *                                  / `waitlistPosition`)
 *   - the roster                — `GET /api/events/:id/rsvps`, gated by the PURE decision
 *                                  `lib/events.ts#canViewRoster` so "forbidden for a
 *                                  non-host member, visible to the host" is a unit test
 *                                  that cannot silently regress through a route refactor;
 *                                  `lib/rsvp.ts#rsvpRoster` is the DB-backed shape it reads.
 *
 * All of this needs only a real Postgres (`fs_*` tables) — none of it needs a live PDS or
 * an indexed event, so the suite skips gracefully (never fails) when Postgres is
 * unreachable, same as every other DB-backed suite in this package.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Role } from '@freeschool/shared'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'
import { canViewRoster } from '../src/lib/events.js'
import { getEventExtra, setEventExtra } from '../src/lib/event-extra.js'
import {
  goingCount,
  promoteFromWaitlist,
  resolveGoingOrWaitlist,
  rsvpCounts,
  rsvpRoster,
  upsertRsvp,
  waitlistPosition,
} from '../src/lib/rsvp.js'

const EVENT = 'at://did:plc:host/community.lexicon.calendar.event/3abc'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_event_extra', 'fs_rsvp')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('fs_event_extra — materials / suppliesNote round-trip', () => {
  it('an event with neither set reads back an empty materials list and no note', async () => {
    if (!available) return
    expect(await getEventExtra(EVENT)).toEqual({ materials: [] })
  })

  it('round-trips materials and a supplies note', async () => {
    if (!available) return
    await setEventExtra(EVENT, ['a padlock', 'gloves'], 'bring your own bike if you have one')
    expect(await getEventExtra(EVENT)).toEqual({
      materials: ['a padlock', 'gloves'],
      suppliesNote: 'bring your own bike if you have one',
    })
  })

  it('a second write replaces the full value (upsert, not append)', async () => {
    if (!available) return
    await setEventExtra(EVENT, ['gloves'], 'note one')
    await setEventExtra(EVENT, ['a lock'])
    expect(await getEventExtra(EVENT)).toEqual({ materials: ['a lock'] })
  })

  it('is scoped per event', async () => {
    if (!available) return
    await setEventExtra(EVENT, ['gloves'])
    expect(await getEventExtra('at://did:plc:host/community.lexicon.calendar.event/other')).toEqual({ materials: [] })
  })
})

describe('waitlist — resolveGoingOrWaitlist', () => {
  it('an uncapped event always resolves to going', async () => {
    if (!available) return
    expect(await resolveGoingOrWaitlist(EVENT, 'did:plc:a', undefined)).toBe('going')
  })

  it('the first `capacity` RSVPs get going; the next gets waitlisted', async () => {
    if (!available) return
    for (const did of ['did:plc:a', 'did:plc:b']) {
      const status = await resolveGoingOrWaitlist(EVENT, did, 2)
      expect(status).toBe('going')
      await upsertRsvp({ eventUri: EVENT, did, status })
    }
    const third = await resolveGoingOrWaitlist(EVENT, 'did:plc:c', 2)
    expect(third).toBe('waitlisted')
  })

  it('re-confirming an existing going spot never counts against yourself (no self-bump to waitlisted)', async () => {
    if (!available) return
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:a', status: 'going' })
    expect(await goingCount(EVENT, 'did:plc:a')).toBe(0) // excludes self
    expect(await resolveGoingOrWaitlist(EVENT, 'did:plc:a', 1)).toBe('going')
  })
})

describe('waitlist — promoteFromWaitlist', () => {
  it('promotes the earliest-by-createdAt waitlisted row, first come first served', async () => {
    if (!available) return
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:first', status: 'waitlisted' })
    await new Promise((r) => setTimeout(r, 5))
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:second', status: 'waitlisted' })

    const promoted = await promoteFromWaitlist(EVENT)
    expect(promoted).toEqual({ did: 'did:plc:first' })

    const counts = await rsvpCounts(EVENT)
    expect(counts.going).toBe(1)
    expect(counts.waitlisted).toBe(1)
  })

  it('returns null when nobody is waiting', async () => {
    if (!available) return
    expect(await promoteFromWaitlist(EVENT)).toBeNull()
  })
})

describe('waitlist — waitlistPosition', () => {
  it('is null for a non-waitlisted (or absent) RSVP', async () => {
    if (!available) return
    expect(await waitlistPosition(EVENT, 'did:plc:nobody')).toBeNull()
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:a', status: 'going' })
    expect(await waitlistPosition(EVENT, 'did:plc:a')).toBeNull()
  })

  it('is 1-based and reflects queue order', async () => {
    if (!available) return
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:a', status: 'waitlisted' })
    await new Promise((r) => setTimeout(r, 5))
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:b', status: 'waitlisted' })
    await new Promise((r) => setTimeout(r, 5))
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:c', status: 'waitlisted' })

    expect(await waitlistPosition(EVENT, 'did:plc:a')).toBe(1)
    expect(await waitlistPosition(EVENT, 'did:plc:b')).toBe(2)
    expect(await waitlistPosition(EVENT, 'did:plc:c')).toBe(3)
  })
})

describe('canViewRoster (pure) — the roster\'s one authorization rule', () => {
  const HOST = 'did:plc:host'
  const MEMBER = 'did:plc:member'

  it('the host of this event may always see the roster', () => {
    expect(canViewRoster(HOST, HOST, Role.Member)).toBe(true)
  })

  it('an ordinary member who is not the host is forbidden', () => {
    expect(canViewRoster(HOST, MEMBER, Role.Member)).toBe(false)
    expect(canViewRoster(HOST, MEMBER, Role.Host)).toBe(false)
  })

  it('a steward may see the roster for ANY event, not just their own', () => {
    expect(canViewRoster(HOST, MEMBER, Role.Steward)).toBe(true)
  })
})

describe('rsvpRoster — the DB-backed shape the route reads', () => {
  it('lists every RSVP, did + status + createdAt, in registration order', async () => {
    if (!available) return
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:a', status: 'going' })
    await new Promise((r) => setTimeout(r, 5))
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:b', status: 'waitlisted' })

    const roster = await rsvpRoster(EVENT)
    expect(roster.map((r) => r.did)).toEqual(['did:plc:a', 'did:plc:b'])
    expect(roster.map((r) => r.status)).toEqual(['going', 'waitlisted'])
    for (const r of roster) expect(r.createdAt).toBeInstanceOf(Date)
  })

  it('never includes anyone from a different event', async () => {
    if (!available) return
    await upsertRsvp({ eventUri: EVENT, did: 'did:plc:a', status: 'going' })
    await upsertRsvp({ eventUri: 'at://did:plc:host/community.lexicon.calendar.event/other', did: 'did:plc:z', status: 'going' })
    const roster = await rsvpRoster(EVENT)
    expect(roster.map((r) => r.did)).toEqual(['did:plc:a'])
  })
})
