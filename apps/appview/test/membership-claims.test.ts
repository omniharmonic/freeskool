/**
 * `publishRoleClaim` must refuse to write `coop.lexicon.membership` unless ALL THREE
 * gates hold: the policy allows it, the subject opted in, and the role is Host+. A fake
 * `SchoolActorPort` (never a real PDS — see `test/tag-routing.test.ts` for the same
 * pattern) lets us assert exactly what, if anything, was written.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultThresholds, Role } from '@freeschool/shared'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { setSchoolActor } from '../src/lib/school-actor.js'
import { clearPolicyMemo } from '../src/lib/policy.js'
import { isPublicRoleOptIn, publishRoleClaim, setPublicRoleOptIn } from '../src/lib/membership-claims.js'
import { policyCache } from '../src/db/schema.js'

const SCHOOL = 'did:plc:school' as Did
const SUBJECT = 'did:plc:a-host' as Did

function fakePort(calls: Array<{ collection: string; record: unknown; callerDid: string }>): SchoolActorPort {
  return {
    async describeActor() {
      throw new Error('not used by this test')
    },
    async actAs() {
      throw new Error('not used by this test')
    },
    async putRecordAsSchool(i) {
      calls.push({ collection: i.collection, record: i.record, callerDid: i.callerDid })
      return { uri: `at://${i.schoolDid}/${i.collection}/x`, cid: 'bafyx', auditId: 'audit-1' }
    },
    async deleteRecordAsSchool() {
      throw new Error('not used by this test')
    },
    async authorize() {
      return { allowed: true, role: Role.Host, reason: 'ok' }
    },
  }
}

async function setPublishRoles(publishRoles: boolean): Promise<void> {
  const thresholds = { ...defaultThresholds, publishRoles }
  await testDb()
    .insert(policyCache)
    .values({ schoolDid: SCHOOL, thresholds, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: policyCache.schoolDid, set: { thresholds, fetchedAt: new Date() } })
  clearPolicyMemo()
}

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_member_prefs', 'fs_policy_cache')
  clearPolicyMemo()
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('publishRoleClaim: the role-too-low gate (no DB, no network)', () => {
  it('never publishes below Host, regardless of policy or opt-in', async () => {
    const calls: Array<{ collection: string; record: unknown; callerDid: string }> = []
    setSchoolActor(fakePort(calls))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Member)
    expect(res).toEqual({ published: false, reason: 'role-too-low' })
    expect(calls.length).toBe(0)
  })
})

describe('publishRoleClaim: both flags required (live Postgres)', () => {
  it('does not publish when the policy has publishRoles off (default), even if opted in', async () => {
    if (!available) return
    await setPublishRoles(false)
    await setPublicRoleOptIn(SUBJECT, true)
    const calls: Array<{ collection: string; record: unknown; callerDid: string }> = []
    setSchoolActor(fakePort(calls))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)
    expect(res.published).toBe(false)
    expect(res.reason).toBe('policy-off')
    expect(calls.length).toBe(0)
  })

  it('does not publish when the subject has not opted in, even if the policy allows it', async () => {
    if (!available) return
    await setPublishRoles(true)
    const calls: Array<{ collection: string; record: unknown; callerDid: string }> = []
    setSchoolActor(fakePort(calls))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)
    expect(res.published).toBe(false)
    expect(res.reason).toBe('not-opted-in')
    expect(calls.length).toBe(0)
  })

  it('publishes coop.lexicon.membership when the policy allows it AND the subject opted in AND role >= Host', async () => {
    if (!available) return
    await setPublishRoles(true)
    await setPublicRoleOptIn(SUBJECT, true)
    expect(await isPublicRoleOptIn(SUBJECT)).toBe(true)

    const calls: Array<{ collection: string; record: unknown; callerDid: string }> = []
    setSchoolActor(fakePort(calls))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)

    expect(res.published).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0]!.collection).toBe('coop.lexicon.membership')
    expect(calls[0]!.callerDid).toBe(SUBJECT)
    expect(calls[0]!.record).toMatchObject({ subject: SUBJECT, role: Role.Host, school: SCHOOL, addedBy: SCHOOL })
  })

  it('opting back out stops it: unsetting the opt-in keeps the policy-on path from publishing', async () => {
    if (!available) return
    await setPublishRoles(true)
    await setPublicRoleOptIn(SUBJECT, false)
    const calls: Array<{ collection: string; record: unknown; callerDid: string }> = []
    setSchoolActor(fakePort(calls))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Steward)
    expect(res.published).toBe(false)
    expect(calls.length).toBe(0)
  })
})
