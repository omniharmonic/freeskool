/**
 * Calendar visibility. Pure functions, no I/O, so the rules are testable in isolation —
 * `test/calendar-visibility.test.ts` is the specification.
 *
 * Two independent decisions:
 *
 *   1. DOES THIS EVENT APPEAR AT ALL?  Only if it is `listed`: either the school's NEWEST
 *      `coop.lexicon.event.listing` says so, or — with no listing at all — the host's own
 *      `coop.lexicon.event.config` says `visibility: 'listed'`. A school listing of either
 *      status WINS over the host's own config: that is what moderation means, and it is
 *      also what makes `restore-listing` work at all.
 *
 *   2. HOW MUCH OF IT?  For a LISTED class everyone sees what the host's own public
 *      record says — title, time, mode, public description, host — plus a neighborhood.
 *      The precise LOCATION (street address, venue name, coordinates) is only ever sent
 *      to a viewer who is the host, has RSVP'd, has confirmed attendance, or is a
 *      steward, and so — since task 19c — are the host's ATTENDEE NOTES and MEETING LINK,
 *      which are app-side (`lib/event-extra.ts`) precisely so that gate can be honoured.
 *      Someone's living room is not public information just because the class is; a class
 *      description, published by its host into a world-readable repo, already is (see
 *      `publicRecordFields` and `attendeeOnlyFields`).
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

/**
 * THE NEWEST LISTING WINS, by `createdAt`.
 *
 * Listings are append-only — the school never edits or deletes one, it writes another (see
 * `http/routes/admin.ts`'s `remove-listing` / `restore-listing`) — so "is it listed" is a
 * question about the LATEST record, not about whether a `removed` one exists anywhere in
 * the history. The old "any removal wins, forever" rule made `restore-listing`
 * structurally impossible: the removal it was undoing was still sitting there.
 *
 * Ties, including the all-missing-`createdAt` case, resolve to REMOVED. Two listings
 * stamped the same instant is not a state a steward can intend, and between "hidden when we
 * are unsure" and "visible when we are unsure" the privacy-respecting answer is hidden.
 * (Every listing this codebase writes carries a `createdAt`; the tie rule is for records
 * from elsewhere.)
 */
export function isListed({ listings, configs }: ListingInputs): boolean {
  let newest = -Infinity
  let removed = false
  let listed = false
  for (const l of listings) {
    const at = listingTime(l.createdAt)
    if (at > newest) {
      newest = at
      removed = false
      listed = false
    }
    if (at < newest) continue
    if (l.status === 'removed') removed = true
    else listed = true // 'listed', or absent (the lexicon's default reading)
  }
  if (removed) return false
  if (listed) return true
  // No school listing at all: the host's own config is the only voice.
  return configs.some((c) => c.visibility === 'listed')
}

/** An unparseable or absent `createdAt` sorts oldest, so a stamped record always beats it. */
function listingTime(createdAt?: string): number {
  const t = createdAt ? Date.parse(createdAt) : Number.NaN
  return Number.isNaN(t) ? -Infinity : t
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
  /** App-side, attendee-only (task 19c). Never on any record. */
  attendeeNotes?: string
  meetingLink?: string
  hostDid: string
}

/**
 * The fields that are ALREADY PUBLIC in the `community.lexicon.calendar.event` record
 * itself, and so are not ours to withhold from a listed class (interop gap 5).
 *
 * Why this is not a privacy regression: the event lives in the HOST'S OWN REPO and is
 * world-readable over `com.atproto.repo.listRecords` by anyone who knows the PDS — the
 * host published it, deliberately, as a public record. Hiding `description` and `hostDid`
 * from our own API therefore protected nothing (one `listRecords` away) while making
 * every site syndicating our calendar show titles with no descriptions.
 *
 * TASK 19c narrowed what `description` MEANS rather than what we release: the record's
 * `description` is now the host's PUBLIC overview and only that (`lib/events.ts`). The
 * attendee notes and the meeting link that used to sit in `description` / `uris` — under
 * a form that told the host "shown after RSVP" — are app-side (`lib/event-extra.ts`) and
 * are released by `attendeeOnlyFields` below, through the same gate as the address.
 * `uris` therefore left this function: nothing writes them any more, so a record that
 * still has them is a class published before 19c whose host was promised the link was
 * private, and serving it to strangers would break that promise a second time.
 *
 * `locations` is the other exception and stays gated: the street address is the R9 harm —
 * someone's living room is not public information just because the class is — and it is
 * coarsened to a neighborhood rather than omitted. `hostDid` is already inside the
 * event's own AT-URI, so naming it adds no identity the record did not carry.
 *
 * These fields are released only for a class that is actually LISTED. An unlisted,
 * private or moderated-away event tells a stranger nothing beyond what the calendar
 * routes already refuse to show them.
 */
function publicRecordFields(event: CalendarEvent) {
  return {
    hostDid: event.hostDid,
    ...(event.description ? { description: event.description } : {}),
  }
}

/**
 * What the host wrote FOR THE PEOPLE WHO ARE COMING — app-side, and released by exactly
 * the predicate that releases the street address (`seesFullLocation`: host, steward,
 * RSVP'd, attended). `uris` rides here too; see `publicRecordFields`.
 */
export interface AttendeeOnlyFields {
  attendeeNotes?: string
  meetingLink?: string
}

function attendeeOnlyFields(event: CalendarEvent, extra?: AttendeeOnlyFields) {
  return {
    ...(extra?.attendeeNotes ? { attendeeNotes: extra.attendeeNotes } : {}),
    ...(extra?.meetingLink ? { meetingLink: extra.meetingLink } : {}),
    ...(event.uris ? { uris: event.uris } : {}),
  }
}

export function projectEvent(
  event: CalendarEvent,
  inputs: ListingInputs,
  relation: ViewerRelation,
  /** `fs_event_extra` for this class, when the caller has it (the event detail route). */
  extra?: AttendeeOnlyFields,
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
  if (!seesFullLocation(relation)) {
    // Listed and public: the record's own public fields, minus the precise location.
    return isListed(inputs) ? { ...base, ...publicRecordFields(event) } : base
  }
  return {
    ...base,
    locationRedacted: false,
    ...publicRecordFields(event),
    ...attendeeOnlyFields(event, extra),
    ...(event.locations ? { locations: event.locations } : {}),
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
