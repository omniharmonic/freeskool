/**
 * Newsletter sending, against a live Postgres (`fs_newsletter_issue` +
 * `fs_newsletter_subscription`), with the mail TRANSPORT faked (`sendFn`) so this suite
 * never touches SMTP, never falls through to `mail.ts`'s console fallback, and prints
 * nothing — see `jobs/newsletter.ts#SendNewsletterDeps`.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { composeNewsletterIssue, renderDigestHtml, sendNewsletterIssue } from '../src/jobs/newsletter.js'
import { subscribe, unsubscribeByToken } from '../src/lib/newsletter-subscriptions.js'
import { newsletterIssue } from '../src/db/schema.js'
import type { Mail } from '../src/lib/mail.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_newsletter_issue', 'fs_newsletter_subscription')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

function fakeSender() {
  const calls: Mail[] = []
  return { calls, sendFn: async (mail: Mail) => (calls.push(mail), { delivered: true, transport: 'fake' }) }
}

describe('renderDigestHtml', () => {
  it('never contains an <img tag — no tracking pixel', () => {
    const html = renderDigestHtml({ subject: 'Free School, 2026-09', body: 'line one\nline two', eventCount: 2 })
    expect(html.toLowerCase()).not.toContain('<img')
  })
})

describe('sendNewsletterIssue', () => {
  it('sends only to currently-subscribed members, excludes anyone unsubscribed, and marks the issue sent', async () => {
    if (!available) return
    await subscribe('did:plc:subscriber-a', 'a@example.org')
    await subscribe('did:plc:subscriber-b', 'b@example.org')
    const c = await subscribe('did:plc:subscriber-c', 'c@example.org')
    const unsub = await unsubscribeByToken(c.token)
    expect(unsub.ok).toBe(true)

    const draft = await composeNewsletterIssue('2026-09')
    const { calls, sendFn } = fakeSender()
    const res = await sendNewsletterIssue(draft.id, { sendFn })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.recipientCount).toBe(2)
      expect(res.failedCount).toBe(0)
    }
    expect(calls.length).toBe(2)
    expect(calls.map((m) => m.to).sort()).toEqual(['a@example.org', 'b@example.org'])
    for (const mail of calls) {
      expect(mail.html ?? '').not.toContain('<img')
      expect(mail.html).toContain('Unsubscribe')
    }

    const rows = await testDb().select().from(newsletterIssue).where(eq(newsletterIssue.id, draft.id))
    expect(rows[0]?.status).toBe('sent')
    expect(rows[0]?.recipientCount).toBe(2)
    expect(rows[0]?.failedCount).toBe(0)
    expect(rows[0]?.sentAt).toBeTruthy()
  })

  it('one recipient throwing does not abort the run for the rest, and is counted rather than silently dropped', async () => {
    if (!available) return
    await subscribe('did:plc:subscriber-ok-1', 'ok1@example.org')
    await subscribe('did:plc:subscriber-fail', 'fail@example.org')
    await subscribe('did:plc:subscriber-ok-2', 'ok2@example.org')

    const draft = await composeNewsletterIssue('2026-09')
    const calls: Mail[] = []
    const sendFn = async (mail: Mail) => {
      if (mail.to === 'fail@example.org') throw new Error('simulated transport failure')
      calls.push(mail)
      return { delivered: true, transport: 'fake' }
    }
    const res = await sendNewsletterIssue(draft.id, { sendFn })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.recipientCount).toBe(2)
      expect(res.failedCount).toBe(1)
    }
    // both surviving recipients still got their mail — the throw did not abort the loop
    expect(calls.map((m) => m.to).sort()).toEqual(['ok1@example.org', 'ok2@example.org'])

    const rows = await testDb().select().from(newsletterIssue).where(eq(newsletterIssue.id, draft.id))
    expect(rows[0]?.status).toBe('sent')
    expect(rows[0]?.recipientCount).toBe(2)
    expect(rows[0]?.failedCount).toBe(1)
  })

  it('refuses to send an already-sent issue a second time', async () => {
    if (!available) return
    await subscribe('did:plc:subscriber-d', 'd@example.org')
    const draft = await composeNewsletterIssue('2026-09')
    const { sendFn } = fakeSender()
    const first = await sendNewsletterIssue(draft.id, { sendFn })
    expect(first.ok).toBe(true)
    const second = await sendNewsletterIssue(draft.id, { sendFn })
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.error).toBe('AlreadySent')
  })

  it('404s on an unknown issue id', async () => {
    if (!available) return
    const res = await sendNewsletterIssue('not-a-real-id', { sendFn: fakeSender().sendFn })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(404)
  })
})

describe('unsubscribe tokens are single-use', () => {
  it('the first use succeeds; the second use of the SAME token fails', async () => {
    if (!available) return
    const { token } = await subscribe('did:plc:subscriber-e', 'e@example.org')
    const first = await unsubscribeByToken(token)
    expect(first.ok).toBe(true)
    const second = await unsubscribeByToken(token)
    expect(second.ok).toBe(false)
  })

  it('an unknown token is refused', async () => {
    if (!available) return
    const res = await unsubscribeByToken('not-a-real-token')
    expect(res.ok).toBe(false)
  })
})
