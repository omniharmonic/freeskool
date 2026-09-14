/**
 * PER-SCHOOL TAG ROUTING (MS §7, design §2 ruling 9).
 *
 * `routesOnTags` was always a pure function of two tag lists; what the federation phase
 * makes true is that the second list belongs to a SCHOOL and there is more than one
 * school. Boulder routes `skillshare, free-school`; Denver routes `skillshare,
 * mutual-aid` — with no coordination between them, because each reads its OWN
 * `freeschool.draft.school#tags`.
 *
 * So: the same class, offered in two cities, gets a curation listing from the school
 * whose tags it matches and NO listing from the school whose tags it does not — and the
 * listing that is written names the school that wrote it. Hermetic: the PDS read is
 * mocked (one school record per DID) and the school session is a fake port, so this
 * suite makes no network call and needs no database.
 */
process.env.SCHOOL_DID = 'did:plc:routing-boulder'
process.env.SESSION_SECRET ??= 'per-school-routing-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 29).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'per-school-routing-test-pepper'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'

const BOULDER = 'did:plc:routing-boulder'
const DENVER = 'did:plc:routing-denver'
const HOST = 'did:plc:routing-host'

const { records } = vi.hoisted(() => ({ records: new Map<string, Record<string, unknown>>() }))

vi.mock('../src/lib/pds.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/pds.js')>()),
  async getRecord(repoDid: string, collection: string, rkey: string) {
    const value = records.get(`${repoDid}/${collection}/${rkey}`)
    return value ? { uri: `at://${repoDid}/${collection}/${rkey}`, value } : null
  },
}))

import { routeListing, schoolRoutingTags } from '../src/lib/events.js'
import { setSchoolActor } from '../src/lib/school-actor.js'

interface Written {
  schoolDid: string
  collection: string
  record: Record<string, unknown>
}

function fakePort(written: Written[]): SchoolActorPort {
  return {
    async describeActor(i: { schoolDid: Did }) {
      return { schoolDid: i.schoolDid, pdsEndpoint: 'http://pds.test', custody: 'app-owned' as const, online: true }
    },
    async authorize() {
      return { allowed: true as const, role: 30, reason: 'ok' }
    },
    async putRecordAsSchool(i: { schoolDid: Did; collection: string; rkey: string; record: Record<string, unknown> }) {
      written.push({ schoolDid: i.schoolDid, collection: i.collection, record: i.record })
      return { uri: `at://${i.schoolDid}/${i.collection}/${i.rkey}`, cid: 'bafylisting', auditId: 'audit' }
    },
    async deleteRecordAsSchool() {
      return { auditId: 'audit' }
    },
  } as unknown as SchoolActorPort
}

const EVENT = { uri: `at://${HOST}/community.lexicon.calendar.event/mutual-aid-101`, cid: 'bafyevent' }

let written: Written[]

beforeEach(() => {
  records.clear()
  records.set(`${BOULDER}/freeschool.draft.school/self`, {
    name: 'Boulder Free School',
    tags: ['skillshare', 'free-school'],
  })
  records.set(`${DENVER}/freeschool.draft.school/self`, {
    name: 'Denver Free School',
    tags: ['skillshare', 'mutual-aid'],
  })
  written = []
  setSchoolActor(fakePort(written))
})

afterEach(() => setSchoolActor(undefined))

describe('two schools, two tag sets', () => {
  it('reads each school\'s OWN record for its routing tags', async () => {
    expect(await schoolRoutingTags(BOULDER)).toEqual(['skillshare', 'free-school'])
    expect(await schoolRoutingTags(DENVER)).toEqual(['skillshare', 'mutual-aid'])
    // A school with no record of its own falls back to the defaults, never to another
    // school's tags.
    expect(await schoolRoutingTags('did:plc:routing-nobody')).toEqual(['skillshare', 'free-school'])
  })

  it('routes a `mutual-aid` class for Denver and not for Boulder', async () => {
    const forDenver = await routeListing({
      event: EVENT,
      name: 'Mutual aid 101',
      tags: ['mutual-aid'],
      callerDid: HOST as Did,
      schoolDid: DENVER,
    })
    expect(forDenver).toBeDefined()
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ schoolDid: DENVER, collection: 'coop.lexicon.event.listing' })
    expect(written[0]!.record).toMatchObject({ school: DENVER, status: 'listed', tags: ['mutual-aid'] })

    const forBoulder = await routeListing({
      event: EVENT,
      name: 'Mutual aid 101',
      tags: ['mutual-aid'],
      callerDid: HOST as Did,
      schoolDid: BOULDER,
    })
    expect(forBoulder).toBeUndefined()
    expect(written).toHaveLength(1)
  })

  it('routes a `free-school` class for Boulder and not for Denver', async () => {
    expect(
      await routeListing({ event: EVENT, name: 'Zine night', tags: ['free-school'], callerDid: HOST as Did, schoolDid: BOULDER }),
    ).toBeDefined()
    expect(
      await routeListing({ event: EVENT, name: 'Zine night', tags: ['free-school'], callerDid: HOST as Did, schoolDid: DENVER }),
    ).toBeUndefined()
    expect(written.map((w) => w.schoolDid)).toEqual([BOULDER])
  })

  it('routes a tag BOTH schools share for each of them, into each school\'s own repo', async () => {
    await routeListing({ event: EVENT, name: 'Bike repair', tags: ['skillshare'], callerDid: HOST as Did, schoolDid: BOULDER })
    await routeListing({ event: EVENT, name: 'Bike repair', tags: ['skillshare'], callerDid: HOST as Did, schoolDid: DENVER })
    expect(written.map((w) => w.schoolDid)).toEqual([BOULDER, DENVER])
    expect(written.map((w) => (w.record as { school: string }).school)).toEqual([BOULDER, DENVER])
  })
})
