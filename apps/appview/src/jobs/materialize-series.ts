import { getPresentation, savePresentation } from '../lib/event-presentation.js'
import { getEventExtra, setEventExtra } from '../lib/event-extra.js'
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
import { DateTime } from 'luxon'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { seriesOccurrence } from '../db/schema.js'
import { getIndexer } from '../index/indexer.js'
import { listCollection, parseAtUri, sidecarsForEvent } from '../index/queries.js'
import type { EventConfig } from '../lexicons/coop.js'
import { routeListing, schoolRoutingTags } from '../lib/events.js'
import { NSID } from '../lexicons/nsids.js'
import { normalizeInstant, occurrenceRkey } from '../lib/crypto.js'
import { schoolActor, schoolDid } from '../lib/school-actor.js'
import { getRecord } from '../lib/pds.js'
import { resolvePdsEndpoint } from '../lib/identity.js'
import { describeError, log } from '../lib/logging.js'
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
 *
 * THE FIX (R6 "Recurrence approach to adopt"): `rrule` has no timezone concept — it
 * matches `BYDAY` against whatever calendar day its `dtstart` Date object's UTC getters
 * report. Handing it a real instant (`new Date(startsAt)`, a UTC instant) therefore
 * matches `BYDAY` against the UTC weekday, which is NOT the host's local weekday once
 * the series' `timezone` has a nonzero UTC offset — a Denver (UTC-6/-7) 18:00 Thursday is
 * already Friday in UTC. So: convert `dtstart` to a FLOATING local datetime (a Date whose
 * UTC getters equal the wall-clock numbers in `series.timezone`), expand entirely in that
 * floating frame (where `BYDAY` now matches the real local weekday), then localize each
 * result back to a real instant by re-interpreting its floating wall-clock fields as
 * `series.timezone` — which also forces the same local `HH:mm:ss` every occurrence, so a
 * DST boundary never shifts "7pm Thursday" to 6pm or 8pm.
 */
export function plannedOccurrences(
  series: Pick<SeriesRecord, 'rrule' | 'exdates' | 'materializeAhead' | 'timezone'>,
  dtstart: Date,
  now = new Date(),
): Date[] {
  const windowDays = series.materializeAhead ?? DEFAULT_WINDOW_DAYS
  const horizon = new Date(now.getTime() + windowDays * 86_400_000)
  const ceiling = new Date(now.getTime())
  ceiling.setUTCMonth(ceiling.getUTCMonth() + MAX_MONTHS_AHEAD)

  const zone = series.timezone
  const floatingStart = toFloatingLocal(dtstart, zone)
  // `RRule.parseString` + an explicit dtstart rather than `rrulestr`: rrule 2.8.1 is CJS and
  // Node's ESM interop does not surface `rrulestr` as a named export, and building the rule
  // from parsed options keeps the DTSTART out of the string entirely.
  const rule = new RRule({ ...RRule.parseString(series.rrule), dtstart: floatingStart })
  // Ask for enough to satisfy the floor even when the horizon is short.
  const candidates = rule.all((_d, i) => i < 500).map((d) => fromFloatingLocal(d, zone))

  const excluded = new Set((series.exdates ?? []).map((d) => safeNormalize(d)).filter(Boolean))
  const usable = candidates.filter((d) => d <= ceiling && !excluded.has(normalizeInstant(d.toISOString())))

  const withinHorizon = usable.filter((d) => d <= horizon)
  if (withinHorizon.length >= MIN_OCCURRENCES) return withinHorizon
  // FLOOR: take the first MIN_OCCURRENCES regardless of the horizon, still under the ceiling.
  return usable.slice(0, MIN_OCCURRENCES)
}

/** A real instant -> a floating Date whose UTC getters equal its wall-clock fields in `zone`. */
function toFloatingLocal(instant: Date, zone: string): Date {
  const local = DateTime.fromJSDate(instant, { zone })
  return new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.millisecond))
}

/** The inverse of `toFloatingLocal`: a floating Date's UTC fields, re-localized to `zone`. */
function fromFloatingLocal(floating: Date, zone: string): Date {
  const local = DateTime.fromObject(
    {
      year: floating.getUTCFullYear(),
      month: floating.getUTCMonth() + 1,
      day: floating.getUTCDate(),
      hour: floating.getUTCHours(),
      minute: floating.getUTCMinutes(),
      second: floating.getUTCSeconds(),
      millisecond: floating.getUTCMilliseconds(),
    },
    { zone },
  )
  return local.toJSDate()
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
      log.warn('series materialization failed', { detail: describeError(err) })
    }
  }
  return out
}

/**
 * TAG ROUTING FOR OCCURRENCES (interop gap 2). An occurrence is a copy of its template
 * class, so it must be routed to peers on exactly the same terms as the template: the
 * tags and visibility the host set on the template's own `coop.lexicon.event.config`.
 * Before this, occurrences were listed unconditionally and with NO tags — so a peer that
 * filters incoming listings by tag (COhere) dropped every instance of every recurring
 * class, while occurrences of a series that never routed were published anyway.
 *
 * The config lives in the HOST's repo and is read from the index. A host may in
 * principle have written more than one config sidecar; we take the union of their tags
 * and the first declared visibility, and fall back to "listed with no tags" — which
 * `routeListing` turns into NO listing at all, never a silent default.
 */
async function templateRouting(
  templateUri: string,
): Promise<{ tags: string[]; visibility: 'listed' | 'unlisted' | 'private' }> {
  try {
    const configs = await sidecarsForEvent<EventConfig>(await getIndexer(), 'eventConfig', templateUri)
    const tags = [...new Set(configs.flatMap((c) => c.value.tags ?? []).filter((t): t is string => typeof t === 'string'))]
    const visibility = configs.map((c) => c.value.visibility).find((v) => v) ?? 'listed'
    return { tags, visibility }
  } catch (err) {
    // An unreachable index must not stop the class from being materialized; it only
    // means we cannot prove the series routes, and an unproven route writes no listing.
    log.warn('could not read the series template config; occurrences will not be listed', { detail: describeError(err) })
    return { tags: [], visibility: 'listed' }
  }
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

  const [presentation, extra] = await Promise.all([getPresentation(series.firstEvent.uri), getEventExtra(series.firstEvent.uri)])
  const routing = await templateRouting(series.firstEvent.uri)
  // Fetched at most once per series, and only if something might actually be listed:
  // `schoolRoutingTags()` is a live read of the school's own record.
  let schoolTags: string[] | undefined
  const routingTags = async () => (schoolTags ??= await schoolRoutingTags())
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

    await savePresentation(event.uri, presentation)
    await setEventExtra(event.uri, extra.materials, extra.suppliesNote)

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

    // Route it to peers, as the school — through the SAME gate a directly created class
    // goes through (`lib/events.ts#routeListing`), with the template's own tags. No
    // routed tag, or an unlisted/private series, means no listing at all.
    if (routing.tags.length > 0 && routing.visibility === 'listed') {
      await routeListing({
        event: { uri: event.uri, cid: event.cid },
        name: String(template.value.name ?? 'class'),
        tags: routing.tags,
        visibility: routing.visibility,
        callerDid: seriesAuthorDid as `did:${string}`,
        schoolTags: await routingTags(),
        action: 'materialize-occurrence',
        auditReason: `list occurrence ${i + 1}`,
      }).catch(() => {
        /* the occurrence exists; listing can be retried */
      })
    }

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
    // The occurrence's `fs_series_occurrence` row exists by now (just above), which is
    // what `lib/events.ts#resolveHostDid` reads — so the feedback this window will collect
    // is attributed to, and notifies, the SERIES AUTHOR and not the school (A8).
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
