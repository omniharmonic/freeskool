/**
 * `/api/admin/*` — steward surface. Everything that changes the school goes through
 * `SchoolActorPort`, which means: role-gated, reason-mandatory, approval-counted, and
 * audited, with no exceptions and no second path.
 *
 *   GET  /policy                the current policy record + derived thresholds
 *   PUT  /policy                write a new version (single-steward, audited, public)
 *   GET  /moderation            the queue
 *   POST /moderation            open an item. `reason` is REQUIRED.
 *   POST /moderation/:id/approve  a second steward signs on
 *   POST /moderation/:id/execute  run it as the school, once the threshold is met
 *   GET  /peers   PUT /peers    the peer registry (= contrail's `relays`)
 *   GET  /newsletter   POST /newsletter          list / compose a monthly digest draft
 *   POST /newsletter/:id/send   send a draft to every subscribed member (see
 *                               ../../jobs/newsletter.ts)
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireRole, requireViewer } from '../session.js'
import { getDb } from '../../db/index.js'
import { attendance, moderationQueue, newsletterIssue } from '../../db/schema.js'
import { rowId, tid } from '../../lib/ids.js'
import { bumpTally } from '../../lib/roles.js'
import { schoolActor, schoolDid } from '../../lib/school-actor.js'
import { SchoolActError, type Approval, type SchoolAction } from '@freeschool/school-actor'
import { NSID } from '../../lexicons/nsids.js'
import { currentPolicyUri, getThresholds, refreshPolicyCache } from '../../lib/policy.js'
import { getRecord } from '../../lib/pds.js'
import { addPeer, disablePeer, listPeers, probePeer } from '../../index/peers.js'
import { getIndexer, resetIndexer } from '../../index/indexer.js'
import { composeNewsletterIssue, sendNewsletterIssue } from '../../jobs/newsletter.js'

export const admin = new Hono<AppEnv>()

admin.use('*', requireViewer, requireRole(Role.Steward))

/* policy */

admin.get('/policy', async (c) => {
  const did = schoolDid()
  const uri = await currentPolicyUri(did)
  const rkey = uri?.split('/').pop()
  const record = rkey ? await getRecord(did, NSID.policy, rkey) : null
  return c.json({ uri, thresholds: await getThresholds(did), record: record?.value ?? null })
})

const policyBody = z.object({
  title: z.string().min(1).max(300),
  text: z.string().min(1).max(200_000),
  version: z.string().min(1).max(20),
  effectiveAt: z.string().optional(),
  thresholds: z
    .object({
      memberRequires: z.enum(['none', 'invite-or-vouch', 'attended-one']).optional(),
      hostMinAttended: z.number().int().min(0).max(20).optional(),
      facilitatorMinHosted: z.number().int().min(0).max(50).optional(),
      firstEventApproval: z.boolean().optional(),
      feedbackK: z.number().int().min(2).max(10).optional(),
      destructiveActionStewards: z.number().int().min(1).max(5).optional(),
      /** A steward's choice to let qualifying members' roles reach the protocol. */
      publishRoles: z.boolean().optional(),
    })
    .optional(),
  reason: z.string().min(3).max(1000),
  /**
   * Optional: `write-policy` is single-steward (not in `DESTRUCTIVE_ACTIONS`), since the
   * first school has exactly one steward and PRD F15 requires policy to be editable
   * without a deploy. Still audited, and the policy record itself is public, so any
   * threshold change a steward makes is visible. Accepted here only so a school that
   * later raises its threshold, or a multi-steward school, can co-sign if it chooses.
   */
  approvals: z
    .array(z.object({ stewardDid: z.custom<`did:${string}`>((v) => typeof v === 'string' && v.startsWith('did:')), at: z.string() }))
    .optional(),
})

admin.put('/policy', async (c) => {
  const parsed = policyBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 400)
  const viewer = c.var.viewer!
  const now = new Date().toISOString()
  const rkey = tid()
  const did = schoolDid()
  const caller = viewer.did as `did:${string}`
  const approvals = parsed.data.approvals ?? []
  // The rkey is ours, so the policy's at-uri is known BEFORE it is written — which is what
  // lets the two writes be ordered (#16).
  const policyUri = `at://${did}/${NSID.policy}/${rkey}`

  try {
    /**
     * ORDER, and why (#16). There are two writes and they can fail independently:
     *
     *   - school record LAST, policy record FIRST (the old order) could leave a policy
     *       record nothing points at — invisible, and the OLD thresholds silently still in
     *       force while the steward is told the change succeeded;
     *   - school record FIRST could leave the school pointing at a policy that does not
     *       exist, which since A2 means `refreshPolicyCache` FAILS CLOSED rather than
     *       relaxing anything — the strictly safer of the two failure shapes.
     *
     * So: re-point the school record first, then write the policy it names, and ROLL THE
     * POINTER BACK if the policy write fails. `refreshPolicyCache` runs only once both
     * have succeeded, so the cache never reflects a half-applied change.
     */
    const school = await getRecord(did, NSID.school, 'self')
    const previousPolicyUri = typeof school?.value?.policy === 'string' ? school.value.policy : undefined
    if (school) {
      await schoolActor().putRecordAsSchool({
        schoolDid: did,
        callerDid: caller,
        scope: NSID.school,
        action: 'write-policy',
        collection: NSID.school,
        rkey: 'self',
        record: { ...school.value, policy: policyUri },
        audit: { reason: `point the school record at policy ${parsed.data.version}`, approvals },
      })
    }

    let res: { uri: string; cid: string; auditId: string }
    try {
      res = await schoolActor().putRecordAsSchool({
        schoolDid: did,
        callerDid: caller,
        scope: NSID.policy,
        action: 'write-policy',
        collection: NSID.policy,
        rkey,
        record: {
          $type: NSID.policy,
          title: parsed.data.title,
          text: parsed.data.text,
          version: parsed.data.version,
          effectiveAt: parsed.data.effectiveAt ?? now,
          ...(parsed.data.thresholds ? { thresholds: parsed.data.thresholds } : {}),
          createdAt: now,
        },
        audit: { reason: parsed.data.reason, approvals },
      })
    } catch (err) {
      // Undo the pointer, so the school still names the policy that is actually in force.
      // Best effort: if THIS fails too, A2's fail-closed read is the backstop.
      if (school) {
        await schoolActor()
          .putRecordAsSchool({
            schoolDid: did,
            callerDid: caller,
            scope: NSID.school,
            action: 'write-policy',
            collection: NSID.school,
            rkey: 'self',
            record: {
              ...school.value,
              ...(previousPolicyUri ? { policy: previousPolicyUri } : { policy: undefined }),
            },
            audit: { reason: `roll back the policy pointer: writing policy ${parsed.data.version} failed`, approvals },
          })
          .catch(() => {
            /* A2: an unreadable/absent policy now reads as strict, never as permissive */
          })
      }
      throw err
    }

    await refreshPolicyCache(did)
    const indexer = await getIndexer()
    await indexer.notify(res.uri).catch(() => {})
    return c.json({ uri: res.uri, cid: res.cid, auditId: res.auditId }, 201)
  } catch (err) {
    const { body, status } = schoolErrorBody(err)
    return c.json(body, status)
  }
})

/* moderation */

const moderationBody = z.object({
  action: z.enum([
    'curate-listing',
    'remove-listing',
    'restore-listing',
    'set-role',
    'suspend-role',
    'close-request',
    'void-attendance',
  ]),
  subjectUri: z.string().startsWith('at://').optional(),
  subjectDid: z.string().startsWith('did:').optional(),
  /** MANDATORY. There is no code path that acts without one. */
  reason: z.string().min(3).max(1000),
})

admin.get('/moderation', async (c) => {
  const status = c.req.query('status') ?? 'open'
  const rows = await getDb()
    .select()
    .from(moderationQueue)
    .where(eq(moderationQueue.status, status))
    .orderBy(desc(moderationQueue.createdAt))
    .limit(100)
  const thresholds = await getThresholds()
  return c.json({
    requiredApprovals: thresholds.destructiveActionStewards,
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      subjectUri: r.subjectUri,
      subjectDid: r.subjectDid,
      reason: r.reason,
      status: r.status,
      approvals: r.approvals,
      createdAt: r.createdAt,
    })),
  })
})

admin.post('/moderation', async (c) => {
  const parsed = moderationBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    return c.json({ error: 'InvalidRequest', message: 'action and a written reason are required' }, 400)
  }
  const viewer = c.var.viewer!
  const id = rowId()
  await getDb().insert(moderationQueue).values({
    id,
    action: parsed.data.action,
    subjectUri: parsed.data.subjectUri ?? null,
    subjectDid: parsed.data.subjectDid ?? null,
    reason: parsed.data.reason,
    openedByDid: viewer.did,
    // The opener's own approval is implicit (AppCustodyAdapter adds the caller).
    approvals: [{ stewardDid: viewer.did as `did:${string}`, at: new Date().toISOString() }] satisfies Approval[],
  })
  return c.json({ id, status: 'open' }, 201)
})

admin.post('/moderation/:id/approve', async (c) => {
  const id = c.req.param('id')
  const viewer = c.var.viewer!
  const rows = await getDb().select().from(moderationQueue).where(eq(moderationQueue.id, id)).limit(1)
  const row = rows[0]
  if (!row) return c.json({ error: 'NotFound' }, 404)
  const approvals = asApprovals(row.approvals)
  if (approvals.some((a) => a.stewardDid === viewer.did)) {
    return c.json({ error: 'AlreadyApproved', approvals }, 409)
  }
  const next: Approval[] = [...approvals, { stewardDid: viewer.did as `did:${string}`, at: new Date().toISOString() }]
  await getDb().update(moderationQueue).set({ approvals: next }).where(eq(moderationQueue.id, id))
  const thresholds = await getThresholds()
  return c.json({ approvals: next, required: thresholds.destructiveActionStewards })
})

admin.post('/moderation/:id/execute', async (c) => {
  const id = c.req.param('id')
  const viewer = c.var.viewer!
  const rows = await getDb().select().from(moderationQueue).where(eq(moderationQueue.id, id)).limit(1)
  const row = rows[0]
  if (!row) return c.json({ error: 'NotFound' }, 404)
  if (row.status !== 'open') return c.json({ error: 'AlreadyResolved', status: row.status }, 409)

  const approvals = asApprovals(row.approvals)
  try {
    const result = await schoolActor().putRecordAsSchool({
      schoolDid: schoolDid(),
      callerDid: viewer.did as `did:${string}`,
      scope: NSID.moderationAction,
      action: row.action as SchoolAction,
      collection: NSID.moderationAction,
      rkey: tid(),
      record: publicModerationRecord(row.action, await currentPolicyUri(schoolDid()), approvals),
      audit: { reason: row.reason, approvals },
    })

    /**
     * THE ACTION ITSELF. The record above is the decision; these are the effects, and they
     * are deliberately best-effort-but-reported: a listing write or a tally decrement that
     * fails must not roll back a decision two stewards have already approved, so the queue
     * row still resolves and `effects` says what actually happened.
     */
    const effects: Record<string, unknown> = {}

    // A listing change, as the school. The host's event is NEVER touched: the school
    // curates, it does not edit other people's repos. `remove-listing` and
    // `restore-listing` are the same write with a different `status` — and because
    // `isListed` takes the NEWEST listing (`http/visibility.ts`), appending a `listed`
    // record genuinely un-hides the class.
    if ((row.action === 'remove-listing' || row.action === 'restore-listing') && row.subjectUri) {
      const status = row.action === 'remove-listing' ? 'removed' : 'listed'
      const listing = await schoolActor()
        .putRecordAsSchool({
          schoolDid: schoolDid(),
          callerDid: viewer.did as `did:${string}`,
          scope: NSID.eventListing,
          action: row.action,
          collection: NSID.eventListing,
          rkey: tid(),
          record: {
            $type: NSID.eventListing,
            event: { uri: row.subjectUri },
            school: schoolDid(),
            status,
            createdAt: new Date().toISOString(),
          },
          audit: { reason: row.reason, approvals },
        })
        .catch(() => undefined)
      effects.listing = listing ? { uri: listing.uri, status } : null
    }

    // A3: void-attendance actually voids it. The subject is the app-side row's
    // `subject_uri` (the event) and/or `subject_did` (the person) — whichever the steward
    // gave: an event alone voids the whole sheet, a DID alone voids that person's
    // attendance everywhere, both narrows to one row.
    if (row.action === 'void-attendance' && (row.subjectUri || row.subjectDid)) {
      effects.attendanceVoided = await voidAttendance(row.subjectUri, row.subjectDid)
    }

    await getDb()
      .update(moderationQueue)
      .set({ status: 'resolved', resolvedAt: new Date(), resultUri: result.uri })
      .where(eq(moderationQueue.id, id))
    return c.json({ ok: true, uri: result.uri, auditId: result.auditId, ...effects })
  } catch (err) {
    const { body, status } = schoolErrorBody(err)
    return c.json(body, status)
  }
})

/* peers */

admin.get('/peers', async (c) => {
  const peers = await listPeers()
  const probed = c.req.query('probe') === '1' ? await Promise.all(peers.map((p) => probePeer(p.host))) : undefined
  return c.json({ peers, probed })
})

const peersBody = z.object({
  add: z.array(z.string().url()).optional(),
  remove: z.array(z.string()).optional(),
})

admin.put('/peers', async (c) => {
  const parsed = peersBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  for (const host of parsed.data.add ?? []) await addPeer(host, 'admin')
  for (const host of parsed.data.remove ?? []) await disablePeer(host)
  // The peer list IS contrail's `relays`, so the indexer has to be rebuilt.
  resetIndexer()
  return c.json({ peers: await listPeers() })
})

/* newsletter */

admin.post('/newsletter', async (c) => {
  const period = c.req.query('period') ?? new Date().toISOString().slice(0, 7)
  const draft = await composeNewsletterIssue(period)
  return c.json({ subject: `Free School, ${draft.month}`, body: draft.text, ...draft }, 201)
})

admin.get('/newsletter', async (c) => {
  const rows = await getDb()
    .select({
      id: newsletterIssue.id,
      month: newsletterIssue.month,
      status: newsletterIssue.status,
      sentAt: newsletterIssue.sentAt,
      recipientCount: newsletterIssue.recipientCount,
    })
    .from(newsletterIssue)
    .orderBy(desc(newsletterIssue.month))
    .limit(24)
  return c.json({ drafts: rows })
})

admin.post('/newsletter/:id/send', async (c) => {
  const id = c.req.param('id')
  const result = await sendNewsletterIssue(id)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 404 | 409)
  return c.json({ ok: true, recipientCount: result.recipientCount })
})

/**
 * The PUBLIC projection of a moderation decision (F0).
 *
 * R9, twice over:
 *   - no public record may name a DID its holder did not write, and an at-uri's authority
 *     segment IS a DID — so the SUBJECT (who or what this acted on) stays app-side in
 *     `fs_moderation_queue.subject_uri`/`subject_did`, which is where `GET /moderation`
 *     shows it to stewards;
 *   - MODERATION REASONS ARE NEVER PUBLIC (CLAUDE.md). The reason is mandatory free text a
 *     steward writes about a specific person — "repeated no-shows after a warning", "kept
 *     turning up drunk" — and publishing it publishes both a judgement and, in practice,
 *     enough detail to identify its subject. It lives in `fs_moderation_queue.reason` and
 *     in `fs_audit`, both app-side, and the port still REQUIRES one for every call.
 *
 * What is left is the decision, and it is enough to audit the school: what was done, under
 * which policy, by which stewards, when.
 */
function publicModerationRecord(
  action: string,
  policyRef: string | null,
  approvals: Approval[],
): Record<string, unknown> {
  return {
    $type: NSID.moderationAction,
    action,
    policyRef,
    actors: approvals.map((a) => a.stewardDid),
    createdAt: new Date().toISOString(),
  }
}

/**
 * A3. Void the attendance the steward named, and take the same number back off each
 * person's lifetime tally — the tally is bumped at attest time and is the only attendance
 * evidence that outlives the 90-day row collapse (`jobs/retention.ts`), so leaving it alone
 * would mean a voided attendance still counted towards Host forever.
 *
 * Only rows that are not ALREADY voided are touched, which makes re-running this a no-op
 * rather than a second decrement, and only rows with `participated` — a "they did not take
 * part" row never incremented anything. `bumpTally` floors each counter at 0.
 */
async function voidAttendance(subjectUri: string | null, subjectDid: string | null): Promise<number> {
  const db = getDb()
  const where = [isNull(attendance.voidedAt)]
  if (subjectUri) where.push(eq(attendance.eventUri, subjectUri))
  if (subjectDid) where.push(eq(attendance.attendeeDid, subjectDid))
  const voided = await db
    .update(attendance)
    .set({ voidedAt: new Date() })
    .where(and(...where))
    .returning({ attendeeDid: attendance.attendeeDid, participated: attendance.participated })
  for (const r of voided) {
    if (r.participated) await bumpTally(r.attendeeDid, { attendedConfirmed: -1 })
  }
  return voided.length
}

/** A denial from the port is a 403/409 with its audit id, never a 500. */
function schoolErrorBody(err: unknown): { body: Record<string, unknown>; status: 403 } {
  if (err instanceof SchoolActError) {
    return {
      body: { error: err.result.error, message: err.result.message, auditId: err.result.auditId },
      status: (err.result.status || 403) as 403,
    }
  }
  throw err
}

function asApprovals(raw: unknown): Approval[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((a) => {
    const row = a as { stewardDid?: unknown; at?: unknown; sig?: unknown }
    if (typeof row.stewardDid !== 'string' || !row.stewardDid.startsWith('did:')) return []
    return [
      {
        stewardDid: row.stewardDid as `did:${string}`,
        at: typeof row.at === 'string' ? row.at : new Date().toISOString(),
        ...(typeof row.sig === 'string' ? { sig: row.sig } : {}),
      },
    ]
  })
}
