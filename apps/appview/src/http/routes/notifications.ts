/**
 * `/api/push/subscribe` and `/api/notifications`.
 *
 * Preferences and subscriptions are app state, never public records: a list of
 * "categories this person wants to hear about" is exactly the kind of thing that should
 * not be on the firehose.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { CATEGORIES, listNotifications, markRead, registerPushTarget, setPref } from '../../notifications/dispatch.js'
import { vapidPublicKey } from '../../lib/push.js'
import { getDb } from '../../db/index.js'
import { notificationPref, notificationTarget } from '../../db/schema.js'
import { currentSchool } from '../school-context.js'

export const notifications = new Hono<AppEnv>()

const subscribeBody = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

notifications.get('/push/vapid-public-key', (c) => c.json({ key: vapidPublicKey() }))

notifications.post('/push/subscribe', requireViewer, async (c) => {
  const parsed = subscribeBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const { id } = await registerPushTarget({ did: c.var.viewer!.did, ...parsed.data })
  return c.json({ id, categories: CATEGORIES }, 201)
})

notifications.delete('/push/subscribe', requireViewer, async (c) => {
  const endpoint = c.req.query('endpoint')
  if (!endpoint) return c.json({ error: 'InvalidRequest' }, 400)
  await getDb()
    .update(notificationTarget)
    .set({ disabledAt: new Date() })
    .where(eq(notificationTarget.address, endpoint))
  return c.json({ ok: true })
})

notifications.get('/notifications', requireViewer, async (c) => {
  const rows = await listNotifications(c.var.viewer!.did, Number(c.req.query('limit') ?? 50), currentSchool(c).did)
  return c.json({
    notifications: rows.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      body: r.body,
      navigate: r.navigate,
      createdAt: r.createdAt,
      read: Boolean(r.readAt),
    })),
  })
})

notifications.post('/notifications/read', requireViewer, async (c) => {
  const parsed = z.object({ ids: z.array(z.string()).max(500) }).safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  await markRead(c.var.viewer!.did, parsed.data.ids, currentSchool(c).did)
  return c.json({ ok: true })
})

notifications.get('/notifications/prefs', requireViewer, async (c) => {
  const rows = await getDb().select().from(notificationPref).where(eq(notificationPref.did, c.var.viewer!.did))
  return c.json({ categories: CATEGORIES, prefs: rows })
})

notifications.put('/notifications/prefs', requireViewer, async (c) => {
  const parsed = z
    .object({
      prefs: z
        .array(
          z.object({
            category: z.enum(CATEGORIES),
            transport: z.enum(['web-push', 'email']),
            enabled: z.boolean(),
          }),
        )
        .max(100),
    })
    .safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  for (const p of parsed.data.prefs) await setPref(c.var.viewer!.did, p.category, p.transport, p.enabled)
  return c.json({ ok: true })
})
