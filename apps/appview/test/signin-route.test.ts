/**
 * `POST /api/auth/signin` — the same "Continue with email" door as `/signup`, aliased
 * (see `http/routes/auth.ts`). This suite is deliberately at the route level, decoupled
 * from `custody.ts`, so it proves the two ROUTES share a handler rather than re-testing
 * `signup()`'s own behaviour (that's `custody-adopt.test.ts` and `returning-signin.test.ts`).
 */
process.env.WEB_PUBLIC_URL = 'https://app.example'
process.env.APPVIEW_PUBLIC_URL = 'https://api.example'
process.env.SESSION_SECRET ??= 'signin-route-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'signin-route-test-pepper'

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/lib/custody.js', () => ({
  signup: vi.fn(),
  verifyEmailToken: vi.fn(),
  getCustodialAccount: vi.fn(),
  takeOwnership: vi.fn(),
  revealOwnershipPassword: vi.fn(),
  RevealPendingError: class RevealPendingError extends Error {},
  SignupError: class SignupError extends Error {
    status: number
    code: string
    constructor(message: string, status: number, code: string) {
      super(message)
      this.status = status
      this.code = code
    }
  },
}))

import { auth } from '../src/http/routes/auth.js'
import { signup, SignupError } from '../src/lib/custody.js'

async function post(path: string, body: unknown) {
  return auth.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /signin', () => {
  beforeEach(() => {
    vi.mocked(signup).mockReset()
  })

  it('calls the same signup() as /signup and returns the same shape', async () => {
    vi.mocked(signup).mockResolvedValue({ did: 'did:plc:door', handle: 'door.test', verifyUrl: 'https://app.example/verify?token=x' })

    const res = await post('/signin', { email: 'door@example.org' })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { did: string; handle: string }
    expect(signup).toHaveBeenCalledWith({ email: 'door@example.org' })
    expect(body).toMatchObject({ did: 'did:plc:door', handle: 'door.test' })
  })

  it('rejects a missing email the same way /signup does', async () => {
    const res = await post('/signin', {})
    expect(res.status).toBe(400)
    expect(signup).not.toHaveBeenCalled()
  })

  it('surfaces a SignupError with its own status, same as /signup', async () => {
    vi.mocked(signup).mockRejectedValue(new SignupError('You own this account now.', 409, 'AccountOwned'))
    const res = await post('/signin', { email: 'owned@example.org' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('AccountOwned')
  })
})
