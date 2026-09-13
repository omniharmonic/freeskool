/**
 * `GET /api/calendar?from&to&school`
 *
 * Public, unauthenticated. Returns only `listed` events, and only
 * title / time / mode / neighborhood. A viewer who is the host, has RSVP'd, has
 * confirmed attendance, or is a steward additionally gets the precise location — see
 * ../visibility.ts, which holds the rules and is unit-tested on its own.
 *
 * There is deliberately no `?host=` or `?attendee=` parameter: no public endpoint
 * enumerates members (R9).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../session.js'
import { getIndexer } from '../../index/indexer.js'
import { eventsInWindow, sidecarsForEvent } from '../../index/queries.js'
import { config } from '../../config.js'
import type { EventConfig, EventListing } from '../../lexicons/coop.js'
import { isListed, projectEvent, type CalendarEvent, type ViewerRelation } from '../visibility.js'
import { viewerRelation } from '../relation.js'

export const calendar = new Hono<AppEnv>()

const query = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  school: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})

calendar.get('/calendar', async (c) => {
  const parsed = query.safeParse(Object.fromEntries(new URL(c.req.url).searchParams))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const { from, to, school, limit } = parsed.data

  const fromIso = from ?? new Date().toISOString()
  const toIso = to ?? new Date(Date.now() + 90 * 86_400_000).toISOString()

  const indexer = await getIndexer()
  const events = await eventsInWindow(indexer, fromIso, toIso, limit)
  const viewer = c.var.viewer

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
    if (!isListed(inputs)) continue

    const relation: ViewerRelation = viewer ? await viewerRelation(viewer, e.uri, e.did) : 'public'
    // 'ours' when our own school curated or configured it; 'listed' means it reached us
    // only through ANOTHER school's listing (peer exchange — see docs/plans/gap-report.md
    // §A item 11; inbound consumption is not built yet, so this is almost always 'ours').
    const schoolDid = config().SCHOOL_DID
    const origin: 'ours' | 'listed' =
      listingValues.some((l) => l.school === schoolDid) || configValues.some((cfg) => cfg.school === schoolDid)
        ? 'ours'
        : 'listed'
    out.push({ ...projectEvent(toCalendarEvent(e.uri, e.did, e.value), inputs, relation), origin })
  }

  return c.json({ from: fromIso, to: toIso, events: out })
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
