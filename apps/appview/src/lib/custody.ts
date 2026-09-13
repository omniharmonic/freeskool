/**
 * The PRIMARY door: a new Free School identity on our own PDS.
 *
 * `POST /api/auth/signup {email}` mints a real ATProto account:
 *   createInviteCode (admin)  ->  createAccount  ->  wrap the password  ->  magic link
 *
 * The member never chooses or sees a password. It is 32 random bytes, AES-256-GCM
 * encrypted under a versioned key, and the app holds it — OpenMeet's custodial pattern.
 * That is what makes "sign up with an email address" possible on a protocol that has no
 * such concept, and `takeOwnership` is the documented exit.
 *
 * The handle is `<word><word><NNN>.<domain>` and is NEVER derived from the email (R9).
 */
import { and, eq, gt, isNull } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { custodialAccount, emailVerification, invite } from '../db/schema.js'
import { config } from '../config.js'
import { generateHandle } from './handles.js'
import { hashToken, newToken, randomPassword, unwrapSecret, wrapSecret } from './crypto.js'
import { createAccount, createInviteCode, PdsError } from './pds.js'
import { sendMail } from './mail.js'
import { registerEmailTarget } from '../notifications/dispatch.js'
import { log } from './logging.js'

export const VERIFY_TTL_MS = 24 * 3_600_000

export class SignupError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SignupError'
  }
}

export interface SignupResult {
  did: string
  handle: string
  /** Returned ONLY when SMTP is unconfigured, so local development can proceed. */
  verifyUrl?: string
}

export async function signup(input: { email: string; inviterDid?: string }): Promise<SignupResult> {
  const c = config()
  const email = input.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SignupError('that does not look like an email address', 400, 'InvalidEmail')
  }

  const code = await createInviteCode(1)
  const password = randomPassword(32)

  // The PDS rejects a handle that is taken or that trips its slur filter; both are
  // cheap to retry past, and the handle space is ~360k so collisions are rare.
  let account: { did: string; handle: string } | undefined
  let lastError: unknown
  for (let attempt = 0; attempt < 5 && !account; attempt++) {
    const handle = generateHandle(c.handleDomain)
    try {
      account = await createAccount({ email, handle, password, inviteCode: code })
    } catch (err) {
      lastError = err
      if (err instanceof PdsError && err.code === 'HandleNotAvailable') continue
      if (err instanceof PdsError && err.code === 'InvalidHandle') continue
      throw err
    }
  }
  if (!account) {
    throw new SignupError(
      `could not mint an account on the PDS: ${lastError instanceof Error ? lastError.message : 'unknown'}`,
      502,
      'PdsRejected',
    )
  }

  const wrapped = wrapSecret(password)
  await getDb().insert(custodialAccount).values({
    did: account.did,
    handle: account.handle,
    email,
    isCustodial: true,
    keyVersion: wrapped.keyVersion,
    wrappedPassword: wrapped.blob,
  })
  await getDb().insert(invite).values({
    code,
    inviterDid: input.inviterDid ?? null,
    usedByDid: account.did,
    usedAt: new Date(),
  })
  await registerEmailTarget(account.did, email)

  const { url } = await sendVerificationEmail(account.did, email)
  log.info('custodial account minted', { handleDomain: c.handleDomain })
  return {
    did: account.did,
    handle: account.handle,
    ...(config().SMTP_URL ? {} : { verifyUrl: url }),
  }
}

export async function sendVerificationEmail(did: string, email: string): Promise<{ url: string }> {
  const token = newToken()
  await getDb().insert(emailVerification).values({
    tokenHash: hashToken(token),
    did,
    purpose: 'verify-email',
    expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
  })
  const url = `${config().APPVIEW_PUBLIC_URL}/api/auth/verify?token=${encodeURIComponent(token)}`
  await sendMail({
    to: email,
    subject: 'Confirm your Free School account',
    text: [
      'Welcome to Free School.',
      '',
      'Open this link to finish setting up your account:',
      url,
      '',
      'The link works once and expires in 24 hours.',
    ].join('\n'),
  })
  return { url }
}

/** Consumes the token and returns the DID to open a session for. */
export async function verifyEmailToken(token: string): Promise<{ did: string }> {
  const db = getDb()
  const hash = hashToken(token)
  const rows = await db
    .update(emailVerification)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailVerification.tokenHash, hash),
        isNull(emailVerification.usedAt),
        gt(emailVerification.expiresAt, new Date()),
      ),
    )
    .returning({ did: emailVerification.did })
  const row = rows[0]
  if (!row) throw new SignupError('that link is no longer valid', 400, 'InvalidToken')
  await db
    .update(custodialAccount)
    .set({ verifiedAt: new Date() })
    .where(eq(custodialAccount.did, row.did))
  return { did: row.did }
}

export async function getCustodialAccount(did: string) {
  const rows = await getDb().select().from(custodialAccount).where(eq(custodialAccount.did, did)).limit(1)
  return rows[0] ?? null
}

/**
 * INTERNAL. The only reader of a custodial member's password — used when the app must
 * write to the member's OWN repo on their behalf (a custodial host publishing a class).
 * Never returned over HTTP, never logged.
 */
export async function custodialPassword(did: string): Promise<string | null> {
  const row = await getCustodialAccount(did)
  if (!row?.isCustodial || !row.wrappedPassword) return null
  return unwrapSecret({ keyVersion: row.keyVersion, blob: Buffer.from(row.wrappedPassword) })
}

/**
 * STUB — `takeOwnership`.
 *
 * The exit from custody. The member proves their email, we reveal a one-time password
 * reset, and from then on the app holds nothing:
 *
 *   1. verify a fresh magic link for purpose='take-ownership'
 *   2. `com.atproto.server.requestPasswordReset` / `resetPassword` through the PDS, OR
 *      hand the member the current password once over TLS and force a change
 *   3. `UPDATE fs_custodial_account SET is_custodial = false, wrapped_password = NULL,
 *      owned_at = now()`
 *   4. future writes on their behalf stop working — the app must fall back to asking
 *      them to authorize via OAuth, exactly like any other existing account
 *
 * Step 2 is the open question (the PDS's reset flow emails the user directly, which is
 * what we want, but it also invalidates the password we hold mid-flight), so this is
 * deliberately left unimplemented rather than half-implemented.
 */
export async function takeOwnership(_did: string): Promise<never> {
  throw new SignupError('taking ownership of a custodial account is not implemented yet', 501, 'NotImplemented')
}
