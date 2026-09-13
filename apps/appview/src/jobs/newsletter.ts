/**
 * Monthly digest. Monthly, on pg-boss.
 *
 * COMPOSING is implemented: it reads last month's listed classes out of the index and
 * renders a plain-text digest. SENDING is a STUB, deliberately:
 *
 *   - a newsletter needs a recipient list, which means a consent record per address, which
 *     is an app-side table we have not designed yet (and which must be separate from
 *     `fs_notification_target`, because "tell me when my class changes" is not "send me a
 *     monthly email");
 *   - it needs MJML templates + an unsubscribe link with its own token namespace;
 *   - and it needs a steward to approve the draft before it goes out. A cron job that mails
 *     the whole school unattended is not a feature.
 *
 * So the job composes a draft into `fs_newsletter` with `status: 'draft'` and stops. A
 * steward publishes it from `/api/admin/newsletter`.
 */
import { getIndexer } from '../index/indexer.js'
import { eventsInWindow, sidecarsForEvent } from '../index/queries.js'
import type { EventConfig, EventListing } from '../lexicons/coop.js'
import { isListed } from '../http/visibility.js'
import { getDb } from '../db/index.js'
import { newsletter } from '../db/schema.js'
import { rowId } from '../lib/ids.js'
import { log } from '../lib/logging.js'

export interface Digest {
  subject: string
  body: string
  eventCount: number
}

export async function composeMonthlyDigest(period: string): Promise<Digest> {
  const [year, month] = period.split('-').map(Number)
  const from = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1))
  const to = new Date(Date.UTC(year ?? 1970, month ?? 1, 1))

  const indexer = await getIndexer()
  const events = await eventsInWindow(indexer, from.toISOString(), to.toISOString(), 500)

  const lines: string[] = []
  let count = 0
  for (const e of events) {
    const [listings, configs] = await Promise.all([
      sidecarsForEvent<EventListing>(indexer, 'eventListing', e.uri),
      sidecarsForEvent<EventConfig>(indexer, 'eventConfig', e.uri),
    ])
    if (!isListed({ listings: listings.map((l) => l.value), configs: configs.map((x) => x.value) })) continue
    count++
    const name = typeof e.value.name === 'string' ? e.value.name : 'Untitled'
    const when = typeof e.value.startsAt === 'string' ? e.value.startsAt.slice(0, 16).replace('T', ' ') : 'TBD'
    // The digest never names a host or an attendee. A class, a date, a link.
    lines.push(`- ${when}  ${name}`)
  }

  return {
    subject: `Free School, ${period}`,
    body: [
      `What happened at Free School in ${period}:`,
      '',
      ...(lines.length ? lines : ['(no listed classes this month)']),
      '',
      'Everything is free. Anyone can teach.',
    ].join('\n'),
    eventCount: count,
  }
}

/** The job body. Composes and stores a draft; never sends. */
export async function runMonthlyNewsletter(now = new Date()): Promise<{ id: string; period: string; eventCount: number }> {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const period = prev.toISOString().slice(0, 7)
  const digest = await composeMonthlyDigest(period)
  const id = rowId()
  await getDb()
    .insert(newsletter)
    .values({ id, period, subject: digest.subject, body: digest.body, status: 'draft' })
  log.info('newsletter draft composed (sending is a stub)', { period, events: digest.eventCount })
  return { id, period, eventCount: digest.eventCount }
}
