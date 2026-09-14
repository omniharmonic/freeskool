/**
 * A Bluesky-door member who signed in here but keeps every claim school-only has no
 * custodial row and no record in our index. Until 2026-09-14 that made them a Visitor
 * forever — and a steward appointment for such a member was silently ignored (the
 * founder's own Bluesky account on production). A live `fs_membership` row is now
 * enough for `hasProfile`.
 */
process.env.SCHOOL_DID = 'did:plc:evidence-test-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'evidence-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 23).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'evidence-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({
    contrail: { async query() { return { records: [] } } },
    async notify() {},
  }),
}))

import { Role } from '@freeschool/shared'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { member, steward } from '../src/db/schema.js'
import { evidenceFor, roleOf } from '../src/lib/roles.js'
import { joinSchool, leaveSchool } from '../src/lib/membership.js'

const SCHOOL = 'did:plc:evidence-test-school'
const BLUESKY_MEMBER = 'did:plc:evidence-bluesky-member'

let available = false
beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})
afterAll(async () => { await closeTestDb() })
beforeEach(async () => {
  if (!available) return
  await truncate('fs_member', 'fs_membership', 'fs_steward', 'fs_custodial_account', 'fs_attendance_tally', 'fs_invite', 'fs_attestation', 'fs_moderation_queue', 'fs_policy_cache')
  await testDb().insert(member).values({ did: BLUESKY_MEMBER, door: 'oauth' })
})

describe('evidence for a Bluesky-door member with no custodial row and no indexed records', () => {
  it('a live membership is a profile, so the open default makes them a Host', async () => {
    if (!available) return
    await joinSchool(BLUESKY_MEMBER, SCHOOL, 'oauth')
    const e = await evidenceFor(BLUESKY_MEMBER, SCHOOL)
    expect(e.hasProfile).toBe(true)
    expect(await roleOf(BLUESKY_MEMBER, SCHOOL)).toBeGreaterThanOrEqual(Role.Member)
  })

  it('a steward appointment for such a member takes effect', async () => {
    if (!available) return
    await joinSchool(BLUESKY_MEMBER, SCHOOL, 'oauth')
    await testDb().insert(steward).values({ did: BLUESKY_MEMBER, schoolDid: SCHOOL, appointedAt: new Date() })
    expect(await roleOf(BLUESKY_MEMBER, SCHOOL)).toBe(Role.Steward)
  })

  it('without any membership they are still a Visitor', async () => {
    if (!available) return
    const e = await evidenceFor(BLUESKY_MEMBER, SCHOOL)
    expect(e.hasProfile).toBe(false)
    expect(await roleOf(BLUESKY_MEMBER, SCHOOL)).toBe(Role.Visitor)
  })

  it('leaving the school takes the profile away again', async () => {
    if (!available) return
    await joinSchool(BLUESKY_MEMBER, SCHOOL, 'oauth')
    await leaveSchool(BLUESKY_MEMBER, SCHOOL)
    const e = await evidenceFor(BLUESKY_MEMBER, SCHOOL)
    expect(e.hasProfile).toBe(false)
  })
})
