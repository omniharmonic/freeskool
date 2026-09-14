/**
 * `GET /api/admin/newsletter/last` — the Preview section of the compose screen's data
 * source. The most recently composed `fs_newsletter_issue` for the CURRENT school, or
 * `null` when nothing has ever been composed — content and status, never a recipient
 * list (the table does not carry one; per-send fan-out is `jobs/newsletter.ts`'s own
 * unindexed work).
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'hono'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { custodialAccount, newsletterIssue, steward } from '../src/db/schema.js'
import { rowId } from '../src/lib/ids.js'

const SCHOOL = 'did:plc:school'
const OTHER_SCHOOL = 'did:plc:other-school'
const STEWARD = 'did:plc:steward-a'
const MEMBER = 'did:plc:a-member'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_newsletter_issue', 'fs_steward', 'fs_session', 'fs_custodial_account')
  await testDb().insert(steward).values({ did: STEWARD, schoolDid: SCHOOL })
  // `hasProfile` (a precondition for any derived role, including Steward) requires a
  // custodial account or indexed records — see `lib/roles.ts#evidenceFor`.
  await testDb()
    .insert(custodialAccount)
    .values({ did: STEWARD, handle: 'steward-a.test', email: 'steward-a@example.org', keyVersion: 'v1' })
  await testDb()
    .insert(custodialAccount)
    .values({ did: MEMBER, handle: 'a-member.test', email: 'a-member@example.org', keyVersion: 'v1' })
})

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

describe('GET /api/admin/newsletter/last', () => {
  it('is null when nothing has ever been composed for this school', async () => {
    if (!available) return
    const app = createApp()
    const cookie = await cookieFor(STEWARD)
    const res = await app.request('/api/admin/newsletter/last', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ issue: null })
  })

  it('returns the most recent issue, by content — never a recipient list', async () => {
    if (!available) return
    await testDb().insert(newsletterIssue).values({
      id: rowId(),
      schoolDid: SCHOOL,
      month: '2026-07',
      html: '<p>July</p>',
      text: 'July',
      status: 'sent',
      sentAt: new Date('2026-08-01T00:00:00Z'),
      recipientCount: 42,
    })
    const id = rowId()
    await testDb().insert(newsletterIssue).values({
      id,
      schoolDid: SCHOOL,
      month: '2026-08',
      html: '<p>August</p>',
      text: 'August',
      status: 'draft',
    })

    const app = createApp()
    const cookie = await cookieFor(STEWARD)
    const res = await app.request('/api/admin/newsletter/last', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { issue: Record<string, unknown> }
    expect(body.issue).toMatchObject({ id, month: '2026-08', status: 'draft', html: '<p>August</p>', text: 'August' })
    // No per-recipient shape anywhere in the response.
    expect(JSON.stringify(body)).not.toMatch(/recipients|emails/i)
  })

  it('never shows an issue composed for a DIFFERENT school', async () => {
    if (!available) return
    await testDb().insert(newsletterIssue).values({
      id: rowId(),
      schoolDid: OTHER_SCHOOL,
      month: '2026-08',
      html: '<p>Not us</p>',
      text: 'Not us',
      status: 'draft',
    })
    const app = createApp()
    const cookie = await cookieFor(STEWARD)
    const res = await app.request('/api/admin/newsletter/last', { headers: { Cookie: cookie } })
    expect(await res.json()).toEqual({ issue: null })
  })

  it('is steward-gated: a member who is not a steward is refused', async () => {
    if (!available) return
    const app = createApp()
    const cookie = await cookieFor(MEMBER)
    const res = await app.request('/api/admin/newsletter/last', { headers: { Cookie: cookie } })
    expect(res.status).toBe(403)
  })

  it('requires a session at all', async () => {
    if (!available) return
    const app = createApp()
    const res = await app.request('/api/admin/newsletter/last')
    expect(res.status).toBe(401)
  })
})
