/**
 * `PUT /api/admin/policy` — the ORDER of the two writes (#16).
 *
 * A policy change is two records: the new `freeschool.draft.policy`, and the
 * `freeschool.draft.school` record re-pointed at it. They can fail independently, and the
 * old order (policy first, pointer last) could leave a policy record nothing points at —
 * invisible, with the OLD thresholds silently still in force while the steward was told the
 * change had succeeded.
 *
 * Now the pointer goes first and the policy it names second, with the pointer ROLLED BACK if
 * the policy write fails; the school pointing at a policy that does not exist is the safer
 * failure shape, because since A2 that reads as STRICT rather than as permissive. And
 * `refreshPolicyCache` runs only once both writes have succeeded, so the cache never
 * reflects a half-applied change.
 */
process.env.SCHOOL_DID = 'did:plc:admin-policy-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.SESSION_SECRET ??= 'admin-policy-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 17).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'admin-policy-test-pepper'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Context } from 'hono'
import { AppCustodyAdapter, type Did } from '@freeschool/school-actor'
import { Role } from '@freeschool/shared'

const SCHOOL = 'did:plc:admin-policy-school'
const STEWARD = 'did:plc:admin-policy-steward'
const OLD_POLICY_URI = `at://${SCHOOL}/freeschool.draft.policy/old1`

/**
 * A tiny in-memory stand-in for the school's own repo, shared between the mocked
 * `getRecord` and the faked PDS session below — so a write this route makes is visible to
 * the read the NEXT step makes, which is the whole thing under test.
 */
const { repo } = vi.hoisted(() => ({ repo: new Map<string, Record<string, unknown>>() }))

function seedRepo() {
  repo.clear()
  repo.set('freeschool.draft.school/self', {
    $type: 'freeschool.draft.school',
    name: 'Free School Test',
    policy: OLD_POLICY_URI,
    createdAt: '2026-01-01T00:00:00Z',
  })
  repo.set('freeschool.draft.policy/old1', {
    $type: 'freeschool.draft.policy',
    title: 'the first policy',
    version: 'v1',
    thresholds: { memberRequires: 'none', hostMinAttended: 0, feedbackK: 3 },
  })
}

vi.mock('../src/lib/pds.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/pds.js')>('../src/lib/pds.js')
  return {
    ...actual,
    async getRecord(repoDid: string, collection: string, rkey: string) {
      const value = repo.get(`${collection}/${rkey}`)
      return value ? { uri: `at://${repoDid}/${collection}/${rkey}`, value } : null
    },
  }
})

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { PostgresAuditSink, setSchoolActor } from '../src/lib/school-actor.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { custodialAccount, policyCache, steward } from '../src/db/schema.js'
import { clearPolicyMemo } from '../src/lib/policy.js'

interface Sent {
  collection: string
  rkey: string
  record: Record<string, unknown>
}

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_policy_cache', 'fs_audit', 'fs_steward', 'fs_session', 'fs_custodial_account', 'fs_member')
  clearPolicyMemo()
  seedRepo()
  await testDb().insert(steward).values({ did: STEWARD, schoolDid: SCHOOL })
  await testDb()
    .insert(custodialAccount)
    .values({ did: STEWARD, handle: 'admin-policy-steward.test', email: 'aps@example.org', keyVersion: 'v1' })
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

/** A real `AppCustodyAdapter`; only the PDS session is faked, so writes can be inspected. */
function wirePort(sent: Sent[], failOn?: string) {
  return new AppCustodyAdapter({
    roles: { async roleOf() { return Role.Steward } },
    policy: { async destructiveActionStewards() { return 1 } },
    audit: new PostgresAuditSink(),
    session: {
      async call(i) {
        const body = i.body as Sent
        sent.push({ collection: body.collection, rkey: body.rkey, record: body.record })
        if (failOn && body.collection === failOn) throw new Error('the PDS refused this write')
        repo.set(`${body.collection}/${body.rkey}`, body.record)
        return { status: 200, output: { uri: `at://${SCHOOL}/${body.collection}/${body.rkey}`, cid: 'bafyp' } }
      },
    },
    pdsEndpoint: 'http://localhost:3000',
  })
}

function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function cookieFor(did: string): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

const BODY = {
  title: 'Free School Boulder policy',
  text: 'Anyone can teach. Bring your own tools.',
  version: 'v2',
  thresholds: { hostMinAttended: 2, feedbackK: 4 },
  reason: 'the first school is ready to ask for one attended class before hosting',
}

async function putPolicy(): Promise<Response> {
  return createApp().request('/api/admin/policy', {
    method: 'PUT',
    headers: { Cookie: await cookieFor(STEWARD), 'content-type': 'application/json' },
    body: JSON.stringify(BODY),
  })
}

describe('#16: PUT /api/admin/policy write ordering', () => {
  it('re-points the school record FIRST, then writes the policy it names', async () => {
    if (!available) return
    const sent: Sent[] = []
    setSchoolActor(wirePort(sent))

    const res = await putPolicy()
    expect(res.status).toBe(201)
    const body = (await res.json()) as { uri: string }

    expect(sent.map((s) => s.collection)).toEqual(['freeschool.draft.school', 'freeschool.draft.policy'])
    // The pointer names the policy written second — the rkey is ours, so the at-uri is
    // known before the record exists, which is what lets the two be ordered at all.
    expect(sent[0]!.record.policy).toBe(`at://${SCHOOL}/freeschool.draft.policy/${sent[1]!.rkey}`)
    expect(sent[0]!.record.policy).toBe(body.uri)
    expect(sent[1]!.record).toMatchObject({ version: 'v2', thresholds: { hostMinAttended: 2, feedbackK: 4 } })
    // Everything else about the school record is carried through untouched.
    expect(sent[0]!.record.name).toBe('Free School Test')
  })

  it('rolls the pointer back to the previous policy when the policy write fails, and refreshes no cache', async () => {
    if (!available) return
    const sent: Sent[] = []
    setSchoolActor(wirePort(sent, 'freeschool.draft.policy'))

    const res = await putPolicy()
    expect(res.status).toBe(500)

    expect(sent.map((s) => s.collection)).toEqual([
      'freeschool.draft.school', // re-pointed at the new policy
      'freeschool.draft.policy', // …which then failed
      'freeschool.draft.school', // …so the pointer is put back
    ])
    expect(sent[2]!.rkey).toBe('self')
    expect(sent[2]!.record.policy).toBe(OLD_POLICY_URI)

    // The repo is back where it started: the school names the policy actually in force.
    expect(repo.get('freeschool.draft.school/self')?.policy).toBe(OLD_POLICY_URI)

    // A half-applied change must never reach the cache — it still describes v1.
    const cached = await testDb().select().from(policyCache).where(eq(policyCache.schoolDid, SCHOOL))
    expect(cached[0]?.policyUri).toBe(OLD_POLICY_URI)
    expect((cached[0]?.thresholds as { hostMinAttended: number }).hostMinAttended).toBe(0)
  })

  it('refreshes the cache to the NEW policy only once both writes have succeeded', async () => {
    if (!available) return
    setSchoolActor(wirePort([]))
    const res = await putPolicy()
    expect(res.status).toBe(201)
    const { uri } = (await res.json()) as { uri: string }

    const cached = await testDb().select().from(policyCache).where(eq(policyCache.schoolDid, SCHOOL))
    expect(cached[0]?.policyUri).toBe(uri)
    expect(cached[0]?.thresholds).toMatchObject({ hostMinAttended: 2, feedbackK: 4 })
  })
})
