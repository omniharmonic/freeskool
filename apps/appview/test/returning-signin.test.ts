process.env.SESSION_SECRET ??= 'returning-signin-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'returning-signin-test-pepper'
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { closeTestDb, pgAvailable, truncate, SKIP_MESSAGE } from './helpers/pg.js'
import { getDb } from '../src/db/index.js'
import { custodialAccount } from '../src/db/schema.js'
vi.mock('../src/lib/pds.js', () => ({ createAccount: vi.fn(), createInviteCode: vi.fn(), updateAccountPassword: vi.fn(), PdsError: class extends Error {} }))
vi.mock('../src/lib/mail.js', () => ({ sendMail: vi.fn().mockResolvedValue({ delivered: true, transport: 'file' }) }))
import { createAccount, createInviteCode } from '../src/lib/pds.js'
import { sendMail } from '../src/lib/mail.js'
import { signup, verifyEmailToken } from '../src/lib/custody.js'
let available = false
beforeAll(async () => { available = await pgAvailable(); if (!available) console.warn(SKIP_MESSAGE) })
beforeEach(async () => {
  vi.clearAllMocks()
  if (available) await truncate('fs_custodial_account', 'fs_email_verification')
})
afterAll(async () => { if (available) await closeTestDb() })
async function seed(owned = false) {
  await getDb().insert(custodialAccount).values({ did: 'did:plc:returning', handle: 'returning.test', email: 'returning@example.org', keyVersion: 'v1', isCustodial: !owned })
}
describe('returning through the email door', () => {
  it('sends a fresh one-time link for the same identity without creating another PDS account', async () => {
    if (!available) return
    await seed()
    const result = await signup({ email: ' Returning@Example.org ' })
    expect(result.did).toBe('did:plc:returning')
    expect(createAccount).not.toHaveBeenCalled()
    expect(createInviteCode).not.toHaveBeenCalled()
    expect(sendMail).toHaveBeenCalledOnce()
    const mail = vi.mocked(sendMail).mock.calls[0]![0]
    expect(mail.to).toBe('returning@example.org')
    const url = mail.text.match(/https?:\/\/\S+\/verify\?token=\S+/)![0]
    const token = new URL(url).searchParams.get('token')!
    expect(await verifyEmailToken(token)).toEqual({ did: result.did })
    await expect(verifyEmailToken(token)).rejects.toMatchObject({ code: 'InvalidToken' })
  })
  it('keeps accounts whose owners reclaimed custody behind the AT Protocol sign-in door', async () => {
    if (!available) return
    await seed(true)
    await expect(signup({ email: 'returning@example.org' })).rejects.toMatchObject({ code: 'AccountOwned', status: 409 })
    expect(sendMail).not.toHaveBeenCalled()
    expect(createAccount).not.toHaveBeenCalled()
  })
})
