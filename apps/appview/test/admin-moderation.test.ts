/**
 * `POST /api/admin/moderation/:id/execute` — R9 regression coverage for the defect the
 * privacy audit caught: the PUBLIC `freeschool.draft.moderationAction` record must never
 * carry `subjectDid`/`subjectRecord` (an at-uri's authority segment IS a DID), while the
 * steward-only admin queue (`GET /api/admin/moderation`) keeps showing the subject — it
 * reads the app-side `fs_moderation_queue` row, never the public record.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest'
import { AppCustodyAdapter, type Did } from '@freeschool/school-actor'
import { Role } from '@freeschool/shared'
import type { Context } from 'hono'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { PostgresAuditSink, setSchoolActor } from '../src/lib/school-actor.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { custodialAccount, moderationQueue, steward } from '../src/db/schema.js'
import { rowId } from '../src/lib/ids.js'

const SCHOOL = 'did:plc:school' as Did
const STEWARD_A = 'did:plc:steward-a' as Did
const SUBJECT = 'did:plc:a-member-acted-on'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_moderation_queue', 'fs_audit', 'fs_steward', 'fs_session', 'fs_custodial_account')
  await testDb().insert(steward).values({ did: STEWARD_A, schoolDid: SCHOOL })
  // `hasProfile` (a precondition for any derived role, including Steward) requires a
  // custodial account or indexed records — see `lib/roles.ts#evidenceFor`.
  await testDb()
    .insert(custodialAccount)
    .values({ did: STEWARD_A, handle: 'steward-a.test', email: 'steward-a@example.org', keyVersion: 'v1' })
})

afterEach(() => setSchoolActor(undefined))

afterAll(async () => {
  if (available) await closeTestDb()
})

/** `setCookie` only ever calls `c.header(...)` — see `test/handoff.test.ts`. */
function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function cookieFor(did: string): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

/** A REAL `AppCustodyAdapter` (threshold = 1, so one steward's own approval suffices),
 * with only the PDS session faked so the write record can be inspected. */
function wirePort(captured: Array<Record<string, unknown>>) {
  return new AppCustodyAdapter({
    roles: { async roleOf() { return Role.Steward } },
    policy: { async destructiveActionStewards() { return 1 } },
    audit: new PostgresAuditSink(),
    session: {
      async call(i) {
        captured.push(i.body as Record<string, unknown>)
        return { status: 200, output: { uri: `at://${SCHOOL}/freeschool.draft.moderationAction/x`, cid: 'bafyx' } }
      },
    },
    pdsEndpoint: 'http://localhost:3000',
  })
}

describe('POST /api/admin/moderation/:id/execute', () => {
  it('never writes subjectDid or subjectRecord into the public record, and the admin queue still shows the subject', async () => {
    if (!available) return
    const captured: Array<Record<string, unknown>> = []
    setSchoolActor(wirePort(captured))

    const id = rowId()
    await testDb().insert(moderationQueue).values({
      id,
      action: 'suspend-role',
      subjectUri: null,
      subjectDid: SUBJECT,
      reason: 'repeated no-shows after a warning',
      openedByDid: STEWARD_A,
      approvals: [{ stewardDid: STEWARD_A, at: new Date().toISOString() }],
    })

    const app = createApp()
    const cookie = await cookieFor(STEWARD_A)

    const res = await app.request(`/api/admin/moderation/${id}/execute`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; uri: string }
    expect(body.ok).toBe(true)

    // The record actually sent to the PDS, as the school.
    expect(captured.length).toBe(1)
    const sent = captured[0] as { record: Record<string, unknown> }
    expect('subjectDid' in sent.record).toBe(false)
    expect('subjectRecord' in sent.record).toBe(false)
    expect(JSON.stringify(sent.record)).not.toContain(SUBJECT)
    expect(sent.record.action).toBe('suspend-role')
    expect(sent.record.actors).toEqual([STEWARD_A])

    // The steward-only queue still carries the subject — it comes from the app-side
    // row, never from the public record.
    const queueRes = await app.request('/api/admin/moderation?status=resolved', { headers: { Cookie: cookie } })
    expect(queueRes.status).toBe(200)
    const queueBody = (await queueRes.json()) as { items: Array<{ id: string; subjectDid: string | null }> }
    const item = queueBody.items.find((i) => i.id === id)
    expect(item?.subjectDid).toBe(SUBJECT)
  })

  it('names an event listing at-uri in the app-side row but not in the public record, for remove-listing', async () => {
    if (!available) return
    const captured: Array<Record<string, unknown>> = []
    setSchoolActor(wirePort(captured))

    const subjectUri = 'at://did:plc:some-host/community.lexicon.calendar.event/abc123'
    const id = rowId()
    await testDb().insert(moderationQueue).values({
      id,
      action: 'remove-listing',
      subjectUri,
      subjectDid: null,
      reason: 'off-topic listing',
      openedByDid: STEWARD_A,
      approvals: [{ stewardDid: STEWARD_A, at: new Date().toISOString() }],
    })

    const app = createApp()
    const cookie = await cookieFor(STEWARD_A)
    const res = await app.request(`/api/admin/moderation/${id}/execute`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(200)

    // First call is the moderationAction write; a second (best-effort) call retracts
    // the listing. Neither may name the subject record publicly.
    expect(captured.length).toBeGreaterThanOrEqual(1)
    const moderationRecord = captured[0] as { record: Record<string, unknown> }
    expect('subjectRecord' in moderationRecord.record).toBe(false)
    expect('subjectDid' in moderationRecord.record).toBe(false)
    expect(JSON.stringify(moderationRecord.record)).not.toContain(subjectUri)
  })
})
