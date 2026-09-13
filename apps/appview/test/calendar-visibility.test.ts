/**
 * The visibility rules are the privacy boundary of the public calendar, so they are
 * pinned here rather than only exercised through HTTP.
 */
import { describe, expect, it } from 'vitest'
import {
  icsLocation,
  isListed,
  neighborhoodOf,
  projectEvent,
  seesFullLocation,
  type CalendarEvent,
  type ListingInputs,
} from '../src/http/visibility.js'

const event: CalendarEvent = {
  uri: 'at://did:plc:host/community.lexicon.calendar.event/3abc',
  hostDid: 'did:plc:host',
  name: 'Sourdough for beginners',
  description: 'Bring a jar.',
  startsAt: '2026-10-01T18:00:00Z',
  endsAt: '2026-10-01T20:00:00Z',
  mode: 'community.lexicon.calendar.event#inperson',
  status: 'community.lexicon.calendar.event#scheduled',
  locations: [
    {
      $type: 'community.lexicon.location.address',
      name: "Dana's kitchen",
      street: '1412 Juniper Ave',
      locality: 'Boulder',
      region: 'CO',
      postalCode: '80304',
      country: 'US',
    },
  ],
  uris: [{ uri: 'https://meet.example.org/abc', name: 'Video link' }],
}

const ref = { uri: event.uri, cid: 'bafy' }

describe('is the event on the public calendar at all?', () => {
  it('a school listing lists it', () => {
    expect(isListed({ listings: [{ event: ref, school: 'did:plc:school', status: 'listed' }], configs: [] })).toBe(true)
  })

  it('a listing with no explicit status counts as listed', () => {
    expect(isListed({ listings: [{ event: ref, school: 'did:plc:school' }], configs: [] })).toBe(true)
  })

  it("the host's own config can list it with no school listing yet", () => {
    expect(isListed({ listings: [], configs: [{ event: ref, visibility: 'listed' }] })).toBe(true)
  })

  it('an unlisted or private config is not on the calendar', () => {
    expect(isListed({ listings: [], configs: [{ event: ref, visibility: 'unlisted' }] })).toBe(false)
    expect(isListed({ listings: [], configs: [{ event: ref, visibility: 'private' }] })).toBe(false)
    expect(isListed({ listings: [], configs: [] })).toBe(false)
  })

  it('a school REMOVAL beats the host saying listed — that is what moderation means', () => {
    expect(
      isListed({
        listings: [
          { event: ref, school: 'did:plc:school', status: 'listed' },
          { event: ref, school: 'did:plc:school', status: 'removed' },
        ],
        configs: [{ event: ref, visibility: 'listed' }],
      }),
    ).toBe(false)
  })
})

describe('how much of it does this viewer see?', () => {
  const listed: ListingInputs = {
    listings: [{ event: ref, school: 'did:plc:school', status: 'listed' }],
    configs: [{ event: ref, visibility: 'listed', neighborhood: 'North Boulder' }],
  }

  it('the public gets title, time, mode and neighborhood — and nothing else', () => {
    const out = projectEvent(event, listed, 'public')
    expect(out).toEqual({
      uri: event.uri,
      name: 'Sourdough for beginners',
      startsAt: '2026-10-01T18:00:00Z',
      endsAt: '2026-10-01T20:00:00Z',
      mode: 'community.lexicon.calendar.event#inperson',
      status: 'community.lexicon.calendar.event#scheduled',
      neighborhood: 'North Boulder',
      locationRedacted: true,
    })
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('Juniper')
    expect(serialized).not.toContain('80304')
    expect(serialized).not.toContain("Dana's kitchen")
    expect(serialized).not.toContain('meet.example.org')
    // `hostDid` is not a field on the public projection. The host's DID is still inside the
    // event's own AT-URI, which is unavoidable and already public — the event record lives
    // in their repo. What matters is that we add no identity of our own.
    expect(out).not.toHaveProperty('hostDid')
    expect(out).not.toHaveProperty('description')
    expect(out).not.toHaveProperty('locations')
    expect(out).not.toHaveProperty('uris')
  })

  it.each(['rsvp', 'attendee', 'host', 'steward'] as const)('a %s viewer gets the precise location', (relation) => {
    expect(seesFullLocation(relation)).toBe(true)
    const out = projectEvent(event, listed, relation) as unknown as Record<string, unknown>
    expect(out.locationRedacted).toBe(false)
    expect(JSON.stringify(out.locations)).toContain('1412 Juniper Ave')
    expect(out.description).toBe('Bring a jar.')
    expect(out.hostDid).toBe('did:plc:host')
  })

  it('falls back to locality/region when no neighborhood is configured', () => {
    const noNeighborhood: ListingInputs = { listings: listed.listings, configs: [{ event: ref, visibility: 'listed' }] }
    expect(neighborhoodOf(noNeighborhood, event)).toBe('Boulder, CO')
    // Never the street, even in the fallback.
    expect(neighborhoodOf(noNeighborhood, event)).not.toContain('Juniper')
  })

  it('has no neighborhood at all for a location-less online class', () => {
    expect(neighborhoodOf({ listings: [], configs: [] }, { uri: 'u', hostDid: 'd' })).toBeUndefined()
  })
})

describe('the .ics LOCATION line respects the same boundary', () => {
  const listed: ListingInputs = {
    listings: [{ event: ref, school: 'did:plc:school', status: 'listed' }],
    configs: [{ event: ref, visibility: 'listed', neighborhood: 'North Boulder' }],
  }

  it('gives the public only the neighborhood', () => {
    expect(icsLocation(event, listed, 'public')).toBe('North Boulder')
  })

  it('gives an RSVP the full address', () => {
    expect(icsLocation(event, listed, 'rsvp')).toBe("Dana's kitchen, 1412 Juniper Ave, Boulder, CO, 80304")
  })

  it('uses the join URL for a location-less online class', () => {
    const online: CalendarEvent = { uri: 'u', hostDid: 'd', locations: [{ uri: 'https://meet.example.org/abc' }] }
    expect(icsLocation(online, { listings: [], configs: [] }, 'rsvp')).toBe('https://meet.example.org/abc')
    expect(icsLocation(online, { listings: [], configs: [] }, 'public')).toBeUndefined()
  })
})
