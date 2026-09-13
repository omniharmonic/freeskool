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
import type { Context } from 'hono'
import { AppCustodyAdapter, type Did } from '@freeschool/school-actor'
import { Role } from '@freeschool/shared'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { PostgresAuditSink, setSchoolActor } from '../src/lib/school-actor.js'
import { acceptHandoff, proposeHandoff } from '../src/http/routes/handoff.js'
import { audit, custodialAccount, handoff as handoffTable, steward } from '../src/db/schema.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'

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
  await truncate('fs_handoff', 'fs_steward', 'fs_audit', 'fs_session', 'fs_member', 'fs_custodial_account')
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

  it('resolves a named successor into fs_handoff.to_did, but NEVER into the public approval record', async () => {
    if (!available) return
    const writeCalls: Array<Record<string, unknown>> = []
    const res = await proposeHandoff({ did: FROM, kind: 'custodial' }, { toHandleOrDid: ACCEPTOR }, {
      writeApproval: async (_viewer, record) => (writeCalls.push(record), fakeApproval()),
    })
    expect(res.ok).toBe(true)
    // The successor's DID lives only app-side (fs_handoff), bound once THEY accept —
    // never in the proposer's public repo before the successor has consented to anything.
    expect('subjectDid' in writeCalls[0]!).toBe(false)
    expect(JSON.stringify(writeCalls[0])).not.toContain(ACCEPTOR)
  })

  it('the approval record never carries any DID other than the proposer\'s own (R9)', async () => {
    if (!available) return
    const writeCalls: Array<Record<string, unknown>> = []
    await proposeHandoff({ did: FROM, kind: 'custodial' }, { toHandleOrDid: ACCEPTOR }, {
      writeApproval: async (viewer, record) => (writeCalls.push(record), fakeApproval()),
    })
    const serialized = JSON.stringify(writeCalls[0])
    // the proposal's synthetic at-uri legitimately contains the SCHOOL's did; nothing
    // else in the record may contain any did: at all.
    const dids = serialized.match(/did:[a-z0-9]+:[a-zA-Z0-9._-]+/g) ?? []
    for (const d of dids) expect(d).toBe(SCHOOL)
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

  it('never writes the acceptor’s DID into the PUBLIC moderationAction record (R9) — it lives app-side in fs_handoff.to_did and fs_steward', async () => {
    if (!available) return
    const captured: Array<Record<string, unknown>> = []
    setSchoolActor(
      new AppCustodyAdapter({
        roles: { async roleOf(_school, did) { return did === FROM ? Role.Steward : Role.Visitor } },
        policy: { async destructiveActionStewards() { return 2 } },
        audit: new PostgresAuditSink(),
        session: {
          async call(i) {
            captured.push(i.body as Record<string, unknown>)
            return { status: 200, output: { uri: `at://${SCHOOL}/freeschool.draft.moderationAction/x`, cid: 'bafyx' } }
          },
        },
        pdsEndpoint: 'http://localhost:3000',
      }),
    )
    const proposed = await propose()
    const result = await acceptHandoff(proposed.token, ACCEPTOR)
    expect(result.ok).toBe(true)

    expect(captured.length).toBe(1)
    const sent = captured[0] as { record: Record<string, unknown> }
    expect('subjectDid' in sent.record).toBe(false)
    expect('subjectRecord' in sent.record).toBe(false)
    expect(JSON.stringify(sent.record)).not.toContain(ACCEPTOR)
    // F0: nor a reason. Moderation reasons are never public; this record type is shared
    // with the moderation queue, where the reason is free text about a particular person.
    expect('reason' in sent.record).toBe(false)
    expect(Object.keys(sent.record).sort()).toEqual(['$type', 'action', 'actors', 'createdAt', 'policyRef'])

    // The subject is still recoverable app-side.
    const row = await testDb().select().from(handoffTable).where(eq(handoffTable.id, proposed.id))
    expect(row[0]?.toDid).toBe(ACCEPTOR)
    const stewardRows = await testDb().select().from(steward).where(eq(steward.did, ACCEPTOR))
    expect(stewardRows.length).toBe(1)
    // …and the audit row still carries the reason.
    const auditRows = await testDb().select().from(audit).where(eq(audit.action, 'set-role'))
    expect(auditRows.some((r) => r.reason.includes('hand-off'))).toBe(true)
  })

  /**
   * A12. The old sequence was SELECT, check `accepted_at`, act, UPDATE — so two requests
   * arriving together both read `accepted_at IS NULL`, both passed the check, and both ran
   * `set-role`. One link, two stewards, the second with no approval behind it. The fix is
   * the same shape as `invites.ts`'s atomic decrement: claim the row in the WHERE clause
   * and act only on a returned row.
   */
  describe('A12: single-use under concurrency', () => {
    it('two simultaneous accepts produce exactly one steward and one port call', async () => {
      if (!available) return
      const calls: unknown[] = []
      setSchoolActor(
        new AppCustodyAdapter({
          roles: { async roleOf(_school, did) { return did === FROM ? Role.Steward : Role.Visitor } },
          policy: { async destructiveActionStewards() { return 2 } },
          audit: new PostgresAuditSink(),
          session: {
            async call(i) {
              calls.push(i)
              // A real PDS write is not instantaneous; the whole point is that the second
              // caller must already have been refused BEFORE this resolves.
              await new Promise((r) => setTimeout(r, 40))
              return { status: 200, output: { uri: `at://${SCHOOL}/freeschool.draft.moderationAction/x`, cid: 'bafyx' } }
            },
          },
          pdsEndpoint: 'http://localhost:3000',
        }),
      )
      const proposed = await propose()

      const [a, b] = await Promise.all([acceptHandoff(proposed.token, ACCEPTOR), acceptHandoff(proposed.token, OTHER)])
      const winners = [a, b].filter((r) => r.ok)
      const losers = [a, b].filter((r) => !r.ok)
      expect(winners.length).toBe(1)
      expect(losers.length).toBe(1)
      expect(losers[0]!.ok === false && losers[0]!.error).toBe('AlreadyUsed')

      // ONE port call, ONE steward.
      expect(calls.length).toBe(1)
      const stewardRows = await testDb().select().from(steward)
      expect(stewardRows.length).toBe(1)

      const row = await testDb().select().from(handoffTable).where(eq(handoffTable.id, proposed.id))
      expect(row[0]?.acceptedAt).not.toBeNull()
      // `to_did` records who actually accepted, written only after the hand-off succeeded.
      expect(row[0]?.toDid).toBe(stewardRows[0]?.did)
    })

    it('releases the claim when the school declines, so the link is still usable', async () => {
      if (!available) return
      // FROM is NOT a steward here, so the port refuses: nothing took effect, and burning
      // the link on a refusal that was not the acceptor's doing would be wrong.
      setSchoolActor(wirePort([]))
      const proposed = await propose()
      const refused = await acceptHandoff(proposed.token, ACCEPTOR)
      expect(refused.ok).toBe(false)

      const row = await testDb().select().from(handoffTable).where(eq(handoffTable.id, proposed.id))
      expect(row[0]?.acceptedAt).toBeNull()
      expect(row[0]?.toDid).toBeNull()

      // …and now it works.
      setSchoolActor(wirePort())
      expect((await acceptHandoff(proposed.token, ACCEPTOR)).ok).toBe(true)
    })

    it('still distinguishes expired from already-used from unknown', async () => {
      if (!available) return
      setSchoolActor(wirePort())
      const proposed = await propose()
      await testDb()
        .update(handoffTable)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(handoffTable.id, proposed.id))
      const expired = await acceptHandoff(proposed.token, ACCEPTOR)
      expect(expired.ok).toBe(false)
      if (!expired.ok) expect(expired.error).toBe('Expired')
    })
  })
})

/**
 * HTTP level, through the REAL `createApp()` — pins the actual route: `POST
 * /api/handoff/:token/accept` must NOT be caught by `admin.use('*', requireRole(Steward))`
 * (it would be, at `/api/admin/handoff/:token/accept`, since Hono applies a mounted
 * sub-app's `'*'` middleware to any path under its prefix regardless of whether that
 * sub-app has its own handler for it).
 */
describe('HTTP: POST /api/handoff/:token/accept', () => {
  /** `setCookie` only ever calls `c.header(...)` on this — see `test/membership.test.ts`. */
  function fakeContext(): Context {
    return { header: () => undefined } as unknown as Context
  }

  async function cookieFor(did: string): Promise<string> {
    const id = await createSession(fakeContext(), did, 'custodial')
    return `${config().SESSION_COOKIE}=${signSessionId(id)}`
  }

  it('a non-steward Member can accept — no 403 from the admin gate', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    const proposed = await proposeHandoff({ did: FROM, kind: 'custodial' }, {}, { writeApproval: fakeApproval })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return

    // A custodial account gives this DID hasProfile=true; under the default open
    // policy that derives (at least) Host — comfortably >= Member, and NOT Steward,
    // which is exactly the case the admin blanket gate used to 403.
    await testDb().insert(custodialAccount).values({ did: ACCEPTOR, handle: 'member.test', email: 'member@example.org', keyVersion: 'v1' })
    const cookie = await cookieFor(ACCEPTOR)

    const app = createApp()
    const res = await app.request(`/api/handoff/${proposed.token}/accept`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('a Visitor (no profile at all) is refused with 403, not a steward-gate 403 masquerading as the wrong error', async () => {
    if (!available) return
    setSchoolActor(wirePort())
    const proposed = await proposeHandoff({ did: FROM, kind: 'custodial' }, {}, { writeApproval: fakeApproval })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return

    const visitor = 'did:plc:a-bare-visitor'
    const cookie = await cookieFor(visitor)

    const app = createApp()
    const res = await app.request(`/api/handoff/${proposed.token}/accept`, {
      method: 'POST',
      headers: { Cookie: cookie },
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('PermissionDenied')
  })

  it('an unauthenticated request is refused with 401', async () => {
    if (!available) return
    const app = createApp()
    const res = await app.request('/api/handoff/not-a-real-token/accept', { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
