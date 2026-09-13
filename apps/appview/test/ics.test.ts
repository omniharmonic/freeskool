import { describe, expect, it } from 'vitest'
import { buildIcs, escapeText, fold, icsStatus, utc } from '../src/lib/ics.js'

describe('ics generation', () => {
  it('emits a complete, CRLF-terminated VCALENDAR', () => {
    const out = buildIcs([
      {
        uid: 'at://did:plc:host/community.lexicon.calendar.event/3abc',
        summary: 'Bread baking',
        startsAt: '2026-10-01T18:00:00.000Z',
        endsAt: '2026-10-01T20:00:00.000Z',
        location: 'North Boulder',
        status: 'CONFIRMED',
      },
    ])
    const lines = out.split('\r\n')
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('VERSION:2.0')
    expect(lines).toContain('BEGIN:VEVENT')
    expect(lines).toContain('DTSTART:20261001T180000Z')
    expect(lines).toContain('DTEND:20261001T200000Z')
    expect(lines).toContain('SUMMARY:Bread baking')
    expect(lines).toContain('LOCATION:North Boulder')
    expect(lines).toContain('STATUS:CONFIRMED')
    expect(lines).toContain('END:VEVENT')
    expect(out.endsWith('END:VCALENDAR\r\n')).toBe(true)
    // Every line must end CRLF, including the last.
    expect(out.split('\n').every((l, i, a) => i === a.length - 1 || l.endsWith('\r'))).toBe(true)
  })

  it('is deterministic: no wall clock anywhere', () => {
    const event = { uid: 'u', summary: 's', startsAt: '2026-10-01T18:00:00Z' }
    expect(buildIcs([event])).toBe(buildIcs([event]))
    // DTSTAMP defaults to DTSTART rather than now().
    expect(buildIcs([event])).toContain('DTSTAMP:20261001T180000Z')
  })

  it('escapes text per RFC 5545 3.3.11, backslash first', () => {
    expect(escapeText('a;b,c')).toBe('a\\;b\\,c')
    expect(escapeText('line1\nline2')).toBe('line1\\nline2')
    expect(escapeText('back\\slash')).toBe('back\\\\slash')
    // The order matters: escaping the backslash after the semicolon would double-escape.
    expect(escapeText('x\\;y')).toBe('x\\\\\\;y')
  })

  it('folds long lines at 75 octets with a single-space continuation', () => {
    const long = 'DESCRIPTION:' + 'a'.repeat(200)
    const folded = fold(long)
    expect(folded[0]!.length).toBe(75)
    expect(folded.slice(1).every((l) => l.startsWith(' '))).toBe(true)
    expect(folded.slice(1).every((l) => Buffer.byteLength(l) <= 75)).toBe(true)
    expect(folded.join('').replace(/ /g, '')).toBe(long)
  })

  it('never splits a multi-byte character across a fold', () => {
    // 3-byte chars: a naive 75-byte cut lands mid-sequence.
    const line = 'SUMMARY:' + '漢'.repeat(40)
    const folded = fold(line)
    for (const l of folded) {
      expect(Buffer.byteLength(l)).toBeLessThanOrEqual(75)
      // A mis-split would produce U+FFFD on decode.
      expect(l).not.toContain('�')
    }
    expect(folded.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(line)
  })

  it('carries an RRULE and EXDATEs for a series', () => {
    const out = buildIcs([
      {
        uid: 'u',
        summary: 'Weekly mending circle',
        startsAt: '2026-10-06T23:00:00Z',
        rrule: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;COUNT=8',
        exdates: ['2026-10-27T23:00:00Z'],
      },
    ])
    expect(out).toContain('RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;COUNT=8')
    expect(out).toContain('EXDATE:20261027T230000Z')
  })

  it('maps calendar status tokens to iCalendar STATUS', () => {
    expect(icsStatus('community.lexicon.calendar.event#cancelled')).toBe('CANCELLED')
    expect(icsStatus('community.lexicon.calendar.event#scheduled')).toBe('CONFIRMED')
    expect(icsStatus('community.lexicon.calendar.event#rescheduled')).toBe('CONFIRMED')
    expect(icsStatus('community.lexicon.calendar.event#planned')).toBe('TENTATIVE')
    expect(icsStatus(undefined)).toBeUndefined()
    expect(icsStatus('something.else#weird')).toBeUndefined()
  })

  it('normalizes any offset spelling to UTC', () => {
    expect(utc('2026-10-01T12:00:00-06:00')).toBe('20261001T180000Z')
    expect(() => utc('not a date')).toThrow()
  })
})
