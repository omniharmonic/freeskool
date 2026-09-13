/**
 * `publishRoleClaim` must refuse to write `coop.lexicon.membership` unless ALL THREE
 * gates hold: the policy allows it, the subject opted in, and the role is Host+. A fake
 * `SchoolActorPort` (never a real PDS — see `test/tag-routing.test.ts` for the same
 * pattern) lets us assert exactly what, if anything, was written — including retraction
 * (`deleteRecordAsSchool`) when opting out or when the role drops back below Host.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultThresholds, Role } from '@freeschool/shared'
import type { Did, SchoolActorPort } from '@freeschool/school-actor'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { setSchoolActor } from '../src/lib/school-actor.js'
import { clearPolicyMemo } from '../src/lib/policy.js'
import {
  isPublicRoleOptIn,
  membershipClaimRkey,
  publishRoleClaim,
  retractRoleClaim,
  setPublicRoleOptIn,
} from '../src/lib/membership-claims.js'
import { policyCache } from '../src/db/schema.js'

const SCHOOL = 'did:plc:school' as Did
const SUBJECT = 'did:plc:a-host' as Did

interface PutCall {
  collection: string
  rkey: string
  record: unknown
  callerDid: string
}
interface DeleteCall {
  collection: string
  rkey: string
  callerDid: string
}

function fakePort(puts: PutCall[], deletes: DeleteCall[]): SchoolActorPort {
  return {
    async describeActor() {
      throw new Error('not used by this test')
    },
    async actAs() {
      throw new Error('not used by this test')
    },
    async putRecordAsSchool(i) {
      puts.push({ collection: i.collection, rkey: i.rkey, record: i.record, callerDid: i.callerDid })
      return { uri: `at://${i.schoolDid}/${i.collection}/${i.rkey}`, cid: 'bafyx', auditId: 'audit-1' }
    },
    async deleteRecordAsSchool(i) {
      deletes.push({ collection: i.collection, rkey: i.rkey, callerDid: i.callerDid })
      return { auditId: 'audit-delete-1' }
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
  it('never publishes below Host, regardless of policy or opt-in, and has nothing to retract when never opted in', async () => {
    const puts: PutCall[] = []
    const deletes: DeleteCall[] = []
    setSchoolActor(fakePort(puts, deletes))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Member)
    expect(res).toEqual({ published: false, reason: 'role-too-low' })
    expect(puts.length).toBe(0)
    // never opted in -> isPublicRoleOptIn is false -> no retraction attempt either
    expect(deletes.length).toBe(0)
  })
})

describe('membershipClaimRkey', () => {
  it('is deterministic for the same (schoolDid, subjectDid), and differs across subjects', () => {
    expect(membershipClaimRkey(SCHOOL, SUBJECT)).toBe(membershipClaimRkey(SCHOOL, SUBJECT))
    expect(membershipClaimRkey(SCHOOL, SUBJECT)).not.toBe(membershipClaimRkey(SCHOOL, 'did:plc:someone-else'))
  })
})

describe('publishRoleClaim: both flags required (live Postgres)', () => {
  it('does not publish when the policy has publishRoles off (default), even if opted in', async () => {
    if (!available) return
    await setPublishRoles(false)
    await setPublicRoleOptIn(SUBJECT, true)
    const puts: PutCall[] = []
    const deletes: DeleteCall[] = []
    setSchoolActor(fakePort(puts, deletes))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)
    expect(res.published).toBe(false)
    expect(res.reason).toBe('policy-off')
    expect(puts.length).toBe(0)
  })

  it('does not publish when the subject has not opted in, even if the policy allows it', async () => {
    if (!available) return
    await setPublishRoles(true)
    const puts: PutCall[] = []
    const deletes: DeleteCall[] = []
    setSchoolActor(fakePort(puts, deletes))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)
    expect(res.published).toBe(false)
    expect(res.reason).toBe('not-opted-in')
    expect(puts.length).toBe(0)
  })

  it('publishes coop.lexicon.membership when the policy allows it AND the subject opted in AND role >= Host, at a deterministic rkey', async () => {
    if (!available) return
    await setPublishRoles(true)
    await setPublicRoleOptIn(SUBJECT, true)
    expect(await isPublicRoleOptIn(SUBJECT)).toBe(true)

    const puts: PutCall[] = []
    const deletes: DeleteCall[] = []
    setSchoolActor(fakePort(puts, deletes))
    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)

    expect(res.published).toBe(true)
    expect(puts.length).toBe(1)
    expect(puts[0]!.collection).toBe('coop.lexicon.membership')
    expect(puts[0]!.rkey).toBe(membershipClaimRkey(SCHOOL, SUBJECT))
    expect(puts[0]!.callerDid).toBe(SUBJECT)
    expect(puts[0]!.record).toMatchObject({ subject: SUBJECT, role: Role.Host, school: SCHOOL, addedBy: SCHOOL })
  })

  it('two derivations (e.g. a second hosted event) yield ONE record: the same rkey both times', async () => {
    if (!available) return
    await setPublishRoles(true)
    await setPublicRoleOptIn(SUBJECT, true)
    const puts: PutCall[] = []
    const deletes: DeleteCall[] = []
    setSchoolActor(fakePort(puts, deletes))

    await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)
    await publishRoleClaim(SCHOOL, SUBJECT, Role.Facilitator)

    expect(puts.length).toBe(2)
    expect(puts[0]!.rkey).toBe(puts[1]!.rkey)
    expect(puts[0]!.collection).toBe(puts[1]!.collection)
  })

  it('opting back out (setPublicRoleOptIn false) retracts any published claim at the same rkey', async () => {
    if (!available) return
    await setPublishRoles(true)
    await setPublicRoleOptIn(SUBJECT, true)
    const puts: PutCall[] = []
    const deletes: DeleteCall[] = []
    setSchoolActor(fakePort(puts, deletes))

    await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)
    expect(puts.length).toBe(1)

    await setPublicRoleOptIn(SUBJECT, false)
    expect(deletes.length).toBe(1)
    expect(deletes[0]!.collection).toBe('coop.lexicon.membership')
    expect(deletes[0]!.rkey).toBe(puts[0]!.rkey)

    // and opting back out a second time (nothing left to retract) does not error
    await setPublicRoleOptIn(SUBJECT, false)
  })

  it('when the role drops back below Host, publishRoleClaim retracts the existing claim', async () => {
    if (!available) return
    await setPublishRoles(true)
    await setPublicRoleOptIn(SUBJECT, true)
    const puts: PutCall[] = []
    const deletes: DeleteCall[] = []
    setSchoolActor(fakePort(puts, deletes))

    await publishRoleClaim(SCHOOL, SUBJECT, Role.Host)
    expect(puts.length).toBe(1)

    const res = await publishRoleClaim(SCHOOL, SUBJECT, Role.Member)
    expect(res).toEqual({ published: false, reason: 'role-too-low' })
    expect(deletes.length).toBe(1)
    expect(deletes[0]!.rkey).toBe(puts[0]!.rkey)
  })

  it('retractRoleClaim never throws even when the port call fails (best-effort)', async () => {
    setSchoolActor({
      async describeActor() {
        throw new Error('unused')
      },
      async actAs() {
        throw new Error('unused')
      },
      async putRecordAsSchool() {
        throw new Error('unused')
      },
      async deleteRecordAsSchool() {
        throw new Error('simulated PDS failure')
      },
      async authorize() {
        return { allowed: true, role: Role.Host, reason: 'ok' }
      },
    })
    await expect(retractRoleClaim(SCHOOL, SUBJECT)).resolves.toBeUndefined()
  })
})
