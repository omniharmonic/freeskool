/**
 * `lib/slug.ts` — pure functions, no DB/PDS needed.
 */
import { describe, expect, it } from 'vitest'
import { normalizeLabel, slugify } from '../src/lib/slug.js'

describe('slugify', () => {
  it('lowercases and dashes non-alphanumeric runs', () => {
    expect(slugify('Wood Working & Repair')).toBe('wood-working-repair')
  })

  it('strips diacritics', () => {
    expect(slugify('Café Repair')).toBe('cafe-repair')
  })

  it('trims leading and trailing dashes', () => {
    expect(slugify('  --Bike Repair--  ')).toBe('bike-repair')
  })

  it('caps at 60 characters', () => {
    const slug = slugify('a'.repeat(100))
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug).toBe('a'.repeat(60))
  })

  it('never leaves a trailing dash after truncation', () => {
    // Normalizes to 59 a's + '-b', which truncates at 60 chars to 59 a's + '-'.
    const slug = slugify(`${'a'.repeat(59)} b`)
    expect(slug.endsWith('-')).toBe(false)
    expect(slug).toBe('a'.repeat(59))
  })

  it('is deterministic', () => {
    expect(slugify('Bread Baking')).toBe(slugify('Bread Baking'))
  })
})

describe('normalizeLabel', () => {
  it('is case-insensitive', () => {
    expect(normalizeLabel('Bread Baking')).toBe(normalizeLabel('BREAD BAKING'))
  })

  it('is diacritic-insensitive', () => {
    expect(normalizeLabel('Café Repair')).toBe(normalizeLabel('Cafe Repair'))
  })

  it('collapses internal whitespace but keeps words distinct (unlike slugify)', () => {
    expect(normalizeLabel('Wood   Working')).toBe('wood working')
    expect(normalizeLabel('Wood Working')).not.toBe(normalizeLabel('Woodworking'))
  })

  it('trims leading/trailing whitespace', () => {
    expect(normalizeLabel('  Bike Repair  ')).toBe('bike repair')
  })
})
