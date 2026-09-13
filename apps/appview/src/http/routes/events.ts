/**
 * `/api/events`
 *
 *   POST   /events                  a host publishes a class (see ../../lib/events.ts
 *                                   for the "whose repo" decision)
 *   GET    /events/:id              one event, projected for the viewer
 *   GET    /events/:id.ics          text/calendar, as an attachment
 *   POST   /events/:id/attendance   the host attests who took part (app-side)
 *
 * `:id` is a URL-encoded AT-URI. An AppView-local opaque id would be prettier but would
 * also be a second namespace to keep in sync; the AT-URI is already the identity.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireViewer, requireRole } from '../session.js'
import {
  createEventAsHost,
  EventNotFoundError,
  EventPermissionError,
  SeriesEditNotSupportedError,
  updateEventAsHost,
} from '../../lib/events.js'
import { NoActorCredentialError } from '../../lib/actor-agent.js'
import { getIndexer } from '../../index/indexer.js'
import { getRecordByUri, sidecarsForEvent } from '../../index/queries.js'
import type { EventConfig, EventListing } from '../../lexicons/coop.js'
import { icsLocation, isListed, projectEvent } from '../visibility.js'
import { viewerRelation } from '../relation.js'
import { toCalendarEvent } from './calendar.js'
import { buildIcs, icsStatus } from '../../lib/ics.js'
import { getDb } from '../../db/index.js'
import { attendance, attendanceRollup } from '../../db/schema.js'
import { rowId } from '../../lib/ids.js'
import { bumpTally } from '../../lib/roles.js'
import { rsvpCounts } from '../../lib/rsvp.js'

export const events = new Hono<AppEnv>()

const createBody = z.object({
  name: z.string().min(1).max(300),
  description: z.string().max(20_000).optional(),
  startsAt: z.string(),
  endsAt: z.string().optional(),
  mode: z.string().optional(),
  locations: z.array(z.unknown()).optional(),
  uris: z.array(z.object({ uri: z.string(), name: z.string().optional() })).optional(),
  timezone: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  visibility: z.enum(['listed', 'unlisted', 'private']).optional(),
  neighborhood: z.string().max(200).optional(),
  rsvpRequired: z.boolean().optional(),
  tags: z
    .array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'tags must be lowercase kebab-case'))
    .max(10)
    .optional(),
  skills: z
    .array(
      z.object({
        skill: z.string().startsWith('at://'),
        level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        prerequisites: z.string().max(2560).optional(),
      }),
    )
    .optional(),
  series: z
    .object({
      rrule: z.string().min(3).max(1024),
      freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
      interval: z.number().int().positive().optional(),
      byDay: z.array(z.string()).max(7).optional(),
      until: z.string().optional(),
      count: z.number().int().positive().optional(),
      exdates: z.array(z.string()).max(200).optional(),
      timezone: z.string(),
      materializeAhead: z.number().int().min(1).max(730).optional(),
    })
    .optional(),
})

events.post('/events', requireViewer, requireRole(Role.Host), async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'InvalidRequest', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400)
  }
  try {
    const created = await createEventAsHost(c.var.viewer!, parsed.data)
    return c.json(created, 201)
  } catch (err) {
    if (err instanceof NoActorCredentialError) {
      return c.json(
        {
          error: 'ReauthRequired',
          message:
            'Your class is written to your own repo, and your authorization has lapsed. Sign in again before publishing.',
        },
        401,
      )
    }
    throw err
  }
})

const updateBody = createBody.partial()

events.put('/events/:id', requireViewer, async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const parsed = updateBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'InvalidRequest', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400)
  }
  try {
    const updated = await updateEventAsHost(c.var.viewer!, uri, parsed.data)
    return c.json(updated)
  } catch (err) {
    if (err instanceof EventNotFoundError) return c.json({ error: 'NotFound' }, 404)
    if (err instanceof EventPermissionError) return c.json({ error: 'PermissionDenied', message: err.message }, 403)
    if (err instanceof SeriesEditNotSupportedError) {
      return c.json({ error: 'SeriesEditNotSupported', message: err.message }, 400)
    }
    if (err instanceof NoActorCredentialError) {
      return c.json({ error: 'ReauthRequired', message: 'sign in again before updating your class' }, 401)
    }
    throw err
  }
})

events.get('/events/:id{.+\\.ics}', async (c) => {
  const raw = c.req.param('id')
  const uri = decodeURIComponent(raw.replace(/\.ics$/, ''))
  const loaded = await loadEvent(uri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  const viewer = c.var.viewer
  const relation = viewer ? await viewerRelation(viewer, uri, loaded.hostDid) : 'public'
  if (!loaded.listed && relation === 'public') return c.json({ error: 'NotFound' }, 404)

  const series = loaded.series
  const ics = buildIcs(
    [
      {
        uid: uri,
        summary: loaded.event.name ?? 'Free School class',
        description: relation === 'public' ? undefined : loaded.event.description,
        startsAt: loaded.event.startsAt,
        endsAt: loaded.event.endsAt,
        location: icsLocation(loaded.event, loaded.inputs, relation),
        url: `${new URL(c.req.url).origin}/events/${encodeURIComponent(uri)}`,
        status: icsStatus(loaded.event.status),
        ...(series?.rrule ? { rrule: series.rrule } : {}),
        ...(series?.exdates?.length ? { exdates: series.exdates } : {}),
      },
    ],
    { calName: 'Free School' },
  )
  c.header('Content-Type', 'text/calendar; charset=utf-8')
  c.header('Content-Disposition', `attachment; filename="event.ics"`)
  return c.body(ics)
})

events.get('/events/:id', async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const loaded = await loadEvent(uri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  const viewer = c.var.viewer
  const relation = viewer ? await viewerRelation(viewer, uri, loaded.hostDid) : 'public'
  if (!loaded.listed && relation === 'public') return c.json({ error: 'NotFound' }, 404)
  return c.json({
    ...projectEvent(loaded.event, loaded.inputs, relation),
    listed: loaded.listed,
    skills: loaded.skillLevels,
    // Counts only. Never the roster.
    rsvps: await rsvpCounts(uri),
    viewerRelation: relation,
  })
})

const attendanceBody = z.object({
  attendees: z
    .array(
      z.object({
        did: z.string().startsWith('did:'),
        participated: z.boolean().default(true),
        role: z.enum(['attendee', 'assistant', 'co-host']).default('attendee'),
      }),
    )
    .min(1)
    .max(200),
})

/**
 * The host attests participation. App-side only: `freeschool.draft.attendance` exists as
 * a lexicon, but writing one publishes "this person was in this room", which is exactly
 * what R9 says not to do by default.
 */
events.post('/events/:id/attendance', requireViewer, async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const viewer = c.var.viewer!
  const loaded = await loadEvent(uri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  if (loaded.hostDid !== viewer.did) {
    return c.json({ error: 'PermissionDenied', message: 'only the host of a class may attest attendance' }, 403)
  }
  const parsed = attendanceBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)

  const db = getDb()
  let recorded = 0
  for (const a of parsed.data.attendees) {
    if (a.did === viewer.did) continue // a host does not attest themselves
    const rows = await db
      .insert(attendance)
      .values({
        id: rowId(),
        eventUri: uri,
        attendeeDid: a.did,
        attestedByDid: viewer.did,
        participated: a.participated,
        role: a.role,
        eventStartsAt: loaded.event.startsAt ? new Date(loaded.event.startsAt) : null,
      })
      .onConflictDoUpdate({
        target: [attendance.eventUri, attendance.attendeeDid],
        set: { participated: a.participated, role: a.role, attestedByDid: viewer.did, voidedAt: null },
      })
      .returning({ id: attendance.id })
    if (rows.length > 0 && a.participated) {
      await bumpTally(a.did, { attendedConfirmed: 1 })
      recorded++
    }
  }
  return c.json({ ok: true, recorded })
})

/** Counts, for the host's own view. Never a list of DIDs. */
events.get('/events/:id/attendance', requireViewer, async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const loaded = await loadEvent(uri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  const viewer = c.var.viewer!
  if (loaded.hostDid !== viewer.did) return c.json({ error: 'PermissionDenied' }, 403)
  const db = getDb()
  const [live, rollup] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int`, p: sql<number>`count(*) filter (where participated)::int` })
      .from(attendance)
      .where(and(eq(attendance.eventUri, uri), isNull(attendance.voidedAt))),
    db.select().from(attendanceRollup).where(eq(attendanceRollup.eventUri, uri)).limit(1),
  ])
  return c.json({
    total: (live[0]?.n ?? 0) + (rollup[0]?.totalCount ?? 0),
    participated: (live[0]?.p ?? 0) + (rollup[0]?.participatedCount ?? 0),
    collapsed: Boolean(rollup[0]),
  })
})

/* loading */

export interface LoadedEvent {
  hostDid: string
  event: ReturnType<typeof toCalendarEvent>
  inputs: { listings: EventListing[]; configs: EventConfig[] }
  listed: boolean
  skillLevels: Array<{ skill: string; level: number; prerequisites?: string }>
  series?: { rrule?: string; exdates?: string[] }
}

export async function loadEvent(uri: string): Promise<LoadedEvent | null> {
  const indexer = await getIndexer()
  const row = await getRecordByUri(indexer, 'event', uri)
  if (!row) return null
  const [listings, configs, skills, seriesRows] = await Promise.all([
    sidecarsForEvent<EventListing>(indexer, 'eventListing', uri),
    sidecarsForEvent<EventConfig>(indexer, 'eventConfig', uri),
    sidecarsForEvent<{ skill: string; level: number; prerequisites?: string }>(indexer, 'skillLevel', uri),
    sidecarsForEvent<{ rrule?: string; exdates?: string[] }>(indexer, 'series', uri, 'firstEvent.uri'),
  ])
  const inputs = { listings: listings.map((l) => l.value), configs: configs.map((x) => x.value) }
  return {
    hostDid: row.did,
    event: toCalendarEvent(uri, row.did, row.value),
    inputs,
    listed: isListed(inputs),
    skillLevels: skills.map((s) => s.value),
    ...(seriesRows[0] ? { series: seriesRows[0].value } : {}),
  }
}
