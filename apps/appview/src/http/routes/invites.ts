/**
 * `/api/invites` — shareable invite LINKS.
 *
 *   POST /invites                mint a bearer link (auth required, Member+)
 *   POST /invites/:token/redeem  consume one use (auth required)
 *
 * Distinct from `fs_invite`, the signup-invite-code evidence table: a member (Role.Member
 * or above — a bare Visitor cannot) can mint one of these to hand to a friend (optionally
 * scoped to one class), it can be reused up to `uses` times, and it expires. Only the
 * SHA-256 of the token is ever stored, so a leaked database row is not a working link.
 *
 * THE MEMBER ADMISSION GATE, two independent layers (closes the self-promotion hole
 * where a fresh Visitor mints their own link and redeems it to promote themselves):
 *   1. minting requires Role.Member+ (`requireRole` at the route, `roleOf` inside
 *      `mintInviteLink` itself so the function is safe even called directly);
 *   2. `redeemInviteLink` refuses a redemption where `redeemerDid === inviterDid`
 *      (409 `SelfRedeem`, a hard error) — no self-invite, from any account.
 *
 * A redeemer who ALREADY satisfies invite-or-vouch is NOT an error: this is the brief's
 * class deep-link (mint with `eventUri`, hand the link to someone already admitted so
 * they land on the class). Redemption still succeeds — `{ ok: true, eventUri,
 * alreadyMember: true }` — it just consumes no use and writes no new evidence, since
 * there is nothing left to admit them to.
 *
 * PRIVACY (R9): the inviter's DID never appears in the minted URL, in the token, or in
 * the redeemer's response — `fs_invite_link.inviterDid` stays server-side, same as
 * `fs_invite.inviterDid` (which this endpoint also writes, as gating evidence for the
 * `invite-or-vouch` member gate; see lib/roles.ts).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, gt, isNotNull, or, sql } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireRole, requireViewer } from '../session.js'
import { getDb } from '../../db/index.js'
import { invite, inviteLink } from '../../db/schema.js'
import { config } from '../../config.js'
import { hashToken, newInviteToken } from '../../lib/crypto.js'
import { rowId } from '../../lib/ids.js'
import { roleOf } from '../../lib/roles.js'

export const invites = new Hono<AppEnv>()

const DEFAULT_TTL_DAYS = 14

const mintBody = z.object({
  eventUri: z.string().startsWith('at://').optional(),
  uses: z.number().int().min(1).max(20).optional(),
  ttlDays: z.number().int().min(1).max(30).optional(),
})

export interface MintedInvite {
  url: string
  token: string
  expiresAt: string
}

export class MintPermissionError extends Error {
  constructor() {
    super('must be at least a member to mint an invite link')
    this.name = 'MintPermissionError'
  }
}

export async function mintInviteLink(inviterDid: string, input: z.infer<typeof mintBody>): Promise<MintedInvite> {
  // Belt-and-braces: the route also gates on `requireRole(Role.Member)`, but this
  // function is called directly by tests (and could be called from elsewhere), so the
  // rule lives here too rather than only at the door.
  if ((await roleOf(inviterDid)) < Role.Member) throw new MintPermissionError()

  const token = newInviteToken()
  const expiresAt = new Date(Date.now() + (input.ttlDays ?? DEFAULT_TTL_DAYS) * 86_400_000)
  await getDb().insert(inviteLink).values({
    id: rowId(),
    tokenHash: hashToken(token),
    inviterDid,
    schoolDid: config().SCHOOL_DID,
    eventUri: input.eventUri ?? null,
    usesLeft: input.uses ?? 1,
    expiresAt,
  })
  return { url: `${config().webPublicUrl}/invite/${token}`, token, expiresAt: expiresAt.toISOString() }
}

export type RedeemResult =
  | { ok: true; eventUri?: string; alreadyMember?: boolean }
  | { ok: false; status: number; error: string; message?: string }

export async function redeemInviteLink(token: string, redeemerDid: string): Promise<RedeemResult> {
  const db = getDb()
  const tokenHash = hashToken(token)
  const rows = await db.select().from(inviteLink).where(eq(inviteLink.tokenHash, tokenHash)).limit(1)
  const row = rows[0]
  if (!row) return { ok: false, status: 404, error: 'NotFound', message: 'unknown invite link' }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, status: 410, error: 'InviteExpired', message: 'this invite link has expired' }
  }

  // Layer 2: no self-invite. Checked against the minter's stored DID, which never leaves
  // this function — not in the request, not in the response.
  if (row.inviterDid === redeemerDid) {
    return { ok: false, status: 409, error: 'SelfRedeem', message: 'you cannot redeem your own invite link' }
  }

  // A redeemer who already satisfies invite-or-vouch (the exact condition `evidenceFor`
  // checks) is not turned away: this is the class deep-link case — succeed, but consume
  // no use and write no new evidence, since there is nothing left for this link to admit
  // them to.
  const already = await db
    .select({ code: invite.code })
    .from(invite)
    .where(and(eq(invite.usedByDid, redeemerDid), or(isNotNull(invite.inviterDid), isNotNull(invite.inviterPurgedAt))))
    .limit(1)
  if (already.length > 0) {
    return { ok: true, ...(row.eventUri ? { eventUri: row.eventUri } : {}), alreadyMember: true }
  }

  // Atomic claim: decrement only while a use remains, so two simultaneous redemptions
  // cannot both succeed past the limit.
  const claimed = await db
    .update(inviteLink)
    .set({ usesLeft: sql`${inviteLink.usesLeft} - 1`, redeemedAt: new Date() })
    .where(and(eq(inviteLink.tokenHash, tokenHash), gt(inviteLink.usesLeft, 0)))
    .returning({ eventUri: inviteLink.eventUri, inviterDid: inviteLink.inviterDid })
  const claim = claimed[0]
  if (!claim) return { ok: false, status: 410, error: 'InviteExhausted', message: 'this invite link has no uses left' }

  // Gating evidence: the redeemer now satisfies the invite-or-vouch member gate. This is
  // the SAME table the signup flow writes to (fs_invite); `code` here is just this
  // redemption's own id, never a real PDS invite code.
  await db.insert(invite).values({
    code: rowId(),
    inviterDid: claim.inviterDid,
    usedByDid: redeemerDid,
    usedAt: new Date(),
  })

  return { ok: true, ...(claim.eventUri ? { eventUri: claim.eventUri } : {}) }
}

invites.post('/invites', requireViewer, requireRole(Role.Member), async (c) => {
  const parsed = mintBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  try {
    const minted = await mintInviteLink(c.var.viewer!.did, parsed.data)
    return c.json(minted, 201)
  } catch (err) {
    if (err instanceof MintPermissionError) return c.json({ error: 'PermissionDenied', message: err.message }, 403)
    throw err
  }
})

invites.post('/invites/:token/redeem', requireViewer, async (c) => {
  const token = c.req.param('token')
  const result = await redeemInviteLink(token, c.var.viewer!.did)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 404 | 409 | 410)
  return c.json({
    ok: true,
    ...(result.eventUri ? { eventUri: result.eventUri } : {}),
    ...(result.alreadyMember ? { alreadyMember: true } : {}),
  })
})
