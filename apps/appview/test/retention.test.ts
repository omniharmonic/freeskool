/**
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
import { ownershipReveal } from '../src/db/schema.js'
import { hashToken, wrapSecret } from '../src/lib/crypto.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_ownership_reveal')
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
