/**
 * Reminder due-window logic. Pure, and the most subtle arithmetic in the codebase: a
 * minutely cron that misses ticks must still send exactly one reminder.
 */
import { describe, expect, it } from 'vitest'
import { CATCH_UP_MS, isDigestDue, isReminderDue, LEAD_MS } from '../src/jobs/reminders.js'

const at = (iso: string) => new Date(iso)

describe('isReminderDue', () => {
  const starts = at('2026-10-02T18:00:00Z')

  it('fires exactly on the target instant', () => {
    expect(isReminderDue(starts, '24h', at('2026-10-01T18:00:00Z'))).toBe(true)
    expect(isReminderDue(starts, '1h', at('2026-10-02T17:00:00Z'))).toBe(true)
  })

  it('does not fire before the target', () => {
    expect(isReminderDue(starts, '24h', at('2026-10-01T17:59:00Z'))).toBe(false)
    expect(isReminderDue(starts, '1h', at('2026-10-02T16:55:00Z'))).toBe(false)
  })

  it('still fires after a missed tick, anywhere in the catch-up window', () => {
    expect(isReminderDue(starts, '24h', at('2026-10-01T18:05:00Z'))).toBe(true)
    expect(isReminderDue(starts, '24h', at('2026-10-01T18:29:59Z'))).toBe(true)
    expect(isReminderDue(starts, '24h', at('2026-10-01T18:30:00Z'))).toBe(false)
  })

  it('gives up once the catch-up window has passed, rather than sending a stale reminder', () => {
    expect(isReminderDue(starts, '24h', at('2026-10-01T18:30:01Z'))).toBe(false)
    expect(isReminderDue(starts, '24h', at('2026-10-01T19:30:00Z'))).toBe(false)
  })

  it('never reminds about an event that has already started', () => {
    expect(isReminderDue(starts, '1h', at('2026-10-02T18:00:00Z'))).toBe(false)
    expect(isReminderDue(starts, '1h', at('2026-10-02T18:30:00Z'))).toBe(false)
  })

  it('the due window is exactly [target, target + catch-up)', () => {
    const target = new Date(starts.getTime() - LEAD_MS['1h'])
    expect(isReminderDue(starts, '1h', target)).toBe(true)
    expect(isReminderDue(starts, '1h', new Date(target.getTime() - 1))).toBe(false)
    const lastDue = new Date(target.getTime() + CATCH_UP_MS - 1)
    expect(isReminderDue(starts, '1h', lastDue)).toBe(true)
    // Closed at the start, open at the end, so two adjacent windows can never both match.
    expect(isReminderDue(starts, '1h', new Date(target.getTime() + CATCH_UP_MS))).toBe(false)
  })

  it('the 1h window and the 24h window never both fire on the same tick', () => {
    // 23h apart > the 30-minute catch-up, so overlap is impossible by construction.
    expect(LEAD_MS['24h'] - LEAD_MS['1h']).toBeGreaterThan(CATCH_UP_MS)
  })

  it('matches on a bounded number of minutely ticks across a whole day, never all of them', () => {
    let twentyFour = 0
    let oneHour = 0
    for (let t = at('2026-10-01T00:00:00Z').getTime(); t <= starts.getTime(); t += 60_000) {
      if (isReminderDue(starts, '24h', new Date(t))) twentyFour++
      if (isReminderDue(starts, '1h', new Date(t))) oneHour++
    }
    // Within one catch-up window a minutely tick matches repeatedly; the DEDUP LEDGER, not
    // the window, is what makes it send once. This test pins that the window is BOUNDED:
    // exactly 30 minutely ticks, never the whole day.
    expect(twentyFour).toBe(CATCH_UP_MS / 60_000)
    expect(oneHour).toBe(CATCH_UP_MS / 60_000)
  })
})

describe('isDigestDue', () => {
  it('fires in the catch-up window after the digest hour', () => {
    expect(isDigestDue(at('2026-10-02T08:00:00Z'))).toBe(true)
    expect(isDigestDue(at('2026-10-02T08:20:00Z'))).toBe(true)
  })

  it('does not fire before the digest hour or long after', () => {
    expect(isDigestDue(at('2026-10-02T07:59:00Z'))).toBe(false)
    expect(isDigestDue(at('2026-10-02T09:00:00Z'))).toBe(false)
    expect(isDigestDue(at('2026-10-02T23:00:00Z'))).toBe(false)
  })

  it('honours a configured digest hour', () => {
    expect(isDigestDue(at('2026-10-02T14:05:00Z'), 14)).toBe(true)
    expect(isDigestDue(at('2026-10-02T08:05:00Z'), 14)).toBe(false)
  })
})
