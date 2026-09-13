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
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { schoolActor, schoolDid } from './school-actor.js'
import { getIndexer } from '../index/indexer.js'
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { bumpTally } from './roles.js'
import { openFeedbackWindow } from './feedback.js'
import type { EventConfig } from '../lexicons/coop.js'

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

export async function createEventAsHost(viewer: Viewer, input: CreateEventInput): Promise<CreatedEvent> {
  const agent = await actorAgent(viewer)
  const now = new Date().toISOString()

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

  // Curation, as the school, through the port. Never inline in the host's repo.
  let listing: { uri: string; cid: string } | undefined
  if ((input.visibility ?? 'listed') === 'listed') {
    const res = await schoolActor().putRecordAsSchool({
      schoolDid: schoolDid(),
      callerDid: viewer.did as `did:${string}`,
      scope: NSID.eventListing,
      action: 'publish-event',
      collection: NSID.eventListing,
      rkey: tid(),
      record: {
        $type: NSID.eventListing,
        event: { uri: event.uri, cid: event.cid },
        school: schoolDid(),
        status: 'listed',
        createdAt: now,
      },
      audit: { reason: `host published "${input.name}"` },
    })
    listing = { uri: res.uri, cid: res.cid }
  }

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
