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
import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { custodialAccount, emailVerification, invite, ownershipReveal } from '../db/schema.js'
import { config } from '../config.js'
import { generateHandle } from './handles.js'
import { hashToken, newToken, randomPassword, unwrapSecret, wrapSecret } from './crypto.js'
import { createAccount, createInviteCode, PdsError, searchAccountByEmail, updateAccountPassword } from './pds.js'
import { sendMail } from './mail.js'
import { registerEmailTarget } from '../notifications/dispatch.js'
import { subscribe } from './newsletter-subscriptions.js'
import { log } from './logging.js'
import { legacySchoolDid } from './schools.js'

export const VERIFY_TTL_MS = 24 * 3_600_000

/** The PDS's various phrasings of "this email already belongs to an account". */
const EMAIL_TAKEN_RE = /email.*(taken|already)/i

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

/** What the locked section below resolved to, for the caller to react to afterward. */
type SignupOutcome =
  | { kind: 'resend'; did: string; handle: string }
  | { kind: 'created' | 'adopted'; did: string; handle: string }

export async function signup(input: {
  email: string
  inviterDid?: string
  newsletter?: boolean
  /** The school being joined: the invite evidence and the digest are both per school. */
  schoolDid?: string
}): Promise<SignupResult> {
  const c = config()
  const email = input.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new SignupError('that does not look like an email address', 400, 'InvalidEmail')
  }

  // REVIEW ROUND 1 (blocking): two concurrent signups for the same BRAND-NEW email used
  // to race — both could pass the "no existing row" check, both call `createAccount`,
  // and the loser would either crash on the unique-DID insert or (worse) land in
  // `adoptOrphanedAccount` and rotate the WINNER's freshly-minted password out from
  // under it. `pg_advisory_xact_lock(hashtext(email))` serializes the whole
  // check -> mint-or-adopt -> insert sequence per email: the second request simply
  // waits for the lock, then sees the first request's now-committed row and takes the
  // ordinary resend path below. The lock is released automatically at transaction end.
  const outcome = await getDb().transaction(async (tx): Promise<SignupOutcome> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${email}))`)

    // A returning member uses the same email door. Minting another PDS account
    // fails on its unique email constraint and would lose the member's history. This
    // is ALSO exactly what a second, now-serialized concurrent signup for the same
    // brand-new email sees once the first one has committed its row.
    const [existing] = await tx.select().from(custodialAccount).where(eq(custodialAccount.email, email)).limit(1)
    if (existing) {
      if (!existing.isCustodial) {
        throw new SignupError('You own this account now. Sign in with your existing AT Protocol account below.', 409, 'AccountOwned')
      }
      return { kind: 'resend', did: existing.did, handle: existing.handle }
    }

    const code = await createInviteCode(1)
    const password = randomPassword(32)

    // The PDS rejects a handle that is taken or that trips its slur filter; both are
    // cheap to retry past, and the handle space is ~360k so collisions are rare.
    let account: { did: string; handle: string } | undefined
    let adopted = false
    let lastError: unknown
    for (let attempt = 0; attempt < 5 && !account; attempt++) {
      const handle = generateHandle(c.handleDomain)
      try {
        account = await createAccount({ email, handle, password, inviteCode: code })
      } catch (err) {
        lastError = err
        if (err instanceof PdsError && err.code === 'HandleNotAvailable') continue
        if (err instanceof PdsError && err.code === 'InvalidHandle') continue
        // Orphan self-heal: the PDS already has an account under this email — almost
        // certainly one whose earlier signup minted it and then lost the mail send (or
        // crashed) before we ever recorded a row. Adopt it rather than fail forever.
        if (err instanceof PdsError && EMAIL_TAKEN_RE.test(err.message)) {
          const adoption = await adoptOrphanedAccount(tx, email, password)
          // REVIEW ROUND 1 (blocking, part c): re-checked by did AND by email, under
          // the same lock, right before rotating anything — if a row already exists
          // either way, someone else's signup already won this email; do NOT rotate
          // their account's password out from under them, just resend their link.
          if (adoption.kind === 'existing') return { kind: 'resend', did: adoption.did, handle: adoption.handle }
          account = { did: adoption.did, handle: adoption.handle }
          adopted = true
          break
        }
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
    // REVIEW ROUND 1 (blocking, part b): a defense-in-depth backstop, not the primary
    // guard (the advisory lock above is) — `onConflictDoNothing` means a uniqueness
    // violation on either `did` or the new `fs_custodial_account_email_idx` never
    // throws an unhandled error; `.returning()` coming back empty is how we detect it.
    const inserted = await tx
      .insert(custodialAccount)
      .values({
        did: account.did,
        handle: account.handle,
        email,
        isCustodial: true,
        keyVersion: wrapped.keyVersion,
        wrappedPassword: wrapped.blob,
      })
      .onConflictDoNothing()
      .returning()
    if (inserted.length === 0) {
      const [raced] = await tx.select().from(custodialAccount).where(eq(custodialAccount.email, email)).limit(1)
      if (raced) return { kind: 'resend', did: raced.did, handle: raced.handle }
      // Conflicted but nothing found (deleted concurrently, or a did-only collision
      // with a different email) — fail loudly rather than silently drop the account.
      throw new SignupError('could not create the account', 502, 'PdsRejected')
    }
    // The invite code was never actually consumed by the PDS for an adopted account
    // (`createAccount` failed before that could happen) — nothing to record as used.
    if (!adopted) {
      await tx.insert(invite).values({
        code,
        schoolDid: input.schoolDid ?? legacySchoolDid(),
        inviterDid: input.inviterDid ?? null,
        usedByDid: account.did,
        usedAt: new Date(),
      })
    }
    return { kind: adopted ? 'adopted' : 'created', did: account.did, handle: account.handle }
  })

  if (outcome.kind === 'resend') {
    const { url } = await sendVerificationEmail(outcome.did, email)
    return { did: outcome.did, handle: outcome.handle, ...(c.SMTP_URL ? {} : { verifyUrl: url }) }
  }

  await registerEmailTarget(outcome.did, email)
  // Default false: only the signup form's own checkbox, ticked, subscribes.
  if (input.newsletter === true) await subscribe(outcome.did, email, input.schoolDid ?? legacySchoolDid())

  const { url } = await sendVerificationEmail(outcome.did, email)
  if (outcome.kind === 'adopted') {
    log.info('custodial account adopted')
  } else {
    log.info('custodial account minted', { handleDomain: c.handleDomain })
  }
  return {
    did: outcome.did,
    handle: outcome.handle,
    ...(config().SMTP_URL ? {} : { verifyUrl: url }),
  }
}

/** A transaction handle, as passed into `getDb().transaction(async (tx) => ...)`. */
type Tx = Parameters<Parameters<ReturnType<typeof getDb>['transaction']>[0]>[0]

/**
 * Looks up a stranded PDS account by email (admin-side) and re-homes it: a fresh random
 * password (we never learn or reuse the one from this signup attempt's failed
 * `createAccount` call — it was never accepted by the PDS), rotated admin-side exactly
 * like `takeOwnership`'s step 2. Throws (502, surfaced the same way as any other PDS
 * rejection) if the PDS reports the email taken but no matching account can be found —
 * an inconsistency worth failing loudly on rather than silently retrying forever.
 *
 * REVIEW ROUND 1 (blocking, part c): before rotating anything, re-queries — inside the
 * SAME locked transaction as the caller — for a custodial row by the PDS-returned did OR
 * by this email. If either already exists, some other request already won this email
 * (or this very did) and we must not touch its password; the caller resends instead.
 */
async function adoptOrphanedAccount(
  tx: Tx,
  email: string,
  password: string,
): Promise<{ kind: 'adopted' | 'existing'; did: string; handle: string }> {
  const found = await searchAccountByEmail(email)
  if (!found) {
    throw new SignupError(
      'could not mint an account on the PDS: email already taken, but no matching account was found',
      502,
      'PdsRejected',
    )
  }
  const [already] = await tx
    .select()
    .from(custodialAccount)
    .where(or(eq(custodialAccount.did, found.did), eq(custodialAccount.email, email)))
    .limit(1)
  if (already) return { kind: 'existing', did: already.did, handle: already.handle }
  await updateAccountPassword(found.did, password)
  return { kind: 'adopted', did: found.did, handle: found.handle }
}

export async function sendVerificationEmail(did: string, email: string): Promise<{ url: string }> {
  const token = newToken()
  await getDb().insert(emailVerification).values({
    tokenHash: hashToken(token),
    did,
    purpose: 'verify-email',
    expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
  })
  // The PWA's own `/verify` screen, NOT the API endpoint: `VerifyScreen` is what calls
  // `GET /api/auth/verify` (and shows a human a page either way). Every link a person
  // clicks is on `webPublicUrl`; only the OAuth client metadata/jwks/callback, which are
  // fetched by a PDS rather than clicked, stay on `APPVIEW_PUBLIC_URL`.
  const url = `${config().webPublicUrl}/verify?token=${encodeURIComponent(token)}`
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
  /** Returned when SMTP is unconfigured, OR when the send itself failed — see below. */
  revealUrl?: string
}

/**
 * Thrown instead of rotating again while an unused, unexpired reveal link already
 * exists for this DID — re-rotating would silently orphan that link's password (the
 * member who has it would be holding a password the PDS no longer accepts). Carries
 * `expiresAt` so the caller can say "check your email, the link is good until then."
 */
export class RevealPendingError extends SignupError {
  constructor(readonly expiresAt: Date) {
    super('a take-ownership link is already pending for this account', 409, 'RevealPending')
  }
}

async function latestReveal(did: string) {
  const rows = await getDb().select().from(ownershipReveal).where(eq(ownershipReveal.did, did)).orderBy(desc(ownershipReveal.createdAt)).limit(1)
  return rows[0] ?? null
}

/**
 * The exit from custody. FIX (review round 1, C1): the DB state (the reveal row + the
 * `isCustodial` flip) is now committed BEFORE the PDS call, in one transaction, and
 * rolled back to EXACTLY what it was if the PDS call then fails — the old ordering could
 * strand a member with neither a working old credential (flipped away) nor a working new
 * one (the PDS was never actually told to rotate, because the insert/flip/mail chain
 * failed somewhere after it). Sequence:
 *
 *   1. the caller is already authenticated as this DID (`requireViewer`, in auth.ts) —
 *      that IS "the session belongs to the custodial account"; a second factor is not
 *      this step's job.
 *   2. refuse (409 `RevealPending`) if an unused, unexpired reveal link already exists —
 *      re-rotating now would orphan it. Otherwise, clear any prior UNUSED (necessarily
 *      expired, by the check just above) row for this DID — at most one "live" reveal row
 *      per DID at a time.
 *   3. generate the new password, wrap it, and in ONE transaction: insert the new
 *      `fs_ownership_reveal` row and flip `fs_custodial_account` (`isCustodial = false`,
 *      `wrappedPassword = null`, `ownedAt = now()`). This is allowed to run again for an
 *      account that is ALREADY non-custodial — re-issuing a missed link — since nothing
 *      about the flip itself is false to repeat.
 *   4. rotate the PDS password ADMIN-SIDE (`com.atproto.admin.updateAccountPassword`) —
 *      needs no session of the member's own. If this throws, the PDS password was NOT
 *      actually changed, so step 3 is undone exactly (delete the new row, restore the
 *      account row's prior snapshot) and we 502 — the member can simply retry.
 *   5. email the reveal link. A mail failure does not lose the token: it is logged (no
 *      identifiers) and `revealUrl` is still returned — the caller is already proven to
 *      be this account's own session, so showing them the link directly is exactly as
 *      safe as the email would have been.
 *   6. future writes on this DID's behalf through `actorAgent` now 401
 *      (`NoActorCredentialError`) until the member signs in via OAuth — the secondary
 *      door, exactly like any other existing account. The UI explains this (Task 10).
 */
export async function takeOwnership(did: string): Promise<TakeOwnershipResult> {
  const row = await getCustodialAccount(did)
  if (!row) throw new SignupError('no custodial account for this session', 404, 'NotFound')

  const pending = await latestReveal(did)
  if (pending && !pending.usedAt && pending.expiresAt.getTime() > Date.now()) {
    throw new RevealPendingError(pending.expiresAt)
  }
  // Any remaining UNUSED row here is necessarily expired (the check above already
  // refused a live one) — clear it before issuing a fresh one.
  await getDb().delete(ownershipReveal).where(and(eq(ownershipReveal.did, did), isNull(ownershipReveal.usedAt)))

  const newPassword = randomPassword(18) // 18 bytes -> 24 base64url chars
  const wrapped = wrapSecret(newPassword)
  const token = newToken()
  const tokenHash = hashToken(token)
  const expiresAt = new Date(Date.now() + OWNERSHIP_REVEAL_TTL_MS)

  // Snapshot of the credential state to restore exactly if the PDS call below fails.
  const prior = {
    isCustodial: row.isCustodial,
    wrappedPassword: row.wrappedPassword,
    keyVersion: row.keyVersion,
    ownedAt: row.ownedAt,
  }

  await getDb().transaction(async (tx) => {
    await tx.insert(ownershipReveal).values({ tokenHash, did, keyVersion: wrapped.keyVersion, wrappedPassword: wrapped.blob, expiresAt })
    await tx
      .update(custodialAccount)
      .set({ isCustodial: false, wrappedPassword: null, ownedAt: new Date() })
      .where(eq(custodialAccount.did, did))
  })

  try {
    await updateAccountPassword(did, newPassword)
  } catch (err) {
    // The PDS password was NOT actually changed — undo step 3 exactly, so the member's
    // existing credential (ours, or the PDS's) is still consistent, and a retry is just
    // calling this again.
    await getDb().transaction(async (tx) => {
      await tx.delete(ownershipReveal).where(eq(ownershipReveal.tokenHash, tokenHash))
      await tx.update(custodialAccount).set(prior).where(eq(custodialAccount.did, did))
    })
    log.error('take-ownership PDS rotation failed; rolled back, member can retry')
    throw new SignupError('could not rotate the PDS password — nothing changed; please try again', 502, 'PdsRotationFailed')
  }

  const url = `${config().webPublicUrl}/account/reveal/${encodeURIComponent(token)}`
  let mailOk = true
  try {
    await sendMail({
      to: row.email,
      subject: 'Take full ownership of your Free School account',
      text: [
        `You asked to take full ownership of @${row.handle}.`,
        '',
        'Open this link in the app to see your new password (it is shown ONCE, so save it somewhere safe):',
        url,
        '',
        'After that, sign in with it at your PDS and change it to one of your own choosing.',
        "You can export your full repo any time with com.atproto.sync.getRepo — it is your data, not ours.",
        '',
        'The link works once and expires in 24 hours. From now on, publishing here needs a real sign-in.',
      ].join('\n'),
    })
  } catch {
    mailOk = false
    log.warn('ownership reveal mail failed')
  }
  log.info('custodial account took ownership')
  // The link is shown directly whenever mail is unconfigured OR mail genuinely failed —
  // the caller is proven to be this account's own session either way, so this is not a
  // new exposure, only a fallback for a send that would otherwise lose the token.
  return { handle: row.handle, ...(config().SMTP_URL && mailOk ? {} : { revealUrl: url }) }
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
