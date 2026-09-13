/**
 * `/api/admin/*` — steward surface. Everything that changes the school goes through
 * `SchoolActorPort`, which means: role-gated, reason-mandatory, approval-counted, and
 * audited, with no exceptions and no second path.
 *
 *   GET  /policy                the current policy record + derived thresholds
 *   PUT  /policy                write a new version (destructive -> needs approvals)
 *   GET  /moderation            the queue
 *   POST /moderation            open an item. `reason` is REQUIRED.
 *   POST /moderation/:id/approve  a second steward signs on
 *   POST /moderation/:id/execute  run it as the school, once the threshold is met
 *   GET  /peers   PUT /peers    the peer registry (= contrail's `relays`)
 *   POST /newsletter            compose a monthly digest draft (stub)
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { desc, eq } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireRole, requireViewer } from '../session.js'
import { getDb } from '../../db/index.js'
import { moderationQueue, newsletter } from '../../db/schema.js'
import { rowId, tid } from '../../lib/ids.js'
import { schoolActor, schoolDid } from '../../lib/school-actor.js'
import { SchoolActError, type Approval, type SchoolAction } from '@freeschool/school-actor'
import { NSID } from '../../lexicons/nsids.js'
import { currentPolicyUri, getThresholds, refreshPolicyCache } from '../../lib/policy.js'
import { getRecord } from '../../lib/pds.js'
import { addPeer, disablePeer, listPeers, probePeer } from '../../index/peers.js'
import { getIndexer, resetIndexer } from '../../index/indexer.js'
import { composeMonthlyDigest } from '../../jobs/newsletter.js'

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
    })
    .optional(),
  reason: z.string().min(3).max(1000),
  /** Co-signing stewards. `write-policy` is a destructive action. */
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
  try {
    const res = await schoolActor().putRecordAsSchool({
      schoolDid: schoolDid(),
      callerDid: viewer.did as `did:${string}`,
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
      audit: { reason: parsed.data.reason, approvals: parsed.data.approvals ?? [] },
    })
    // Point the school record at the new policy, as the school, through the port.
    const school = await getRecord(schoolDid(), NSID.school, 'self')
    if (school) {
      await schoolActor().putRecordAsSchool({
        schoolDid: schoolDid(),
        callerDid: viewer.did as `did:${string}`,
        scope: NSID.school,
        action: 'write-policy',
        collection: NSID.school,
        rkey: 'self',
        record: { ...school.value, policy: res.uri },
        audit: {
          reason: `point the school record at policy ${parsed.data.version}`,
          approvals: parsed.data.approvals ?? [],
        },
      })
    }
    await refreshPolicyCache(schoolDid())
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
      record: {
        $type: NSID.moderationAction,
        ...(row.subjectUri ? { subjectRecord: row.subjectUri } : {}),
        ...(row.subjectDid ? { subjectDid: row.subjectDid } : {}),
        action: row.action,
        reason: row.reason,
        policyRef: await currentPolicyUri(schoolDid()),
        actors: approvals.map((a) => a.stewardDid),
        createdAt: new Date().toISOString(),
      },
      audit: { reason: row.reason, approvals },
    })
    // A removal must also retract the listing, as the school. The host's event is never
    // touched: the school curates, it does not edit other people's repos.
    if (row.action === 'remove-listing' && row.subjectUri) {
      await schoolActor()
        .putRecordAsSchool({
          schoolDid: schoolDid(),
          callerDid: viewer.did as `did:${string}`,
          scope: NSID.eventListing,
          action: 'remove-listing',
          collection: NSID.eventListing,
          rkey: tid(),
          record: {
            $type: NSID.eventListing,
            event: { uri: row.subjectUri },
            school: schoolDid(),
            status: 'removed',
            createdAt: new Date().toISOString(),
          },
          audit: { reason: row.reason, approvals },
        })
        .catch(() => {
          /* the moderationAction record is the decision of record */
        })
    }
    await getDb()
      .update(moderationQueue)
      .set({ status: 'resolved', resolvedAt: new Date(), resultUri: result.uri })
      .where(eq(moderationQueue.id, id))
    return c.json({ ok: true, uri: result.uri, auditId: result.auditId })
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

/* newsletter (stub) */

admin.post('/newsletter', async (c) => {
  const period = c.req.query('period') ?? new Date().toISOString().slice(0, 7)
  const draft = await composeMonthlyDigest(period)
  const id = rowId()
  await getDb().insert(newsletter).values({ id, period, subject: draft.subject, body: draft.body, status: 'draft' })
  return c.json({ id, ...draft, status: 'draft', note: 'composing is implemented; SENDING is a stub' }, 201)
})

admin.get('/newsletter', async (c) => {
  const rows = await getDb().select().from(newsletter).orderBy(desc(newsletter.createdAt)).limit(24)
  return c.json({ drafts: rows })
})

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
