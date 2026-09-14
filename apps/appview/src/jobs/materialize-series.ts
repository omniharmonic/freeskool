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
 *   - `until` ENDS the series: nothing at or after it is ever planned, however far the
 *     window later moves. That is what "cancel this and all following dates"
 *     (`lib/events.ts#cancelEventAsHost`) writes, and a series whose end date is only in
 *     its `exdates` would quietly come back to life the next time the horizon widened;
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
import { getRecordByUri, listCollection, parseAtUri, sidecarsForEvent } from '../index/queries.js'
import type { EventConfig, EventListing } from '../lexicons/coop.js'
import { routeListing, routesOnTags, schoolRoutingTags } from '../lib/events.js'
import { NSID } from '../lexicons/nsids.js'
import { normalizeInstant, occurrenceRkey } from '../lib/crypto.js'
import { actorFor, asDid } from '../lib/school-actors.js'
import { schoolOfEvent, stampEventSchool } from '../lib/event-school.js'
import { getRecord } from '../lib/pds.js'
import { resolvePdsEndpoint } from '../lib/identity.js'
import { describeError, log } from '../lib/logging.js'
import { openFeedbackWindow } from '../lib/feedback.js'

const RELIST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

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
  series: Pick<SeriesRecord, 'rrule' | 'exdates' | 'materializeAhead' | 'timezone' | 'until'>,
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
  // `until` is a real instant compared against real instants — deliberately NOT folded
  // into the rrule string, whose own UNTIL would be matched against the FLOATING local
  // dates this expansion works in and would therefore be wrong by the zone's offset.
  const until = series.until ? Date.parse(series.until) : Number.NaN
  const usable = candidates.filter(
    (d) =>
      d <= ceiling &&
      !excluded.has(normalizeInstant(d.toISOString())) &&
      (Number.isNaN(until) || d.getTime() < until),
  )

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
  /**
   * WHOSE SCHEDULING ARTIFACT this is. MS §4: "the materializer resolves the school from
   * `fs_event_school` of the template" — which is both cheaper and more correct than
   * looping every school over every series, since a series belongs to exactly one
   * calendar and an absent row means the legacy school.
   */
  school?: string,
): Promise<{ written: number; skipped: number }> {
  const parts = parseAtUri(seriesUri)
  if (!parts) return { written: 0, skipped: 0 }
  const schoolDid = school ?? (await schoolOfEvent(series.firstEvent.uri))

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
  // Captured here rather than read inside the closures below: TypeScript cannot keep the
  // `if (!template) return` narrowing across a function boundary, and neither should we.
  const templateName = String(template.value.name ?? 'class')
  // Fetched at most once per series, and only if something might actually be listed:
  // `schoolRoutingTags()` is a live read of the school's own record.
  let schoolTags: string[] | undefined
  const routingTags = async () => (schoolTags ??= await schoolRoutingTags(schoolDid))
  // "Does this series route at all?", answered at most once per series. Cheap enough to
  // ask before touching the index for every already-materialized occurrence.
  let routes: boolean | undefined
  const seriesRoutes = async () => {
    if (routes === undefined) {
      routes =
        routing.visibility === 'listed' &&
        routing.tags.length > 0 &&
        routesOnTags(routing.tags, await routingTags())
    }
    return routes
  }

  /**
   * REVIEW ROUND 1 (blocking). An occurrence written on an earlier tick — when the
   * host's config sidecar had not yet reached our index, so the series could not be
   * proven to route — is skipped by the `existing` check below before anything asks
   * whether it should be listed. Without this, that occurrence is NEVER listed: the drop
   * is permanent, not "until the next run".
   *
   * Idempotent, and it respects a steward's removal: we write a listing only when the
   * index shows NO listing for this occurrence at all. A `removed` one is still a
   * listing, and re-listing what a steward took down is exactly the stickiness bug
   * `decideListingEdit` exists to prevent.
   */
  async function relistIfMissing(eventUri: string | null, sequence: number): Promise<void> {
    if (!eventUri) return
    try {
      const indexer = await getIndexer()
      const already = await sidecarsForEvent<EventListing>(indexer, 'eventListing', eventUri)
      if (already.length > 0) return
      const cid = (await getRecordByUri(indexer, 'event', eventUri))?.cid ?? (await cidFromPds(eventUri))
      // A strongRef needs both halves; no cid means no listing rather than an invalid one.
      if (!cid) return
      await routeListing({
        event: { uri: eventUri, cid },
        name: templateName,
        tags: routing.tags,
        visibility: routing.visibility,
        callerDid: seriesAuthorDid as `did:${string}`,
        schoolTags: await routingTags(),
        action: 'materialize-occurrence',
        auditReason: `list occurrence ${sequence} (config indexed after it was materialized)`,
        schoolDid,
      })
    } catch (err) {
      // Best effort, like the first-pass listing: the occurrence exists either way and
      // the next tick will try again.
      log.warn('could not back-fill an occurrence listing', { detail: describeError(err) })
    }
  }
  const db = getDb()
  // rkey -> the occurrence event we already wrote for it. The URI matters as much as the
  // key: a previously materialized occurrence may still be missing its listing (see
  // `relistIfMissing`), and that is only fixable if we know which event to list.
  const existing = new Map(
    (
      await db
        .select({ rkey: seriesOccurrence.occurrenceRkey, eventUri: seriesOccurrence.eventUri })
        .from(seriesOccurrence)
        .where(eq(seriesOccurrence.seriesUri, seriesUri))
    ).map((r) => [r.rkey, r.eventUri] as const),
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
      // Back-fill a missing listing only for recent or upcoming occurrences: index lag
      // resolves within a tick or two, and a years-old weekly series would otherwise
      // cost one index query per past occurrence on every run, forever.
      const recent = instant.getTime() >= now.getTime() - RELIST_LOOKBACK_MS
      if (recent && (await seriesRoutes())) await relistIfMissing(existing.get(rkey) ?? null, i + 1)
      continue
    }

    const endsAt = durationMs ? new Date(instant.getTime() + durationMs).toISOString() : undefined
    const actor = await actorFor(schoolDid)
    const event = await actor.putRecordAsSchool({
      schoolDid: asDid(schoolDid),
      callerDid: seriesAuthorDid as `did:${string}`,
      scope: NSID.event,
      action: 'materialize-occurrence',
      collection: NSID.event,
      rkey,
      record: {
        $type: NSID.event,
        name: template.value.name,
        // Task 19c: the record's `description` is the PUBLIC overview, taken from the
        // template's app-side presentation — never the template record's own field,
        // which on a class published before 19c holds the host's attendee notes. The
        // notes and the meeting link ride along in `fs_event_extra` below instead, and
        // `uris` is not copied at all (nothing writes it any more).
        ...(presentation.publicOverview?.description?.trim()
          ? { description: presentation.publicOverview.description.trim() }
          : {}),
        createdAt: new Date().toISOString(),
        startsAt: originalStartsAt,
        ...(endsAt ? { endsAt } : {}),
        ...(template.value.mode ? { mode: template.value.mode } : {}),
        status: `${NSID.event}#scheduled`,
        ...(template.value.locations ? { locations: template.value.locations } : {}),
        rsvpExpected: template.value.rsvpExpected ?? true,
      },
      audit: { reason: `materialize occurrence ${i + 1} of series ${parts.rkey}` },
    })

    // The occurrence is on the SAME calendar as its template (MS §4).
    await stampEventSchool(event.uri, schoolDid)
    await savePresentation(event.uri, presentation)
    // Everything the template carries for its attendees, EXCEPT why the template itself
    // was called off — a fresh date is not cancelled.
    const { cancelReason: _templateCancelReason, ...occurrenceExtra } = extra
    await setEventExtra(event.uri, occurrenceExtra)

    await actor.putRecordAsSchool({
      schoolDid: asDid(schoolDid),
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
    if (await seriesRoutes()) {
      await routeListing({
        event: { uri: event.uri, cid: event.cid },
        name: templateName,
        tags: routing.tags,
        visibility: routing.visibility,
        callerDid: seriesAuthorDid as `did:${string}`,
        schoolTags: await routingTags(),
        action: 'materialize-occurrence',
        auditReason: `list occurrence ${i + 1}`,
        schoolDid,
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

/** The cid of a record straight from its repo, when the index has not caught up. */
async function cidFromPds(uri: string): Promise<string | null> {
  const parts = parseAtUri(uri)
  if (!parts) return null
  const endpoint = await resolvePdsEndpoint(parts.did)
  if (!endpoint) return null
  return (await getRecord(parts.did, parts.collection, parts.rkey, endpoint))?.cid ?? null
}

async function loadTemplate(eventUri: string) {
  const parts = parseAtUri(eventUri)
  if (!parts) return null
  const endpoint = await resolvePdsEndpoint(parts.did)
  if (!endpoint) return null
  return getRecord(parts.did, parts.collection, parts.rkey, endpoint)
}
