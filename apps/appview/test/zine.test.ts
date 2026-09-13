/**
 * The monthly print zine shares the calendar's redaction rules exactly — it reuses
 * `projectEvent` at the 'public' relation — so what is specific to the zine and worth
 * pinning here is: parsing the `yyyy-mm` month into a query window, and grouping already-
 * projected events by day. Pure, no DB.
 */
import { describe, expect, it } from 'vitest'
import { groupByDay, monthRange } from '../src/http/routes/zine.js'
import { projectEvent, type CalendarEvent, type ListingInputs } from '../src/http/visibility.js'

describe('monthRange', () => {
  it('parses a yyyy-mm into UTC month boundaries', () => {
    const range = monthRange('2026-10')
    expect(range).not.toBeNull()
    expect(range!.fromIso).toBe('2026-10-01T00:00:00.000Z')
    expect(range!.toIso).toBe('2026-11-01T00:00:00.000Z')
  })

  it('rolls over a December correctly', () => {
    const range = monthRange('2026-12')
    expect(range!.toIso).toBe('2027-01-01T00:00:00.000Z')
  })

  it('rejects anything that is not yyyy-mm', () => {
    expect(monthRange('2026-10-01')).toBeNull()
    expect(monthRange('not-a-month')).toBeNull()
    expect(monthRange('2026-13')).toBeNull()
  })
})

describe('groupByDay', () => {
  const ref = { uri: 'at://did:plc:host/community.lexicon.calendar.event/1', cid: 'bafy' }
  const inputs: ListingInputs = {
    listings: [{ event: ref, school: 'did:plc:school', status: 'listed' }],
    configs: [{ event: ref, visibility: 'listed', neighborhood: 'North Boulder' }],
  }

  const sourdough: CalendarEvent = {
    uri: 'at://did:plc:host/community.lexicon.calendar.event/1',
    hostDid: 'did:plc:host',
    name: 'Sourdough for beginners',
    startsAt: '2026-10-01T18:00:00Z',
    locations: [{ $type: 'community.lexicon.location.address', street: '1412 Juniper Ave', locality: 'Boulder' }],
  }
  const bikeRepair: CalendarEvent = {
    uri: 'at://did:plc:host2/community.lexicon.calendar.event/2',
    hostDid: 'did:plc:host2',
    name: 'Bike repair',
    startsAt: '2026-10-01T10:00:00Z',
  }
  const knitting: CalendarEvent = {
    uri: 'at://did:plc:host3/community.lexicon.calendar.event/3',
    hostDid: 'did:plc:host3',
    name: 'Knitting circle',
    startsAt: '2026-10-15T12:00:00Z',
  }

  it('groups by the UTC date of startsAt, sorted by day then by time within the day', () => {
    const projected = [sourdough, knitting, bikeRepair].map((e) => projectEvent(e, inputs, 'public'))
    const days = groupByDay(projected)
    expect(days.map((d) => d.date)).toEqual(['2026-10-01', '2026-10-15'])
    expect(days[0]!.events.map((e) => e.name)).toEqual(['Bike repair', 'Sourdough for beginners'])
  })

  it('redacts the address — the public view never carries the street', () => {
    const projected = projectEvent(sourdough, inputs, 'public')
    const days = groupByDay([projected])
    expect(JSON.stringify(days)).not.toContain('Juniper')
    expect(days[0]!.events[0]).not.toHaveProperty('locations')
  })

  it('includes a venue-needed class, marked venueNeeded: true', () => {
    const noVenue: CalendarEvent = {
      uri: 'at://did:plc:host4/community.lexicon.calendar.event/4',
      hostDid: 'did:plc:host4',
      name: 'Sign painting (venue needed)',
      startsAt: '2026-10-20T12:00:00Z',
    }
    const projected = projectEvent(noVenue, { listings: [], configs: [] }, 'public')
    const days = groupByDay([projected])
    expect(days[0]!.events[0]!.venueNeeded).toBe(true)
  })

  it('drops an event with no startsAt rather than crashing', () => {
    const timeless: CalendarEvent = { uri: 'u', hostDid: 'd', name: 'whenever' }
    const projected = projectEvent(timeless, { listings: [], configs: [] }, 'public')
    expect(groupByDay([projected])).toEqual([])
  })
})
