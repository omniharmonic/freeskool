/**
 * Materialize series occurrences. Daily, on pg-boss.
 *
 * The windowing rule, which is the whole job:
 *
 *   - materialize everything the rule produces in the next `materializeAhead` days
 *     (default 90) — that is the *normal* horizon;
 *   - but ALWAYS materialize at least 4 occurrences, even if they fall past it, so a
 *     monthly or quarterly series is never an empty calendar (the FLOOR);
 *   - and never look further than 18 months ahead, whatever the floor says, so an
 *     open-ended `FREQ=YEARLY` cannot write unbounded records (the CEILING);
 *   - `exdates` are removed from the expansion, not cancelled after the fact — a skipped
 *     week should never have existed;
 *   - the rkey is `hash(series rkey + originalStartsAt)` so a re-run, or two workers, or a
 *     widened window, all converge on the same records instead of duplicating them.
 *
 * Occurrences are written by the SCHOOL through `SchoolActorPort`
 * (`materialize-occurrence`): they are the school's scheduling artifact, and the host
 * should not have to be online for next month's class to appear. Each one is an ordinary
 * `community.lexicon.calendar.event` plus a `freeschool.draft.occurrence` back-pointer, so
 * any consumer that has never heard of `freeschool.draft.series` still sees real events.
 */
/**
 * `rrule@2.8.1` has no `exports` map, so Node resolves its `main` — a UMD bundle whose named
 * exports the CJS lexer cannot see (`does not provide an export named 'RRule'`). The deep
 * ESM path is the real module and carries its own types.
 */
import { RRule } from 'rrule/dist/esm/index.js'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { seriesOccurrence } from '../db/schema.js'
import { getIndexer } from '../index/indexer.js'
import { listCollection, parseAtUri } from '../index/queries.js'
import { NSID } from '../lexicons/nsids.js'
import { normalizeInstant, occurrenceRkey } from '../lib/crypto.js'
import { tid } from '../lib/ids.js'
import { schoolActor, schoolDid } from '../lib/school-actor.js'
import { getRecord } from '../lib/pds.js'
import { resolvePdsEndpoint } from '../lib/identity.js'
import { log } from '../lib/logging.js'
import { openFeedbackWindow } from '../lib/feedback.js'

export const DEFAULT_WINDOW_DAYS = 90
export const MIN_OCCURRENCES = 4
export const MAX_MONTHS_AHEAD = 18

export interface SeriesRecord {
  firstEvent: { uri: string; cid: string }
  rrule: string
  freq: string
  interval?: number
  byDay?: string[]
  until?: string
  count?: number
  exdates?: string[]
  timezone: string
  materializeAhead?: number
}

/**
 * Pure: expand a series into the instants that should exist right now. Unit-testable
 * without a database, which is the only way the floor/ceiling interaction stays honest.
 */
export function plannedOccurrences(
  series: Pick<SeriesRecord, 'rrule' | 'exdates' | 'materializeAhead'>,
  dtstart: Date,
  now = new Date(),
): Date[] {
  const windowDays = series.materializeAhead ?? DEFAULT_WINDOW_DAYS
  const horizon = new Date(now.getTime() + windowDays * 86_400_000)
  const ceiling = new Date(now.getTime())
  ceiling.setUTCMonth(ceiling.getUTCMonth() + MAX_MONTHS_AHEAD)

  // `RRule.parseString` + an explicit dtstart rather than `rrulestr`: rrule 2.8.1 is CJS and
  // Node's ESM interop does not surface `rrulestr` as a named export, and building the rule
  // from parsed options keeps the DTSTART out of the string entirely.
  const rule = new RRule({ ...RRule.parseString(series.rrule), dtstart })
  // Ask for enough to satisfy the floor even when the horizon is short.
  const candidates = rule.all((_d, i) => i < 500)

  const excluded = new Set((series.exdates ?? []).map((d) => safeNormalize(d)).filter(Boolean))
  const usable = candidates.filter((d) => d <= ceiling && !excluded.has(normalizeInstant(d.toISOString())))

  const withinHorizon = usable.filter((d) => d <= horizon)
  if (withinHorizon.length >= MIN_OCCURRENCES) return withinHorizon
  // FLOOR: take the first MIN_OCCURRENCES regardless of the horizon, still under the ceiling.
  return usable.slice(0, MIN_OCCURRENCES)
}

function safeNormalize(iso: string): string {
  try {
    return normalizeInstant(iso)
  } catch {
    return ''
  }
}

export interface MaterializeResult {
  series: number
  written: number
  skipped: number
}

export async function materializeAllSeries(now = new Date()): Promise<MaterializeResult> {
  const indexer = await getIndexer()
  const { records } = await listCollection<SeriesRecord>(indexer, 'series', { limit: 500 })
  const out: MaterializeResult = { series: 0, written: 0, skipped: 0 }

  for (const row of records) {
    out.series++
    try {
      const res = await materializeSeries(row.uri, row.did, row.value, now)
      out.written += res.written
      out.skipped += res.skipped
    } catch (err) {
      log.warn('series materialization failed', { detail: String(err) })
    }
  }
  return out
}

export async function materializeSeries(
  seriesUri: string,
  seriesAuthorDid: string,
  series: SeriesRecord,
  now = new Date(),
): Promise<{ written: number; skipped: number }> {
  const parts = parseAtUri(seriesUri)
  if (!parts) return { written: 0, skipped: 0 }

  const template = await loadTemplate(series.firstEvent.uri)
  if (!template) return { written: 0, skipped: 0 }
  const dtstart = new Date(String(template.value.startsAt ?? ''))
  if (Number.isNaN(dtstart.getTime())) return { written: 0, skipped: 0 }

  const durationMs =
    typeof template.value.endsAt === 'string'
      ? Math.max(0, new Date(template.value.endsAt).getTime() - dtstart.getTime())
      : 0

  const db = getDb()
  const existing = new Set(
    (
      await db
        .select({ rkey: seriesOccurrence.occurrenceRkey })
        .from(seriesOccurrence)
        .where(eq(seriesOccurrence.seriesUri, seriesUri))
    ).map((r) => r.rkey),
  )

  let written = 0
  let skipped = 0
  const planned = plannedOccurrences(series, dtstart, now)

  for (const [i, instant] of planned.entries()) {
    const originalStartsAt = normalizeInstant(instant.toISOString())
    // The first occurrence IS the template event; never duplicate it.
    if (originalStartsAt === normalizeInstant(dtstart.toISOString())) {
      skipped++
      continue
    }
    const rkey = occurrenceRkey(parts.rkey, originalStartsAt)
    if (existing.has(rkey)) {
      skipped++
      continue
    }

    const endsAt = durationMs ? new Date(instant.getTime() + durationMs).toISOString() : undefined
    const event = await schoolActor().putRecordAsSchool({
      schoolDid: schoolDid(),
      callerDid: seriesAuthorDid as `did:${string}`,
      scope: NSID.event,
      action: 'materialize-occurrence',
      collection: NSID.event,
      rkey,
      record: {
        $type: NSID.event,
        name: template.value.name,
        ...(template.value.description ? { description: template.value.description } : {}),
        createdAt: new Date().toISOString(),
        startsAt: originalStartsAt,
        ...(endsAt ? { endsAt } : {}),
        ...(template.value.mode ? { mode: template.value.mode } : {}),
        status: `${NSID.event}#scheduled`,
        ...(template.value.locations ? { locations: template.value.locations } : {}),
        ...(template.value.uris ? { uris: template.value.uris } : {}),
        rsvpExpected: template.value.rsvpExpected ?? true,
      },
      audit: { reason: `materialize occurrence ${i + 1} of series ${parts.rkey}` },
    })

    await schoolActor().putRecordAsSchool({
      schoolDid: schoolDid(),
      callerDid: seriesAuthorDid as `did:${string}`,
      scope: NSID.occurrence,
      action: 'materialize-occurrence',
      collection: NSID.occurrence,
      rkey,
      record: {
        $type: NSID.occurrence,
        event: { uri: event.uri, cid: event.cid },
        series: { uri: seriesUri, cid: series.firstEvent.cid },
        originalStartsAt,
        sequence: i + 1,
        createdAt: new Date().toISOString(),
      },
      audit: { reason: `back-pointer for occurrence ${i + 1}` },
    })

    // Put it on the calendar, as the school.
    await schoolActor()
      .putRecordAsSchool({
        schoolDid: schoolDid(),
        callerDid: seriesAuthorDid as `did:${string}`,
        scope: NSID.eventListing,
        action: 'materialize-occurrence',
        collection: NSID.eventListing,
        rkey: tid(),
        record: {
          $type: NSID.eventListing,
          event: { uri: event.uri, cid: event.cid },
          school: schoolDid(),
          status: 'listed',
          createdAt: new Date().toISOString(),
        },
        audit: { reason: `list occurrence ${i + 1}` },
      })
      .catch(() => {
        /* the occurrence exists; listing can be retried */
      })

    await db
      .insert(seriesOccurrence)
      .values({
        seriesUri,
        occurrenceRkey: rkey,
        originalStartsAt: new Date(originalStartsAt),
        eventUri: event.uri,
        sequence: i + 1,
      })
      .onConflictDoNothing()
    await openFeedbackWindow(event.uri, endsAt ?? originalStartsAt)
    written++
  }

  if (written > 0) {
    const indexer = await getIndexer()
    await indexer.backfillFromPeers({ concurrency: 5 }).catch(() => {})
  }
  return { written, skipped }
}

async function loadTemplate(eventUri: string) {
  const parts = parseAtUri(eventUri)
  if (!parts) return null
  const endpoint = await resolvePdsEndpoint(parts.did)
  if (!endpoint) return null
  return getRecord(parts.did, parts.collection, parts.rkey, endpoint)
}
