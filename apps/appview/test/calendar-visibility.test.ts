/**
 * The visibility rules are the privacy boundary of the public calendar, so they are
 * pinned here rather than only exercised through HTTP.
 */
import { describe, expect, it } from 'vitest'
import {
  calendarInclusion,
  icsLocation,
  isListed,
  isVenueNeeded,
  neighborhoodOf,
  projectEvent,
  seesFullLocation,
  tagsOf,
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
          { event: ref, school: 'did:plc:school', status: 'listed', createdAt: '2026-09-01T00:00:00Z' },
          { event: ref, school: 'did:plc:school', status: 'removed', createdAt: '2026-09-02T00:00:00Z' },
        ],
        configs: [{ event: ref, visibility: 'listed' }],
      }),
    ).toBe(false)
  })

  /**
   * A4. Listings are APPEND-ONLY — the school writes another rather than editing one — so
   * the question is always about the newest record. The old rule ("any removal wins,
   * forever") made `restore-listing` structurally impossible: the removal it was undoing
   * was still sitting in the history.
   */
  describe('the newest listing wins, by createdAt', () => {
    const listing = (status: 'listed' | 'removed', createdAt: string) => ({
      event: ref,
      school: 'did:plc:school',
      status,
      createdAt,
    })

    it('a restore AFTER a removal puts the class back on the calendar', () => {
      expect(
        isListed({
          listings: [
            listing('listed', '2026-09-01T00:00:00Z'),
            listing('removed', '2026-09-02T00:00:00Z'),
            listing('listed', '2026-09-03T00:00:00Z'),
          ],
          configs: [],
        }),
      ).toBe(true)
    })

    it('a removal AFTER a restore takes it off again', () => {
      expect(
        isListed({
          listings: [listing('listed', '2026-09-03T00:00:00Z'), listing('removed', '2026-09-04T00:00:00Z')],
          configs: [{ event: ref, visibility: 'listed' }],
        }),
      ).toBe(false)
    })

    it('does not care what order the rows arrive in', () => {
      expect(
        isListed({
          listings: [
            listing('listed', '2026-09-03T00:00:00Z'),
            listing('removed', '2026-09-02T00:00:00Z'),
            listing('listed', '2026-09-01T00:00:00Z'),
          ],
          configs: [],
        }),
      ).toBe(true)
    })

    it('a stamped listing beats an unstamped one, whichever way round they are', () => {
      expect(
        isListed({ listings: [{ event: ref, school: 'did:plc:school', status: 'removed' }, listing('listed', '2026-09-01T00:00:00Z')], configs: [] }),
      ).toBe(true)
      expect(
        isListed({ listings: [{ event: ref, school: 'did:plc:school' }, listing('removed', '2026-09-01T00:00:00Z')], configs: [] }),
      ).toBe(false)
    })

    it('resolves a dead tie to REMOVED — hidden is the safe answer when we cannot tell', () => {
      expect(
        isListed({
          listings: [listing('listed', '2026-09-02T00:00:00Z'), listing('removed', '2026-09-02T00:00:00Z')],
          configs: [{ event: ref, visibility: 'listed' }],
        }),
      ).toBe(false)
    })

    it('falls through to the host’s own config only when there is no school listing at all', () => {
      expect(isListed({ listings: [], configs: [{ event: ref, visibility: 'listed' }] })).toBe(true)
      // A live school listing is the only voice once one exists — including a `removed`
      // one, which is what makes moderation stick.
      expect(
        isListed({ listings: [listing('removed', '2026-09-02T00:00:00Z')], configs: [{ event: ref, visibility: 'listed' }] }),
      ).toBe(false)
    })
  })
})

describe('how much of it does this viewer see?', () => {
  const listed: ListingInputs = {
    listings: [{ event: ref, school: 'did:plc:school', status: 'listed' }],
    configs: [{ event: ref, visibility: 'listed', neighborhood: 'North Boulder' }],
  }

  /**
   * INTEROP GAP 5. `description`, `uris` and `hostDid` are fields of the public
   * `community.lexicon.calendar.event` record itself — any ATProto client can read them
   * straight from the host's repo — so withholding them from our own public API bought
   * no privacy at all and made every site syndicating our calendar look broken. What is
   * still withheld is `locations`: the street address is the thing R9 protects, and it
   * is the only one of these fields that is genuinely coarsened rather than omitted.
   */
  it('the public gets the public record: title, time, mode, neighborhood, description, uris and host — never the street', () => {
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
      venueNeeded: false,
      tags: [],
      description: 'Bring a jar.',
      uris: [{ uri: 'https://meet.example.org/abc', name: 'Video link' }],
      hostDid: 'did:plc:host',
    })
    const serialized = JSON.stringify(out)
    expect(serialized).not.toContain('Juniper')
    expect(serialized).not.toContain('80304')
    expect(serialized).not.toContain("Dana's kitchen")
    expect(out).not.toHaveProperty('locations')
    // Still redacted: the viewer is being shown a coarsened location, not a full one.
    expect(out.locationRedacted).toBe(true)
  })

  it('a stranger looking at an UNLISTED event gets none of those fields', () => {
    const unlisted: ListingInputs = { listings: [], configs: [{ event: ref, visibility: 'unlisted', neighborhood: 'North Boulder' }] }
    const out = projectEvent(event, unlisted, 'public')
    expect(out).not.toHaveProperty('description')
    expect(out).not.toHaveProperty('uris')
    expect(out).not.toHaveProperty('hostDid')
    expect(out).not.toHaveProperty('locations')
    expect(JSON.stringify(out)).not.toContain('meet.example.org')
    // A removed (moderated) listing is the same case, whatever the host's config says.
    const removed: ListingInputs = {
      listings: [{ event: ref, school: 'did:plc:school', status: 'removed' }],
      configs: [{ event: ref, visibility: 'listed' }],
    }
    expect(projectEvent(event, removed, 'public')).not.toHaveProperty('description')
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

describe('venueNeeded', () => {
  it('is true when a class has no address and no neighborhood at all', () => {
    const noVenue: CalendarEvent = { uri: 'u', hostDid: 'd', name: 'Knife sharpening' }
    expect(isVenueNeeded(noVenue, { listings: [], configs: [] })).toBe(true)
    const out = projectEvent(noVenue, { listings: [], configs: [] }, 'public')
    expect(out.venueNeeded).toBe(true)
  })

  it('is false once a neighborhood is configured, even with no precise address', () => {
    const noVenue: CalendarEvent = { uri: 'u', hostDid: 'd' }
    const inputs: ListingInputs = { listings: [], configs: [{ event: ref, visibility: 'listed', neighborhood: 'North Boulder' }] }
    expect(isVenueNeeded(noVenue, inputs)).toBe(false)
  })

  it('is false once a location is set', () => {
    expect(isVenueNeeded(event, { listings: [], configs: [] })).toBe(false)
  })
})

describe('tags', () => {
  it('collects tags from every config and listing sidecar, deduped and lowercased', () => {
    const inputs: ListingInputs = {
      listings: [{ event: ref, school: 'did:plc:school', status: 'listed', tags: ['Skillshare'] }],
      configs: [{ event: ref, visibility: 'listed', tags: ['skillshare', 'bikes'] }],
    }
    expect(tagsOf(inputs)).toEqual(['skillshare', 'bikes'])
  })

  it('is an empty array, never undefined, when nothing carries a tag', () => {
    expect(tagsOf({ listings: [], configs: [] })).toEqual([])
  })

  it('projectEvent carries tags for both the public and trusted views', () => {
    const inputs: ListingInputs = {
      listings: [],
      configs: [{ event: ref, visibility: 'listed', tags: ['knitting'] }],
    }
    expect(projectEvent(event, inputs, 'public').tags).toEqual(['knitting'])
    expect(projectEvent(event, inputs, 'host').tags).toEqual(['knitting'])
  })
})

describe('calendarInclusion — ours by AUTHORSHIP, not by listing', () => {
  it('an own-host event with no tags and no listing still shows, origin "ours"', () => {
    // This is the exact regression: an untagged event gets NO listing (see
    // lib/events.ts), but it must still appear on our own calendar.
    const noListingNoTags: ListingInputs = { listings: [], configs: [{ event: ref, visibility: 'listed' }] }
    expect(calendarInclusion(true, noListingNoTags)).toEqual({ show: true, origin: 'ours' })
  })

  it('an own-host event tagged ["knitting"] (does not route) still shows, origin "ours"', () => {
    const mismatchedTag: ListingInputs = { listings: [], configs: [{ event: ref, visibility: 'listed', tags: ['knitting'] }] }
    expect(calendarInclusion(true, mismatchedTag)).toEqual({ show: true, origin: 'ours' })
  })

  it('an own-host event tagged ["skillshare"] (routes, has a listing) shows, origin "ours"', () => {
    const routed: ListingInputs = {
      listings: [{ event: ref, school: 'did:plc:school', status: 'listed', tags: ['skillshare'] }],
      configs: [{ event: ref, visibility: 'listed', tags: ['skillshare'] }],
    }
    expect(calendarInclusion(true, routed)).toEqual({ show: true, origin: 'ours' })
  })

  it('an own-host event the host marked private is hidden, even though it is ours', () => {
    const privateEvent: ListingInputs = { listings: [], configs: [{ event: ref, visibility: 'private' }] }
    expect(calendarInclusion(true, privateEvent)).toEqual({ show: false, origin: 'ours' })
  })

  it('an own-host event a steward removed is hidden, even though it is ours', () => {
    const removed: ListingInputs = {
      listings: [{ event: ref, school: 'did:plc:school', status: 'removed' }],
      configs: [{ event: ref, visibility: 'listed' }],
    }
    expect(calendarInclusion(true, removed)).toEqual({ show: false, origin: 'ours' })
  })

  it('a non-own host with no listing at all is hidden', () => {
    const foreignNoListing: ListingInputs = { listings: [], configs: [{ event: ref, visibility: 'listed' }] }
    expect(calendarInclusion(false, foreignNoListing)).toEqual({ show: false, origin: 'listed' })
  })

  it('a non-own host with a live listing from our school shows, origin "listed"', () => {
    const foreignListed: ListingInputs = {
      listings: [{ event: ref, school: 'did:plc:school', status: 'listed' }],
      configs: [],
    }
    expect(calendarInclusion(false, foreignListed)).toEqual({ show: true, origin: 'listed' })
  })
})
