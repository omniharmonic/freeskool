/**
 * `GET /api/zine/:yyyyMm` — public, unauthenticated, data for the printable monthly zine.
 *
 * Reuses `projectEvent` at the 'public' viewer relation — the SAME redaction as
 * `GET /api/calendar` (neighborhood only, never the street, never a host DID) — so the
 * zine cannot become a second place that leaks what the calendar protects.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import { getIndexer } from '../../index/indexer.js'
import { eventsInWindow, sidecarsForEvent } from '../../index/queries.js'
import { config } from '../../config.js'
import { getRecord } from '../../lib/pds.js'
import { NSID } from '../../lexicons/nsids.js'
import type { EventConfig, EventListing } from '../../lexicons/coop.js'
import { isListed, projectEvent, type PublicCalendarEntry } from '../visibility.js'
import { toCalendarEvent } from './calendar.js'

export const zine = new Hono<AppEnv>()

const YYYY_MM = /^(\d{4})-(\d{2})$/

/** Parses `yyyy-mm` into the UTC `[fromIso, toIso)` window for that month, or null. */
export function monthRange(yyyyMm: string): { fromIso: string; toIso: string } | null {
  const m = YYYY_MM.exec(yyyyMm)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return {
    fromIso: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    toIso: new Date(Date.UTC(year, month, 1)).toISOString(),
  }
}

/** Groups already-projected events by the UTC date of `startsAt`, sorted day then time. */
export function groupByDay<T extends { startsAt?: string }>(events: T[]): Array<{ date: string; events: T[] }> {
  const byDate = new Map<string, T[]>()
  for (const e of events) {
    if (!e.startsAt) continue
    const date = e.startsAt.slice(0, 10)
    const list = byDate.get(date)
    if (list) list.push(e)
    else byDate.set(date, [e])
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayEvents]) => ({
      date,
      events: dayEvents.slice().sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? '')),
    }))
}

const HOW_TO_POST =
  'Give your class a tag the school routes on (ask a steward which ones, or use "skillshare" / ' +
  '"free-school") and set it to "listed" before the month starts. A class with no venue yet still ' +
  'makes the zine — it is marked "venue needed" so a reader can offer one.'

async function schoolInfo(): Promise<{ name: string; region?: string }> {
  const did = config().SCHOOL_DID
  if (!did) return { name: 'Free School' }
  try {
    const rec = await getRecord(did, NSID.school, 'self')
    const name = typeof rec?.value?.name === 'string' ? rec.value.name : 'Free School'
    const region = typeof rec?.value?.region === 'string' ? rec.value.region : undefined
    return { name, ...(region ? { region } : {}) }
  } catch {
    return { name: 'Free School' }
  }
}

zine.get('/zine/:yyyyMm', async (c) => {
  const range = monthRange(c.req.param('yyyyMm'))
  if (!range) return c.json({ error: 'InvalidRequest', message: 'expected a month as yyyy-mm' }, 400)

  const indexer = await getIndexer()
  const events = await eventsInWindow(indexer, range.fromIso, range.toIso, 500)

  const projected: PublicCalendarEntry[] = []
  for (const e of events) {
    const [listings, configs] = await Promise.all([
      sidecarsForEvent<EventListing>(indexer, 'eventListing', e.uri),
      sidecarsForEvent<EventConfig>(indexer, 'eventConfig', e.uri),
    ])
    const inputs = { listings: listings.map((l) => l.value), configs: configs.map((x) => x.value) }
    if (!isListed(inputs)) continue
    // 'public': this endpoint has no session at all, by design (R9 — no public endpoint
    // enumerates members, and the zine is for anyone to print).
    projected.push(projectEvent(toCalendarEvent(e.uri, e.did, e.value), inputs, 'public'))
  }

  return c.json({
    month: c.req.param('yyyyMm'),
    school: await schoolInfo(),
    days: groupByDay(projected),
    howToPost: HOW_TO_POST,
  })
})
