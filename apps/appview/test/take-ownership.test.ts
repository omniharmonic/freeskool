/**
 * `takeOwnership` — the exit from custody. Unlike most suites in this package, this one
 * needs a REAL local PDS as well as a real Postgres: step 2 is a genuine
 * `com.atproto.admin.updateAccountPassword` call, and the only way to prove "we never
 * learn or keep the final password" is to show that the password the member was shown
 * ACTUALLY WORKS against the PDS (`com.atproto.server.createSession`) — a faked PDS
 * response would prove nothing about the one part of this flow that is genuinely new.
 *
 * Skips gracefully (never fails) when either the PDS or Postgres is unreachable, same
 * policy as every other live-infra suite in this package.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'take-ownership-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'take-ownership-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'
if (!process.env.PDS_ADMIN_PASSWORD) {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const envFile = path.resolve(here, '../../../infra/pds.env')
    const text = fs.readFileSync(envFile, 'utf8')
    const match = /^PDS_ADMIN_PASSWORD=(.+)$/m.exec(text)
    if (match) process.env.PDS_ADMIN_PASSWORD = match[1]!.trim()
  } catch {
    /* left unset; the PDS-reachability probe below will skip the suite */
  }
}

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { revealOwnershipPassword, signup, takeOwnership } from '../src/lib/custody.js'
import { agentForAppPassword } from '../src/lib/pds.js'
import { custodialAccount, ownershipReveal } from '../src/db/schema.js'
import { config, resetConfig } from '../src/config.js'

const REAL_PDS_ADMIN_PASSWORD = process.env.PDS_ADMIN_PASSWORD

let dbOk = false
let pdsOk = false

async function pdsReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config().PDS_URL}/xrpc/_health`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

beforeAll(async () => {
  dbOk = await pgAvailable()
  if (!dbOk) console.warn(SKIP_MESSAGE)
  pdsOk = dbOk && Boolean(process.env.PDS_ADMIN_PASSWORD) && (await pdsReachable())
  if (dbOk && !pdsOk) console.warn('the local PDS is unreachable — skipping take-ownership.test.ts')
})

beforeEach(async () => {
  if (!dbOk) return
  await truncate('fs_ownership_reveal', 'fs_custodial_account', 'fs_email_verification', 'fs_invite')
})

afterAll(async () => {
  if (dbOk) await closeTestDb()
})

function tokenFromRevealUrl(url: string): string {
  return decodeURIComponent(url.split('/take-ownership/')[1]!)
}

async function makeCustodialAccount(suffix: string) {
  const res = await signup({ email: `take-ownership-${suffix}@example.org` })
  return res
}

describe('takeOwnership', () => {
  it('rotates the PDS password, flips isCustodial off, and clears the stored credential', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}`)
    const result = await takeOwnership(account.did)
    expect(result.handle).toBe(account.handle)
    expect(result.revealUrl).toBeDefined() // SMTP is unconfigured in this test env

    const rows = await testDb().select().from(custodialAccount).where(eq(custodialAccount.did, account.did))
    expect(rows[0]?.isCustodial).toBe(false)
    expect(rows[0]?.wrappedPassword).toBeNull()
    expect(rows[0]?.ownedAt).not.toBeNull()
  })

  it('refuses a DID with no custodial account at all', async () => {
    if (!dbOk) return
    await expect(takeOwnership('did:plc:never-signed-up')).rejects.toMatchObject({ status: 404, code: 'NotFound' })
  })

  it('refuses a second call while the first reveal link is still unused and unexpired (409 RevealPending, with its expiry)', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}-pending`)
    await takeOwnership(account.did)
    let caught: unknown
    try {
      await takeOwnership(account.did)
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ status: 409, code: 'RevealPending' })
    expect((caught as { expiresAt?: Date }).expiresAt).toBeInstanceOf(Date)
  })

  it('RE-ISSUE (review round 1, C1): once the first link has been used, a second call rotates again and issues a fresh working link', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}-reissue`)
    const first = await takeOwnership(account.did)
    const firstReveal = await revealOwnershipPassword(tokenFromRevealUrl(first.revealUrl!))
    expect(firstReveal.ok).toBe(true)

    // The first link is now used, so a second call must succeed rather than 409.
    const second = await takeOwnership(account.did)
    expect(second.revealUrl).toBeDefined()
    expect(second.revealUrl).not.toBe(first.revealUrl)

    const secondReveal = await revealOwnershipPassword(tokenFromRevealUrl(second.revealUrl!))
    expect(secondReveal.ok).toBe(true)
    if (!secondReveal.ok) return
    // The SECOND password is the one that actually works now — proves the re-issue
    // really did rotate the PDS password again, not just mint a new token for the old one.
    const { session } = await agentForAppPassword(account.did, secondReveal.password)
    expect(session.did).toBe(account.did)
  })

  it('RE-ISSUE after the first link merely EXPIRES (never used): a second call still succeeds and voids the stale row', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}-expired-reissue`)
    const first = await takeOwnership(account.did)
    const firstTokenHash = (await import('../src/lib/crypto.js')).hashToken(tokenFromRevealUrl(first.revealUrl!))
    // Force the first row to look expired without waiting 24h.
    await testDb().update(ownershipReveal).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(ownershipReveal.tokenHash, firstTokenHash))

    const second = await takeOwnership(account.did)
    expect(second.revealUrl).toBeDefined()

    const rows = await testDb().select().from(ownershipReveal).where(eq(ownershipReveal.did, account.did))
    // The expired-unused first row was voided; only the fresh one remains.
    expect(rows.length).toBe(1)
    expect(rows[0]?.tokenHash).not.toBe(firstTokenHash)
  })

  it('ROLLBACK (review round 1, C1): a PDS rotation failure leaves the account exactly as it was, and a retry then succeeds', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}-rollback`)
    const before = (await testDb().select().from(custodialAccount).where(eq(custodialAccount.did, account.did)))[0]!

    // Force the admin PDS call to fail: a wrong admin password is a genuine PDS-side
    // failure (401), not a mock — proving the rollback path against the real service.
    process.env.PDS_ADMIN_PASSWORD = 'deliberately-wrong-admin-password'
    resetConfig()
    try {
      await expect(takeOwnership(account.did)).rejects.toMatchObject({ status: 502, code: 'PdsRotationFailed' })
    } finally {
      process.env.PDS_ADMIN_PASSWORD = REAL_PDS_ADMIN_PASSWORD
      resetConfig()
    }

    // Rolled back to EXACTLY the prior state — no orphaned reveal row, no flipped flag.
    const afterFailure = (await testDb().select().from(custodialAccount).where(eq(custodialAccount.did, account.did)))[0]!
    expect(afterFailure.isCustodial).toBe(before.isCustodial)
    expect(afterFailure.wrappedPassword).toEqual(before.wrappedPassword)
    expect(afterFailure.ownedAt).toBeNull()
    const revealRows = await testDb().select().from(ownershipReveal).where(eq(ownershipReveal.did, account.did))
    expect(revealRows.length).toBe(0)

    // A plain retry, with the real admin password restored, now succeeds normally.
    const retried = await takeOwnership(account.did)
    expect(retried.revealUrl).toBeDefined()
    const retriedRow = (await testDb().select().from(custodialAccount).where(eq(custodialAccount.did, account.did)))[0]!
    expect(retriedRow.isCustodial).toBe(false)
  })

  it('the revealed password actually works: com.atproto.server.createSession succeeds with it', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}-session`)
    const result = await takeOwnership(account.did)
    const token = tokenFromRevealUrl(result.revealUrl!)
    const revealed = await revealOwnershipPassword(token)
    expect(revealed.ok).toBe(true)
    if (!revealed.ok) return

    const { session } = await agentForAppPassword(account.did, revealed.password)
    expect(session.did).toBe(account.did)
  })
})

describe('revealOwnershipPassword', () => {
  it('is single-use: a second reveal of the same token is 410 AlreadyUsed', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}-reveal`)
    const result = await takeOwnership(account.did)
    const token = tokenFromRevealUrl(result.revealUrl!)

    const first = await revealOwnershipPassword(token)
    expect(first.ok).toBe(true)
    const second = await revealOwnershipPassword(token)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.status).toBe(410)
      expect(second.error).toBe('AlreadyUsed')
    }
  })

  it('nulls the wrapped password in storage once revealed — nothing is retained after the one read', async () => {
    if (!pdsOk) return
    const account = await makeCustodialAccount(`${Date.now()}-retention`)
    const result = await takeOwnership(account.did)
    const token = tokenFromRevealUrl(result.revealUrl!)
    await revealOwnershipPassword(token)

    const rows = await testDb().select().from(ownershipReveal)
    const row = rows.find((r) => r.did === account.did)
    expect(row?.wrappedPassword).toBeNull()
    expect(row?.usedAt).not.toBeNull()
  })

  it('an unknown token 404s', async () => {
    if (!dbOk) return
    const result = await revealOwnershipPassword('not-a-real-token')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('an expired (but never-used) token is 410 Expired, not AlreadyUsed', async () => {
    if (!dbOk) return
    const token = 'an-expired-token-for-this-test'
    const { hashToken, wrapSecret } = await import('../src/lib/crypto.js')
    const wrapped = wrapSecret('irrelevant-password')
    await testDb().insert(ownershipReveal).values({
      tokenHash: hashToken(token),
      did: 'did:plc:whoever',
      keyVersion: wrapped.keyVersion,
      wrappedPassword: wrapped.blob,
      expiresAt: new Date(Date.now() - 1000),
    })
    const result = await revealOwnershipPassword(token)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.status).toBe(410)
      expect(result.error).toBe('Expired')
    }
  })
})
