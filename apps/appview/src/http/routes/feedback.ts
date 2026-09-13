/**
 * `/api/feedback` and `/api/events/:id/feedback-summary`.
 *
 * Writing: only someone with confirmed attendance may leave feedback, once, and the host
 * never learns who. See ../../lib/feedback.ts for how the ballot and the content are kept
 * apart.
 *
 * Reading: the ONLY view is the k-anonymous aggregate. There is no endpoint that returns
 * rows, to anyone, including stewards — that is what the moderation queue is for, and it
 * works on reports rather than on raw feedback.
 *
 * NOTE on the Spaces shim: raw feedback is deliberately NOT mirrored into a space. The
 * shim stores an `author` alongside every record, and writing the text there would
 * re-create exactly the author-to-text link the ballot tables exist to destroy. What DOES
 * go through the shim is the PUBLISHED AGGREGATE, authored by the school
 * (`publishAggregateToSpace` in ../../lib/feedback.ts), so the interface is exercised on
 * the real path without undoing the anonymity.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, isNull } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { feedbackSummary, submitFeedback, FeedbackError } from '../../lib/feedback.js'
import { loadEvent } from './events.js'
import { getDb } from '../../db/index.js'
import { attendance } from '../../db/schema.js'
import { enqueueNotification } from '../../notifications/dispatch.js'

export const feedbackRoutes = new Hono<AppEnv>()

const body = z.object({
  eventUri: z.string().startsWith('at://'),
  direction: z.enum(['positive', 'negative']),
  aspects: z
    .object({
      knowledge: z.number().int().min(1).max(5).optional(),
      teaching: z.number().int().min(1).max(5).optional(),
      experience: z.number().int().min(1).max(5).optional(),
    })
    .optional(),
  text: z.string().max(4000).optional(),
})

feedbackRoutes.post('/feedback', requireViewer, async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  const { eventUri, direction, aspects, text } = parsed.data

  const loaded = await loadEvent(eventUri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)

  const attended = await getDb()
    .select({ id: attendance.id })
    .from(attendance)
    .where(
      and(
        eq(attendance.eventUri, eventUri),
        eq(attendance.attendeeDid, viewer.did),
        eq(attendance.participated, true),
        isNull(attendance.voidedAt),
      ),
    )
    .limit(1)
  if (attended.length === 0) {
    return c.json(
      { error: 'NotEligible', message: 'feedback is open to people the host confirmed were there' },
      403,
    )
  }

  try {
    await submitFeedback({
      eventUri,
      hostDid: loaded.hostDid,
      authorDid: viewer.did,
      direction,
      ...(aspects ? { aspects } : {}),
      ...(text ? { text } : {}),
    })
  } catch (err) {
    if (err instanceof FeedbackError) return c.json({ error: err.code, message: err.message }, err.status as 409)
    throw err
  }

  // The host is told feedback arrived. With NO actor, ever.
  await enqueueNotification({
    did: loaded.hostDid,
    category: 'feedback.received',
    dedupKey: `feedback.received:${eventUri}:${Date.now()}`,
    title: 'New feedback on a class you taught',
    body: 'It stays anonymous. A summary appears once enough people have answered.',
    navigate: `/events/${encodeURIComponent(eventUri)}/feedback`,
  })

  return c.json({ ok: true }, 201)
})

feedbackRoutes.get('/events/:id/feedback-summary', async (c) => {
  const eventUri = decodeURIComponent(c.req.param('id'))
  const loaded = await loadEvent(eventUri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  const summary = await feedbackSummary(eventUri)
  // Everyone sees the same thing. The host has no privileged view, by design.
  return c.json(summary)
})
