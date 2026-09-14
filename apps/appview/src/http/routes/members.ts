/**
 * `/api/members` — the members-only people directory (R9: this roster is never public).
 *
 *   GET /members            paginated list; `q` (displayName substring) and `skill`
 *                           (AT-URI) filters; opaque `cursor`
 *   GET /members/:did       one member's profile — 404 when not directory-visible
 *   GET /members/:did/avatar
 *
 * Every route requires a session and sets `X-Robots-Tag: noindex, nofollow`, same
 * convention as `/api/me/*` and `/api/attestations`.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { listMembers, memberProfile, memberVisible } from '../../lib/members.js'
import { loadProfile } from './me.js'

export const members = new Hono<AppEnv>()

// Header first, gate second: even the 401 for an anonymous caller must say noindex.
members.use('*', async (c, next) => {
  c.header('X-Robots-Tag', 'noindex, nofollow')
  await next()
})
members.use('*', requireViewer)

const listQuery = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  skill: z.string().startsWith('at://').optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

members.get('/members', async (c) => {
  const parsed = listQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  return c.json(await listMembers(parsed.data))
})

members.get('/members/:did', async (c) => {
  const did = c.req.param('did')
  const viewer = c.var.viewer!
  const profile = await memberProfile(did, viewer.did)
  if (!profile) return c.json({ error: 'NotFound' }, 404)
  return c.json(profile)
})

members.get('/members/:did/avatar', async (c) => {
  const did = c.req.param('did')
  const viewer = c.var.viewer!
  if (!(await memberVisible(did, viewer.did))) return c.json({ error: 'NotFound' }, 404)
  const profile = await loadProfile(did)
  if (!profile.avatar) return c.json({ error: 'NotFound' }, 404)
  c.header('Content-Type', 'image/webp')
  c.header('Cache-Control', 'private, no-store')
  return c.body(new Uint8Array(Buffer.from(profile.avatar.data, 'base64')))
})
