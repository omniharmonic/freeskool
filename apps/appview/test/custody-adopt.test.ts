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

  // REVIEW ROUND 1 (blocking, part c): adopt's own re-check, inside the lock, right
  // before rotating anything. The outer "no existing row for this EMAIL" check at the
  // top of `signup()` cannot catch every case on its own (e.g. a data inconsistency, or
  // a genuinely different email whose PDS lookup happens to resolve to a DID we already
  // hold) — this is the second, narrower guard specifically over the did.
  it('adopt bails to resend, never rotating a password, when the found did already has a row', async () => {
    if (!available) return
    await getDb().insert(custodialAccount).values({
      did: 'did:plc:already-there',
      handle: 'already-there.test',
      email: 'other-email@example.org',
      isCustodial: true,
      keyVersion: 'v1',
    })
    vi.mocked(createAccount).mockRejectedValue(new PdsError('email already taken', 400, 'InvalidRequest'))
    vi.mocked(searchAccountByEmail).mockResolvedValue({ did: 'did:plc:already-there', handle: 'already-there.test' })

    const result = await signup({ email: 'raced2@example.org' })

    expect(result.did).toBe('did:plc:already-there')
    expect(updateAccountPassword).not.toHaveBeenCalled()
    expect(sendMail).toHaveBeenCalledOnce()
  })

  // REVIEW ROUND 1 (blocking, part b): the unique index is a DB-level backstop
  // independent of `signup()`'s own advisory-lock serialization — proved directly here
  // rather than by trying to race past the lock (which is the whole point of part a).
  it('the DB itself refuses two rows for the same email (fs_custodial_account_email_idx)', async () => {
    if (!available) return
    await getDb().insert(custodialAccount).values({
      did: 'did:plc:dupe-a',
      handle: 'dupe-a.test',
      email: 'dupe@example.org',
      isCustodial: true,
      keyVersion: 'v1',
    })
    await expect(
      getDb().insert(custodialAccount).values({
        did: 'did:plc:dupe-b',
        handle: 'dupe-b.test',
        email: 'dupe@example.org',
        isCustodial: true,
        keyVersion: 'v1',
      }),
    ).rejects.toThrow()
  })
})

describe('signup() under real concurrency (review round 1, blocking finding)', () => {
  // The bug: two concurrent signups for the same BRAND-NEW email both pass the "no
  // existing row" check, both call `createAccount`, and the loser either crashes on the
  // unique-did insert or (worse) lands in the orphan-adopt path and rotates the
  // WINNER's just-minted password out from under it. The fix serializes the whole
  // check -> mint -> insert sequence per email with `pg_advisory_xact_lock`, so this
  // needs a REAL Postgres (the lock itself is the thing under test) — the PDS client
  // stays mocked, exactly like the rest of this file.
  it('two concurrent signup() calls for the same new email: exactly one createAccount, one row, both calls resolve, and the stored password matches what the PDS was actually given', async () => {
    if (!available) return
    const email = `race-${Date.now()}@example.org`
    let capturedPassword: string | undefined
    vi.mocked(createAccount).mockImplementation(async (input) => {
      capturedPassword = input.password
      // A small delay so both concurrent calls are genuinely in flight together before
      // either reaches the point the lock actually has to serialize.
      await new Promise((resolve) => setTimeout(resolve, 40))
      return { did: 'did:plc:race-winner', handle: 'race-winner.test', accessJwt: 'x', refreshJwt: 'y' }
    })

    const [a, b] = await Promise.all([signup({ email }), signup({ email })])

    expect(createAccount).toHaveBeenCalledTimes(1)
    expect(updateAccountPassword).not.toHaveBeenCalled()
    expect(a.did).toBe('did:plc:race-winner')
    expect(b.did).toBe('did:plc:race-winner')
    expect(a.handle).toBe('race-winner.test')
    expect(b.handle).toBe('race-winner.test')

    const rows = await getDb().select().from(custodialAccount).where(eq(custodialAccount.did, 'did:plc:race-winner'))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.email).toBe(email)

    const { unwrapSecret } = await import('../src/lib/crypto.js')
    const decrypted = unwrapSecret({ keyVersion: rows[0]!.keyVersion, blob: Buffer.from(rows[0]!.wrappedPassword!) })
    expect(decrypted).toBe(capturedPassword)
  })
})
