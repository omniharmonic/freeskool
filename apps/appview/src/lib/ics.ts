/**
 * RFC 5545 generation, by hand.
 *
 * No library: the output has to be byte-stable for tests (a generated PRODID or a
 * wall-clock DTSTAMP would make it untestable), and the subset we need is small. The
 * one thing worth being careful about is CRLF line folding at 75 octets, which real
 * calendar clients do enforce.
 *
 * A series becomes one VEVENT with an RRULE and EXDATEs; a single event becomes one
 * VEVENT. We never emit attendees — who is coming is app-side (R9).
 */
export interface IcsEvent {
  /** Stable UID. The event's AT-URI is ideal: globally unique and already stable. */
  uid: string
  summary: string
  description?: string
  /** RFC 3339. */
  startsAt?: string
  endsAt?: string
  /** Free text, already coarsened for the viewer by src/http/visibility.ts. */
  location?: string
  url?: string
  /** 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE' */
  status?: string
  /** RRULE value without the `RRULE:` prefix. */
  rrule?: string
  exdates?: string[]
  /** Defaults to `startsAt` so output is deterministic. */
  dtstamp?: string
  sequence?: number
}

const CRLF = '\r\n'

export function buildIcs(events: IcsEvent[], opts: { prodId?: string; calName?: string } = {}): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${opts.prodId ?? '-//Free School//AppView//EN'}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ]
  if (opts.calName) lines.push(`X-WR-CALNAME:${escapeText(opts.calName)}`)
  for (const e of events) lines.push(...vevent(e))
  lines.push('END:VCALENDAR')
  return lines.flatMap(fold).join(CRLF) + CRLF
}

function vevent(e: IcsEvent): string[] {
  const out: string[] = ['BEGIN:VEVENT', `UID:${escapeText(e.uid)}`]
  const stamp = e.dtstamp ?? e.startsAt
  if (stamp) out.push(`DTSTAMP:${utc(stamp)}`)
  if (e.startsAt) out.push(`DTSTART:${utc(e.startsAt)}`)
  if (e.endsAt) out.push(`DTEND:${utc(e.endsAt)}`)
  out.push(`SUMMARY:${escapeText(e.summary)}`)
  if (e.description) out.push(`DESCRIPTION:${escapeText(e.description)}`)
  if (e.location) out.push(`LOCATION:${escapeText(e.location)}`)
  if (e.url) out.push(`URL:${escapeText(e.url)}`)
  if (e.status) out.push(`STATUS:${e.status}`)
  if (e.rrule) out.push(`RRULE:${e.rrule}`)
  if (e.exdates?.length) out.push(`EXDATE:${e.exdates.map(utc).join(',')}`)
  if (typeof e.sequence === 'number') out.push(`SEQUENCE:${e.sequence}`)
  out.push('END:VEVENT')
  return out
}

/** RFC 3339 -> `YYYYMMDDTHHMMSSZ`. */
export function utc(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) throw new Error(`invalid datetime: ${iso}`)
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** RFC 5545 3.3.11 text escaping. Order matters: backslash first. */
export function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * RFC 5545 3.1: content lines are folded at 75 OCTETS (not characters), with a single
 * space continuation. Multi-byte characters must not be split mid-sequence.
 */
export function fold(line: string): string[] {
  const bytes = Buffer.from(line, 'utf8')
  if (bytes.length <= 75) return [line]
  const out: string[] = []
  let start = 0
  let limit = 75
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length)
    // Never split a UTF-8 continuation byte (0b10xxxxxx) from its lead byte.
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
    out.push((out.length ? ' ' : '') + bytes.subarray(start, end).toString('utf8'))
    start = end
    limit = 74 // subsequent lines carry a leading space
  }
  return out
}

/** Derived from a community.lexicon.calendar.event `status` token. */
export function icsStatus(status?: string): string | undefined {
  if (!status) return undefined
  if (status.endsWith('#cancelled')) return 'CANCELLED'
  if (status.endsWith('#planned') || status.endsWith('#postponed')) return 'TENTATIVE'
  if (status.endsWith('#scheduled') || status.endsWith('#rescheduled')) return 'CONFIRMED'
  return undefined
}
