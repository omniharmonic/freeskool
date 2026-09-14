/**
 * `/api/admin/handoff` — steward continuity. A steward proposes a hand-off (optionally
 * to a named successor); any signed-in member who holds the resulting token can accept
 * it and become a steward. This is the "how to start this school again if it goes
 * quiet" mechanism `lib/how-it-works.ts` points at.
 *
 *   POST /admin/handoff            (steward) propose — 7-day single-use token
 *   POST /handoff/:token/accept    (any Member+; a bare Visitor is refused) accept
 *
 * Accept is deliberately NOT under `/api/admin/*`: `admin.ts` mounts a blanket
 * `admin.use('*', requireRole(Steward))` there, which would 403 the very non-steward
 * the token is meant for (Hono applies a sub-app's `'*'` middleware to any path under
 * its mount, whether or not that sub-app has its own handler for it).
 *
 * The PROPOSER's own approval is written FIRST, to their OWN repo
 * (`freeschool.draft.approval`, per that lexicon's own description — "written by the
 * steward in their OWN repo"), referencing a synthetic at-uri for this hand-off (there
 * is no dedicated "hand-off proposal" record type). Only once that write succeeds does
 * the `fs_handoff` row — and therefore the token — come into existence, so "the
 * proposer's own approval already exists" is true by construction, not by a runtime
 * check against something that could have failed independently.
 *
 * The approval record NEVER carries the successor's DID: R9 forbids a public record
 * naming a DID its holder did not write, and at propose time the successor has not
 * consented to anything (they may not even know the token exists yet). `fs_handoff.to_did`
 * — app-side only — is what binds an addressed hand-off to a specific successor.
 *
 * Accepting runs `set-role` through `SchoolActorPort` — the SAME action and record
 * shape (`freeschool.draft.moderationAction`) the generic moderation queue already uses
 * for steward-granted roles — with the PROPOSER as the authorizing caller (they are the
 * steward; the acceptor need not be one yet). It also inserts the acceptor into
 * `fs_steward` directly: role derivation (`lib/roles.ts#evidenceFor`) reads THAT table
 * for `stewardAppointed`, not the protocol record, so this is what actually takes
 * effect.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq, gt, isNull, or } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import { SchoolActError, type Did } from '@freeschool/school-actor'
import type { AppEnv, Viewer } from '../session.js'
import { requireRole, requireViewer } from '../session.js'
import { getDb } from '../../db/index.js'
import { handoff, steward } from '../../db/schema.js'
import { rowId, tid } from '../../lib/ids.js'
import { hashToken, newToken } from '../../lib/crypto.js'
import { config } from '../../config.js'
import { actorFor, asDid } from '../../lib/school-actors.js'
import { legacySchoolDid } from '../../lib/schools.js'
import { currentSchool } from '../school-context.js'
import { currentPolicyUri } from '../../lib/policy.js'
import { NSID } from '../../lexicons/nsids.js'
import { actorAgent, NoActorCredentialError } from '../../lib/actor-agent.js'
import { resolveHandle } from '../../lib/pds.js'

export const handoffRoutes = new Hono<AppEnv>()

const HANDOFF_TTL_MS = 7 * 86_400_000

export interface ProposeHandoffDeps {
  /** Overridable in tests: writes the proposer's `freeschool.draft.approval` record. */
  writeApproval?: (viewer: Pick<Viewer, 'did' | 'kind'>, record: Record<string, unknown>) => Promise<{ uri: string; cid: string }>
  /** Overridable in tests: resolves a handle to a DID. */
  resolve?: (handle: string) => Promise<string | null>
}

export type ProposeHandoffResult =
  | { ok: true; id: string; token: string; url: string; expiresAt: string }
  | { ok: false; status: number; error: string; message: string }

async function defaultWriteApproval(viewer: Pick<Viewer, 'did' | 'kind'>, record: Record<string, unknown>) {
  const agent = await actorAgent(viewer as Viewer)
  // `actorAgent` returns an `Agent` (OAuth-session-shaped), not the `AtpAgent` the
  // `pds.ts` helpers expect — same reason `lib/events.ts#put` calls the XRPC method
  // directly rather than through that helper.
  const res = await agent.com.atproto.repo.putRecord({
    repo: viewer.did,
    collection: NSID.approval,
    rkey: tid(),
    record,
    // Our sidecar lexicons are not published to the network; the PDS cannot resolve
    // them, so validation would reject every one.
    validate: false,
  })
  return { uri: res.data.uri, cid: res.data.cid }
}

export async function proposeHandoff(
  viewer: Pick<Viewer, 'did' | 'kind'>,
  input: { toHandleOrDid?: string },
  deps: ProposeHandoffDeps = {},
  /** The school being handed off. A hand-off is for ONE school (MS §4). */
  schoolDid: string = legacySchoolDid(),
): Promise<ProposeHandoffResult> {
  const resolve = deps.resolve ?? resolveHandle
  let toDid: string | null = null
  if (input.toHandleOrDid) {
    toDid = input.toHandleOrDid.startsWith('did:') ? input.toHandleOrDid : await resolve(input.toHandleOrDid)
    if (!toDid) return { ok: false, status: 404, error: 'NotFound', message: 'could not resolve that handle' }
  }

  const id = rowId()
  // There is no "hand-off proposal" record type; a synthetic at-uri under the school
  // DID is exactly the approval lexicon's documented allowance for "an app-side
  // proposal id expressed as an at-uri under the school DID".
  const proposalUri = `at://${schoolDid}/freeschool.draft.handoff/${id}`

  const writeApproval = deps.writeApproval ?? defaultWriteApproval
  try {
    // Deliberately NO subjectDid here, even when the proposal is addressed to a named
    // successor: that DID has not consented to being named in the proposer's public
    // repo. `toDid` lives only in fs_handoff (app-side) until the successor themselves
    // accepts — at which point it is THEIR OWN action naming themselves.
    await writeApproval(viewer, {
      $type: NSID.approval,
      proposal: proposalUri,
      action: 'set-role',
      reason: 'steward hand-off: approving whoever accepts this token as the successor',
      createdAt: new Date().toISOString(),
    })
  } catch (err) {
    if (err instanceof NoActorCredentialError) {
      return { ok: false, status: 401, error: 'ReauthRequired', message: 'sign in again before proposing a hand-off' }
    }
    throw err
  }

  const token = newToken()
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS)
  await getDb().insert(handoff).values({ id, schoolDid, fromDid: viewer.did, toDid, tokenHash: hashToken(token), expiresAt })
  return {
    ok: true,
    id,
    token,
    url: `${config().webPublicUrl}/admin/handoff/accept/${token}`,
    expiresAt: expiresAt.toISOString(),
  }
}

export type AcceptHandoffResult =
  | { ok: true; uri: string; auditId: string; warning?: 'single-steward' }
  | { ok: false; status: number; error: string; message: string }

export async function acceptHandoff(
  token: string,
  acceptorDid: string,
  schoolDid: string = legacySchoolDid(),
): Promise<AcceptHandoffResult> {
  const db = getDb()
  const tokenHash = hashToken(token)

  /**
   * A12: CLAIM FIRST, then act — the same shape as `invites.ts`'s atomic decrement.
   *
   * The old sequence was SELECT, check `accepted_at`, act, UPDATE. Two requests arriving
   * together both read `accepted_at IS NULL`, both passed the check and both ran `set-role`:
   * one link, two stewards, and the second one had no approval behind it. A single-use token
   * has to be claimed by the database, not by a read followed by a hope.
   *
   * Every precondition moves into the WHERE clause — unused, unexpired, and either open or
   * addressed to this acceptor — so exactly one concurrent caller gets a row back.
   *
   * `to_did` is deliberately NOT set by the claim: it is written only once the hand-off has
   * actually succeeded, which is what lets the claim be released (below) if the school
   * declines the write, without turning an open link into one addressed to whoever happened
   * to fail first.
   */
  const claimed = await db
    .update(handoff)
    .set({ acceptedAt: new Date() })
    .where(
      and(
        eq(handoff.tokenHash, tokenHash),
        isNull(handoff.acceptedAt),
        gt(handoff.expiresAt, new Date()),
        or(isNull(handoff.toDid), eq(handoff.toDid, acceptorDid)),
      ),
    )
    .returning()
  const row = claimed[0]
  if (!row) return await explainFailedClaim(tokenHash, acceptorDid)

  try {
    const result = await (await actorFor(schoolDid)).putRecordAsSchool({
      schoolDid: asDid(schoolDid),
      // The PROPOSER authorizes — they are the steward; the acceptor need not be one
      // yet. Their own approval (written at proposal time) is what stands behind this.
      callerDid: row.fromDid as Did,
      scope: NSID.moderationAction,
      action: 'set-role',
      collection: NSID.moderationAction,
      rkey: tid(),
      record: {
        $type: NSID.moderationAction,
        // R9, and F0. The public record never names the SUBJECT — `acceptorDid` lives
        // app-side, in `fs_handoff.to_did` (set below) and `fs_steward.did` (also below,
        // which is what actually grants the role; `evidenceFor` reads that table, not this
        // record) — and never carries a REASON either: moderation reasons are never public
        // (CLAUDE.md), and this record type is shared with the moderation queue, where the
        // reason is free text a steward wrote about a particular person. The reason for THIS
        // action is in `fs_audit` (below), which is app-side.
        action: 'set-role',
        policyRef: await currentPolicyUri(schoolDid),
        actors: [row.fromDid],
        createdAt: new Date().toISOString(),
      },
      audit: {
        reason: 'steward hand-off accepted',
        approvals: [{ stewardDid: row.fromDid as Did, at: new Date().toISOString() }],
      },
    })

    // The record above is the protocol's audit trail; THIS is what actually changes
    // the acceptor's derived role — evidenceFor() reads fs_steward, not moderationAction.
    await db
      .insert(steward)
      .values({ did: acceptorDid, schoolDid, appointedByDid: row.fromDid })
      .onConflictDoUpdate({
        // `(did, school_did)` since the federation phase: being a steward of one school
        // must not overwrite — or imply — being a steward of another (MS §4).
        target: [steward.did, steward.schoolDid],
        set: { suspendedAt: null, appointedByDid: row.fromDid },
      })

    // The claim already set `accepted_at`; record WHO accepted now that it has happened.
    await db.update(handoff).set({ toDid: acceptorDid }).where(eq(handoff.id, row.id))

    const active = await db
      .select({ did: steward.did })
      .from(steward)
      .where(and(eq(steward.schoolDid, schoolDid), isNull(steward.suspendedAt)))

    return {
      ok: true,
      uri: result.uri,
      auditId: result.auditId,
      ...(active.length < 2 ? { warning: 'single-steward' as const } : {}),
    }
  } catch (err) {
    // RELEASE THE CLAIM. Nothing took effect — the port refused before writing, or threw —
    // so the link must be usable again rather than burnt by a failure that was not the
    // acceptor's doing. `to_did` was never touched, so an open link stays open.
    await db.update(handoff).set({ acceptedAt: null }).where(eq(handoff.id, row.id)).catch(() => undefined)
    if (err instanceof SchoolActError) {
      return {
        ok: false,
        status: (err.result.status || 403) as number,
        error: err.result.error,
        message: err.result.message ?? 'the school declined this action',
      }
    }
    throw err
  }
}

/**
 * The claim matched nothing. Re-read the row — purely to say WHY, never to act — so the
 * caller still gets "already used" / "expired" / "addressed to someone else" rather than one
 * undifferentiated 404. A row that vanished between the two statements reads as unknown,
 * which is accurate.
 */
async function explainFailedClaim(tokenHash: string, acceptorDid: string): Promise<AcceptHandoffResult> {
  const rows = await getDb().select().from(handoff).where(eq(handoff.tokenHash, tokenHash)).limit(1)
  const row = rows[0]
  if (!row) return { ok: false, status: 404, error: 'NotFound', message: 'unknown hand-off token' }
  if (row.acceptedAt) return { ok: false, status: 410, error: 'AlreadyUsed', message: 'this hand-off link has already been used' }
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, status: 410, error: 'Expired', message: 'this hand-off link has expired' }
  if (row.toDid && row.toDid !== acceptorDid) {
    return { ok: false, status: 403, error: 'WrongRecipient', message: 'this hand-off was addressed to someone else' }
  }
  // Unreachable in practice: every WHERE condition is covered above.
  return { ok: false, status: 409, error: 'HandoffUnavailable', message: 'this hand-off link could not be claimed' }
}

const startBody = z.object({ toHandleOrDid: z.string().optional() })

handoffRoutes.post('/admin/handoff', requireViewer, requireRole(Role.Steward), async (c) => {
  const parsed = startBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const result = await proposeHandoff(c.var.viewer!, parsed.data, {}, currentSchool(c).did)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 401 | 404)
  return c.json({ id: result.id, url: result.url, token: result.token, expiresAt: result.expiresAt }, 201)
})

// NOT under /admin — see the module doc for why (the admin router's blanket Steward
// gate would otherwise 403 the very non-steward this token is meant for).
handoffRoutes.post('/handoff/:token/accept', requireViewer, requireRole(Role.Member), async (c) => {
  const token = c.req.param('token')
  const result = await acceptHandoff(token, c.var.viewer!.did, currentSchool(c).did)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 403 | 404 | 410)
  return c.json({ ok: true, uri: result.uri, auditId: result.auditId, ...(result.warning ? { warning: result.warning } : {}) })
})
