/**
 * THE FIX (R6): `plannedOccurrences` used to hand `rrule` a real UTC instant as
 * `dtstart`, so `BYDAY` matched the UTC calendar weekday — wrong the moment the series'
 * `timezone` has a nonzero offset. The web client's `apps/web/src/lib/recurrence.ts`
 * `effectiveByDay` shifts the weekday it SENDS to compensate for exactly this bug; once
 * this lands, Task 10 removes that shift. Pure — no DB, no PDS.
 */
import { describe, expect, it } from 'vitest'
import { MIN_OCCURRENCES, plannedOccurrences } from '../src/jobs/materialize-series.js'

const WEEKDAY_FMT = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'long' })
const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Denver',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function localWeekday(d: Date): string {
  return WEEKDAY_FMT.format(d)
}

function localTime(d: Date): string {
  return TIME_FMT.format(d)
}

describe('plannedOccurrences — BYDAY expands on wall-clock in the series timezone, not UTC', () => {
  // 2026-09-18T00:00:00.000Z is 2026-09-17 18:00 in America/Denver (MDT, UTC-6): a
  // Thursday. Its UTC calendar day is Friday — the old bug's failure mode.
  const dtstart = new Date('2026-09-18T00:00:00.000Z')
  const now = new Date('2026-09-10T00:00:00.000Z')

  it('anchors on the real local weekday: Thursday, not the UTC-shifted Friday', () => {
    expect(localWeekday(dtstart)).toBe('Thursday')
  })

  it('a weekly BYDAY=TH series yields Thursday-in-Denver occurrences, not Friday', () => {
    const occurrences = plannedOccurrences(
      { rrule: 'FREQ=WEEKLY;BYDAY=TH', timezone: 'America/Denver', materializeAhead: 60 },
      dtstart,
      now,
    )
    expect(occurrences.length).toBeGreaterThanOrEqual(MIN_OCCURRENCES)
    for (const d of occurrences) expect(localWeekday(d)).toBe('Thursday')
  })

  it('every occurrence keeps the same local wall-clock time (18:00) across the run, DST or not', () => {
    const occurrences = plannedOccurrences(
      { rrule: 'FREQ=WEEKLY;BYDAY=TH', timezone: 'America/Denver', materializeAhead: 365 },
      dtstart,
      now,
    )
    // 365 days ahead of Sept 2026 crosses the Nov 2026 DST fall-back — the whole point of
    // forcing local HH:mm:ss rather than holding the UTC instant fixed.
    for (const d of occurrences) expect(localTime(d)).toBe('18:00')
  })

  it('the first occurrence round-trips to exactly the original dtstart instant', () => {
    const occurrences = plannedOccurrences(
      { rrule: 'FREQ=WEEKLY;BYDAY=TH', timezone: 'America/Denver', materializeAhead: 30 },
      dtstart,
      now,
    )
    expect(occurrences[0]?.toISOString()).toBe(dtstart.toISOString())
  })

  it('occurrences land seven real days apart (weekly cadence survives the local-time conversion)', () => {
    const occurrences = plannedOccurrences(
      { rrule: 'FREQ=WEEKLY;BYDAY=TH', timezone: 'America/Denver', materializeAhead: 30 },
      dtstart,
      now,
    )
    for (let i = 1; i < occurrences.length; i++) {
      const deltaDays = (occurrences[i]!.getTime() - occurrences[i - 1]!.getTime()) / 86_400_000
      expect(deltaDays).toBe(7)
    }
  })
})
