/**
 * Calendar visibility. Pure functions, no I/O, so the rules are testable in isolation —
 * `test/calendar-visibility.test.ts` is the specification.
 *
 * Two independent decisions:
 *
 *   1. DOES THIS EVENT APPEAR AT ALL?  Only if it is `listed`: either the school wrote a
 *      `coop.lexicon.event.listing` with status != 'removed', or the host's own
 *      `coop.lexicon.event.config` says `visibility: 'listed'`. A removal by the school
 *      WINS over the host's own config — that is what moderation means.
 *
 *   2. HOW MUCH OF IT?  Everyone sees title / time / neighborhood. The full location —
 *      street address, venue name, coordinates, join URL — is only ever sent to a viewer
 *      who is the host, has RSVP'd, has confirmed attendance, or is a steward. Someone's
 *      living room is not public information just because the class is.
 */
import type { EventConfig, EventListing } from '../lexicons/coop.js'

export type ViewerRelation = 'public' | 'rsvp' | 'attendee' | 'host' | 'steward'

/** Relations that unlock the precise location. */
const TRUSTED: ReadonlySet<ViewerRelation> = new Set<ViewerRelation>(['rsvp', 'attendee', 'host', 'steward'])

export function seesFullLocation(relation: ViewerRelation): boolean {
  return TRUSTED.has(relation)
}

export interface CalendarEvent {
  uri: string
  hostDid: string
  name?: string
  description?: string
  startsAt?: string
  endsAt?: string
  mode?: string
  status?: string
  locations?: unknown[]
  uris?: Array<{ uri: string; name?: string }>
}

export interface ListingInputs {
  listings: EventListing[]
  configs: EventConfig[]
}

export function isListed({ listings, configs }: ListingInputs): boolean {
  // A school removal is final, regardless of what the host's config claims.
  if (listings.some((l) => l.status === 'removed')) return false
  if (listings.some((l) => l.status === undefined || l.status === 'listed')) return true
  return configs.some((c) => c.visibility === 'listed')
}

export interface CalendarInclusion {
  show: boolean
  origin: 'ours' | 'listed'
}

/**
 * Does this event belong on OUR calendar (and zine), and under what origin? The
 * inclusion rule is AUTHORSHIP, not the listing: an event whose host belongs to this
 * school (`isOwnHost`, from `lib/roles.ts#isOwnMember`) is `'ours'` and is shown or
 * hidden by the ordinary `isListed` rule (moderation removal and the host's own
 * visibility choice both still apply, exactly as before). An event hosted elsewhere is
 * shown ONLY if our own school has a live curation listing for it — `'listed'`, the
 * peer-routing case. `coop.lexicon.event.listing` is for routing content TO PEERS; it is
 * never required for OUR OWN content to appear on OUR OWN calendar.
 */
export function calendarInclusion(isOwnHost: boolean, inputs: ListingInputs): CalendarInclusion {
  if (isOwnHost) {
    return { show: isListed(inputs), origin: 'ours' }
  }
  // Ignore the config fallback for a host that is not ours — a foreign host's own
  // `visibility: 'listed'` flag grants nothing on OUR calendar; only OUR curation does.
  return { show: isListed({ listings: inputs.listings, configs: [] }), origin: 'listed' }
}

/** Union of every config sidecar's declared tags, deduped, lowercase. Never the event's author. */
export function tagsOf({ configs, listings }: ListingInputs): string[] {
  const out = new Set<string>()
  for (const c of configs) for (const t of c.tags ?? []) out.add(t.toLowerCase())
  for (const l of listings) for (const t of l.tags ?? []) out.add(t.toLowerCase())
  return [...out]
}

/** True when nobody has offered a place for this class to happen yet. */
export function isVenueNeeded(event: CalendarEvent, inputs: ListingInputs): boolean {
  const hasLocations = Array.isArray(event.locations) && event.locations.length > 0
  return !hasLocations && !neighborhoodOf(inputs, event)
}

export function neighborhoodOf({ configs }: ListingInputs, event: CalendarEvent): string | undefined {
  const fromConfig = configs.find((c) => c.neighborhood)?.neighborhood
  if (fromConfig) return fromConfig
  // Fall back to the COARSEST part of the address we have. Never the street.
  for (const loc of event.locations ?? []) {
    const l = loc as Record<string, unknown>
    const locality = pick(l, 'locality')
    const region = pick(l, 'region')
    if (locality) return region ? `${locality}, ${region}` : locality
    if (region) return region
  }
  return undefined
}

export interface PublicCalendarEntry {
  uri: string
  name: string
  startsAt?: string
  endsAt?: string
  mode?: string
  status?: string
  neighborhood?: string
  /** True when the viewer is being shown a coarsened location. */
  locationRedacted: boolean
  /** True when the host has no address and no neighborhood at all — nobody has a room yet. */
  venueNeeded: boolean
  /** Lowercase kebab tags this class carries. Never includes who added them. */
  tags: string[]
}

export interface FullCalendarEntry extends PublicCalendarEntry {
  description?: string
  locations?: unknown[]
  uris?: Array<{ uri: string; name?: string }>
  hostDid: string
}

export function projectEvent(
  event: CalendarEvent,
  inputs: ListingInputs,
  relation: ViewerRelation,
): PublicCalendarEntry | FullCalendarEntry {
  const base: PublicCalendarEntry = {
    uri: event.uri,
    name: event.name ?? 'Untitled',
    ...(event.startsAt ? { startsAt: event.startsAt } : {}),
    ...(event.endsAt ? { endsAt: event.endsAt } : {}),
    ...(event.mode ? { mode: event.mode } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(() => {
      const n = neighborhoodOf(inputs, event)
      return n ? { neighborhood: n } : {}
    })(),
    locationRedacted: !seesFullLocation(relation),
    venueNeeded: isVenueNeeded(event, inputs),
    tags: tagsOf(inputs),
  }
  if (!seesFullLocation(relation)) return base
  return {
    ...base,
    locationRedacted: false,
    hostDid: event.hostDid,
    ...(event.description ? { description: event.description } : {}),
    ...(event.locations ? { locations: event.locations } : {}),
    ...(event.uris ? { uris: event.uris } : {}),
  }
}

/** What goes into the `.ics` LOCATION line for this viewer. */
export function icsLocation(
  event: CalendarEvent,
  inputs: ListingInputs,
  relation: ViewerRelation,
): string | undefined {
  if (!seesFullLocation(relation)) return neighborhoodOf(inputs, event)
  const parts: string[] = []
  for (const loc of event.locations ?? []) {
    const l = loc as Record<string, unknown>
    const line = [pick(l, 'name'), pick(l, 'street'), pick(l, 'locality'), pick(l, 'region'), pick(l, 'postalCode')]
      .filter(Boolean)
      .join(', ')
    if (line) parts.push(line)
    else if (pick(l, 'uri')) parts.push(pick(l, 'uri')!)
  }
  return parts.length ? parts.join(' / ') : neighborhoodOf(inputs, event)
}

function pick(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
