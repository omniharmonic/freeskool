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
 *   GET  /peers   PUT /peers    the peer registry (= contrail's `relays`), published as
 *                               `freeschool.draft.school#peers`/`#tags` by the school actor
 *   GET  /newsletter   POST /newsletter          list / compose a monthly digest draft
 *   POST /newsletter/:id/send   send a draft to every subscribed member (see
 *                               ../../jobs/newsletter.ts)
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, desc, eq, isNull, ne } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireRole, requireViewer } from '../session.js'
import { config } from '../../config.js'
import { getDb } from '../../db/index.js'
import { appMeta, attendance, moderationQueue, newsletterIssue, skillProposal } from '../../db/schema.js'
import { rowId, tid } from '../../lib/ids.js'
import { bumpTally } from '../../lib/roles.js'
import { actorFor, asDid } from '../../lib/school-actors.js'
import { currentSchool } from '../school-context.js'
import { schoolScope } from '../../lib/school-scope.js'
import { SchoolActError, type Approval, type SchoolAction } from '@freeschool/school-actor'
import { NSID } from '../../lexicons/nsids.js'
import { currentPolicyUri, getThresholds, refreshPolicyCache } from '../../lib/policy.js'
import { getRecord } from '../../lib/pds.js'
import { getRecordByUri, parseAtUri } from '../../index/queries.js'
import { resolvePdsEndpoint } from '../../lib/identity.js'
import { addPeer, disablePeer, listPeers, probePeer } from '../../index/peers.js'
import { peerHostsFor, publishedPeerState, publishPeerState, reloadIndexerForPeers } from '../../lib/peers.js'
import { normalizePeerHost } from '../../sync/cursor-map.js'
import { getIndexer } from '../../index/indexer.js'
import { composeNewsletterIssue, sendNewsletterIssue } from '../../jobs/newsletter.js'
import { authorityClient } from '../../lib/authority.js'
import { skillRecords } from './skills.js'
// `handlesForDids` lives in `me.ts` (DID -> handle, custodial account first, then the
// index's `identities` table); `lib/members.ts` imports it from there rather than
// duplicating it, and so do we.
import { handlesForDids } from './me.js'
import { describeError, log } from '../../lib/logging.js'

export const admin = new Hono<AppEnv>()

admin.use('*', requireViewer, requireRole(Role.Steward))

/* policy */

admin.get('/policy', async (c) => {
  const did = currentSchool(c).did
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
  const did = currentSchool(c).did
  const caller = viewer.did as `did:${string}`
  const actor = await actorFor(did)
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
      await actor.putRecordAsSchool({
        schoolDid: asDid(did),
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
      res = await actor.putRecordAsSchool({
        schoolDid: asDid(did),
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
        await actor
          .putRecordAsSchool({
            schoolDid: asDid(did),
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
    'remove-resource',
    'restore-resource',
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
  const did = currentSchool(c).did
  const status = c.req.query('status') ?? 'open'
  const rows = await getDb()
    .select()
    .from(moderationQueue)
    // A steward sees their OWN school's case file and no other (MS §10): not the reason,
    // not the subject, not that a case exists.
    .where(and(eq(moderationQueue.status, status), schoolScope(moderationQueue.schoolDid, did)))
    .orderBy(desc(moderationQueue.createdAt))
    .limit(100)
  const thresholds = await getThresholds(did)
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
    schoolDid: currentSchool(c).did,
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
  const did = currentSchool(c).did
  const rows = await getDb()
    .select()
    .from(moderationQueue)
    .where(and(eq(moderationQueue.id, id), schoolScope(moderationQueue.schoolDid, did)))
    .limit(1)
  const row = rows[0]
  if (!row) return c.json({ error: 'NotFound' }, 404)
  const approvals = asApprovals(row.approvals)
  if (approvals.some((a) => a.stewardDid === viewer.did)) {
    return c.json({ error: 'AlreadyApproved', approvals }, 409)
  }
  const next: Approval[] = [...approvals, { stewardDid: viewer.did as `did:${string}`, at: new Date().toISOString() }]
  await getDb().update(moderationQueue).set({ approvals: next }).where(eq(moderationQueue.id, id))
  const thresholds = await getThresholds(did)
  return c.json({ approvals: next, required: thresholds.destructiveActionStewards })
})

admin.post('/moderation/:id/execute', async (c) => {
  const id = c.req.param('id')
  const viewer = c.var.viewer!
  const did = currentSchool(c).did
  const actor = await actorFor(did)
  const rows = await getDb()
    .select()
    .from(moderationQueue)
    .where(and(eq(moderationQueue.id, id), schoolScope(moderationQueue.schoolDid, did)))
    .limit(1)
  const row = rows[0]
  if (!row) return c.json({ error: 'NotFound' }, 404)
  if (row.status !== 'open') return c.json({ error: 'AlreadyResolved', status: row.status }, 409)

  if ((row.action === 'remove-resource' || row.action === 'restore-resource') && !row.subjectUri?.includes(`/${NSID.resource}/`)) return c.json({error:'InvalidRequest',message:'Choose a resource record to moderate.'},400)

  /**
   * INTEROP GAP 3. A `coop.lexicon.event.listing`'s `event` is a
   * `com.atproto.repo.strongRef`, which requires BOTH `uri` and `cid`. We used to write
   * the uri alone, so a peer that validates the record dropped it — and a dropped
   * removal leaves a moderated class listed on someone else's calendar, the worst
   * possible direction for a moderation failure.
   *
   * The ref is resolved BEFORE anything is written (index first, the host's PDS second)
   * and the whole action is refused if neither answers: a decision record whose effect
   * cannot be published is worse than an item that stays open and can be retried.
   */
  let eventRef: { uri: string; cid: string } | undefined
  if ((row.action === 'remove-listing' || row.action === 'restore-listing') && row.subjectUri) {
    const cid = await resolveEventCid(row.subjectUri)
    if (!cid)
      return c.json(
        {
          error: 'UnresolvableSubject',
          message: 'Could not read the current version of that class record, so the listing would be invalid. Try again once it is reachable.',
        },
        409,
      )
    eventRef = { uri: row.subjectUri, cid }
  }
  const approvals = asApprovals(row.approvals)
  try {
    const result = await actor.putRecordAsSchool({
      schoolDid: asDid(did),
      callerDid: viewer.did as `did:${string}`,
      scope: NSID.moderationAction,
      action: row.action as SchoolAction,
      collection: NSID.moderationAction,
      rkey: tid(),
      record: publicModerationRecord(row.action, await currentPolicyUri(did), approvals),
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
    if (eventRef && (row.action === 'remove-listing' || row.action === 'restore-listing')) {
      const status = row.action === 'remove-listing' ? 'removed' : 'listed'
      const listing = await actor
        .putRecordAsSchool({
          schoolDid: asDid(did),
          callerDid: viewer.did as `did:${string}`,
          scope: NSID.eventListing,
          action: row.action,
          collection: NSID.eventListing,
          rkey: tid(),
          record: {
            $type: NSID.eventListing,
            event: eventRef,
            school: did,
            status,
            createdAt: new Date().toISOString(),
          },
          audit: { reason: row.reason, approvals },
        })
        .catch(() => undefined)
      effects.listing = listing ? { uri: listing.uri, status } : null
    }

    if ((row.action === 'remove-resource' || row.action === 'restore-resource') && row.subjectUri) {
      const hidden = row.action === 'remove-resource'
      await getDb().insert(appMeta).values({key:`resource-hidden:${row.subjectUri}`,value:hidden,updatedAt:new Date()}).onConflictDoUpdate({target:appMeta.key,set:{value:hidden,updatedAt:new Date()}})
      effects.resource = { hidden }
    }

    // A3: void-attendance actually voids it. The subject is the app-side row's
    // `subject_uri` (the event) and/or `subject_did` (the person) — whichever the steward
    // gave: an event alone voids the whole sheet, a DID alone voids that person's
    // attendance everywhere, both narrows to one row.
    if (row.action === 'void-attendance' && (row.subjectUri || row.subjectDid)) {
      effects.attendanceVoided = await voidAttendance(row.subjectUri, row.subjectDid, did)
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

/**
 * THE PEER LIST IS TWO THINGS, and this route keeps them in step (ruling 9, gap 4b):
 *
 *   `fs_peer`  — the PDS hosts THIS AppView follows for this school. Local, private,
 *                per school, and what contrail is handed as `relays`.
 *   the record — `freeschool.draft.school#peers` / `#tags` in the school's own repo,
 *                written by the school actor. PUBLIC, and the only thing a peer can
 *                read: it is the source of truth another city discovers us by.
 *
 * `GET` returns both, so the admin screen can show what the world sees rather than only
 * what our database holds.
 */
admin.get('/peers', async (c) => {
  const did = currentSchool(c).did
  const peers = await listPeers(did)
  const probed = c.req.query('probe') === '1' ? await Promise.all(peers.map((p) => probePeer(p.host))) : undefined
  return c.json({ peers, probed, published: await publishedPeerState(did) })
})

/**
 * `add`/`remove` take a PDS host (`https://pds.denver.example`) or a peer school's DID —
 * a DID is resolved to its endpoint, because a peer is a school, not a machine, and that
 * is also the form the record publishes.
 */
const peerRef = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((v) => v.startsWith('did:') || /^https?:\/\//.test(v), 'a peer is a https:// PDS host or a did:')

const peersBody = z.object({
  add: z.array(peerRef).max(50).optional(),
  remove: z.array(peerRef).max(50).optional(),
  /** The tags this school routes listings on. Omit to leave the published tags alone. */
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
})

admin.put('/peers', async (c) => {
  const parsed = peersBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const school = currentSchool(c)
  const did = school.did
  const caller = c.var.viewer!.did

  const add = await splitPeerRefs(parsed.data.add ?? [])
  const remove = await splitPeerRefs(parsed.data.remove ?? [])
  const current = await peerHostsFor(did)
  const removeHosts = new Set(remove.hosts)
  const nextHosts = [...new Set([...current, ...add.hosts])].filter((h) => !removeHosts.has(h))
  const tags = parsed.data.tags
    ? [...new Set(parsed.data.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]
    : undefined

  /**
   * ORDER: THE RECORD FIRST, THE TABLE SECOND.
   *
   * The record is what a peer reads and the table is only what we follow, so of the two
   * half-applied states the survivable one is "published but not yet followed" — our own
   * backfill closes that on its next tick. The other way round, a steward is told the
   * peering happened while the world still sees the old list, with nothing to repair it.
   * `publishPeerState` throws when the actor refuses, and `fs_peer` is then untouched.
   */
  let published: Awaited<ReturnType<typeof publishPeerState>>
  try {
    published = await publishPeerState({
      schoolDid: did,
      callerDid: caller,
      hosts: nextHosts,
      addDids: add.dids,
      removeDids: remove.dids,
      ...(tags ? { tags } : {}),
      school,
    })
  } catch (err) {
    if (err instanceof SchoolActError) {
      const { body, status } = schoolErrorBody(err)
      return c.json(body, status)
    }
    log.warn('publishing the peer list failed; the peer table is unchanged', { detail: describeError(err) })
    return c.json(
      { error: 'PeerPublishFailed', message: 'the school record could not be republished; nothing was changed' },
      502,
    )
  }

  for (const host of add.hosts) await addPeer(host, 'admin', did)
  for (const host of remove.hosts) await disablePeer(host, did)

  // The peer list IS contrail's `relays` — the UNION across schools, since the index is
  // global (MS §4) — so the indexer is rebuilt, whichever school edited it, but only when
  // the union actually changed.
  await reloadIndexerForPeers()
  if (published.uri) {
    const indexer = await getIndexer()
    await indexer.notify(published.uri).catch(() => {})
  }
  return c.json({ peers: await listPeers(did), published })
})

/**
 * A mixed list of hosts and DIDs, split; a DID's PDS endpoint becomes a host to follow.
 *
 * Every host is NORMALIZED here (`https://pds.example/` and `https://pds.example` are the
 * same peer), because the add/remove sets are compared against the school's current hosts
 * — which `peerHostsFor` normalizes — to decide what the record publishes. Without it a
 * removal spelled with a trailing slash disabled the row and left the peer in the record.
 */
async function splitPeerRefs(refs: string[]): Promise<{ hosts: string[]; dids: string[] }> {
  const hosts = new Set<string>()
  const dids: string[] = []
  const host = (raw: string) => {
    try {
      hosts.add(normalizePeerHost(raw))
    } catch {
      log.warn('ignoring a peer host that is not a URL')
    }
  }
  for (const ref of refs) {
    if (!ref.startsWith('did:')) {
      host(ref)
      continue
    }
    dids.push(ref)
    const endpoint = await resolvePdsEndpoint(ref).catch(() => null)
    // Unresolvable: the affiliation is still published (the steward asserted it), we just
    // cannot follow that school's repo yet. The next backfill retries nothing — a steward
    // re-adding it once the DID resolves is the repair, and `GET /peers` shows the gap.
    if (endpoint) host(endpoint)
    else log.warn('a peer DID could not be resolved to a PDS endpoint; publishing it unfollowed')
  }
  return { hosts: [...hosts], dids }
}

/* newsletter */

admin.post('/newsletter', async (c) => {
  const period = c.req.query('period') ?? new Date().toISOString().slice(0, 7)
  const draft = await composeNewsletterIssue(period, currentSchool(c).did)
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
    .where(schoolScope(newsletterIssue.schoolDid, currentSchool(c).did))
    .orderBy(desc(newsletterIssue.month))
    .limit(24)
  return c.json({ drafts: rows })
})

admin.post('/newsletter/:id/send', async (c) => {
  const id = c.req.param('id')
  const result = await sendNewsletterIssue(id, currentSchool(c).did)
  if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status as 404 | 409)
  return c.json({ ok: true, recipientCount: result.recipientCount })
})

/* skill taxonomy (R-6: proposals publish immediately; a steward's only levers are
 * deprecate and move) */

/** `false` when the authority credential this router needs isn't configured — the
 * same 503 shape `POST /api/skills` uses, so a steward sees the same story a member does. */
function authorityUnconfigured(): boolean {
  const c = config()
  return !c.AUTHORITY_DID || !c.AUTHORITY_HANDLE || !c.AUTHORITY_PASSWORD
}

/** The path from the taxonomy root to this skill, as labels — same ancestor walk
 * `GET /api/skills/:id` does, over the SAME already-fetched record set (one query, not
 * one per row of the proposal queue). */
function pathFor(byUri: Map<string, { uri: string; value: { label: string; broader?: string[] } }>, uri: string): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  let cursor = byUri.get(uri)
  while (cursor && !seen.has(cursor.uri)) {
    labels.unshift(cursor.value.label)
    seen.add(cursor.uri)
    const parentUri = cursor.value.broader?.[0]
    cursor = parentUri ? byUri.get(parentUri) : undefined
  }
  return labels
}

/**
 * The proposal queue. Every `fs_skill_proposal` row, joined against the indexed record
 * for its current label/status/path (a proposal can be deprecated or moved after the
 * fact, and the record — not the row written at proposal time — is the truth for that).
 * The proposer is shown as a HANDLE, never a bare DID (R9's spirit: this is a steward
 * surface, not a public one, but there is no reason to show more than a handle here).
 *
 * `'failed'` rows are excluded (review round 1, blocking #2): those are proposals whose
 * authority write never actually happened — nothing for a steward to act on. A
 * `'pending'` row (the authority write succeeded but the follow-up bookkeeping didn't)
 * DOES still show, since its skill record is genuinely live.
 */
admin.get('/skills/proposals', async (c) => {
  const rows = await getDb()
    .select()
    .from(skillProposal)
    // Attribution is per school (MS §6): the taxonomy is shared, the proposal queue is
    // this school's own.
    .where(and(ne(skillProposal.status, 'failed'), schoolScope(skillProposal.schoolDid, currentSchool(c).did)))
    .orderBy(desc(skillProposal.createdAt))
    .limit(200)
  const indexer = await getIndexer()
  const records = await skillRecords(indexer)
  const byUri = new Map(records.map((r) => [r.uri, r]))
  const handles = await handlesForDids(rows.map((r) => r.proposerDid))

  return c.json({
    proposals: rows.map((r) => {
      const record = byUri.get(r.skillUri)
      return {
        // The web-facing id is the skill's OWN rkey (not the app-side proposal row id) —
        // `POST /skills/:id/deprecate` and `/move` below take the same id.
        id: record?.value.id ?? r.skillUri.split('/').pop(),
        skillUri: r.skillUri,
        label: record?.value.label,
        status: record?.value.status ?? r.status,
        path: pathFor(byUri, r.skillUri),
        proposerHandle: handles[r.proposerDid],
        proposedAt: r.createdAt,
      }
    }),
  })
})

const deprecateBody = z.object({ replacedBy: z.string().startsWith('at://').optional() })

/** `:id` is the SKILL's rkey (e.g. `bike-repair`), not the `fs_skill_proposal` row id —
 * the proposal record above already gives the web picker that rkey as `id`. */
admin.post('/skills/:id/deprecate', async (c) => {
  if (authorityUnconfigured()) return c.json({ error: 'AuthorityUnavailable' }, 503)
  const parsed = deprecateBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)

  const uri = `at://${config().AUTHORITY_DID}/${NSID.skill}/${c.req.param('id')}`

  // review round 1, should-fix #4: the authority call and its follow-up (the DB row and
  // the indexer notify) are separate failure domains and must not be reported the same
  // way — once `deprecateSkill` returns, the record IS deprecated, so a follow-up
  // failure is bookkeeping, never an `AuthorityError`.
  let result: { uri: string; cid: string }
  try {
    result = await authorityClient().deprecateSkill(uri, parsed.data.replacedBy)
  } catch (err) {
    log.warn('admin: skill deprecate failed at the authority', { code: describeError(err) })
    return c.json({ error: 'AuthorityError' }, 502)
  }

  try {
    await getDb().update(skillProposal).set({ status: 'deprecated' }).where(eq(skillProposal.skillUri, result.uri))
    const indexer = await getIndexer()
    await indexer.notify(result.uri)
  } catch (err) {
    log.warn('admin: skill deprecate follow-up failed', { code: describeError(err) })
  }

  return c.json({ uri: result.uri, status: 'deprecated' })
})

const moveBody = z.object({ parentUri: z.string().startsWith('at://') })

admin.post('/skills/:id/move', async (c) => {
  if (authorityUnconfigured()) return c.json({ error: 'AuthorityUnavailable' }, 503)
  const parsed = moveBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)

  const uri = `at://${config().AUTHORITY_DID}/${NSID.skill}/${c.req.param('id')}`

  // Same separation as `/deprecate` above: the move itself vs. the notify follow-up.
  let result: { uri: string; cid: string }
  try {
    result = await authorityClient().moveSkill(uri, parsed.data.parentUri)
  } catch (err) {
    log.warn('admin: skill move failed at the authority', { code: describeError(err) })
    return c.json({ error: 'AuthorityError' }, 502)
  }

  try {
    const indexer = await getIndexer()
    await indexer.notify(result.uri)
  } catch (err) {
    log.warn('admin: skill move follow-up failed', { code: describeError(err) })
  }

  return c.json({ uri: result.uri, broader: [parsed.data.parentUri] })
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
async function voidAttendance(subjectUri: string | null, subjectDid: string | null, schoolDid: string): Promise<number> {
  const db = getDb()
  const where = [isNull(attendance.voidedAt), schoolScope(attendance.schoolDid, schoolDid)]
  if (subjectUri) where.push(eq(attendance.eventUri, subjectUri))
  if (subjectDid) where.push(eq(attendance.attendeeDid, subjectDid))
  const voided = await db
    .update(attendance)
    .set({ voidedAt: new Date() })
    .where(and(...where))
    .returning({ attendeeDid: attendance.attendeeDid, participated: attendance.participated })
  for (const r of voided) {
    if (r.participated) await bumpTally(r.attendeeDid, { attendedConfirmed: -1 }, schoolDid)
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

/**
 * The current cid of an event record: the indexed copy first (no network), the host's
 * own PDS second. `null` means we cannot build a valid strongRef for it — see the
 * refusal in `POST /moderation/:id/execute`.
 */
async function resolveEventCid(uri: string): Promise<string | null> {
  try {
    const indexed = await getRecordByUri(await getIndexer(), 'event', uri)
    if (indexed?.cid) return indexed.cid
  } catch {
    /* the index is not the only source; fall through to the PDS */
  }
  try {
    const parts = parseAtUri(uri)
    if (!parts) return null
    const endpoint = await resolvePdsEndpoint(parts.did)
    if (!endpoint) return null
    return (await getRecord(parts.did, parts.collection, parts.rkey, endpoint))?.cid ?? null
  } catch {
    return null
  }
}
