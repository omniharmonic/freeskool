/**
 * "I'm interested" on a needs-board request: an app-side toggle (R9 — no roster), and
 * the count a request's own `threshold` is checked against before a host may claim it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'
import { countInterested, meetsThreshold, toggleInterest } from '../src/lib/request-rsvp.js'

const REQUEST = 'at://did:plc:asker/freeschool.draft.request/abc'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_request_rsvp')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('toggleInterest', () => {
  it('records interest, then toggling again withdraws it', async () => {
    if (!available) return
    const first = await toggleInterest(REQUEST, 'did:plc:a')
    expect(first).toEqual({ interested: true, count: 1 })
    const second = await toggleInterest(REQUEST, 'did:plc:a')
    expect(second).toEqual({ interested: false, count: 0 })
  })

  it('counts distinct interested members, not toggle events', async () => {
    if (!available) return
    await toggleInterest(REQUEST, 'did:plc:a')
    await toggleInterest(REQUEST, 'did:plc:b')
    expect(await countInterested(REQUEST)).toBe(2)
    await toggleInterest(REQUEST, 'did:plc:a')
    expect(await countInterested(REQUEST)).toBe(1)
  })

  it('never leaks who is interested — only a count is ever returned', async () => {
    if (!available) return
    const res = await toggleInterest(REQUEST, 'did:plc:a')
    expect(JSON.stringify(res)).not.toContain('did:')
  })
})

describe('meetsThreshold', () => {
  it('a request with no threshold is always claimable', () => {
    expect(meetsThreshold(0, undefined)).toBe(true)
  })

  it('refuses a claim below the threshold', () => {
    expect(meetsThreshold(2, 5)).toBe(false)
  })

  it('allows a claim at or above the threshold', () => {
    expect(meetsThreshold(5, 5)).toBe(true)
    expect(meetsThreshold(6, 5)).toBe(true)
  })
})
