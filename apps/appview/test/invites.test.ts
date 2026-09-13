/**
 * Shareable invite links: mint a bearer token (only its hash is stored), redeem it up to
 * `uses`, and never let the inviter's DID leak into the URL or the redeemer's response.
 * Redemption also has to feed `evidenceFor()`'s `invite-or-vouch` gate, so this needs a
 * real Postgres.
 */
process.env.SCHOOL_DID = 'did:plc:school'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { defaultThresholds } from '@freeschool/shared'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { mintInviteLink, MintPermissionError, redeemInviteLink } from '../src/http/routes/invites.js'
import { evidenceFor } from '../src/lib/roles.js'
import { config } from '../src/config.js'
import { custodialAccount, policyCache } from '../src/db/schema.js'

const INVITER = 'did:plc:inviter'
const REDEEMER_A = 'did:plc:redeemera'
const REDEEMER_B = 'did:plc:redeemerb'
// Never given a custodial account: hasProfile=false -> Role.Visitor, regardless of policy.
const VISITOR = 'did:plc:a-bare-visitor'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) {
    console.warn(SKIP_MESSAGE)
    return
  }
  // `mintInviteLink` calls `roleOf`, which calls `getThresholds`, which otherwise fetches
  // did:plc:school's record over HTTP (and logs a warning when that fails, since the DID
  // is not real) — priming the DB-level policy cache directly means it never has to.
  // This file must make no network call and print nothing.
  await testDb()
    .insert(policyCache)
    .values({ schoolDid: 'did:plc:school', thresholds: defaultThresholds, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: policyCache.schoolDid, set: { thresholds: defaultThresholds, fetchedAt: new Date() } })
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_invite_link', 'fs_invite', 'fs_custodial_account')
  // The default open policy derives Host for ANY account with a profile on day one, which
  // is >= Role.Member — giving INVITER (and redeemers who go on to mint themselves) a
  // custodial account is the cheapest way to get a qualifying role without a real PDS.
  await testDb()
    .insert(custodialAccount)
    .values({ did: INVITER, handle: 'inviter.test', email: 'inviter@example.org', keyVersion: 'v1' })
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

describe('the member admission gate cannot be bypassed', () => {
  it('minting requires at least Role.Member — a bare Visitor cannot mint at all', async () => {
    if (!available) return
    await expect(mintInviteLink(VISITOR, {})).rejects.toBeInstanceOf(MintPermissionError)
  })

  it('a Member-or-above account can mint', async () => {
    if (!available) return
    await expect(mintInviteLink(INVITER, {})).resolves.toBeDefined()
  })

  it('refuses self-redemption (409 SelfRedeem) and does not consume the use', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, { uses: 1 })
    const selfAttempt = await redeemInviteLink(minted.token, INVITER)
    expect(selfAttempt.ok).toBe(false)
    expect(selfAttempt.ok === false && selfAttempt.error).toBe('SelfRedeem')
    expect(selfAttempt.ok === false && selfAttempt.status).toBe(409)
    // the use was NOT burned by the rejected self-attempt
    const realRedeemer = await redeemInviteLink(minted.token, REDEEMER_A)
    expect(realRedeemer.ok).toBe(true)
  })

  it('self-redemption never grants invite-or-vouch evidence to the minter', async () => {
    if (!available) return
    const minted = await mintInviteLink(INVITER, {})
    await redeemInviteLink(minted.token, INVITER)
    const evidence = await evidenceFor(INVITER)
    expect(evidence.inviteOrVouch).toBe(false)
  })

  it('an already-admitted redeemer succeeds (the class deep-link case) without consuming a use or writing new evidence', async () => {
    if (!available) return
    // REDEEMER_A is admitted once, legitimately, by INVITER.
    const first = await mintInviteLink(INVITER, {})
    const firstRedeem = await redeemInviteLink(first.token, REDEEMER_A)
    expect(firstRedeem.ok).toBe(true)

    // INVITER now mints a class deep-link and hands it to REDEEMER_A, who is already a
    // member — this must still work (it is how someone already admitted opens the class),
    // just without burning the single use or writing a second piece of evidence.
    const eventUri = 'at://did:plc:host/community.lexicon.calendar.event/xyz'
    const second = await mintInviteLink(INVITER, { eventUri, uses: 1 })
    const secondAttempt = await redeemInviteLink(second.token, REDEEMER_A)
    expect(secondAttempt.ok).toBe(true)
    expect(secondAttempt.ok === true && secondAttempt.eventUri).toBe(eventUri)
    expect(secondAttempt.ok === true && secondAttempt.alreadyMember).toBe(true)

    // the use was NOT consumed: REDEEMER_B, genuinely new, can still redeem it
    const thirdAttempt = await redeemInviteLink(second.token, REDEEMER_B)
    expect(thirdAttempt.ok).toBe(true)
    expect(thirdAttempt.ok === true && thirdAttempt.alreadyMember).toBeUndefined()

    // no duplicate evidence row was written for REDEEMER_A by the already-admitted path
    const { invite } = await import('../src/db/schema.js')
    const { eq } = await import('drizzle-orm')
    const rows = await testDb().select().from(invite).where(eq(invite.usedByDid, REDEEMER_A))
    expect(rows.length).toBe(1)
  })
})
