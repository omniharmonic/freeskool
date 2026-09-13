/**
 * `renderHowItWorks` is pure (no DB, no network) — this is what `GET
 * /api/school/how-it-works` actually renders, given a school record and the current
 * policy thresholds. The one thing worth pinning down: the sections change when the
 * thresholds do, so a steward who tightens or loosens a rule sees the page change too.
 */
import { describe, expect, it } from 'vitest'
import { defaultThresholds } from '@freeschool/shared'
import { renderHowItWorks } from '../src/lib/how-it-works.js'

function section(body: ReturnType<typeof renderHowItWorks>, heading: string) {
  return body.sections.find((s) => s.heading === heading)
}

describe('renderHowItWorks', () => {
  it('uses the school name and region when a school record exists', () => {
    const out = renderHowItWorks({ name: 'Free School Boulder', region: 'Boulder, CO' }, defaultThresholds)
    expect(out.title).toContain('Free School Boulder')
    expect(out.school).toEqual({ name: 'Free School Boulder', region: 'Boulder, CO' })
    expect(out.printable).toBe(true)
  })

  it('falls back to a generic name when there is no school record', () => {
    const out = renderHowItWorks(null, defaultThresholds)
    expect(out.school.name).toBe('Free School')
  })

  it('says hosting is open from day one when hostMinAttended is 0', () => {
    const out = renderHowItWorks(null, { ...defaultThresholds, hostMinAttended: 0 })
    expect(section(out, 'How to post a class')?.body).toMatch(/open to everyone from day one/)
  })

  it('names the actual attendance threshold when hosting is gated', () => {
    const out = renderHowItWorks(null, { ...defaultThresholds, hostMinAttended: 3 })
    expect(section(out, 'How to post a class')?.body).toContain('3 confirmed attendances')
    expect(section(out, 'Who can host')?.body).toContain('3 confirmed attendances')
  })

  it('reflects the facilitator threshold', () => {
    const out = renderHowItWorks(null, { ...defaultThresholds, facilitatorMinHosted: 7 })
    expect(section(out, 'Who can host')?.body).toContain('7 hosted classes')
  })

  it('reflects the member admission gate text', () => {
    const invite = renderHowItWorks(null, { ...defaultThresholds, memberRequires: 'invite-or-vouch' })
    expect(section(invite, 'Who can host')?.body).toMatch(/invite, or a vouch/)
    const attended = renderHowItWorks(null, { ...defaultThresholds, memberRequires: 'attended-one' })
    expect(section(attended, 'Who can host')?.body).toMatch(/attending at least one class/)
  })

  it('reflects feedbackK in the feedback section', () => {
    const out = renderHowItWorks(null, { ...defaultThresholds, feedbackK: 5 })
    expect(section(out, 'How feedback works')?.body).toContain('5 people')
  })

  it('reflects destructiveActionStewards in the moderation section', () => {
    const out = renderHowItWorks(null, { ...defaultThresholds, destructiveActionStewards: 3 })
    expect(section(out, 'How moderation works')?.body).toContain('3 stewards')
  })

  it('points at the steward hand-off flow and open source when the school goes quiet', () => {
    const out = renderHowItWorks(null, defaultThresholds)
    const body = section(out, 'If this school goes quiet')?.body ?? ''
    expect(body).toMatch(/hand-off/)
    expect(body).toMatch(/open source/)
  })

  it('uses the given lastUpdated, falling back to the school record, then to the epoch', () => {
    const withPolicyDate = renderHowItWorks({ name: 'X', createdAt: '2020-01-01T00:00:00Z' }, defaultThresholds, '2026-05-01T00:00:00Z')
    expect(withPolicyDate.lastUpdated).toBe('2026-05-01T00:00:00Z')
    const withSchoolDateOnly = renderHowItWorks({ name: 'X', createdAt: '2020-01-01T00:00:00Z' }, defaultThresholds, null)
    expect(withSchoolDateOnly.lastUpdated).toBe('2020-01-01T00:00:00Z')
    const withNeither = renderHowItWorks(null, defaultThresholds)
    expect(withNeither.lastUpdated).toBe(new Date(0).toISOString())
  })

  it('covers every required topic from the brief', () => {
    const out = renderHowItWorks({ name: 'X' }, defaultThresholds)
    const headings = out.sections.map((s) => s.heading)
    expect(headings).toEqual(
      expect.arrayContaining([
        'What this is',
        'How to post a class',
        'How to post a request',
        'Who can host',
        'How feedback works',
        'How moderation works',
        'If this school goes quiet',
      ]),
    )
  })
})
