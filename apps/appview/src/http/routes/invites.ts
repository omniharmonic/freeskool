/**
 * `/api/invites` — shareable invite LINKS.
 *
 *   POST /invites                mint a bearer link (auth required)
 *   POST /invites/:token/redeem  consume one use (auth required)
 *
 * Distinct from `fs_invite`, the signup-invite-code evidence table: anyone already
 * signed in can mint one of these to hand to a friend (optionally scoped to one class),
 * it can be reused up to `uses` times, and it expires. Only the SHA-256 of the token is
 * ever stored, so a leaked database row is not a working link.
 *
 * PRIVACY (R9): the inviter's DID never appears in the minted URL, in the token, or in
 * the redeemer's response — `fs_invite_link.inviterDid` stays server-side, same as
 * `fs_invite.inviterDid` (which this endpoint also writes, as gating evidence for the
 * `invite-or-vouch` member gate; see lib/roles.ts).
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, gt, sql } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { getDb } from '../../db/index.js'
import { invite, inviteLink } from '../../db/schema.js'
import { config } from '../../config.js'
import { hashToken, newInviteToken } from '../../lib/crypto.js'
import { rowId } from '../../lib/ids.js'

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

export async function mintInviteLink(inviterDid: string, input: z.infer<typeof mintBody>): Promise<MintedInvite> {
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
  | { ok: true; eventUri?: string }
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

invites.post('/invites', requireViewer, async (c) => {
  const parsed = mintBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const minted = await mintInviteLink(c.var.viewer!.did, parsed.data)
  return c.json(minted, 201)
})

invites.post('/invites/:token/redeem', requireViewer, async (c) => {
  const token = c.req.param('token')
  const result = await redeemInviteLink(token, c.var.viewer!.did)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 404 | 410)
  return c.json({ ok: true, ...(result.eventUri ? { eventUri: result.eventUri } : {}) })
})
