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
