/**
 * `GET /api/calendar?from&to&school`      the public calendar, as JSON
 * `GET /api/calendar.ics?from&to&school`  the same calendar, as a subscribable feed
 *
 * Public, unauthenticated, and identical in what they disclose: only `listed` events,
 * and of each one only what the host's own public `community.lexicon.calendar.event`
 * record already says — title, time, mode, description, links, host — plus the
 * NEIGHBORHOOD in place of the address. Exact locations are only returned by the
 * separately authorized event-detail endpoint, never this offline feed (R9).
 *
 * There is deliberately no `?host=` or `?attendee=` parameter: no public endpoint
 * enumerates members (R9). The `.ics` feed emits no ATTENDEE lines for the same reason —
 * who is coming is app-side, always.
 */
import { getPresentations, presentationFields } from '../../lib/event-presentation.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../session.js'
import { config } from '../../config.js'
import { getIndexer } from '../../index/indexer.js'
import { eventsInWindow, sidecarsForEvent } from '../../index/queries.js'
import { isOwnMemberSet } from '../../lib/roles.js'
import { resolveHostDids } from '../../lib/events.js'
import { buildIcs, icsStatus } from '../../lib/ics.js'
import type { EventConfig, EventListing } from '../../lexicons/coop.js'
import {
  calendarInclusion,
  icsLocation,
  projectEvent,
  type CalendarEvent,
  type ListingInputs,
  type ViewerRelation,
} from '../visibility.js'

export const calendar = new Hono<AppEnv>()

/** How far ahead the subscribable feed reaches when the caller says nothing. */
export const ICS_WINDOW_DAYS = 90

const query = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  school: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

interface VisibleEvent {
  uri: string
  hostDid: string
  event: CalendarEvent
  inputs: ListingInputs
  origin: 'ours' | 'listed'
}

/**
 * Every event in the window this viewer may see, with the sidecars that decided it.
 * Shared by both representations so the JSON calendar and the `.ics` feed can never
 * drift apart on what is listed.
 */
async function visibleEvents(
  from: string,
  to: string,
  limit: number,
  school?: string,
): Promise<{ events: VisibleEvent[]; truncated: boolean }> {
  const indexer = await getIndexer()
  const rows = await eventsInWindow(indexer, from, to, limit)

  // A8: the HOST of each event. A materialized occurrence's record author is the SCHOOL;
  // its host is the series author. One query for the whole page, not one per event.
  const hostDids = await resolveHostDids(rows)
  // One batched membership lookup for the whole page, not one per event (N+1). Both the
  // authors AND the resolved hosts, so an occurrence can be recognized as ours.
  const ownDids = await isOwnMemberSet([...rows.map((e) => e.did), ...hostDids.values()])

  const out: VisibleEvent[] = []
  for (const e of rows) {
    const [listings, configs] = await Promise.all([
      sidecarsForEvent<EventListing>(indexer, 'eventListing', e.uri),
      sidecarsForEvent<EventConfig>(indexer, 'eventConfig', e.uri),
    ])
    const listingValues = listings.map((l) => l.value)
    const configValues = configs.map((cfg) => cfg.value)
    if (school && !listingValues.some((l) => l.school === school) && !configValues.some((cfg) => cfg.school === school)) {
      continue
    }
    const inputs = { listings: listingValues, configs: configValues }
    // AUTHORSHIP decides inclusion, not the listing (gap-report §A item 11: listings are
    // for routing to peers; a host who belongs to this school is 'ours' regardless of
    // whether the tags they chose happened to route — see http/visibility.ts).
    const hostDid = hostDids.get(e.uri) ?? e.did
    // Inclusion still asks about the event's AUTHOR for an ordinary class; for an
    // occurrence the school authored it, so ask about the host instead — an occurrence of
    // one of our own members' series is ours.
    const { show, origin } = calendarInclusion(ownDids.has(e.did) || ownDids.has(hostDid), inputs)
    if (!show) continue
    out.push({ uri: e.uri, hostDid, event: toCalendarEvent(e.uri, hostDid, e.value), inputs, origin })
  }
  return { events: out, truncated: rows.length === limit }
}

calendar.get('/calendar', async (c) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const { from, to, school, limit } = parsed.data

  const fromIso = from ?? new Date().toISOString()
  const toIso = to ?? new Date(Date.now() + ICS_WINDOW_DAYS * 86_400_000).toISOString()

  const { events, truncated } = await visibleEvents(fromIso, toIso, limit, school)
  const presentations = await getPresentations(events.map((e) => e.uri))

  // Offline calendar is always public. Precise addresses belong only in the uncached detail API.
  const relation: ViewerRelation = 'public'
  const out = events.map((e) => ({
    ...projectEvent(e.event, e.inputs, relation),
    ...presentationFields(e.uri, presentations.get(e.uri)),
    origin: e.origin,
  }))

  return c.json({ from: fromIso, to: toIso, events: out, truncated })
})

/**
 * The same calendar as an iCalendar feed, for every organizer in town who will never
 * install a PWA and cannot speak ATProto. Cacheable for five minutes because it is
 * identical for everyone: there is no viewer here, only the public projection.
 */
calendar.get('/calendar.ics', async (c) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const { from, to, school, limit } = parsed.data

  const fromIso = from ?? new Date().toISOString()
  const toIso = to ?? new Date(Date.now() + ICS_WINDOW_DAYS * 86_400_000).toISOString()

  const { events } = await visibleEvents(fromIso, toIso, limit, school)
  const relation: ViewerRelation = 'public'

  const body = buildIcs(
    events.map((e) => {
      const projected = projectEvent(e.event, e.inputs, relation) as { description?: string }
      return {
        uid: e.uri,
        summary: e.event.name ?? 'Free School class',
        ...(projected.description ? { description: projected.description } : {}),
        ...(e.event.startsAt ? { startsAt: e.event.startsAt } : {}),
        ...(e.event.endsAt ? { endsAt: e.event.endsAt } : {}),
        ...(() => {
          const location = icsLocation(e.event, e.inputs, relation)
          return location ? { location } : {}
        })(),
        // The PWA's event page, not this API origin: a calendar client shows URL to a
        // human, who clicks it.
        url: `${config().webPublicUrl}/events/${encodeURIComponent(e.uri)}`,
        ...(() => {
          const status = icsStatus(e.event.status)
          return status ? { status } : {}
        })(),
      }
    }),
    { calName: 'Free School' },
  )

  c.header('Content-Type', 'text/calendar; charset=utf-8')
  // Public and identical for every reader — see the `Cache-Control` exemption in app.ts.
  c.header('Cache-Control', 'public, max-age=300')
  return c.body(body)
})

export function toCalendarEvent(uri: string, hostDid: string, value: Record<string, unknown>): CalendarEvent {
  return {
    uri,
    hostDid,
    name: str(value.name),
    description: str(value.description),
    startsAt: str(value.startsAt),
    endsAt: str(value.endsAt),
    mode: str(value.mode),
    status: str(value.status),
    locations: Array.isArray(value.locations) ? value.locations : undefined,
    uris: Array.isArray(value.uris) ? (value.uris as Array<{ uri: string; name?: string }>) : undefined,
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
