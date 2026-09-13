/**
 * The school writes its curation listing (`coop.lexicon.event.listing`) ONLY when the
 * event carries at least one tag the school routes on. Pure-ish: `routeListing` is
 * exercised against a FAKE `SchoolActorPort` (no PDS, no DB), with `schoolTags` injected
 * explicitly so the test makes NO network call and prints nothing — `schoolRoutingTags()`
 * itself (the live-fetch path) is exercised for real only by the smoke test.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterEach, describe, expect, it } from 'vitest'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'
import { setSchoolActor } from '../src/lib/school-actor.js'
import { DEFAULT_ROUTING_TAGS, decideListingEdit, routeListing, routesOnTags } from '../src/lib/events.js'

function fakePort(calls: Array<{ collection: string; record: unknown }>): SchoolActorPort {
  return {
    async describeActor() {
      throw new Error('not used by this test')
    },
    async actAs() {
      throw new Error('not used by this test')
    },
    async putRecordAsSchool(i) {
      calls.push({ collection: i.collection, record: i.record })
      return { uri: `at://did:plc:school/${i.collection}/x`, cid: 'bafyx', auditId: 'audit-1' }
    },
    async deleteRecordAsSchool() {
      throw new Error('not used by this test')
    },
    async authorize() {
      return { allowed: true, role: 40, reason: 'ok' }
    },
  }
}

const event = { uri: 'at://did:plc:host/community.lexicon.calendar.event/3abc', cid: 'bafyevent' }
const schoolTags = DEFAULT_ROUTING_TAGS

afterEach(() => setSchoolActor(undefined))

describe('routesOnTags (pure)', () => {
  it('routes when the event shares at least one tag with the school', () => {
    expect(routesOnTags(['skillshare'], DEFAULT_ROUTING_TAGS)).toBe(true)
    expect(routesOnTags(['bikes', 'skillshare'], DEFAULT_ROUTING_TAGS)).toBe(true)
  })

  it('does not route when there is no overlap', () => {
    expect(routesOnTags(['knitting'], DEFAULT_ROUTING_TAGS)).toBe(false)
    expect(routesOnTags([], DEFAULT_ROUTING_TAGS)).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(routesOnTags(['Skillshare'], DEFAULT_ROUTING_TAGS)).toBe(true)
  })
})

describe('routeListing writes the school listing only when tags route (hermetic: schoolTags injected, no network)', () => {
  it('tags: [skillshare] results in exactly one putRecordAsSchool call for the listing', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    const out = await routeListing({ event, name: 'Bike repair basics', tags: ['skillshare'], schoolTags, callerDid: 'did:plc:host' as Did })
    expect(calls.length).toBe(1)
    expect(calls[0]!.collection).toBe('coop.lexicon.event.listing')
    expect(out).toBeDefined()
  })

  it('tags: [knitting] results in zero calls', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    const out = await routeListing({ event, name: 'Knitting circle', tags: ['knitting'], schoolTags, callerDid: 'did:plc:host' as Did })
    expect(calls.length).toBe(0)
    expect(out).toBeUndefined()
  })

  it('no tags at all (unset) results in zero calls — there is no silent default', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    const out = await routeListing({ event, name: 'Mystery class', tags: [], schoolTags, callerDid: 'did:plc:host' as Did })
    expect(calls.length).toBe(0)
    expect(out).toBeUndefined()
  })

  it('never writes a listing for an unlisted or private event, even with a routed tag', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    await routeListing({ event, name: 'x', tags: ['skillshare'], visibility: 'unlisted', schoolTags, callerDid: 'did:plc:host' as Did })
    expect(calls.length).toBe(0)
  })

  it('carries the tags onto the written listing record', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    await routeListing({ event, name: 'Bike repair basics', tags: ['skillshare', 'bikes'], schoolTags, callerDid: 'did:plc:host' as Did })
    expect((calls[0]!.record as { tags?: string[] }).tags).toEqual(['skillshare', 'bikes'])
  })
})

describe('decideListingEdit (pure) — re-listing after a steward removal', () => {
  it('creates a listing the first time an event routes and has never been listed', () => {
    expect(decideListingEdit({ everListedByUs: false, isActivelyListedByUs: false, routesNow: true })).toBe('create')
  })

  it('does nothing if it is already actively listed and still routes', () => {
    expect(decideListingEdit({ everListedByUs: true, isActivelyListedByUs: true, routesNow: true })).toBe('none')
  })

  it('removes an active listing once it no longer routes', () => {
    expect(decideListingEdit({ everListedByUs: true, isActivelyListedByUs: true, routesNow: false })).toBe('remove')
  })

  it('THE FIX: never re-creates a listing a steward has removed, even if it routes again', () => {
    // everListedByUs=true (we HAVE listed it before) but isActivelyListedByUs=false
    // (a steward removed it) — retagging back onto a routed tag must not recreate it.
    expect(decideListingEdit({ everListedByUs: true, isActivelyListedByUs: false, routesNow: true })).toBe('none')
  })

  it('does nothing for an event that has never routed and still does not', () => {
    expect(decideListingEdit({ everListedByUs: false, isActivelyListedByUs: false, routesNow: false })).toBe('none')
  })
})
