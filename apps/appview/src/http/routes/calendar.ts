/**
 * `GET /api/calendar?from&to&school`
 *
 * Public, unauthenticated. Returns only `listed` events, and only
 * title / time / mode / neighborhood and class covers. Exact locations are only
 * returned by the separately authorized event-detail endpoint, never this offline feed.
 *
 * There is deliberately no `?host=` or `?attendee=` parameter: no public endpoint
 * enumerates members (R9).
 */
import { getPresentations, presentationFields } from '../../lib/event-presentation.js'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../session.js'
import { getIndexer } from '../../index/indexer.js'
import { eventsInWindow, sidecarsForEvent } from '../../index/queries.js'
import { isOwnMemberSet } from '../../lib/roles.js'
import { resolveHostDids } from '../../lib/events.js'
import type { EventConfig, EventListing } from '../../lexicons/coop.js'
import { calendarInclusion, projectEvent, type CalendarEvent, type ViewerRelation } from '../visibility.js'

export const calendar = new Hono<AppEnv>()

const query = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  school: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
})

calendar.get('/calendar', async (c) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const { from, to, school, limit } = parsed.data

  const fromIso = from ?? new Date().toISOString()
  const toIso = to ?? new Date(Date.now() + 90 * 86_400_000).toISOString()

  const indexer = await getIndexer()
  const events = await eventsInWindow(indexer, fromIso, toIso, limit)
  const presentations = await getPresentations(events.map(e => e.uri))

  // A8: the HOST of each event. A materialized occurrence's record author is the SCHOOL;
  // its host is the series author. One query for the whole page, not one per event.
  const hostDids = await resolveHostDids(events)
  // One batched membership lookup for the whole page, not one per event (N+1). Both the
  // authors AND the resolved hosts, so an occurrence can be recognized as ours.
  const ownDids = await isOwnMemberSet([...events.map((e) => e.did), ...hostDids.values()])

  const out: unknown[] = []
  for (const e of events) {
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

    // Offline calendar is always public. Precise addresses belong only in the uncached detail API.
    const relation: ViewerRelation = 'public'
    out.push({ ...projectEvent(toCalendarEvent(e.uri, hostDid, e.value), inputs, relation), ...presentationFields(e.uri, presentations.get(e.uri)), origin })
  }

  return c.json({ from: fromIso, to: toIso, events: out, truncated: events.length === limit })
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
