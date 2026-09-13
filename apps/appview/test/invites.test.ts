/**
 * Shareable invite links: mint a bearer token (only its hash is stored), redeem it up to
 * `uses`, and never let the inviter's DID leak into the URL or the redeemer's response.
 * Redemption also has to feed `evidenceFor()`'s `invite-or-vouch` gate, so this needs a
 * real Postgres.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { mintInviteLink, redeemInviteLink } from '../src/http/routes/invites.js'
import { evidenceFor } from '../src/lib/roles.js'
import { config } from '../src/config.js'

const INVITER = 'did:plc:inviter'
const REDEEMER_A = 'did:plc:redeemera'
const REDEEMER_B = 'did:plc:redeemerb'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) {
    console.warn(SKIP_MESSAGE)
    return
  }
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_invite_link', 'fs_invite')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('minting', () => {
  it('returns a URL and token without the inviter DID anywhere in them', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, {})
    expect(minted.url.startsWith(config().webPublicUrl)).toBe(true)
    expect(minted.url).toContain(minted.token)
    expect(minted.url).not.toContain(INVITER)
    expect(minted.token).not.toContain(INVITER)
    expect(new Date(minted.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('defaults to a single use', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, {})
    const first = await redeemInviteLink(minted.token, REDEEMER_A)
    expect(first.ok).toBe(true)
    const second = await redeemInviteLink(minted.token, REDEEMER_B)
    expect(second.ok).toBe(false)
    expect(second.ok === false && second.status).toBe(410)
  })

  it('honors an explicit uses count', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, { uses: 2 })
    expect((await redeemInviteLink(minted.token, REDEEMER_A)).ok).toBe(true)
    expect((await redeemInviteLink(minted.token, REDEEMER_B)).ok).toBe(true)
    const third = await redeemInviteLink(minted.token, 'did:plc:redeemerc')
    expect(third.ok).toBe(false)
  })

  it('carries the event through to redemption', async () => {
    if (!available) return
    const eventUri = 'at://did:plc:host/community.lexicon.calendar.event/abc'
    const minted = await mintInviteLink(INVITER, { eventUri })
    const res = await redeemInviteLink(minted.token, REDEEMER_A)
    expect(res.ok === true && res.eventUri).toBe(eventUri)
  })
})

describe('redeeming', () => {
  it('an unknown token is refused', async () => {
    if (!available) return
    const res = await redeemInviteLink('not-a-real-token', REDEEMER_A)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.status).toBe(404)
  })

  it('an expired link is refused with 410, even with uses left', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, { ttlDays: 1 })
    // simulate expiry by minting, then mutating the row directly
    const { inviteLink } = await import('../src/db/schema.js')
    await testDb().update(inviteLink).set({ expiresAt: new Date(Date.now() - 1000) })
    const res = await redeemInviteLink(minted.token, REDEEMER_A)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.status).toBe(410)
  })

  it('never returns the inviter DID to the redeemer', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, {})
    const res = await redeemInviteLink(minted.token, REDEEMER_A)
    expect(JSON.stringify(res)).not.toContain(INVITER)
  })

  it('writes fs_invite evidence so the redeemer satisfies invite-or-vouch', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, {})
    await redeemInviteLink(minted.token, REDEEMER_A)
    const evidence = await evidenceFor(REDEEMER_A)
    expect(evidence.inviteOrVouch).toBe(true)
  })
})
