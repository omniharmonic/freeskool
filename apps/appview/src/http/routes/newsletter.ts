/**
 * `/api/me/newsletter` and `/api/newsletter/unsubscribe/:token` — member-facing consent
 * for the monthly digest. Distinct from `/api/admin/newsletter*`, which is the steward
 * surface for composing/sending an issue.
 *
 *   PUT /me/newsletter { subscribed: boolean }   subscribe/unsubscribe the viewer
 *   GET /newsletter/unsubscribe/:token           public, one-click, single-use
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { getDb } from '../../db/index.js'
import { custodialAccount } from '../../db/schema.js'
import { isSubscribed, subscribe, unsubscribeByToken, unsubscribeDid } from '../../lib/newsletter-subscriptions.js'
import { currentSchool } from '../school-context.js'

export const newsletterRoutes = new Hono<AppEnv>()

const subscribeBody = z.object({ subscribed: z.boolean() })

newsletterRoutes.put('/me/newsletter', requireViewer, async (c) => {
  const parsed = subscribeBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!

  if (!parsed.data.subscribed) {
    await unsubscribeDid(viewer.did, currentSchool(c).did)
    return c.json({ subscribed: false })
  }

  const rows = await getDb().select({ email: custodialAccount.email }).from(custodialAccount).where(eq(custodialAccount.did, viewer.did)).limit(1)
  const email = rows[0]?.email
  if (!email) {
    return c.json({ error: 'NoEmailOnFile', message: 'this session has no email address to send a newsletter to' }, 409)
  }
  await subscribe(viewer.did, email, currentSchool(c).did)
  return c.json({ subscribed: true })
})

newsletterRoutes.get('/me/newsletter', requireViewer, async (c) => {
  return c.json({ subscribed: await isSubscribed(c.var.viewer!.did, currentSchool(c).did) })
})

/** Public: the link in the email. No session, no CORS credential, nothing to confirm. */
newsletterRoutes.get('/newsletter/unsubscribe/:token', async (c) => {
  const result = await unsubscribeByToken(c.req.param('token'))
  if (!result.ok) return c.json({ error: result.error, message: 'this unsubscribe link is invalid or was already used' }, result.status)
  return c.json({ ok: true, message: "you're unsubscribed" })
})
