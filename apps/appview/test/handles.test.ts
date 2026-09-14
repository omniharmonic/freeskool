/**
 * Task 6: pure validation for a member-chosen handle prefix.
 *
 * `isValidChosenHandle` is deliberately pure — no DB, no PDS — so the format/reserved
 * matrix can be checked without a session or a network call. Availability (is it
 * already taken) is a separate, I/O-bound question answered by the HTTP route in
 * `test/me-handle.test.ts`.
 */
process.env.SCHOOL_DOMAIN_SUFFIX ??= 'freeskool.test'
process.env.SCHOOL_LABELS ??= 'boulder'
process.env.SCHOOL_HANDLE ??= 'denver.freeskool.test'

import { describe, expect, it, vi } from 'vitest'

/**
 * `generateHandle` draws from `node:crypto`. The guard under test — "never mint a
 * reserved label" — is unobservable against a 360 000-name space unless the draw is
 * made to land on one, so the queue below feeds fixed indices for the first draws and
 * lets the real generator take over afterwards.
 */
const crypt = vi.hoisted(() => ({ queue: [] as number[] }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomInt: (...args: [number] | [number, number]) =>
      crypt.queue.length > 0 ? crypt.queue.shift()! : (actual.randomInt as (...a: typeof args) => number)(...args),
  }
})

import {
  generateHandle,
  HANDLE_PREFIX_RE,
  isValidChosenHandle,
  normalizeHandlePrefix,
  RESERVED_HANDLE_PREFIXES,
  RESERVED_LABELS,
  reservedLabels,
  schoolLabels,
} from '../src/lib/handles.js'

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

  it('rejects every label a school host could be, including configured school labels', () => {
    for (const reserved of reservedLabels()) {
      expect(isValidChosenHandle(reserved)).toEqual({ ok: false, reason: 'reserved' })
    }
    // The two that only exist because of config, named outright.
    expect(isValidChosenHandle('boulder')).toEqual({ ok: false, reason: 'reserved' })
    expect(isValidChosenHandle('denver')).toEqual({ ok: false, reason: 'reserved' })
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

/**
 * Task 1 (federation): the reserved list is ONE list, shared by the handle generator,
 * the handle chooser and school creation. A name in it can become a school host
 * (`boulder.freeskool.xyz`) — so it must never also be somebody's handle host, and a
 * school must never be created on a label a member already answers for.
 */
describe('RESERVED_LABELS', () => {
  it('carries every label the edge, the app or a city could claim', () => {
    expect([...RESERVED_LABELS].sort()).toEqual(
      [
        'admin', 'api', 'app', 'assets', 'boulder', 'denver', 'help',
        'internal', 'mail', 'pds', 'school', 'skills', 'static', 'www',
      ].sort(),
    )
  })

  it('is the source RESERVED_HANDLE_PREFIXES now reads from', () => {
    for (const prefix of RESERVED_HANDLE_PREFIXES) expect(RESERVED_LABELS).toContain(prefix)
  })
})

describe('schoolLabels', () => {
  it('is SCHOOL_LABELS plus the label of the school this deployment already runs', () => {
    expect([...schoolLabels()].sort()).toEqual(['boulder', 'denver'])
  })

  it('takes nothing from a school handle outside the school domain suffix', () => {
    expect([...schoolLabels({ SCHOOL_LABELS: ['boulder'], SCHOOL_HANDLE: 'boulder.example.org', schoolDomainSuffix: 'freeskool.test' })].sort()).toEqual(['boulder'])
  })

  it('takes nothing from a deeper name under the suffix', () => {
    expect([...schoolLabels({ SCHOOL_LABELS: [], SCHOOL_HANDLE: 'a.b.freeskool.test', schoolDomainSuffix: 'freeskool.test' })]).toEqual([])
  })
})

describe('generateHandle', () => {
  it('mints `<word><word><3 digits>.<domain>`', () => {
    crypt.queue = [0, 0, 417]
    expect(generateHandle('freeskool.test')).toBe('calmotter417.freeskool.test')
  })

  it('draws again rather than mint a reserved label', () => {
    crypt.queue = [0, 0, 417, 1, 1, 418]
    // `calmotter417` is reserved here, so the first draw is thrown away.
    expect(generateHandle('freeskool.test', new Set(['calmotter417']))).toBe('quietmaple418.freeskool.test')
  })

  it('strips a leading dot from the domain', () => {
    crypt.queue = [0, 0, 417]
    expect(generateHandle('.freeskool.test')).toBe('calmotter417.freeskool.test')
  })

  it('never mints a name that isValidChosenHandle would refuse', () => {
    crypt.queue = []
    for (let i = 0; i < 200; i++) {
      const prefix = generateHandle('freeskool.test').split('.')[0]!
      expect(isValidChosenHandle(prefix)).toEqual({ ok: true })
    }
  })
})
