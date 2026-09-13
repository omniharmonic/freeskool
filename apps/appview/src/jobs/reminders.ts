/**
 * Event reminders. Minutely.
 *
 * Three kinds, all derived from the event's `startsAt`:
 *
 *   24h       one day before
 *   1h        one hour before
 *   day-of    a single digest at 08:00 in the event's timezone, for everything today
 *
 * The due-window logic is the interesting part and is pure + unit-tested
 * (`test/reminders.test.ts`). A cron that fires every minute will sometimes not fire —
 * the process restarts, the machine is busy, a deploy takes 90 seconds — so a reminder is
 * due if its target instant falls anywhere in the last CATCH_UP_MS, not only in the last
 * minute. The 30-minute catch-up window is wide enough to survive a deploy and narrow
 * enough that nobody is reminded about a class that already started.
 *
 * Sending more than once is prevented by the dedup ledger, not by the window: the window
 * can overlap freely and `enqueueNotification` claims `reminder:<kind>:<event>:<did>` once.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { rsvp } from '../db/schema.js'
import { getIndexer } from '../index/indexer.js'
import { eventsInWindow } from '../index/queries.js'
import { enqueueNotification } from '../notifications/dispatch.js'

export const CATCH_UP_MS = 30 * 60_000
export type ReminderKind = '24h' | '1h' | 'day-of'

export const LEAD_MS: Record<'24h' | '1h', number> = {
  '24h': 24 * 3_600_000,
  '1h': 3_600_000,
}

/**
 * Is a `lead`-ahead reminder for an event starting at `startsAt` due at `now`?
 *
 * True when `startsAt - lead` is in `(now - CATCH_UP_MS, now]` — equivalently, when `now`
 * is in `[target, target + CATCH_UP_MS)`. Closed at the target and open at the far end, so
 * a tick exactly on the target fires and two adjacent windows can never both match.
 */
export function isReminderDue(
  startsAt: Date,
  kind: '24h' | '1h',
  now: Date,
  catchUpMs = CATCH_UP_MS,
): boolean {
  const target = startsAt.getTime() - LEAD_MS[kind]
  const nowMs = now.getTime()
  // Never remind about something that has already started.
  if (startsAt.getTime() <= nowMs) return false
  return target > nowMs - catchUpMs && target <= nowMs
}

/** The day-of digest fires once, in the catch-up window after 08:00 UTC-equivalent local. */
export function isDigestDue(now: Date, digestHourUtc = 8, catchUpMs = CATCH_UP_MS): boolean {
  const target = new Date(now)
  target.setUTCHours(digestHourUtc, 0, 0, 0)
  const t = target.getTime()
  return t > now.getTime() - catchUpMs && t <= now.getTime()
}

export interface ReminderResult {
  events: number
  queued: number
}

export async function runReminders(now = new Date()): Promise<ReminderResult> {
  const indexer = await getIndexer()
  // Everything starting in the next 25 hours covers both leads with room to spare.
  const events = await eventsInWindow(
    indexer,
    new Date(now.getTime() - CATCH_UP_MS).toISOString(),
    new Date(now.getTime() + 25 * 3_600_000).toISOString(),
    500,
  )

  let queued = 0
  const digestDue = isDigestDue(now)
  const digestByDid = new Map<string, string[]>()

  for (const e of events) {
    const startsAtRaw = e.value.startsAt
    if (typeof startsAtRaw !== 'string') continue
    const startsAt = new Date(startsAtRaw)
    if (Number.isNaN(startsAt.getTime())) continue
    const name = typeof e.value.name === 'string' ? e.value.name : 'a class'

    const dids = await goingDids(e.uri)
    if (dids.length === 0) continue

    for (const kind of ['24h', '1h'] as const) {
      if (!isReminderDue(startsAt, kind, now)) continue
      for (const did of dids) {
        const res = await enqueueNotification({
          did,
          category: 'event.reminder',
          dedupKey: `event.reminder:${kind}:${e.uri}:${did}`,
          title: kind === '1h' ? `"${name}" starts in an hour` : `"${name}" is tomorrow`,
          navigate: `/events/${encodeURIComponent(e.uri)}`,
        })
        if (res.claimed) queued++
      }
    }

    if (digestDue && sameUtcDay(startsAt, now)) {
      for (const did of dids) digestByDid.set(did, [...(digestByDid.get(did) ?? []), name])
    }
  }

  if (digestDue) {
    const day = now.toISOString().slice(0, 10)
    for (const [did, names] of digestByDid) {
      const res = await enqueueNotification({
        did,
        category: 'event.reminder',
        dedupKey: `event.reminder:day-of:${day}:${did}`,
        title: names.length === 1 ? `Today: ${names[0]}` : `Today: ${names.length} classes`,
        body: names.join(', '),
        navigate: '/calendar',
      })
      if (res.claimed) queued++
    }
  }

  return { events: events.length, queued }
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
}

async function goingDids(eventUri: string): Promise<string[]> {
  const rows = await getDb()
    .select({ did: rsvp.did })
    .from(rsvp)
    .where(and(eq(rsvp.eventUri, eventUri), inArray(rsvp.status, ['going', 'interested'])))
  return rows.map((r) => r.did)
}
