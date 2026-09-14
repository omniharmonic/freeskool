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
import { getPresentation, presentationFields } from '../../lib/event-presentation.js'
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireViewer, requireRole } from '../session.js'
import {
  canViewRoster,
  createEventAsHost,
  EventNotFoundError,
  EventPermissionError,
  OccurrenceNotEditableError,
  resolveHostDid,
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
import { appMeta, attendance, attendanceRollup, custodialAccount } from '../../db/schema.js'
import { rowId } from '../../lib/ids.js'
import { bumpTally, roleOf } from '../../lib/roles.js'
import { rsvpCounts, rsvpRoster } from '../../lib/rsvp.js'
import { recordAttendance } from '../../lib/attendance.js'
import { getEventExtra, type EventExtra } from '../../lib/event-extra.js'
import { config } from '../../config.js'
import { PROFILE_KEY, type Profile } from './me.js'

export const events = new Hono<AppEnv>()

const createBody = z.object({
  publicOverview: z.object({ description: z.string().trim().max(6000), audience: z.string().trim().max(1000).optional(), accessibility: z.string().trim().max(1000).optional() }).optional(),
  cover: z.object({ data: z.string().max(11_200_000), alt: z.string().trim().min(1).max(300) }).nullable().optional(),
  venueNeeded: z.boolean().optional(),
  name: z.string().trim().min(1).max(300),
  /**
   * Attendee-only, app-side (task 19c) — `fs_event_extra`, revealed by the same gate as
   * the street address. Neither ever reaches the public event record again.
   */
  attendeeNotes: z.string().max(20_000).optional(),
  meetingLink: z.string().max(2048).optional(),
  /**
   * @deprecated Pre-19c body fields. `description` meant "extra notes for people
   * attending" and `uris` meant "the meeting link", and both were written straight into
   * the world-readable `community.lexicon.calendar.event`. Still ACCEPTED so an older
   * PWA build keeps working; `attendeeFields()` in `lib/events.ts` maps them onto
   * `attendeeNotes` / `meetingLink`, and neither is written to a record.
   */
  description: z.string().max(20_000).optional(),
  uris: z.array(z.object({ uri: z.string(), name: z.string().optional() })).optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  mode: z.string().optional(),
  locations: z.array(z.unknown()).optional(),
  timezone: z.string().optional(),
  capacity: z.number().int().positive().optional(),
  visibility: z.enum(['listed', 'unlisted', 'private']).optional(),
  neighborhood: z.string().max(200).optional(),
  rsvpRequired: z.boolean().optional(),
  materials: z.array(z.string().min(1).max(120)).max(20).optional(),
  suppliesNote: z.string().max(300).optional(),
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
    if (parsed.data.endsAt && Date.parse(parsed.data.endsAt) <= Date.parse(parsed.data.startsAt)) {
      return c.json({ error: 'InvalidDates', message: 'The end time must be after the start time.' }, 400)
    }
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
    if (err instanceof OccurrenceNotEditableError) {
      return c.json({ error: 'OccurrenceNotEditable', message: err.message }, 400)
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
        // The record's `description` IS the public overview (task 19c) — the attendee
        // notes and the meeting link are app-side and never travel in an `.ics` file,
        // which a calendar client may well re-share.
        description: loaded.event.description,
        startsAt: loaded.event.startsAt,
        endsAt: loaded.event.endsAt,
        location: icsLocation(loaded.event, loaded.inputs, relation),
        // The PWA's event page, not this API origin: a calendar client shows URL to a
        // human, who clicks it (A1).
        url: `${config().webPublicUrl}/events/${encodeURIComponent(uri)}`,
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

events.get('/events/:id/image', async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const loaded = await loadEvent(uri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  const relation = c.var.viewer ? await viewerRelation(c.var.viewer, uri, loaded.hostDid) : 'public'
  if (!loaded.listed && relation === 'public') return c.json({ error: 'NotFound' }, 404)
  const image = (await getPresentation(uri)).cover
  if (!image) return c.json({ error: 'NotFound' }, 404)
  c.header('Content-Type', 'image/webp')
  c.header('Cache-Control', 'private, no-store')
  return c.body(new Uint8Array(Buffer.from(image.data, 'base64')))
})

events.get('/events/:id', async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const loaded = await loadEvent(uri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  const viewer = c.var.viewer
  const relation = viewer ? await viewerRelation(viewer, uri, loaded.hostDid) : 'public'
  if (!loaded.listed && relation === 'public') return c.json({ error: 'NotFound' }, 404)
  // The raw visibility enum (listed|unlisted|private) is a moderation/host-facing fact,
  // never shown to an ordinary viewer. FIX (review round 1, M2): this used to gate on
  // `relation === 'steward'`, but `viewerRelation` checks attendee/rsvp BEFORE steward,
  // so a steward who had also RSVP'd would resolve to 'rsvp' and lose raw visibility.
  // Use the same `roleOf`-based host-or-steward check the roster route uses instead.
  const canSeeRawVisibility = viewer ? canViewRoster(loaded.hostDid, viewer.did, await roleOf(viewer.did)) : false
  return c.json({
    // `loaded.extra` carries the attendee notes and the meeting link; `projectEvent`
    // releases them only to a viewer who also gets the street address (task 19c).
    ...projectEvent(loaded.event, loaded.inputs, relation, loaded.extra),
    ...presentationFields(uri, await getPresentation(uri)),
    listed: loaded.listed,
    skills: loaded.skillLevels,
    materials: loaded.extra.materials,
    ...(loaded.extra.suppliesNote ? { suppliesNote: loaded.extra.suppliesNote } : {}),
    // Counts only. Never the roster.
    rsvps: await rsvpCounts(uri),
    viewerRelation: relation,
    ...(canSeeRawVisibility ? { visibility: loaded.inputs.configs[0]?.visibility ?? 'listed' } : {}),
  })
})

/**
 * `GET /api/events/:id/rsvps` — the host's (or a steward's) own roster: who is coming,
 * with their status, so the host can "check attendance off a real list" (PRD persona).
 * Never reachable by anyone else — `canViewRoster` is the one authorization rule, and it
 * is a pure function precisely so "forbidden for a non-host member" is a unit test, not
 * something that can silently regress through a route refactor.
 */
events.get('/events/:id/rsvps', requireViewer, async (c) => {
  const uri = decodeURIComponent(c.req.param('id'))
  const loaded = await loadEvent(uri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)
  const viewer = c.var.viewer!
  const role = await roleOf(viewer.did)
  if (!canViewRoster(loaded.hostDid, viewer.did, role)) {
    return c.json({ error: 'PermissionDenied', message: 'only the host of this class or a steward may see who is coming' }, 403)
  }
  const rows = await rsvpRoster(uri)
  const dids = rows.map((r) => r.did)
  const [handles, displayNames] = await Promise.all([handlesForDids(dids), displayNamesForDids(dids)])
  return c.json(
    rows.map((r) => ({
      did: r.did,
      handle: handles[r.did] ?? r.did,
      ...(displayNames[r.did] ? { displayName: displayNames[r.did] } : {}),
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    })),
  )
})

/**
 * Roster `displayName` (review I3): the app-side profile a member sets at `PUT /api/me`
 * (`fs_app_meta`, key `profile:<did>` — see `http/routes/me.ts`). One batched `inArray`
 * query for every DID on the roster, never one query per row. Omitted when the member
 * never set one.
 */
async function displayNamesForDids(dids: string[]): Promise<Record<string, string>> {
  if (dids.length === 0) return {}
  const rows = await getDb()
    .select({ key: appMeta.key, value: appMeta.value })
    .from(appMeta)
    .where(inArray(appMeta.key, dids.map(PROFILE_KEY)))
  const out: Record<string, string> = {}
  for (const r of rows) {
    const displayName = (r.value as Profile | undefined)?.displayName
    if (displayName) out[r.key.slice('profile:'.length)] = displayName
  }
  return out
}

/**
 * Best-effort DID -> handle for the roster only — never authoritative, never cached.
 * Our own custodial members resolve straight from `fs_custodial_account`; anyone else
 * (an existing OAuth account) falls back to contrail's `identities` table, which is
 * populated by indexing/backfill, not by us. A DID that resolves nowhere falls back to
 * itself rather than leaving a gap in the response.
 */
async function handlesForDids(dids: string[]): Promise<Record<string, string>> {
  if (dids.length === 0) return {}
  const out: Record<string, string> = {}
  const rows = await getDb()
    .select({ did: custodialAccount.did, handle: custodialAccount.handle })
    .from(custodialAccount)
    .where(inArray(custodialAccount.did, dids))
  for (const r of rows) out[r.did] = r.handle
  const remaining = dids.filter((d) => !out[d])
  if (remaining.length > 0) {
    try {
      const indexer = await getIndexer()
      for (const did of remaining) {
        const row = await indexer.db
          .prepare('SELECT handle FROM identities WHERE did = ? LIMIT 1')
          .bind(did)
          .first<{ handle: string | null }>()
        if (row?.handle) out[did] = row.handle
      }
    } catch {
      /* index not ready; the did-as-handle fallback below still gives a usable response */
    }
  }
  return out
}

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

  const { recorded, tallyChanged } = await recordAttendance({
    eventUri: uri,
    hostDid: viewer.did,
    attendees: parsed.data.attendees,
    eventStartsAt: loaded.event.startsAt ? new Date(loaded.event.startsAt) : null,
  })
  return c.json({ ok: true, recorded, tallyChanged })
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
  extra: EventExtra
}

export async function loadEvent(uri: string): Promise<LoadedEvent | null> {
  const indexer = await getIndexer()
  const row = await getRecordByUri(indexer, 'event', uri)
  if (!row) return null
  const [listings, configs, skills, seriesRows, extra] = await Promise.all([
    sidecarsForEvent<EventListing>(indexer, 'eventListing', uri),
    sidecarsForEvent<EventConfig>(indexer, 'eventConfig', uri),
    sidecarsForEvent<{ skill: string; level: number; prerequisites?: string }>(indexer, 'skillLevel', uri),
    sidecarsForEvent<{ rrule?: string; exdates?: string[] }>(indexer, 'series', uri, 'firstEvent.uri'),
    getEventExtra(uri),
  ])
  const inputs = { listings: listings.map((l) => l.value), configs: configs.map((x) => x.value) }
  // A8: for a materialized occurrence the record's author is the SCHOOL; the host is the
  // series author. Everything downstream of `LoadedEvent.hostDid` — the roster gate, the
  // attendance gate, `viewerRelation`, the raw-visibility field, the feedback notification
  // — therefore gets the right person for free.
  const hostDid = await resolveHostDid(uri, row.did)
  return {
    hostDid,
    event: toCalendarEvent(uri, hostDid, row.value),
    inputs,
    listed: isListed(inputs),
    skillLevels: skills.map((s) => s.value),
    ...(seriesRows[0] ? { series: seriesRows[0].value } : {}),
    extra,
  }
}
