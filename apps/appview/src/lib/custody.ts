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
import { custodialAccount, emailVerification, invite, ownershipReveal } from '../db/schema.js'
import { config } from '../config.js'
import { generateHandle } from './handles.js'
import { hashToken, newToken, randomPassword, unwrapSecret, wrapSecret } from './crypto.js'
import { createAccount, createInviteCode, PdsError, updateAccountPassword } from './pds.js'
import { sendMail } from './mail.js'
import { registerEmailTarget } from '../notifications/dispatch.js'
import { subscribe } from './newsletter-subscriptions.js'
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

export async function signup(input: { email: string; inviterDid?: string; newsletter?: boolean }): Promise<SignupResult> {
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
  // Default false: only the signup form's own checkbox, ticked, subscribes.
  if (input.newsletter === true) await subscribe(account.did, email)

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

export const OWNERSHIP_REVEAL_TTL_MS = 24 * 3_600_000

export interface TakeOwnershipResult {
  handle: string
  /** Returned ONLY when SMTP is unconfigured, so local development can see the link. */
  revealUrl?: string
}

/**
 * The exit from custody — resolves the open question the stub above used to leave
 * unanswered ("step 2"), by never holding the NEW password at all except for the single
 * 24h reveal window:
 *
 *   1. the caller is already authenticated as this DID (`requireViewer`, in auth.ts) —
 *      that IS "the session belongs to the custodial account"; a second factor is not
 *      this step's job.
 *   2. rotate the PDS password ADMIN-SIDE, to a fresh random one
 *      (`com.atproto.admin.updateAccountPassword`) — this needs no session of the
 *      member's own and does not touch (or require) the password we currently hold.
 *   3. set `isCustodial = false`, clear `wrappedPassword` — our OLD credential is
 *      worthless the instant the PDS password rotates, so there is nothing left to
 *      protect by keeping it.
 *   4. wrap the NEW password under the same versioned custody key, but in a SEPARATE,
 *      single-use, 24h-TTL table (`fs_ownership_reveal`) keyed by a token we email the
 *      member — never the password itself. `GET /api/auth/take-ownership/:token`
 *      (`revealOwnershipPassword`) is the only reader, and it nulls the wrapped blob the
 *      moment it answers, so "we never learn or keep the final password" holds past the
 *      first (and only) time the member opens the link.
 *   5. future writes on this DID's behalf through `actorAgent` now 401
 *      (`NoActorCredentialError`) until the member signs in via OAuth — the secondary
 *      door, exactly like any other existing account. The UI explains this (Task 10).
 */
export async function takeOwnership(did: string): Promise<TakeOwnershipResult> {
  const row = await getCustodialAccount(did)
  if (!row) throw new SignupError('no custodial account for this session', 404, 'NotFound')
  if (!row.isCustodial) throw new SignupError('this account has already taken full ownership', 409, 'AlreadyOwned')

  const newPassword = randomPassword(18) // 18 bytes -> 24 base64url chars
  await updateAccountPassword(did, newPassword)

  await getDb()
    .update(custodialAccount)
    .set({ isCustodial: false, wrappedPassword: null, ownedAt: new Date() })
    .where(eq(custodialAccount.did, did))

  const wrapped = wrapSecret(newPassword)
  const token = newToken()
  await getDb().insert(ownershipReveal).values({
    tokenHash: hashToken(token),
    did,
    keyVersion: wrapped.keyVersion,
    wrappedPassword: wrapped.blob,
    expiresAt: new Date(Date.now() + OWNERSHIP_REVEAL_TTL_MS),
  })

  const url = `${config().APPVIEW_PUBLIC_URL}/api/auth/take-ownership/${encodeURIComponent(token)}`
  await sendMail({
    to: row.email,
    subject: 'Take full ownership of your Free School account',
    text: [
      `You asked to take full ownership of @${row.handle}.`,
      '',
      'Open this link to see your new password (it is shown ONCE, so save it somewhere safe):',
      url,
      '',
      'After that, sign in with it at your PDS and change it to one of your own choosing.',
      "You can export your full repo any time with com.atproto.sync.getRepo — it is your data, not ours.",
      '',
      'The link works once and expires in 24 hours. From now on, publishing here needs a real sign-in.',
    ].join('\n'),
  })
  log.info('custodial account took ownership')
  return { handle: row.handle, ...(config().SMTP_URL ? {} : { revealUrl: url }) }
}

export type RevealOwnershipResult =
  | { ok: true; handle: string; password: string }
  | { ok: false; status: number; error: string; message: string }

/** The single-use reveal. Claims the row atomically so a double-click cannot double-read. */
export async function revealOwnershipPassword(token: string): Promise<RevealOwnershipResult> {
  const db = getDb()
  const hash = hashToken(token)
  const claimed = await db
    .update(ownershipReveal)
    .set({ usedAt: new Date() })
    .where(and(eq(ownershipReveal.tokenHash, hash), isNull(ownershipReveal.usedAt), gt(ownershipReveal.expiresAt, new Date())))
    .returning()
  const row = claimed[0]
  if (!row) {
    const existing = await db.select().from(ownershipReveal).where(eq(ownershipReveal.tokenHash, hash)).limit(1)
    if (!existing[0]) return { ok: false, status: 404, error: 'NotFound', message: 'unknown take-ownership link' }
    return {
      ok: false,
      status: 410,
      error: existing[0].usedAt ? 'AlreadyUsed' : 'Expired',
      message: existing[0].usedAt
        ? 'this link has already been used — the password was shown once'
        : 'this link has expired',
    }
  }
  if (!row.wrappedPassword) {
    // Defensive: usedAt was NULL at claim time, so this should be unreachable.
    return { ok: false, status: 410, error: 'AlreadyUsed', message: 'this link has already been used' }
  }
  const password = unwrapSecret({ keyVersion: row.keyVersion, blob: Buffer.from(row.wrappedPassword) })
  // Minimize retention: the blob has now served its one purpose.
  await db.update(ownershipReveal).set({ wrappedPassword: null }).where(eq(ownershipReveal.tokenHash, hash))
  const account = await getCustodialAccount(row.did)
  return { ok: true, handle: account?.handle ?? '', password }
}
