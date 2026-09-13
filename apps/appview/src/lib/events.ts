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
import type { Agent } from '@atproto/api'
import type { Did } from '@freeschool/school-actor'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { schoolActor, schoolDid } from './school-actor.js'
import { getIndexer } from '../index/indexer.js'
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { bumpTally } from './roles.js'
import { openFeedbackWindow } from './feedback.js'
import { getRecord } from './pds.js'
import { log } from './logging.js'
import { getRecordByUri, parseAtUri, sidecarsForEvent } from '../index/queries.js'
import { isListed } from '../http/visibility.js'
import type { EventConfig, EventListing } from '../lexicons/coop.js'

export interface CreateEventInput {
  name: string
  description?: string
  startsAt: string
  endsAt?: string
  /** `community.lexicon.calendar.event#inperson` etc. Defaults to in-person. */
  mode?: string
  locations?: unknown[]
  uris?: Array<{ uri: string; name?: string }>
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

export async function schoolRoutingTags(): Promise<string[]> {
  try {
    const school = await getRecord(schoolDid(), NSID.school, 'self')
    const tags = school?.value?.tags
    if (Array.isArray(tags) && tags.length > 0) {
      const strings = tags.filter((t): t is string => typeof t === 'string')
      if (strings.length > 0) return strings
    }
  } catch (err) {
    log.warn('could not read the school record for its routing tags; using defaults', { detail: String(err) })
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
}

/** Writes the school's curation listing, as the school, only when tags + visibility route. */
export async function routeListing(input: RouteListingInput): Promise<{ uri: string; cid: string } | undefined> {
  if ((input.visibility ?? 'listed') !== 'listed') return undefined
  const schoolTags = input.schoolTags ?? (await schoolRoutingTags())
  if (!routesOnTags(input.tags, schoolTags)) return undefined
  const res = await schoolActor().putRecordAsSchool({
    schoolDid: schoolDid(),
    callerDid: input.callerDid,
    scope: NSID.eventListing,
    action: 'publish-event',
    collection: NSID.eventListing,
    rkey: tid(),
    record: {
      $type: NSID.eventListing,
      event: input.event,
      school: schoolDid(),
      status: 'listed',
      tags: input.tags,
      createdAt: new Date().toISOString(),
    },
    audit: { reason: `host published "${input.name}"` },
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

export async function createEventAsHost(viewer: Viewer, input: CreateEventInput): Promise<CreatedEvent> {
  const agent = await actorAgent(viewer)
  const now = new Date().toISOString()
  // No default: an untagged event gets no listing at all (see the doc comment on `tags`
  // above). It still appears on our own calendar by authorship, not by this array.
  const tags = input.tags ?? []

  const eventRkey = tid()
  const event = await put(agent, viewer.did, NSID.event, eventRkey, {
    $type: NSID.event,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    createdAt: now,
    startsAt: input.startsAt,
    ...(input.endsAt ? { endsAt: input.endsAt } : {}),
    mode: input.mode ?? `${NSID.event}#inperson`,
    status: `${NSID.event}#scheduled`,
    ...(input.locations?.length ? { locations: input.locations } : {}),
    ...(input.uris?.length ? { uris: input.uris } : {}),
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
    school: schoolDid(),
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
  })

  await bumpTally(viewer.did, { hostedEvents: 1 })
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
export async function updateEventAsHost(viewer: Viewer, eventUri: string, input: UpdateEventInput): Promise<UpdatedEvent> {
  if (input.series !== undefined) throw new SeriesEditNotSupportedError()

  const indexer = await getIndexer()
  const current = await getRecordByUri(indexer, 'event', eventUri)
  if (!current) throw new EventNotFoundError(eventUri)
  if (current.did !== viewer.did) throw new EventPermissionError()
  const parts = parseAtUri(eventUri)
  if (!parts) throw new EventNotFoundError(eventUri)

  const agent = await actorAgent(viewer)

  const mergedEvent: Record<string, unknown> = {
    ...current.value,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.startsAt !== undefined ? { startsAt: input.startsAt } : {}),
    ...(input.endsAt !== undefined ? { endsAt: input.endsAt } : {}),
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    ...(input.locations !== undefined ? { locations: input.locations } : {}),
    ...(input.uris !== undefined ? { uris: input.uris } : {}),
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
    school: schoolDid(),
    tags: newTags,
    createdAt: existingConfig?.value.createdAt ?? new Date().toISOString(),
  }
  const cfg = await put(agent, viewer.did, NSID.eventConfig, configParts?.rkey ?? tid(), mergedConfig)

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
  const ourListings = listingRows.map((r) => r.value).filter((l) => l.school === schoolDid())
  // "ever listed" (any status, including removed) vs "actively listed right now" are
  // DELIBERATELY different checks — see `decideListingEdit`'s doc comment.
  const everListedByUs = ourListings.length > 0
  const isActivelyListedByUs = isListed({ listings: ourListings, configs: [] })
  const schoolTags = await schoolRoutingTags()
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
    })
  } else if (action === 'remove') {
    try {
      await schoolActor().putRecordAsSchool({
        schoolDid: schoolDid(),
        callerDid: viewer.did as Did,
        scope: NSID.eventListing,
        action: 'remove-listing',
        collection: NSID.eventListing,
        rkey: tid(),
        record: {
          $type: NSID.eventListing,
          event: { uri: event.uri, cid: event.cid },
          school: schoolDid(),
          status: 'removed',
          createdAt: new Date().toISOString(),
        },
        audit: { reason: `host retagged "${String(mergedEvent.name ?? '')}" away from a routed tag` },
      })
      unlisted = true
    } catch (err) {
      // Removing a listing is moderation (Steward-gated). A host who is not a steward
      // cannot unilaterally unlist their own class; it stays listed until one does.
      log.warn('could not auto-remove the school listing on retag; a steward must remove it', { detail: String(err) })
      unlisted = false
    }
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
