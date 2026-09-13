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
import { getEventExtra } from '../../lib/event-extra.js'
import { config } from '../../config.js'
import { PROFILE_KEY, type Profile } from './me.js'

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
        description: relation === 'public' ? undefined : loaded.event.description,
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
    ...projectEvent(loaded.event, loaded.inputs, relation),
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

  const db = getDb()
  let recorded = 0
  let tallyDelta = 0
  for (const a of parsed.data.attendees) {
    if (a.did === viewer.did) continue // a host does not attest themselves

    /**
     * A5: THE TALLY FOLLOWS THE TRANSITION, NOT THE WRITE.
     *
     * The upsert is idempotent; the tally bump was not. A host who opened the attendance
     * sheet, saved, noticed one more name and saved again gave everybody on the list a
     * second attended-class credit — and the sheet is precisely the screen people re-save.
     * `fs_attendance` is collapsed to counts after 90 days, so the tally is the only
     * surviving evidence and the inflation was permanent.
     *
     * So: read the row's current state first, then bump only when `participated`
     * genuinely flips. "Currently participated" means `participated AND NOT voided`.
     *
     * R3: A VOID IS A STEWARD DECISION, NOT THE HOST'S TO REVERSE. `voidedAt` is set only
     * by the steward-approved `void-attendance` action (`admin.ts`). The host path below
     * never clears it — it is left out of `onConflictDoUpdate`'s `set` entirely — and a
     * voided row never counts towards the tally from this endpoint even if the host's
     * sheet still shows the attendee ticked: `wasVoided` short-circuits the bump in both
     * directions, so re-saving the sheet can neither re-credit a voided attendance nor
     * double-debit it.
     */
    const existing = await db
      .select({ participated: attendance.participated, voidedAt: attendance.voidedAt })
      .from(attendance)
      .where(and(eq(attendance.eventUri, uri), eq(attendance.attendeeDid, a.did)))
      .limit(1)
    const wasVoided = existing.length > 0 && existing[0]!.voidedAt !== null
    const wasCounted = existing.length > 0 && existing[0]!.participated && !wasVoided

    await db
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
        // `voidedAt` deliberately absent: the host path never un-voids a row.
        set: { participated: a.participated, role: a.role, attestedByDid: viewer.did },
      })

    if (wasVoided) {
      // No tally movement for a voided row, regardless of what the sheet says now.
    } else if (a.participated && !wasCounted) {
      await bumpTally(a.did, { attendedConfirmed: 1 })
      tallyDelta++
    } else if (!a.participated && wasCounted) {
      // The host un-ticked somebody. Take the credit back, floored at 0 by `bumpTally`.
      await bumpTally(a.did, { attendedConfirmed: -1 })
      tallyDelta--
    }
    if (a.participated) recorded++
  }
  // `recorded` is who is on the sheet as having taken part (stable across re-saves);
  // `tallyChanged` is what this particular save actually moved.
  return c.json({ ok: true, recorded, tallyChanged: tallyDelta })
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
  extra: { materials: string[]; suppliesNote?: string }
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
