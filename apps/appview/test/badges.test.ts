/**
 * Badge sentences are derived ONLY from counts and role — plain language, no averages,
 * no decimals, no percentages (R9-adjacent: a derived role that cannot be explained to
 * the person it applies to is indistinguishable from an arbitrary one). Pure function,
 * no DB.
 */
import { describe, expect, it } from 'vitest'
import { badgeSentences } from '../src/lib/badges.js'

describe('badgeSentences', () => {
  it('says nothing when there is nothing to say', () => {
    expect(badgeSentences({ hosted: 0, attended: 0 }, [])).toEqual([])
  })

  it('states hosted and attended counts in plain language', () => {
    const out = badgeSentences({ hosted: 3, attended: 7 }, [])
    expect(out).toContain('Hosted 3 classes')
    expect(out).toContain('Came to 7 classes')
  })

  it('singularizes a count of exactly one', () => {
    const out = badgeSentences({ hosted: 1, attended: 1 }, [])
    expect(out).toContain('Hosted 1 class')
    expect(out).toContain('Came to 1 class')
  })

  it('states a per-skill vouch count by name, singularizing "person"', () => {
    const out = badgeSentences({ hosted: 0, attended: 0 }, [{ label: 'bike repair', count: 2 }, { label: 'sourdough', count: 1 }])
    expect(out).toContain('Vouched for bike repair by 2 people')
    expect(out).toContain('Vouched for sourdough by 1 person')
  })

  it('never contains a decimal point or a percent sign', () => {
    const out = badgeSentences({ hosted: 3, attended: 7 }, [{ label: 'bike repair', count: 2 }])
    for (const sentence of out) {
      expect(sentence).not.toMatch(/\d+\.\d/)
      expect(sentence).not.toContain('%')
    }
  })
})
