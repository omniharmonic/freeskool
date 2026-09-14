/**
 * Task 6: pure validation for a member-chosen handle prefix.
 *
 * `isValidChosenHandle` is deliberately pure — no DB, no PDS — so the format/reserved
 * matrix can be checked without a session or a network call. Availability (is it
 * already taken) is a separate, I/O-bound question answered by the HTTP route in
 * `test/me-handle.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import { HANDLE_PREFIX_RE, isValidChosenHandle, normalizeHandlePrefix, RESERVED_HANDLE_PREFIXES } from '../src/lib/handles.js'

describe('HANDLE_PREFIX_RE', () => {
  it('matches the brief\'s exact pattern', () => {
    expect(HANDLE_PREFIX_RE.source).toBe('^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$')
  })
})

describe('isValidChosenHandle', () => {
  it('rejects an empty (too short) prefix as invalid', () => {
    expect(isValidChosenHandle('')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects uppercase as invalid', () => {
    expect(isValidChosenHandle('CalmOtter')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a leading dash as invalid', () => {
    expect(isValidChosenHandle('-calmotter')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a trailing dash as invalid', () => {
    expect(isValidChosenHandle('calmotter-')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a character outside [a-z0-9-] as invalid', () => {
    expect(isValidChosenHandle('calm_otter')).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects a prefix over 20 characters as invalid', () => {
    expect(isValidChosenHandle('a'.repeat(21))).toEqual({ ok: false, reason: 'invalid' })
  })

  it('rejects every reserved prefix', () => {
    for (const reserved of RESERVED_HANDLE_PREFIXES) {
      expect(isValidChosenHandle(reserved)).toEqual({ ok: false, reason: 'reserved' })
    }
  })

  it('accepts a well-formed, non-reserved prefix', () => {
    expect(isValidChosenHandle('calmotter417')).toEqual({ ok: true })
  })

  it('accepts the minimum length (single character)', () => {
    expect(isValidChosenHandle('a')).toEqual({ ok: true })
  })

  it('accepts internal dashes', () => {
    expect(isValidChosenHandle('calm-otter')).toEqual({ ok: true })
  })
})

describe('normalizeHandlePrefix', () => {
  // Review round 1 (should-fix): the pure validator stays strict about case — a route
  // is expected to normalize BEFORE calling it (see `routes/me.ts`'s `handle/check` and
  // `PUT /handle`), so a phone's auto-capitalized first letter never reads as invalid.
  it('lowercases, so what would otherwise be "invalid" to isValidChosenHandle becomes valid once normalized', () => {
    expect(isValidChosenHandle('CalmOtter')).toEqual({ ok: false, reason: 'invalid' })
    expect(normalizeHandlePrefix('CalmOtter')).toBe('calmotter')
    expect(isValidChosenHandle(normalizeHandlePrefix('CalmOtter'))).toEqual({ ok: true })
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeHandlePrefix('  calmotter  ')).toBe('calmotter')
  })

  it('is a no-op on an already-normalized prefix', () => {
    expect(normalizeHandlePrefix('calmotter417')).toBe('calmotter417')
  })
})
