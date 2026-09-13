/**
 * The school writes its curation listing (`coop.lexicon.event.listing`) ONLY when the
 * event carries at least one tag the school routes on. Pure-ish: `routeListing` is
 * exercised against a FAKE `SchoolActorPort` (no PDS, no DB) so the routing DECISION is
 * pinned independently of how the event got written.
 *
 * `SCHOOL_DID` has to be set before the first `config()` call for `schoolDid()` to work;
 * `schoolRoutingTags()` then tries to fetch the live school record over HTTP and falls
 * back to the default routing tags (['skillshare', 'free-school']) on any failure —
 * exactly what happens here, since did:plc:school is not a real account.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterEach, describe, expect, it } from 'vitest'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'
import { setSchoolActor } from '../src/lib/school-actor.js'
import { DEFAULT_ROUTING_TAGS, routeListing, routesOnTags } from '../src/lib/events.js'

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

describe('routeListing writes the school listing only when tags route', () => {
  it('tags: [skillshare] results in exactly one putRecordAsSchool call for the listing', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    const out = await routeListing({ event, name: 'Bike repair basics', tags: ['skillshare'], callerDid: 'did:plc:host' as Did })
    expect(calls.length).toBe(1)
    expect(calls[0]!.collection).toBe('coop.lexicon.event.listing')
    expect(out).toBeDefined()
  })

  it('tags: [knitting] results in zero calls', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    const out = await routeListing({ event, name: 'Knitting circle', tags: ['knitting'], callerDid: 'did:plc:host' as Did })
    expect(calls.length).toBe(0)
    expect(out).toBeUndefined()
  })

  it('never writes a listing for an unlisted or private event, even with a routed tag', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    await routeListing({ event, name: 'x', tags: ['skillshare'], visibility: 'unlisted', callerDid: 'did:plc:host' as Did })
    expect(calls.length).toBe(0)
  })

  it('carries the tags onto the written listing record', async () => {
    const calls: Array<{ collection: string; record: unknown }> = []
    setSchoolActor(fakePort(calls))
    await routeListing({ event, name: 'Bike repair basics', tags: ['skillshare', 'bikes'], callerDid: 'did:plc:host' as Did })
    expect((calls[0]!.record as { tags?: string[] }).tags).toEqual(['skillshare', 'bikes'])
  })
})
