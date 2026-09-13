/**
 * `POST /api/admin/moderation/:id/execute`.
 *
 * R9 / F0 — what the public `freeschool.draft.moderationAction` record may say. NOT the
 * subject (`subjectDid`/`subjectRecord`; an at-uri's authority segment IS a DID) and NOT
 * the `reason` (free text a steward wrote about a particular person — moderation reasons
 * are never public, CLAUDE.md). What is left is the decision: action, policyRef, actors,
 * createdAt. The steward-only admin queue keeps showing both, because it reads the app-side
 * `fs_moderation_queue` row rather than the public record.
 *
 * A3 / A4 — and the action has to actually DO something. `void-attendance` voids the rows
 * and takes the credit back off the lifetime tally; `restore-listing` appends a `listed`
 * listing, which `http/visibility.ts#isListed` now honours because the newest listing wins.
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
import { appMeta, attendance, attendanceTally, custodialAccount, moderationQueue, steward } from '../src/db/schema.js'
import { rowId } from '../src/lib/ids.js'
import { eq } from 'drizzle-orm'
import { isListed } from '../src/http/visibility.js'

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
  await truncate(
    'fs_app_meta',
    'fs_moderation_queue',
    'fs_audit',
    'fs_steward',
    'fs_session',
    'fs_custodial_account',
    'fs_attendance',
    'fs_attendance_tally',
  )
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
function wirePort(captured: Array<Record<string, unknown>>, threshold = 1) {
  return new AppCustodyAdapter({
    roles: { async roleOf() { return Role.Steward } },
    policy: { async destructiveActionStewards() { return threshold } },
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
    // F0: no reason either. It is a steward's free text about one person.
    expect('reason' in sent.record).toBe(false)
    expect(JSON.stringify(sent.record)).not.toContain('repeated no-shows')
    expect(Object.keys(sent.record).sort()).toEqual(['$type', 'action', 'actors', 'createdAt', 'policyRef'])

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
    expect('reason' in moderationRecord.record).toBe(false)
    expect(JSON.stringify(moderationRecord.record)).not.toContain(subjectUri)
    expect(JSON.stringify(moderationRecord.record)).not.toContain('off-topic')

    // The LISTING the school writes is a different record and DOES name the event — that
    // is the whole point of a curation listing, and the host published that event.
    const listing = captured[1] as { record: Record<string, unknown> } | undefined
    expect((listing?.record.event as { uri: string }).uri).toBe(subjectUri)
    expect(listing?.record.status).toBe('removed')
    expect('reason' in (listing?.record ?? {})).toBe(false)
  })

  /* A4: restore-listing */

  it('restore-listing appends a `listed` listing, which the newest-wins rule honours', async () => {
    if (!available) return
    const captured: Array<Record<string, unknown>> = []
    setSchoolActor(wirePort(captured))

    const subjectUri = 'at://did:plc:some-host/community.lexicon.calendar.event/restore-me'
    const id = rowId()
    await testDb().insert(moderationQueue).values({
      id,
      action: 'restore-listing',
      subjectUri,
      subjectDid: null,
      reason: 'the report was mistaken; the class is fine',
      openedByDid: STEWARD_A,
      approvals: [{ stewardDid: STEWARD_A, at: new Date().toISOString() }],
    })

    const app = createApp()
    const cookie = await cookieFor(STEWARD_A)
    const res = await app.request(`/api/admin/moderation/${id}/execute`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { listing?: { uri: string; status: string } }
    expect(body.listing?.status).toBe('listed')

    // Two writes: the decision, then the listing.
    expect(captured.length).toBe(2)
    const listing = captured[1] as { record: Record<string, unknown> }
    expect(listing.record.status).toBe('listed')
    expect((listing.record.event as { uri: string }).uri).toBe(subjectUri)

    // …and the restore genuinely un-hides the class, removal still sitting in the history.
    const ref = { uri: subjectUri, cid: 'bafy' }
    expect(
      isListed({
        listings: [
          { event: ref, school: 'did:plc:school', status: 'removed', createdAt: '2026-09-01T00:00:00Z' },
          { event: ref, school: 'did:plc:school', status: listing.record.status as 'listed', createdAt: listing.record.createdAt as string },
        ],
        configs: [],
      }),
    ).toBe(true)
  })

  /* A3: void-attendance */

  it('void-attendance voids the subject’s rows and takes the credit back off their tally', async () => {
    if (!available) return
    const captured: Array<Record<string, unknown>> = []
    setSchoolActor(wirePort(captured))

    const eventUri = 'at://did:plc:some-host/community.lexicon.calendar.event/void-me'
    const otherEvent = 'at://did:plc:some-host/community.lexicon.calendar.event/untouched'
    const voided = 'did:plc:attendance-void-subject'
    const bystander = 'did:plc:attendance-void-bystander'

    await testDb().insert(attendance).values([
      { id: rowId(), eventUri, attendeeDid: voided, attestedByDid: 'did:plc:some-host', participated: true },
      { id: rowId(), eventUri, attendeeDid: bystander, attestedByDid: 'did:plc:some-host', participated: true },
      { id: rowId(), eventUri: otherEvent, attendeeDid: voided, attestedByDid: 'did:plc:some-host', participated: true },
    ])
    await testDb().insert(attendanceTally).values([
      { did: voided, attendedConfirmed: 2, hostedEvents: 0 },
      { did: bystander, attendedConfirmed: 1, hostedEvents: 0 },
    ])

    const id = rowId()
    await testDb().insert(moderationQueue).values({
      id,
      action: 'void-attendance',
      subjectUri: eventUri,
      subjectDid: voided,
      reason: 'the host ticked the wrong name',
      openedByDid: STEWARD_A,
      approvals: [{ stewardDid: STEWARD_A, at: new Date().toISOString() }],
    })

    const app = createApp()
    const cookie = await cookieFor(STEWARD_A)
    const res = await app.request(`/api/admin/moderation/${id}/execute`, { method: 'POST', headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect((await res.json()) as { attendanceVoided?: number }).toMatchObject({ attendanceVoided: 1 })

    // Exactly the (event, person) row named, and nothing else.
    const rows = await testDb().select().from(attendance)
    const voidedRow = rows.find((r) => r.attendeeDid === voided && r.eventUri === eventUri)
    expect(voidedRow?.voidedAt).not.toBeNull()
    expect(rows.find((r) => r.attendeeDid === bystander)?.voidedAt).toBeNull()
    expect(rows.find((r) => r.eventUri === otherEvent)?.voidedAt).toBeNull()

    const tallies = await testDb().select().from(attendanceTally)
    expect(tallies.find((t) => t.did === voided)?.attendedConfirmed).toBe(1)
    expect(tallies.find((t) => t.did === bystander)?.attendedConfirmed).toBe(1)
  })

  it('is idempotent: re-executing a void does not decrement a second time, and never goes below zero', async () => {
    if (!available) return
    setSchoolActor(wirePort([]))
    const eventUri = 'at://did:plc:some-host/community.lexicon.calendar.event/void-twice'
    const subject = 'did:plc:attendance-void-twice'
    await testDb()
      .insert(attendance)
      .values({ id: rowId(), eventUri, attendeeDid: subject, attestedByDid: 'did:plc:some-host', participated: true })
    // Deliberately already at 0: the decrement must floor, not wrap negative.
    await testDb().insert(attendanceTally).values({ did: subject, attendedConfirmed: 0, hostedEvents: 0 })

    const app = createApp()
    const cookie = await cookieFor(STEWARD_A)
    for (const n of [1, 2]) {
      const id = `${rowId()}-${n}`
      await testDb().insert(moderationQueue).values({
        id,
        action: 'void-attendance',
        subjectUri: eventUri,
        subjectDid: subject,
        reason: 'voiding again',
        openedByDid: STEWARD_A,
        approvals: [{ stewardDid: STEWARD_A, at: new Date().toISOString() }],
      })
      const res = await app.request(`/api/admin/moderation/${id}/execute`, { method: 'POST', headers: { Cookie: cookie } })
      expect(res.status).toBe(200)
      // The second pass finds nothing left to void.
      expect((await res.json()) as { attendanceVoided?: number }).toMatchObject({ attendanceVoided: n === 1 ? 1 : 0 })
    }
    const tally = await testDb().select().from(attendanceTally).where(eq(attendanceTally.did, subject))
    expect(tally[0]?.attendedConfirmed).toBe(0)
  })
})

it('requires the school approval threshold to hide knowledge, and supports audited restoration',async()=>{
 if(!available)return
 const captured:Array<Record<string,unknown>>=[]
 setSchoolActor(wirePort(captured,2))
 const app=createApp(),cookie=await cookieFor(STEWARD_A),subjectUri=`at://${SUBJECT}/freeschool.draft.resource/one`
 const headers={Cookie:cookie,'Content-Type':'application/json'}
 const proposed=await (await app.request('/api/admin/moderation',{method:'POST',headers,body:JSON.stringify({action:'remove-resource',subjectUri,reason:'A private moderation reason'})})).json()
 expect((await app.request(`/api/admin/moderation/${proposed.id}/execute`,{method:'POST',headers})).status).toBe(403)
 expect(await testDb().select().from(appMeta).where(eq(appMeta.key,`resource-hidden:${subjectUri}`))).toHaveLength(0)
 await testDb().update(moderationQueue).set({approvals:[{stewardDid:STEWARD_A,at:new Date().toISOString()},{stewardDid:'did:plc:steward-b',at:new Date().toISOString()}]}).where(eq(moderationQueue.id,proposed.id))
 expect((await app.request(`/api/admin/moderation/${proposed.id}/execute`,{method:'POST',headers})).status).toBe(200)
 expect((await testDb().select().from(appMeta).where(eq(appMeta.key,`resource-hidden:${subjectUri}`)))[0]?.value).toBe(true)
 expect(JSON.stringify(captured)).not.toContain(subjectUri)
 expect(JSON.stringify(captured)).not.toContain('A private moderation reason')
 const restore=await (await app.request('/api/admin/moderation',{method:'POST',headers,body:JSON.stringify({action:'restore-resource',subjectUri,reason:'Resolved and ready to restore'})})).json()
 expect((await app.request(`/api/admin/moderation/${restore.id}/execute`,{method:'POST',headers})).status).toBe(200)
 expect((await testDb().select().from(appMeta).where(eq(appMeta.key,`resource-hidden:${subjectUri}`)))[0]?.value).toBe(false)
})
