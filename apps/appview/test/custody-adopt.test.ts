/**
 * Task 5: the orphaned-PDS-account self-heal.
 *
 * A member's first signup can mint a real PDS account and then lose the mail send (or
 * crash) before `fs_custodial_account` ever gets a row for it — the PDS account is real
 * and its email is now permanently "taken" from the PDS's point of view, but we have no
 * record of it at all. Every later signup attempt with that email then fails at
 * `createAccount` with an "email already taken" PdsError, forever, because we keep trying
 * to mint a NEW account rather than recognizing the orphan and adopting it.
 *
 * `signup()`'s existing "returning member" path (see `returning-signin.test.ts`) only
 * covers the case where we already hold a row. This suite covers the three outcomes of
 * hitting `createAccount`'s email-taken error for an email we do NOT hold a row for:
 *   - the PDS actually has a matching account -> adopt it (fresh password, new row, link)
 *   - some other PdsError -> bubbles up unadopted (502 at the route layer)
 *
 * The PDS client is mocked — this is `signup()`'s own branching logic, not a live-PDS
 * concern (that's `take-ownership.test.ts`'s job).
 */
process.env.SESSION_SECRET ??= 'custody-adopt-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'custody-adopt-test-pepper'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'
import { getDb } from '../src/db/index.js'
import { custodialAccount } from '../src/db/schema.js'

vi.mock('../src/lib/pds.js', () => ({
  createAccount: vi.fn(),
  createInviteCode: vi.fn(),
  updateAccountPassword: vi.fn(),
  searchAccountByEmail: vi.fn(),
  PdsError: class PdsError extends Error {
    status: number
    code?: string
    constructor(message: string, status: number, code?: string) {
      super(message)
      this.name = 'PdsError'
      this.status = status
      this.code = code
    }
  },
}))
vi.mock('../src/lib/mail.js', () => ({ sendMail: vi.fn().mockResolvedValue({ delivered: true, transport: 'file' }) }))

import { createAccount, createInviteCode, updateAccountPassword, searchAccountByEmail, PdsError } from '../src/lib/pds.js'
import { sendMail } from '../src/lib/mail.js'
import { signup } from '../src/lib/custody.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(createInviteCode).mockResolvedValue('fake-invite-code')
  if (available) await truncate('fs_custodial_account', 'fs_email_verification', 'fs_invite')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

describe('signup() against an orphaned PDS account', () => {
  it('adopts the orphan: looks it up admin-side, rotates its password, records it, and still sends the link', async () => {
    if (!available) return
    vi.mocked(createAccount).mockRejectedValue(new PdsError('Email already taken', 400, 'InvalidRequest'))
    vi.mocked(searchAccountByEmail).mockResolvedValue({ did: 'did:plc:orphan', handle: 'orphaned-one.test' })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await signup({ email: 'orphan@example.org' })

    expect(result.did).toBe('did:plc:orphan')
    expect(result.handle).toBe('orphaned-one.test')
    expect(searchAccountByEmail).toHaveBeenCalledWith('orphan@example.org')
    expect(updateAccountPassword).toHaveBeenCalledWith('did:plc:orphan', expect.any(String))

    const rows = await getDb().select().from(custodialAccount).where(eq(custodialAccount.did, 'did:plc:orphan'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.isCustodial).toBe(true)
    expect(rows[0]?.email).toBe('orphan@example.org')
    expect(rows[0]?.handle).toBe('orphaned-one.test')

    expect(sendMail).toHaveBeenCalledOnce()

    // Exactly one log line, and it names neither the DID, the handle nor the email.
    const adoptLines = logSpy.mock.calls.filter((c) => String(c[0]).includes('custodial account adopted'))
    expect(adoptLines).toHaveLength(1)
    const logged = adoptLines[0]!.join(' ')
    expect(logged).not.toContain('did:plc:orphan')
    expect(logged).not.toContain('orphaned-one.test')
    expect(logged).not.toContain('orphan@example.org')
    logSpy.mockRestore()
  })

  it('an unrelated PDS failure (not "email taken") is never treated as an orphan and never calls searchAccountByEmail', async () => {
    if (!available) return
    vi.mocked(createAccount).mockRejectedValue(new PdsError('internal server error', 500, 'InternalServerError'))

    await expect(signup({ email: 'unlucky@example.org' })).rejects.toBeInstanceOf(PdsError)
    expect(searchAccountByEmail).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })

  it('an "email taken" error with no matching PDS account is a clean failure, not a crash', async () => {
    if (!available) return
    vi.mocked(createAccount).mockRejectedValue(new PdsError('email already taken', 400, 'InvalidRequest'))
    vi.mocked(searchAccountByEmail).mockResolvedValue(null)

    await expect(signup({ email: 'ghost@example.org' })).rejects.toMatchObject({ status: 502 })
    expect(updateAccountPassword).not.toHaveBeenCalled()
    expect(sendMail).not.toHaveBeenCalled()
  })
})
