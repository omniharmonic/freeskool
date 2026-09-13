import { describe, it, expect } from 'vitest'
import { aggregateFeedback, type FeedbackRow } from '../src/feedback.js'

const row = (direction: 'positive' | 'negative', aspects?: Partial<Record<'knowledge'|'teaching'|'experience', number>>, author = 'did:plc:a'): FeedbackRow => ({ author, direction, aspects, text: undefined })

describe('aggregateFeedback — k-anonymity', () => {
  it('releases nothing below k', () => {
    const out = aggregateFeedback([row('positive'), row('negative', {}, 'did:plc:b')], 3)
    expect(out.released).toBe(false)
    expect(out.count).toBe(2)
    expect(out.positive).toBeUndefined()
  })
  it('counts distinct authors, not rows, toward k', () => {
    const out = aggregateFeedback([row('positive'), row('positive'), row('positive')], 3)
    expect(out.released).toBe(false)
  })
  it('releases counts and aspect means at k', () => {
    const out = aggregateFeedback([
      row('positive', { knowledge: 3, teaching: 2 }, 'did:plc:a'),
      row('positive', { knowledge: 3 }, 'did:plc:b'),
      row('negative', { knowledge: 1, teaching: 1 }, 'did:plc:c'),
    ], 3)
    expect(out.released).toBe(true)
    expect(out.positive).toBe(2)
    expect(out.negative).toBe(1)
    expect(out.aspects?.knowledge).toEqual({ mean: 2.33, n: 3 })
    expect(out.aspects?.teaching).toEqual({ mean: 1.5, n: 2 })
    expect(out.aspects?.experience).toBeUndefined()
  })
  it('never releases free text or authorship', () => {
    const out = aggregateFeedback([
      { author: 'did:plc:a', direction: 'positive', text: 'secret' },
      { author: 'did:plc:b', direction: 'positive', text: 'secret' },
      { author: 'did:plc:c', direction: 'positive', text: 'secret' },
    ], 3)
    expect(JSON.stringify(out)).not.toContain('secret')
    expect(JSON.stringify(out)).not.toContain('did:plc')
  })
})
