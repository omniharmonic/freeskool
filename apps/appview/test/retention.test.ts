/**
 * A10 extends this suite to every remaining table that holds personal data on a clock:
 * `fs_email_verification` (a spent magic link is a permanent "this account was created and
 * verified at this minute"), `fs_invite_link` (a dead link's `inviter_did` is who invited
 * whom), and `fs_handoff` (a pair of steward DIDs). Each purge is asserted to leave the LIVE
 * row alone — a retention job that deletes a token somebody is about to click is a worse bug
 * than one that keeps it too long.
 *
 * `runRetention` (review round 1, I4): `fs_ownership_reveal` rows are purged once they
 * are USED (the one-time read already happened — the wrapped password blob is already
 * nulled at read time, `lib/custody.ts#revealOwnershipPassword`, so this is metadata
 * cleanup, not a secret-retention line of defense) or EXPIRED-and-never-used. A live,
 * unused, unexpired row — the normal "waiting for the member to open the email" state —
 * must survive.
 *
 * No prior `retention.test.ts` existed in this package (verified by search before
 * writing this); this suite is scoped to the one behavior this review round added, not a
 * retroactive test of every other retention step.
 */
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { runRetention } from '../src/jobs/retention.js'
import { emailVerification, handoff, inviteLink, ownershipReveal } from '../src/db/schema.js'
import { hashToken, wrapSecret } from '../src/lib/crypto.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_ownership_reveal', 'fs_email_verification', 'fs_invite_link', 'fs_handoff')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

function row(tokenSeed: string, overrides: { usedAt?: Date | null; expiresAt: Date }) {
  const wrapped = wrapSecret('irrelevant-for-this-test')
  return {
    tokenHash: hashToken(tokenSeed),
    did: 'did:plc:retention-test',
    keyVersion: wrapped.keyVersion,
    wrappedPassword: wrapped.blob,
    expiresAt: overrides.expiresAt,
    usedAt: overrides.usedAt ?? null,
  }
}

describe('runRetention — fs_ownership_reveal purge', () => {
  it('purges a USED row regardless of its expiry', async () => {
    if (!available) return
    await testDb().insert(ownershipReveal).values(row('used', { usedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }))
    const result = await runRetention()
    expect(result.ownershipRevealsPurged).toBe(1)
    const remaining = await testDb().select().from(ownershipReveal)
    expect(remaining.length).toBe(0)
  })

  it('purges an EXPIRED, never-used row', async () => {
    if (!available) return
    await testDb().insert(ownershipReveal).values(row('expired', { expiresAt: new Date(Date.now() - 1000) }))
    const result = await runRetention()
    expect(result.ownershipRevealsPurged).toBe(1)
  })

  it('does NOT purge a live row: unused and unexpired', async () => {
    if (!available) return
    await testDb().insert(ownershipReveal).values(row('live', { expiresAt: new Date(Date.now() + 86_400_000) }))
    const result = await runRetention()
    expect(result.ownershipRevealsPurged).toBe(0)
    const remaining = await testDb().select().from(ownershipReveal)
    expect(remaining.length).toBe(1)
  })

  it('purges only what qualifies, leaving a live row untouched alongside purged ones', async () => {
    if (!available) return
    await testDb().insert(ownershipReveal).values([
      row('mixed-used', { usedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }),
      row('mixed-expired', { expiresAt: new Date(Date.now() - 1000) }),
      row('mixed-live', { expiresAt: new Date(Date.now() + 86_400_000) }),
    ])
    const result = await runRetention()
    expect(result.ownershipRevealsPurged).toBe(2)
    const remaining = await testDb().select().from(ownershipReveal).where(eq(ownershipReveal.tokenHash, hashToken('mixed-live')))
    expect(remaining.length).toBe(1)
  })
})

const days = (n: number) => new Date(Date.now() - n * 86_400_000)
const soon = () => new Date(Date.now() + 86_400_000)

describe('A10: runRetention — fs_email_verification', () => {
  const verification = (seed: string, over: { usedAt?: Date | null; expiresAt: Date }) => ({
    tokenHash: hashToken(seed),
    did: 'did:plc:retention-verify',
    purpose: 'verify-email',
    expiresAt: over.expiresAt,
    usedAt: over.usedAt ?? null,
  })

  it('purges used and expired tokens, and keeps a live unused one', async () => {
    if (!available) return
    await testDb().insert(emailVerification).values([
      verification('ev-used', { usedAt: new Date(), expiresAt: soon() }),
      verification('ev-expired', { expiresAt: days(2) }),
      verification('ev-live', { expiresAt: soon() }),
    ])
    const result = await runRetention()
    expect(result.emailVerificationsPurged).toBe(2)
    const remaining = await testDb().select().from(emailVerification)
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.tokenHash).toBe(hashToken('ev-live'))
  })

  it('is idempotent', async () => {
    if (!available) return
    await testDb().insert(emailVerification).values(verification('ev-once', { usedAt: new Date(), expiresAt: soon() }))
    expect((await runRetention()).emailVerificationsPurged).toBe(1)
    expect((await runRetention()).emailVerificationsPurged).toBe(0)
  })
})

describe('A10: runRetention — fs_invite_link', () => {
  const link = (id: string, over: { usesLeft?: number; expiresAt: Date }) => ({
    id,
    tokenHash: hashToken(id),
    inviterDid: 'did:plc:retention-inviter',
    schoolDid: 'did:plc:retention-school',
    usesLeft: over.usesLeft ?? 1,
    expiresAt: over.expiresAt,
  })

  it('purges expired and exhausted links — which is what removes inviter_did, a NOT NULL column', async () => {
    if (!available) return
    await testDb().insert(inviteLink).values([
      link('il-expired', { expiresAt: days(1) }),
      link('il-exhausted', { usesLeft: 0, expiresAt: soon() }),
      link('il-live', { usesLeft: 3, expiresAt: soon() }),
    ])
    const result = await runRetention()
    expect(result.inviteLinksPurged).toBe(2)
    const remaining = await testDb().select().from(inviteLink)
    expect(remaining.map((r) => r.id)).toEqual(['il-live'])
    // The whole point: no inviter DID survives a dead link.
    expect(remaining.every((r) => r.id === 'il-live')).toBe(true)
  })
})

describe('A10: runRetention — fs_handoff', () => {
  const handoffRow = (id: string, over: { acceptedAt?: Date | null; expiresAt: Date; createdAt: Date }) => ({
    id,
    fromDid: 'did:plc:retention-from',
    toDid: 'did:plc:retention-to',
    tokenHash: hashToken(id),
    createdAt: over.createdAt,
    acceptedAt: over.acceptedAt ?? null,
    expiresAt: over.expiresAt,
  })

  it('purges accepted and expired rows older than 30 days, and keeps everything newer', async () => {
    if (!available) return
    await testDb().insert(handoff).values([
      handoffRow('h-accepted-old', { acceptedAt: days(40), expiresAt: days(33), createdAt: days(40) }),
      handoffRow('h-expired-old', { expiresAt: days(33), createdAt: days(40) }),
      // Settled, but recent: a steward may still be asking what happened.
      handoffRow('h-accepted-recent', { acceptedAt: days(2), expiresAt: soon(), createdAt: days(2) }),
      // Old row, but the link is still live and unused — must not be deleted from under it.
      handoffRow('h-live-old', { expiresAt: soon(), createdAt: days(40) }),
    ])
    const result = await runRetention()
    expect(result.handoffsPurged).toBe(2)
    const remaining = await testDb().select().from(handoff)
    expect(remaining.map((r) => r.id).sort()).toEqual(['h-accepted-recent', 'h-live-old'])
  })
})
