/**
 * Publishing a class.
 *
 * WHOSE REPO — the choice, documented (the brief offers both):
 *
 *   The event, its `coop.lexicon.event.config`, its `freeschool.draft.skillLevel`
 *   sidecars and its `freeschool.draft.series` all go into the HOST'S OWN REPO — for
 *   custodial hosts too, because we hold their credential and authorship is the point:
 *   a class is something a person offered, and if the school authored the record then
 *   leaving the school (or the school going away) orphans it. Portability is the whole
 *   reason for being on ATProto.
 *
 *   The SCHOOL writes exactly two things, both through `SchoolActorPort`:
 *     - `coop.lexicon.event.listing`  — curation: "this class is on our calendar". A
 *       school removing a listing must not be able to edit or delete the host's event,
 *       and this is what makes that structurally true.
 *     - materialized occurrences of a series (src/jobs/materialize-series.ts), which are
 *       the school's own scheduling artifact.
 *
 *   If the viewer has no usable credential for their own repo (an existing account whose
 *   OAuth session has lapsed), we return 401 rather than quietly publishing as the
 *   school: misattributing authorship is worse than an error message.
 */
import { normalizeImage, type ImageInput } from './images.js'
import { getPresentation, savePresentation, type PublicOverview } from './event-presentation.js'
import type { Agent } from '@atproto/api'
import type { Did, SchoolAction } from '@freeschool/school-actor'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { actorFor, asDid } from './school-actors.js'
import { legacySchoolDid } from './schools.js'
import { stampEventSchool } from './event-school.js'
import { getIndexer } from '../index/indexer.js'
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { bumpTally } from './roles.js'
import { openFeedbackWindow } from './feedback.js'
import { getRecord } from './pds.js'
import { describeError, log } from './logging.js'
import { getRecordByUri, parseAtUri, sidecarsForEvent } from '../index/queries.js'
import { isListed } from '../http/visibility.js'
import type { EventConfig, EventListing } from '../lexicons/coop.js'
import { getEventExtra, setEventExtra } from './event-extra.js'
import { Role } from '@freeschool/shared'
import { and, gte, inArray, eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { seriesOccurrence } from '../db/schema.js'
import { rsvpRoster } from './rsvp.js'
import { enqueueNotification } from '../notifications/dispatch.js'
import { normalizeInstant } from './crypto.js'

/**
 * WHO IS THE HUMAN HOST OF THIS EVENT? (A8)
 *
 * For an ordinary class: its record's author, full stop. For a MATERIALIZED OCCURRENCE of a
 * series the author is the SCHOOL — that is settled (`jobs/materialize-series.ts`: the host
 * should not have to be online for next month's class to appear) — and using the author as
 * "the host" made every occurrence after the first one un-hostable: its real host could not
 * take attendance on it, could not see its roster, and read as `viewerRelation: 'public'`
 * on their own class, while the school (which is nobody) was treated as the host.
 *
 * The link back to the person is `fs_series_occurrence`: app-side, written by the
 * materializer next to every occurrence it creates. `series_uri`'s AUTHORITY is the series
 * author, and a series lives in the same repo as the first event it points at — one parse
 * rather than two more round-trips.
 *
 * The public record's author is NOT changed by any of this: the occurrence stays the
 * school's record, which is what keeps the school's scheduling artifact out of somebody
 * else's repo.
 */
export async function resolveHostDid(eventUri: string, recordAuthorDid: string): Promise<string> {
  return hostOfSeries(await seriesUriForOccurrence(eventUri), recordAuthorDid)
}

/**
 * The series this event is a materialized occurrence OF, or `undefined` for an ordinary
 * class (and for the series' own first event, which is the host's own record and finds
 * its series through the `firstEvent` sidecar instead).
 */
export async function seriesUriForOccurrence(eventUri: string): Promise<string | undefined> {
  const rows = await getDb()
    .select({ seriesUri: seriesOccurrence.seriesUri })
    .from(seriesOccurrence)
    .where(eq(seriesOccurrence.eventUri, eventUri))
    .limit(1)
  return rows[0]?.seriesUri ?? undefined
}

/** A series lives in the same repo as the first event it points at — one parse, no I/O. */
export function hostOfSeries(seriesUri: string | undefined, recordAuthorDid: string): string {
  if (!seriesUri) return recordAuthorDid
  return parseAtUri(seriesUri)?.did ?? recordAuthorDid
}

/**
 * The batched form, for a whole calendar page: one query instead of one per event. Returns
 * the host for every input uri, so callers can index it unconditionally.
 */
export async function resolveHostDids(
  events: ReadonlyArray<{ uri: string; did: string }>,
): Promise<Map<string, string>> {
  const out = new Map(events.map((e) => [e.uri, e.did]))
  if (events.length === 0) return out
  const rows = await getDb()
    .select({ eventUri: seriesOccurrence.eventUri, seriesUri: seriesOccurrence.seriesUri })
    .from(seriesOccurrence)
    .where(inArray(seriesOccurrence.eventUri, events.map((e) => e.uri)))
  for (const row of rows) {
    if (!row.eventUri) continue
    const host = parseAtUri(row.seriesUri)?.did
    if (host) out.set(row.eventUri, host)
  }
  return out
}

export interface CreateEventInput {
  /**
   * The PUBLIC invitation. Its `description` is written into the event record's own
   * `description` field (task 19c) — that is what a peer AppView, a calendar client or
   * anyone reading the host's repo sees, and it is the only free text of ours that goes
   * there. `audience` / `accessibility` stay app-side (`lib/event-presentation.ts`),
   * because the borrowed record has nowhere to put them and we never extend it.
   */
  publicOverview?: PublicOverview
  cover?: ImageInput | null
  venueNeeded?: boolean
  name: string
  /**
   * Notes for people who RSVP'd ("come to the side door"). App-side, `fs_event_extra`
   * — NEVER the record. See `lib/event-extra.ts`.
   */
  attendeeNotes?: string
  /** The Zoom/Meet/Jitsi link. App-side too, same reason, same gate. */
  meetingLink?: string
  /**
   * @deprecated Pre-19c names for `attendeeNotes` / `meetingLink`. The class form
   * labelled them "shown after RSVP" and then wrote them into the host's PUBLIC record;
   * `attendeeFields()` below maps them onto the app-side fields so older clients (and
   * the seed scripts) keep working. Neither is ever written to a record again.
   */
  description?: string
  /** @deprecated see `description` — only `uris[0].uri` is read, as the meeting link. */
  uris?: Array<{ uri: string; name?: string }>
  startsAt: string
  endsAt?: string
  /** `community.lexicon.calendar.event#inperson` etc. Defaults to in-person. */
  mode?: string
  locations?: unknown[]
  /** coop.lexicon.event.config */
  timezone?: string
  capacity?: number
  visibility?: 'listed' | 'unlisted' | 'private'
  neighborhood?: string
  rsvpRequired?: boolean
  /**
   * Lowercase kebab tags, ≤ 10. Routes the school's own curation listing — see
   * `routeListing` below. An event with no tag that routes gets NO curation listing at
   * all (it is not silently defaulted into one): it still appears on OUR OWN calendar,
   * because calendar/zine inclusion is decided by AUTHORSHIP, not by the listing — see
   * `calendarInclusion` in `http/visibility.ts`. Listings exist for routing TO PEERS.
   */
  tags?: string[]
  /** One sidecar per (skill, level) the class teaches. */
  skills?: Array<{ skill: string; level: 1 | 2 | 3; prerequisites?: string }>
  /**
   * App-side only (`fs_event_extra` — see `lib/event-extra.ts`'s doc comment for why not
   * a lexicon field). `materials` ≤ 20 items of ≤ 120 chars; `suppliesNote` ≤ 300 chars
   * free text, enforced by the route's zod schema, not here.
   */
  materials?: string[]
  suppliesNote?: string
  /** Recurrence. Materialized server-side by the daily job, never by the client. */
  series?: {
    rrule: string
    freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
    interval?: number
    byDay?: string[]
    until?: string
    count?: number
    exdates?: string[]
    timezone: string
    materializeAhead?: number
  }
}

export interface CreatedEvent {
  event: { uri: string; cid: string }
  config: { uri: string; cid: string }
  skillLevels: Array<{ uri: string; cid: string }>
  series?: { uri: string; cid: string }
  listing?: { uri: string; cid: string }
}

/**
 * TAG ROUTING. The school's curation listing (`coop.lexicon.event.listing`) is written
 * ONLY when the event carries at least one tag the school routes on — taken from the
 * school's own `freeschool.draft.school#tags`, falling back to
 * `['skillshare', 'free-school']` when the school has not set any (or is not reachable).
 * An event with no tag that routes gets NO listing, full stop — it is not silently
 * defaulted into one. It still appears on OUR OWN calendar regardless, because
 * calendar/zine inclusion is decided by authorship (`calendarInclusion` in
 * `http/visibility.ts`), never by the listing. Listings exist for routing TO PEERS.
 */
export const DEFAULT_ROUTING_TAGS = ['skillshare', 'free-school']

export function routesOnTags(eventTags: string[], schoolTags: string[]): boolean {
  const routing = new Set(schoolTags.map((t) => t.toLowerCase()))
  return eventTags.some((t) => routing.has(t.toLowerCase()))
}

export async function schoolRoutingTags(schoolDid = legacySchoolDid()): Promise<string[]> {
  try {
    const school = await getRecord(schoolDid, NSID.school, 'self')
    const tags = school?.value?.tags
    if (Array.isArray(tags) && tags.length > 0) {
      const strings = tags.filter((t): t is string => typeof t === 'string')
      if (strings.length > 0) return strings
    }
  } catch (err) {
    log.warn('could not read the school record for its routing tags; using defaults', { detail: describeError(err) })
  }
  return DEFAULT_ROUTING_TAGS
}

export interface RouteListingInput {
  event: { uri: string; cid: string }
  name: string
  tags: string[]
  visibility?: 'listed' | 'unlisted' | 'private'
  callerDid: Did
  /**
   * Injectable tag source, mainly for tests: when omitted, `schoolRoutingTags()` is
   * called, which makes a live HTTP request to the school's own PDS. Pass an explicit
   * array to keep a unit test hermetic (no network, no warning log).
   */
  schoolTags?: string[]
  /**
   * The audited `SchoolAction` this listing belongs to. Defaults to `publish-event` (a
   * host publishing a class); the series job passes `materialize-occurrence` so the
   * audit row says which job wrote it — the ROUTING RULE is identical either way, which
   * is the entire point of routing occurrences through here (interop gap 2).
   */
  action?: SchoolAction
  /** Audit reason override; defaults to `host published "<name>"`. */
  auditReason?: string
  /** WHICH SCHOOL is curating. Defaults to the legacy school for scripts and tests. */
  schoolDid?: string
}

/** Writes the school's curation listing, as the school, only when tags + visibility route. */
export async function routeListing(input: RouteListingInput): Promise<{ uri: string; cid: string } | undefined> {
  if ((input.visibility ?? 'listed') !== 'listed') return undefined
  const school = input.schoolDid ?? legacySchoolDid()
  const schoolTags = input.schoolTags ?? (await schoolRoutingTags(school))
  if (!routesOnTags(input.tags, schoolTags)) return undefined
  const res = await (await actorFor(school)).putRecordAsSchool({
    schoolDid: asDid(school),
    callerDid: input.callerDid,
    scope: NSID.eventListing,
    action: input.action ?? 'publish-event',
    collection: NSID.eventListing,
    rkey: tid(),
    record: {
      $type: NSID.eventListing,
      event: input.event,
      school,
      status: 'listed',
      tags: input.tags,
      createdAt: new Date().toISOString(),
    },
    audit: { reason: input.auditReason ?? `host published "${input.name}"` },
  })
  return { uri: res.uri, cid: res.cid }
}

export type ListingEditAction = 'create' | 'remove' | 'none'

/**
 * Pure decision for re-routing a listing on a host's edit (no DB, no PDS — see
 * `updateEventAsHost` for the plumbing around it). The key distinction (the bug this
 * closes): `everListedByUs` asks "have we EVER written a listing for this event", NOT
 * "is it currently active" — a moderation REMOVAL is sticky. Once a steward has removed
 * our listing, a host retagging back onto a routed tag must never recreate it; only a
 * steward restoring it can. We only ever CREATE a listing the first time an event
 * transitions into a routed state.
 */
export function decideListingEdit(state: {
  everListedByUs: boolean
  isActivelyListedByUs: boolean
  routesNow: boolean
}): ListingEditAction {
  if (state.routesNow && !state.everListedByUs) return 'create'
  if (!state.routesNow && state.isActivelyListedByUs) return 'remove'
  return 'none'
}

/**
 * Who may see the roster (`GET /api/events/:id/rsvps`) — the host of THIS event, or a
 * steward (moderation needs the same "know who is coming" visibility). Pure, so the
 * "forbidden for an ordinary member / visible to the host" rule is testable without a
 * database or an indexed event.
 */
export function canViewRoster(hostDid: string, viewerDid: string, viewerRole: number): boolean {
  return hostDid === viewerDid || viewerRole >= Role.Steward
}

/**
 * The one place the deprecated `description` / `uris` inputs are folded onto the app-side
 * `attendeeNotes` / `meetingLink` (task 19c). `undefined` still means "leave alone" on an
 * update, so the distinction between an ABSENT key and an explicitly empty one survives
 * the mapping: `uris: []` is a deliberate "clear the link" and resolves to `''`, while an
 * omitted `uris` resolves to `undefined`.
 */
export function attendeeFields(input: Pick<CreateEventInput, 'attendeeNotes' | 'meetingLink' | 'description' | 'uris'>): {
  attendeeNotes?: string
  meetingLink?: string
} {
  const attendeeNotes = input.attendeeNotes !== undefined ? input.attendeeNotes : input.description
  const meetingLink =
    input.meetingLink !== undefined
      ? input.meetingLink
      : input.uris !== undefined
        ? input.uris[0]?.uri ?? ''
        : undefined
  return { ...(attendeeNotes !== undefined ? { attendeeNotes } : {}), ...(meetingLink !== undefined ? { meetingLink } : {}) }
}

/** Empty string and whitespace both mean "not set" for an app-side text field. */
function text(value?: string): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export async function createEventAsHost(
  viewer: Viewer,
  input: CreateEventInput,
  /** The school this class goes on the calendar of — stamped into `fs_event_school`. */
  schoolDid: string = legacySchoolDid(),
): Promise<CreatedEvent> {
  const cover = input.cover ? await normalizeImage(input.cover) : undefined
  const agent = await actorAgent(viewer)
  const now = new Date().toISOString()
  // No default: an untagged event gets no listing at all (see the doc comment on `tags`
  // above). It still appears on our own calendar by authorship, not by this array.
  const tags = input.tags ?? []

  const attendee = attendeeFields(input)

  // THE RECORD'S `description` IS THE PUBLIC OVERVIEW, and nothing else (task 19c). The
  // attendee notes and the meeting link that used to land here — under a form that said
  // "shown after RSVP" — are app-side now: `community.lexicon.calendar.event` is
  // world-readable in the host's own repo, so the old promise was never true, while the
  // text the host actually wrote FOR the public was not on the record at all and peers
  // saw a class with no description. No `uris` either: the only thing that ever
  // populated them was the host's meeting link.
  const eventRkey = tid()
  const event = await put(agent, viewer.did, NSID.event, eventRkey, {
    $type: NSID.event,
    name: input.name,
    ...(text(input.publicOverview?.description) ? { description: input.publicOverview!.description.trim() } : {}),
    createdAt: now,
    startsAt: input.startsAt,
    ...(input.endsAt ? { endsAt: input.endsAt } : {}),
    mode: input.mode ?? `${NSID.event}#inperson`,
    status: `${NSID.event}#scheduled`,
    ...(input.locations?.length ? { locations: input.locations } : {}),
    rsvpExpected: input.rsvpRequired ?? true,
  })

  const configRecord: EventConfig & { $type: string } = {
    $type: NSID.eventConfig,
    event: { uri: event.uri, cid: event.cid },
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(typeof input.capacity === 'number' ? { capacity: input.capacity } : {}),
    visibility: input.visibility ?? 'listed',
    ...(input.neighborhood ? { neighborhood: input.neighborhood } : {}),
    rsvpRequired: input.rsvpRequired ?? true,
    school: schoolDid,
    tags,
    createdAt: now,
  }
  const cfg = await put(agent, viewer.did, NSID.eventConfig, tid(), configRecord)

  const skillLevels: Array<{ uri: string; cid: string }> = []
  for (const s of input.skills ?? []) {
    skillLevels.push(
      await put(agent, viewer.did, NSID.skillLevel, tid(), {
        $type: NSID.skillLevel,
        event: { uri: event.uri, cid: event.cid },
        skill: s.skill,
        level: s.level,
        ...(s.prerequisites ? { prerequisites: s.prerequisites } : {}),
        createdAt: now,
      }),
    )
  }

  let series: { uri: string; cid: string } | undefined
  if (input.series) {
    if (input.series.until && input.series.count) {
      throw new Error('a series may set `until` or `count`, never both (RFC 5545)')
    }
    series = await put(agent, viewer.did, NSID.series, tid(), {
      $type: NSID.series,
      firstEvent: { uri: event.uri, cid: event.cid },
      rrule: input.series.rrule,
      freq: input.series.freq,
      interval: input.series.interval ?? 1,
      ...(input.series.byDay?.length ? { byDay: input.series.byDay } : {}),
      ...(input.series.until ? { until: input.series.until } : {}),
      ...(input.series.count ? { count: input.series.count } : {}),
      ...(input.series.exdates?.length ? { exdates: input.series.exdates } : {}),
      timezone: input.series.timezone,
      materializeAhead: input.series.materializeAhead ?? 90,
      createdAt: now,
    })
  }

  // Curation, as the school, through the port — and only when the tags route. Never
  // inline in the host's repo.
  const listing = await routeListing({
    event: { uri: event.uri, cid: event.cid },
    name: input.name,
    tags,
    visibility: input.visibility,
    callerDid: viewer.did as Did,
    schoolDid,
  })

  /**
   * WHICH CALENDAR this class is on, recorded at creation (MS §4). Authorship stopped
   * identifying the calendar the moment a host could belong to two schools. The event
   * record itself is untouched — sidecar composition only.
   */
  await stampEventSchool(event.uri, schoolDid)

  await setEventExtra(event.uri, {
    materials: input.materials ?? [],
    ...(text(input.suppliesNote) ? { suppliesNote: input.suppliesNote!.trim() } : {}),
    ...(text(attendee.attendeeNotes) ? { attendeeNotes: attendee.attendeeNotes!.trim() } : {}),
    ...(text(attendee.meetingLink) ? { meetingLink: attendee.meetingLink!.trim() } : {}),
  })
  await savePresentation(event.uri, { cover, venueNeeded: input.venueNeeded, publicOverview: input.publicOverview })

  await bumpTally(viewer.did, { hostedEvents: 1 }, schoolDid)
  if (input.endsAt ?? input.startsAt) await openFeedbackWindow(event.uri, input.endsAt ?? input.startsAt)

  // Read-your-writes: pull what we just wrote into the index immediately.
  const indexer = await getIndexer()
  await indexer
    .notify([event.uri, cfg.uri, ...skillLevels.map((s) => s.uri), ...(series ? [series.uri] : []), ...(listing ? [listing.uri] : [])])
    .catch(() => {
      /* the periodic backfill will pick it up */
    })

  return { event, config: cfg, skillLevels, ...(series ? { series } : {}), ...(listing ? { listing } : {}) }
}

export class EventNotFoundError extends Error {
  constructor(readonly uri: string) {
    super('event not found')
    this.name = 'EventNotFoundError'
  }
}

export class EventPermissionError extends Error {
  constructor() {
    super('only the host of a class may update it')
    this.name = 'EventPermissionError'
  }
}

/**
 * The viewer IS this occurrence's host, but the record is the SCHOOL's (A8) — editing it
 * here would write a COPY of the school's occurrence into the host's own repo and leave the
 * real one untouched. The series is the thing to edit.
 */
export class OccurrenceNotEditableError extends Error {
  constructor() {
    super('this date is a materialized occurrence of a recurring class — edit the series, or cancel this date')
    this.name = 'OccurrenceNotEditableError'
  }
}

export type UpdateEventInput = Partial<CreateEventInput>

export interface UpdatedEvent {
  event: { uri: string; cid: string }
  config: { uri: string; cid: string }
  listing?: { uri: string; cid: string }
  skillLevels?: Array<{ uri: string; cid: string }>
  /** True when retagging away from a routed tag could not remove the school's listing
   * (that needs a steward) — the event stays listed until one acts. */
  unlisted?: boolean
}

export class SeriesEditNotSupportedError extends Error {
  constructor() {
    super('recurrence cannot be changed here — see the dedicated recurrence edit path')
    this.name = 'SeriesEditNotSupportedError'
  }
}

/**
 * A host updates their own class. Same "whose repo" rule as creation: the event and its
 * config are overwritten in place, in the HOST's repo. `skills`, when present, REPLACES
 * the event's `freeschool.draft.skillLevel` sidecars entirely (old ones deleted, new
 * ones written) — omit it to leave them untouched. `series` is rejected outright
 * (`SeriesEditNotSupportedError`); recurrence has its own dedicated edit path.
 *
 * The school's curation listing is re-routed (see `decideListingEdit`) but never deleted
 * unilaterally by the host — removing one is moderation (MIN_ROLE['remove-listing'] =
 * Steward), so a detagging host who is not themselves a steward gets `unlisted: false`
 * back and the event stays listed until a steward acts.
 */
export async function updateEventAsHost(
  viewer: Viewer,
  eventUri: string,
  input: UpdateEventInput,
  schoolDid: string = legacySchoolDid(),
): Promise<UpdatedEvent> {
  if (input.series !== undefined) throw new SeriesEditNotSupportedError()

  const indexer = await getIndexer()
  const current = await getRecordByUri(indexer, 'event', eventUri)
  if (!current) throw new EventNotFoundError(eventUri)
  // A8: for an occurrence the record's author is the school and the HOST is the series
  // author — so "are you the host" and "is this your record" are two different questions,
  // and only the first one is about permission.
  const hostDid = await resolveHostDid(eventUri, current.did)
  if (hostDid !== viewer.did) throw new EventPermissionError()
  if (current.did !== viewer.did) throw new OccurrenceNotEditableError()
  const parts = parseAtUri(eventUri)
  if (!parts) throw new EventNotFoundError(eventUri)

  const oldPresentation = await getPresentation(eventUri)
  const cover = input.cover === undefined ? oldPresentation.cover : input.cover ? await normalizeImage(input.cover) : undefined
  const startsAt = input.startsAt ?? String(current.value.startsAt ?? '')
  const endsAt = input.endsAt ?? current.value.endsAt
  if (endsAt && Date.parse(String(endsAt)) <= Date.parse(startsAt)) {
    throw Object.assign(new Error('The end time must be after the start time.'), { status: 400, code: 'InvalidDates' })
  }
  const agent = await actorAgent(viewer)

  // Task 19c. The record's `description` is ALWAYS the resolved public overview — never
  // merged from `current.value`, because on a class published before 19c that field holds
  // the host's attendee notes, and re-writing it from the app-side overview is what
  // repairs the leak on the next edit. `uris` is dropped for the same reason: nothing in
  // this codebase writes them any more, so whatever is there is a legacy meeting link the
  // host was told only attendees would see. (`scripts/migrate-event-notes.ts` is the
  // one-off that moves the old values somewhere safe rather than merely dropping them.)
  const newOverview = input.publicOverview !== undefined ? input.publicOverview : oldPresentation.publicOverview
  const { uris: _legacyUris, description: _legacyDescription, ...carried } = current.value as Record<string, unknown>
  const mergedEvent: Record<string, unknown> = {
    ...carried,
    ...(text(newOverview?.description) ? { description: newOverview!.description.trim() } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.locations !== undefined ? { locations: input.locations } : {}),
    ...(input.rsvpRequired !== undefined ? { rsvpExpected: input.rsvpRequired } : {}),
  }
  const event = await put(agent, viewer.did, NSID.event, parts.rkey, mergedEvent)

  const configRows = await sidecarsForEvent<EventConfig>(indexer, 'eventConfig', eventUri)
  const existingConfig = configRows[0]
  const configParts = existingConfig ? parseAtUri(existingConfig.uri) : null
  // No default here either (see createEventAsHost). Omitting `tags` entirely means "leave
  // it alone" (keeps whatever the config already had). An EXPLICIT `tags: []` is a
  // deliberate instruction to un-route the event — it clears the tags and, a few lines
  // down, `decideListingEdit` will remove the school's listing if one is currently active.
  const newTags = input.tags !== undefined ? input.tags : existingConfig?.value.tags ?? []
  const newVisibility = input.visibility ?? existingConfig?.value.visibility ?? 'listed'
  const mergedConfig: EventConfig & { $type: string } = {
    ...existingConfig?.value,
    $type: NSID.eventConfig,
    event: { uri: event.uri, cid: event.cid },
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
    visibility: newVisibility,
    ...(input.neighborhood !== undefined ? { neighborhood: input.neighborhood } : {}),
    rsvpRequired: input.rsvpRequired ?? existingConfig?.value.rsvpRequired ?? true,
    school: schoolDid,
    tags: newTags,
    createdAt: existingConfig?.value.createdAt ?? new Date().toISOString(),
  }
  const cfg = await put(agent, viewer.did, NSID.eventConfig, configParts?.rkey ?? tid(), mergedConfig)

  // Same "omit means leave alone" convention as `tags`/`visibility` above.
  const existingExtra = await getEventExtra(eventUri)
  const attendee = attendeeFields(input)
  await setEventExtra(event.uri, {
    materials: input.materials !== undefined ? input.materials : existingExtra.materials,
    ...(() => {
      const v = text(input.suppliesNote !== undefined ? input.suppliesNote : existingExtra.suppliesNote)
      return v ? { suppliesNote: v } : {}
    })(),
    ...(() => {
      const v = text(attendee.attendeeNotes !== undefined ? attendee.attendeeNotes : existingExtra.attendeeNotes)
      return v ? { attendeeNotes: v } : {}
    })(),
    ...(() => {
      const v = text(attendee.meetingLink !== undefined ? attendee.meetingLink : existingExtra.meetingLink)
      return v ? { meetingLink: v } : {}
    })(),
    // `setEventExtra` clears anything absent, and a cancellation reason is not the edit
    // form's to forget: editing a cancelled class must not silently erase why it was
    // called off (`cancelEventAsHost` is the only writer).
    ...(existingExtra.cancelReason ? { cancelReason: existingExtra.cancelReason } : {}),
  })
  await savePresentation(event.uri, { ...oldPresentation, cover, ...(input.publicOverview !== undefined ? { publicOverview: input.publicOverview } : {}), ...(input.venueNeeded !== undefined ? { venueNeeded: input.venueNeeded } : {}) })

  // Replace the skill sidecars entirely when `skills` is present; leave them alone
  // otherwise. All in the HOST's own repo, same as creation.
  let skillLevels: Array<{ uri: string; cid: string }> | undefined
  let deletedSkillUris: string[] = []
  if (input.skills !== undefined) {
    const existingSkills = await sidecarsForEvent<{ skill: string; level: number; prerequisites?: string }>(
      indexer,
      'skillLevel',
      eventUri,
    )
    for (const s of existingSkills) {
      const p = parseAtUri(s.uri)
      if (p) {
        await agent.com.atproto.repo
          .deleteRecord({ repo: viewer.did, collection: NSID.skillLevel, rkey: p.rkey })
          .catch(() => {
            /* best effort: the new sidecars are the record of truth going forward */
          })
      }
    }
    // A PDS 404 on notify() is what tells contrail to drop a record from the index
    // (README: "Only an authoritative not-found response deletes local state") — so the
    // OLD uris need a notify too, not just the new ones, or the index keeps the deleted
    // sidecars around until the next backfill happens to notice.
    deletedSkillUris = existingSkills.map((s) => s.uri)
    skillLevels = []
    for (const s of input.skills) {
      skillLevels.push(
        await put(agent, viewer.did, NSID.skillLevel, tid(), {
          $type: NSID.skillLevel,
          event: { uri: event.uri, cid: event.cid },
          skill: s.skill,
          level: s.level,
          ...(s.prerequisites ? { prerequisites: s.prerequisites } : {}),
          createdAt: new Date().toISOString(),
        }),
      )
    }
  }

  // Re-run tag routing against the NEW tags/visibility. Only OUR school's own listings
  // decide whether WE already have a curation record — a peer's listing of this event
  // (once inbound exchange exists) is not ours to re-route.
  const listingRows = await sidecarsForEvent<EventListing>(indexer, 'eventListing', eventUri)
  const ourListings = listingRows.map((r) => r.value).filter((l) => l.school === schoolDid)
  // "ever listed" (any status, including removed) vs "actively listed right now" are
  // DELIBERATELY different checks — see `decideListingEdit`'s doc comment.
  const everListedByUs = ourListings.length > 0
  const isActivelyListedByUs = isListed({ listings: ourListings, configs: [] })
  const schoolTags = await schoolRoutingTags(schoolDid)
  const routesNow = newVisibility === 'listed' && routesOnTags(newTags, schoolTags)
  const action = decideListingEdit({ everListedByUs, isActivelyListedByUs, routesNow })

  let listing: { uri: string; cid: string } | undefined
  let unlisted: boolean | undefined
  if (action === 'create') {
    listing = await routeListing({
      event: { uri: event.uri, cid: event.cid },
      name: String(mergedEvent.name ?? ''),
      tags: newTags,
      visibility: newVisibility,
      callerDid: viewer.did as Did,
      schoolDid,
    })
  } else if (action === 'remove') {
    unlisted = await withdrawListing({
      event: { uri: event.uri, cid: event.cid },
      callerDid: viewer.did as Did,
      reason: `host retagged "${String(mergedEvent.name ?? '')}" away from a routed tag`,
      schoolDid,
    })
  }

  await indexer
    .notify([
      event.uri,
      cfg.uri,
      ...deletedSkillUris,
      ...(skillLevels ?? []).map((s) => s.uri),
      ...(listing ? [listing.uri] : []),
    ])
    .catch(() => {
      /* the periodic backfill will pick it up */
    })

  return {
    event,
    config: cfg,
    ...(skillLevels ? { skillLevels } : {}),
    ...(listing ? { listing } : {}),
    ...(unlisted !== undefined ? { unlisted } : {}),
  }
}


/* ─────────────────────────────── cancelling a class ─────────────────────────────── */

/**
 * CANCELLING IS A STATUS, NEVER A DELETE.
 *
 * `community.lexicon.calendar.event` already has a `status` field and `#cancelled` is one
 * of its values, so a cancellation needs no new field on a borrowed record and no new
 * lexicon at all — which is the whole test for "compose, don't extend". The record STAYS:
 * someone who RSVP'd has the class in their calendar and on this page, and deleting it
 * would leave them standing outside a locked door wondering. `icsStatus` already turns
 * `#cancelled` into `STATUS:CANCELLED`, so a subscribed calendar client learns it too.
 *
 * WHAT DOES NOT GO ON THE RECORD: the reason. "I have Covid" is not a fact a host owes the
 * whole network, and R9 says the default is app-side — so it is a `fs_event_extra` column,
 * released to anyone who can already see the class and to nobody else.
 */
export const CANCELLED_STATUS = `${NSID.event}#cancelled`

/** True for any spelling of the cancelled token (ours, or a peer's own NSID prefix). */
export function isCancelledStatus(status?: unknown): boolean {
  return typeof status === 'string' && status.endsWith('#cancelled')
}

/** `scope: 'following'` on a class that is not part of a series at all. */
export class NotRecurringError extends Error {
  constructor() {
    super('this class is not part of a recurring series, so there is nothing following it')
    this.name = 'NotRecurringError'
  }
}

export interface CancelEventInput {
  /** App-side only. Never written to any record. */
  reason?: string
  /** `'following'` also ends the series here; only meaningful for a recurring class. */
  scope?: 'this' | 'following'
}

export interface CancelledEvent {
  event: { uri: string; cid: string }
  status: string
  scope: 'this' | 'following'
  /**
   * True when the school's curation listing was withdrawn, FALSE when withdrawing it
   * needs a steward (removing a listing is moderation — see `withdrawListing`), and
   * absent when there was no listing of ours to withdraw.
   */
  unlisted?: boolean
  /** Later occurrences of the series that were cancelled too (`scope: 'following'`). */
  alsoCancelled: string[]
  /** Instants added to the series' `exdates` so they are never materialized again. */
  exdatesAdded: number
  /** People who had RSVP'd and were told. */
  notified: number
}

/**
 * Withdraw the school's curation listing for an event, as the school.
 *
 * Steward-gated and destructive by policy (`remove-listing`), on purpose: a listing is the
 * SCHOOL's statement that a class is on its calendar, and taking one down is moderation.
 * A host who is not a steward therefore gets `false` back and the listing stays until one
 * acts — the class still reads as cancelled everywhere, because that lives on the host's
 * own record, which the host always controls. Never throws: losing the listing race must
 * not cost the host the cancellation itself.
 */
async function withdrawListing(input: {
  event: { uri: string; cid: string }
  callerDid: Did
  reason: string
  schoolDid: string
}): Promise<boolean> {
  try {
    await (await actorFor(input.schoolDid)).putRecordAsSchool({
      schoolDid: asDid(input.schoolDid),
      callerDid: input.callerDid,
      scope: NSID.eventListing,
      action: 'remove-listing',
      collection: NSID.eventListing,
      rkey: tid(),
      record: {
        $type: NSID.eventListing,
        event: input.event,
        school: input.schoolDid,
        status: 'removed',
        createdAt: new Date().toISOString(),
      },
      audit: { reason: input.reason },
    })
    return true
  } catch (err) {
    log.warn('could not withdraw the school listing; a steward must remove it', { detail: describeError(err) })
    return false
  }
}

/**
 * Stamp `status: #cancelled` on an event record, in WHOSEVER repo it lives in.
 *
 * An ordinary class is the host's own record and goes through their own credential. A
 * materialized occurrence is the SCHOOL's record (A8) — the host cannot write it, and
 * `updateEventAsHost` rightly refuses to try (`OccurrenceNotEditableError`, which would
 * otherwise fork a copy into the host's repo) — so it goes back through the same
 * `materialize-occurrence` action that created it: the school's scheduling artifact,
 * changed at the request of the person whose class it is.
 */
async function writeCancelledStatus(
  viewer: Viewer,
  record: { did: string; value: Record<string, unknown> },
  rkey: string,
  auditReason: string,
  schoolDid: string,
): Promise<{ uri: string; cid: string }> {
  const merged = { ...record.value, status: CANCELLED_STATUS }
  if (record.did === viewer.did) {
    const agent = await actorAgent(viewer)
    return put(agent, viewer.did, NSID.event, rkey, merged)
  }
  const res = await (await actorFor(schoolDid)).putRecordAsSchool({
    schoolDid: asDid(schoolDid),
    callerDid: viewer.did as Did,
    scope: NSID.event,
    action: 'materialize-occurrence',
    collection: NSID.event,
    rkey,
    record: merged,
    audit: { reason: auditReason },
  })
  return { uri: res.uri, cid: res.cid }
}

/** Everyone who said they were coming, told once (the dedup ledger enforces the "once"). */
async function notifyCancelled(eventUri: string, name: string, reason?: string, schoolDid?: string): Promise<number> {
  let notified = 0
  for (const r of await rsvpRoster(eventUri)) {
    const res = await enqueueNotification({
      did: r.did,
      category: 'event.cancelled',
      dedupKey: `event.cancelled:${eventUri}:${r.did}`,
      title: `"${name}" has been cancelled`,
      ...(reason ? { body: reason } : {}),
      navigate: `/events/${encodeURIComponent(eventUri)}`,
      ...(schoolDid ? { schoolDid } : {}),
    }).catch(() => ({ claimed: false }))
    if (res.claimed) notified++
  }
  return notified
}

/** Does the school currently list this event? (Nothing to withdraw if it never did.) */
async function isListedByUs(eventUri: string, schoolDid: string): Promise<boolean> {
  const indexer = await getIndexer()
  const rows = await sidecarsForEvent<EventListing>(indexer, 'eventListing', eventUri)
  const ours = rows.map((r) => r.value).filter((l) => l.school === schoolDid)
  return ours.length > 0 && isListed({ listings: ours, configs: [] })
}

/**
 * The host calls a class off.
 *
 * `scope: 'this'` cancels one date. `scope: 'following'` cancels this date and every one
 * after it in the series, which means three things at once: the series sidecar gets an
 * `until` (so the materializer stops planning past this date — `plannedOccurrences`
 * honours it) AND `exdates` for the dates it has already planned (so a consumer reading
 * only the recurrence rule agrees), and every occurrence already materialized from here
 * on is stamped cancelled in the school's repo.
 *
 * Idempotent: cancelling an already-cancelled class re-notifies nobody (the dedup ledger)
 * and does not debit the host's hosted-class tally twice.
 */
export async function cancelEventAsHost(
  viewer: Viewer,
  eventUri: string,
  input: CancelEventInput = {},
  schoolDid: string = legacySchoolDid(),
): Promise<CancelledEvent> {
  const scope = input.scope ?? 'this'
  const indexer = await getIndexer()
  const current = await getRecordByUri(indexer, 'event', eventUri)
  if (!current) throw new EventNotFoundError(eventUri)
  // A8 again: for an occurrence the record's author is the school and the HOST is the
  // series author. Only the host may cancel; a steward acts through moderation instead
  // (`remove-listing` in `http/routes/admin.ts`), which takes the class off OUR calendar
  // without reaching into somebody else's repo to declare their class cancelled.
  const hostDid = await resolveHostDid(eventUri, current.did)
  if (hostDid !== viewer.did) throw new EventPermissionError()
  const parts = parseAtUri(eventUri)
  if (!parts) throw new EventNotFoundError(eventUri)

  const name = String(current.value.name ?? 'this class')
  const alreadyCancelled = isCancelledStatus(current.value.status)
  const reason = text(input.reason)

  const seriesLink = scope === 'following' ? await resolveSeriesLink(viewer, eventUri, current) : undefined
  if (scope === 'following' && !seriesLink) throw new NotRecurringError()

  const event = await writeCancelledStatus(viewer, current, parts.rkey, `host cancelled "${name}"`, schoolDid)

  // The reason, app-side, merged onto whatever else the class already carries.
  const existingExtra = await getEventExtra(eventUri)
  await setEventExtra(eventUri, { ...existingExtra, ...(reason ? { cancelReason: reason } : {}) })

  const unlisted = (await isListedByUs(eventUri, schoolDid))
    ? await withdrawListing({
        event: { uri: event.uri, cid: event.cid },
        callerDid: viewer.did as Did,
        reason: `host cancelled "${name}"`,
        schoolDid,
      })
    : undefined

  // A class that did not happen is not a class hosted. Only ever debited for a record the
  // host wrote themselves — materialized occurrences never credited the tally in the
  // first place (`jobs/materialize-series.ts` does not call `bumpTally`).
  if (!alreadyCancelled && current.did === viewer.did) await bumpTally(viewer.did, { hostedEvents: -1 }, schoolDid)

  const notified = alreadyCancelled ? 0 : await notifyCancelled(eventUri, name, reason, schoolDid)

  const touched = [event.uri]
  const alsoCancelled: string[] = []
  let exdatesAdded = 0

  if (seriesLink) {
    exdatesAdded = await endSeriesAt(viewer, seriesLink, touched)
    for (const later of await laterOccurrences(seriesLink.seriesUri, seriesLink.cutoff, eventUri)) {
      const row = await getRecordByUri(indexer, 'event', later)
      if (!row) continue
      const laterParts = parseAtUri(later)
      if (!laterParts) continue
      const laterName = String(row.value.name ?? name)
      const wasCancelled = isCancelledStatus(row.value.status)
      const written = await writeCancelledStatus(
        viewer,
        row,
        laterParts.rkey,
        `host cancelled "${laterName}" and everything after it`,
        schoolDid,
      )
      if (await isListedByUs(later, schoolDid)) {
        await withdrawListing({
          event: { uri: written.uri, cid: written.cid },
          callerDid: viewer.did as Did,
          reason: `host cancelled "${laterName}" and everything after it`,
          schoolDid,
        })
      }
      if (!wasCancelled) await notifyCancelled(later, laterName, reason, schoolDid)
      alsoCancelled.push(later)
      touched.push(written.uri)
    }
  }

  await indexer.notify(touched).catch(() => {
    /* the periodic backfill will pick it up */
  })

  return {
    event,
    status: CANCELLED_STATUS,
    scope,
    ...(unlisted !== undefined ? { unlisted } : {}),
    alsoCancelled,
    exdatesAdded,
    notified,
  }
}

interface SeriesLink {
  seriesUri: string
  seriesRkey: string
  series: Record<string, unknown>
  /** Occurrences at or after this instant are the ones "and following" means. */
  cutoff: Date
}

/**
 * Which series does this date belong to, and from when does "and following" start?
 *
 * Two ways in: the date is a materialized occurrence (`fs_series_occurrence` knows its
 * series and its original instant), or the date IS the series' first event (the template
 * the host actually wrote, whose `freeschool.draft.series` sidecar points back at it).
 * The series record always lives in the HOST's own repo — if it does not, this is not a
 * series this viewer can end.
 */
async function resolveSeriesLink(
  viewer: Viewer,
  eventUri: string,
  current: { value: Record<string, unknown> },
): Promise<SeriesLink | undefined> {
  const indexer = await getIndexer()
  const occ = await getDb()
    .select({ seriesUri: seriesOccurrence.seriesUri, originalStartsAt: seriesOccurrence.originalStartsAt })
    .from(seriesOccurrence)
    .where(eq(seriesOccurrence.eventUri, eventUri))
    .limit(1)

  let seriesUri = occ[0]?.seriesUri
  let cutoff = occ[0]?.originalStartsAt
  if (!seriesUri) {
    const own = await sidecarsForEvent<Record<string, unknown>>(indexer, 'series', eventUri, 'firstEvent.uri')
    if (!own[0]) return undefined
    seriesUri = own[0].uri
    cutoff = new Date(String(current.value.startsAt ?? ''))
  }
  if (!cutoff || Number.isNaN(cutoff.getTime())) return undefined
  const parts = parseAtUri(seriesUri)
  if (!parts || parts.did !== viewer.did) return undefined
  const record = await getRecordByUri<Record<string, unknown>>(indexer, 'series', seriesUri)
  if (!record) return undefined
  return { seriesUri, seriesRkey: parts.rkey, series: record.value, cutoff }
}

/**
 * End the series at the cutoff, in the host's own repo. Returns how many instants were
 * added to `exdates`.
 *
 * `until` is the durable stop — `plannedOccurrences` filters on it, so nothing past the
 * cutoff is ever planned again, however far the window later moves. The `exdates` are for
 * everyone else: a consumer that reads only the recurrence rule (and our own expansion,
 * which honours both) sees the same dates removed. `count` is dropped if it was set: RFC
 * 5545 allows one of `until`/`count`, never both.
 */
async function endSeriesAt(viewer: Viewer, link: SeriesLink, touched: string[]): Promise<number> {
  const { plannedOccurrences } = await import('../jobs/materialize-series.js')
  const indexer = await getIndexer()
  const series = link.series as {
    rrule?: string
    exdates?: string[]
    timezone?: string
    materializeAhead?: number
    firstEvent?: { uri: string }
    count?: number
  }
  const existing = new Set((series.exdates ?? []).filter((d): d is string => typeof d === 'string'))
  const before = existing.size

  const firstUri = series.firstEvent?.uri
  const first = firstUri ? await getRecordByUri(indexer, 'event', firstUri) : null
  const dtstart = first ? new Date(String(first.value.startsAt ?? '')) : new Date(Number.NaN)
  if (series.rrule && series.timezone && !Number.isNaN(dtstart.getTime())) {
    try {
      const planned = plannedOccurrences(
        { rrule: series.rrule, timezone: series.timezone, ...(series.exdates ? { exdates: series.exdates } : {}), ...(series.materializeAhead ? { materializeAhead: series.materializeAhead } : {}) },
        dtstart,
      )
      for (const instant of planned) {
        if (instant.getTime() >= link.cutoff.getTime()) existing.add(normalizeInstant(instant.toISOString()))
      }
    } catch (err) {
      // A rule we cannot expand still gets its `until`, which is the binding half.
      log.warn('could not expand the series to add exdates on cancel', { detail: describeError(err) })
    }
  }

  const { count: _dropped, ...carried } = series
  const agent = await actorAgent(viewer)
  const written = await put(agent, viewer.did, NSID.series, link.seriesRkey, {
    ...carried,
    $type: NSID.series,
    until: link.cutoff.toISOString(),
    exdates: [...existing],
  })
  touched.push(written.uri)
  return existing.size - before
}

/** Already-materialized occurrences of this series at or after the cutoff. */
async function laterOccurrences(seriesUri: string, cutoff: Date, exceptUri: string): Promise<string[]> {
  const rows = await getDb()
    .select({ eventUri: seriesOccurrence.eventUri })
    .from(seriesOccurrence)
    .where(and(eq(seriesOccurrence.seriesUri, seriesUri), gte(seriesOccurrence.originalStartsAt, cutoff)))
  return rows.map((r) => r.eventUri).filter((u): u is string => Boolean(u) && u !== exceptUri)
}

async function put(
  agent: Agent,
  repo: string,
  collection: string,
  rkey: string,
  record: unknown,
): Promise<{ uri: string; cid: string }> {
  const res = await agent.com.atproto.repo.putRecord({
    repo,
    collection,
    rkey,
    record: record as Record<string, unknown>,
    // Our sidecar lexicons are not published to the network, so the PDS cannot resolve
    // them; validation would reject every one.
    validate: false,
  })
  return { uri: res.data.uri, cid: res.data.cid }
}

export { put as putInActorRepo }
