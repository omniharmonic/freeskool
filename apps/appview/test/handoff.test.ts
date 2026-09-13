/**
 * Steward hand-off: a single-use, 7-day token that grants the acceptor Steward through
 * `SchoolActorPort`. The PDS write for the proposer's own `freeschool.draft.approval`
 * record is faked (`writeApproval`) — this suite never touches a real PDS — but the
 * `SchoolActorPort` call on acceptance runs through a REAL `AppCustodyAdapter` wired
 * with the REAL `PostgresAuditSink` (only its `SchoolSession.call` is faked), so the
 * `fs_audit` row this pins down is the genuine one, not a stand-in.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AppCustodyAdapter, type Did } from '@freeschool/school-actor'
import { Role } from '@freeschool/shared'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { PostgresAuditSink, setSchoolActor } from '../src/lib/school-actor.js'
import { acceptHandoff, proposeHandoff } from '../src/http/routes/handoff.js'
import { audit, steward } from '../src/db/schema.js'

const SCHOOL = 'did:plc:school' as Did
const FROM = 'did:plc:from-steward' as Did
const ACCEPTOR = 'did:plc:new-steward' as Did
const OTHER = 'did:plc:someone-else' as Did

function wirePort(stewardDids: Did[] = [FROM]) {
  const stewardSet = new Set(stewardDids)
  return new AppCustodyAdapter({
    roles: { async roleOf(_school, did) { return stewardSet.has(did as Did) ? Role.Steward : Role.Visitor } },
    policy: { async destructiveActionStewards() { return 2 } },
    audit: new PostgresAuditSink(),
    session: {
      async call() {
        return { status: 200, output: { uri: `at://${SCHOOL}/freeschool.draft.moderationAction/x`, cid: 'bafyx' } }
      },
    },
    pdsEndpoint: 'http://localhost:3000',
  })
}

const fakeApproval = async () => ({ uri: 'at://did:plc:from-steward/freeschool.draft.approval/x', cid: 'bafy' })

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_handoff', 'fs_steward', 'fs_audit')
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('proposeHandoff', () => {
  it('writes the proposer approval first and returns a single-use token + URL', async () => {
    if (!available) return
    const writeCalls: unknown[] = []
    const res = await proposeHandoff({ did: FROM, kind: 'custodial' }, {}, {
      writeApproval: async (_viewer, record) => (writeCalls.push(record), fakeApproval()),
    })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(writeCalls.length).toBe(1)
    expect(writeCalls[0]).toMatchObject({ action: 'set-role' })
    expect(res.url).toContain(res.token)
    expect(new Date(res.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('resolves a named successor and records it on the approval', async () => {
    if (!available) return
    const writeCalls: Array<{ subjectDid?: string }> = []
    const res = await proposeHandoff({ did: FROM, kind: 'custodial' }, { toHandleOrDid: ACCEPTOR }, {
      writeApproval: async (_viewer, record) => (writeCalls.push(record as { subjectDid?: string }), fakeApproval()),
    })
    expect(res.ok).toBe(true)
    expect(writeCalls[0]?.subjectDid).toBe(ACCEPTOR)
  })
})

describe('acceptHandoff', () => {
  async function propose(toHandleOrDid?: string) {
    const res = await proposeHandoff({ did: FROM, kind: 'custodial' }, { toHandleOrDid }, { writeApproval: fakeApproval })
    if (!res.ok) throw new Error('propose failed in test setup')
    return res
  }

  it('grants the acceptor Steward through the actor port and writes an audit row', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    const proposed = await propose()
    const result = await acceptHandoff(proposed.token, ACCEPTOR)
    expect(result.ok).toBe(true)

    const stewardRows = await testDb().select().from(steward).where(eq(steward.did, ACCEPTOR))
    expect(stewardRows.length).toBe(1)
    expect(stewardRows[0]?.appointedByDid).toBe(FROM)

    const auditRows = await testDb().select().from(audit).where(eq(audit.action, 'set-role'))
    expect(auditRows.length).toBeGreaterThan(0)
    expect(auditRows.some((r) => r.decision === 'allow' && r.callerDid === FROM)).toBe(true)
  })

  it('the token is single-use: a second accept attempt fails', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    const proposed = await propose()
    const first = await acceptHandoff(proposed.token, ACCEPTOR)
    expect(first.ok).toBe(true)
    const second = await acceptHandoff(proposed.token, OTHER)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe('AlreadyUsed')
  })

  it('an unknown token 404s', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    const result = await acceptHandoff('not-a-real-token', ACCEPTOR)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('a token addressed to a named successor refuses anyone else', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    const proposed = await propose(ACCEPTOR)
    const wrong = await acceptHandoff(proposed.token, OTHER)
    expect(wrong.ok).toBe(false)
    if (!wrong.ok) expect(wrong.error).toBe('WrongRecipient')
    const right = await acceptHandoff(proposed.token, ACCEPTOR)
    expect(right.ok).toBe(true)
  })

  it('warns single-steward when fewer than two stewards remain after acceptance', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    const proposed = await propose()
    const result = await acceptHandoff(proposed.token, ACCEPTOR)
    expect(result.ok).toBe(true)
    // FROM only ever existed as a faked `roleOf` override in this test, never as a real
    // fs_steward row, so after granting ACCEPTOR there is exactly one real steward row.
    if (result.ok) expect(result.warning).toBe('single-steward')
  })

  it('does not warn when two real stewards remain after acceptance', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    await testDb().insert(steward).values({ did: FROM, schoolDid: SCHOOL })
    const proposed = await propose()
    const result = await acceptHandoff(proposed.token, ACCEPTOR)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.warning).toBeUndefined()
  })
})
