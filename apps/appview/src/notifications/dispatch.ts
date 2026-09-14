/**
 * Notification dispatch.
 *
 * Four tables, each with one job:
 *
 *   fs_notification_target   where a DID can be reached (push endpoint / email address)
 *   fs_notification_pref     per (did, category, transport) opt-out; app state, never a
 *                            public record
 *   fs_notification_sent     the DEDUP LEDGER. Its primary key IS the claim: an
 *                            `insert … on conflict do nothing … returning` either wins
 *                            the right to send or tells us someone already did. This is
 *                            the only concurrency primitive here; no locks, no advisory
 *                            ids, safe across processes.
 *   fs_notification_outbox   one row per (notification x target), retried with backoff
 *
 * `feedback.received` payloads deliberately carry NO actor: telling a host "Alex left
 * you feedback" would undo the anonymity the ballot tables exist to protect.
 */
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import {
  notificationFeed,
  notificationOutbox,
  notificationPref,
  notificationSent,
  notificationTarget,
} from '../db/schema.js'
import { rowId } from '../lib/ids.js'
import { legacySchoolDid } from '../lib/schools.js'
import { schoolScope } from '../lib/school-scope.js'
import { declarativePayload, sendPush, type PushSubscriptionRecord } from '../lib/push.js'
import { sendMail } from '../lib/mail.js'
import { log } from '../lib/logging.js'

export const CATEGORIES = [
  'event.reminder',
  'event.changed',
  'event.cancelled',
  'rsvp.received',
  'rsvp.promoted',
  'offering.published',
  'member.joined',
  'feedback.received',
] as const
export type Category = (typeof CATEGORIES)[number]

/** Categories whose payload must never name an actor. */
export const ACTORLESS_CATEGORIES: ReadonlySet<Category> = new Set<Category>(['feedback.received'])

export type Transport = 'web-push' | 'email'

export interface EnqueueInput {
  did: string
  category: Category | string
  /** Stable across retries and across processes. */
  dedupKey: string
  title: string
  body?: string
  navigate?: string
  /** Anything transport-specific (an .ics attachment, say). */
  extra?: Record<string, unknown>
  /**
   * WHICH SCHOOL this is about (MS §4): so a feed row can say which one, and so one
   * school's notifications can be paused without touching another's. Transports and
   * preferences stay GLOBAL — one device, one inbox, preferences per category not per
   * city — which is why only the three ledger tables carry the column.
   */
  schoolDid?: string
}

export interface EnqueueResult {
  claimed: boolean
  targets: number
}

/**
 * Claim the dedup key, write the in-app feed row, and fan out to every enabled target.
 * Returns `claimed: false` when someone else already claimed this exact notification.
 */
export async function enqueueNotification(input: EnqueueInput): Promise<EnqueueResult> {
  const db = getDb()
  const category = input.category as Category
  if (ACTORLESS_CATEGORIES.has(category)) assertActorless(input)

  const schoolDid = input.schoolDid ?? legacySchoolDid()
  const claim = await db
    .insert(notificationSent)
    .values({ dedupKey: input.dedupKey, did: input.did, schoolDid, category })
    .onConflictDoNothing()
    .returning({ dedupKey: notificationSent.dedupKey })
  if (claim.length === 0) return { claimed: false, targets: 0 }

  await db.insert(notificationFeed).values({
    id: rowId(),
    did: input.did,
    schoolDid,
    category,
    title: input.title,
    body: input.body ?? null,
    navigate: input.navigate ?? null,
  })

  const targets = await enabledTargets(input.did, category)
  for (const t of targets) {
    await db.insert(notificationOutbox).values({
      id: rowId(),
      did: input.did,
      schoolDid,
      category,
      dedupKey: `${input.dedupKey}:${t.id}`,
      payload: {
        title: input.title,
        body: input.body ?? null,
        navigate: input.navigate ?? '/',
        targetId: t.id,
        transport: t.transport,
        ...(input.extra ?? {}),
      },
    })
  }
  await db.update(notificationSent).set({ sentAt: new Date() }).where(eq(notificationSent.dedupKey, input.dedupKey))
  return { claimed: true, targets: targets.length }
}

function assertActorless(input: EnqueueInput): void {
  const blob = JSON.stringify({ t: input.title, b: input.body, e: input.extra })
  if (/did:[a-z0-9]+:/.test(blob) || /\bactor\b/i.test(blob)) {
    throw new Error(`${input.category} payloads must not carry an actor`)
  }
}

async function enabledTargets(did: string, category: Category) {
  const db = getDb()
  const [targets, prefs] = await Promise.all([
    db
      .select()
      .from(notificationTarget)
      .where(and(eq(notificationTarget.did, did), sql`${notificationTarget.disabledAt} IS NULL`)),
    db
      .select()
      .from(notificationPref)
      .where(and(eq(notificationPref.did, did), eq(notificationPref.category, category))),
  ])
  const disabled = new Set(prefs.filter((p) => !p.enabled).map((p) => p.transport))
  return targets.filter((t) => !disabled.has(t.transport))
}

/* delivery */

export interface DeliverResult {
  attempted: number
  delivered: number
  failed: number
}

const BACKOFF_MS = [0, 60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000]
const MAX_ATTEMPTS = BACKOFF_MS.length

export async function deliverOutbox(limit = 100, now = new Date()): Promise<DeliverResult> {
  const db = getDb()
  const due = await db
    .select()
    .from(notificationOutbox)
    .where(and(eq(notificationOutbox.status, 'pending'), lte(notificationOutbox.nextAttemptAt, now)))
    .orderBy(asc(notificationOutbox.nextAttemptAt))
    .limit(limit)

  let delivered = 0
  let failed = 0
  for (const row of due) {
    const payload = row.payload as Record<string, unknown>
    const targetId = String(payload.targetId ?? '')
    const targets = await db.select().from(notificationTarget).where(eq(notificationTarget.id, targetId)).limit(1)
    const target = targets[0]
    if (!target || target.disabledAt) {
      await db
        .update(notificationOutbox)
        .set({ status: 'dropped', failureCode: 'no_target' })
        .where(eq(notificationOutbox.id, row.id))
      continue
    }

    const outcome = await deliverOne(target, payload)
    if (outcome.ok) {
      delivered++
      await db
        .update(notificationOutbox)
        .set({ status: 'delivered', deliveredAt: new Date(), attempts: row.attempts + 1 })
        .where(eq(notificationOutbox.id, row.id))
      if (target.failures > 0) {
        await db.update(notificationTarget).set({ failures: 0 }).where(eq(notificationTarget.id, target.id))
      }
      continue
    }

    failed++
    if (outcome.gone) {
      await db
        .update(notificationTarget)
        .set({ disabledAt: new Date() })
        .where(eq(notificationTarget.id, target.id))
    }
    const attempts = row.attempts + 1
    const exhausted = attempts >= MAX_ATTEMPTS || outcome.gone
    await db
      .update(notificationOutbox)
      .set({
        attempts,
        status: exhausted ? 'failed' : 'pending',
        failureCode: outcome.code,
        nextAttemptAt: new Date(now.getTime() + (BACKOFF_MS[Math.min(attempts, MAX_ATTEMPTS - 1)] ?? 0)),
      })
      .where(eq(notificationOutbox.id, row.id))
  }
  return { attempted: due.length, delivered, failed }
}

async function deliverOne(
  target: { transport: string; address: string; keys: unknown },
  payload: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; gone: boolean; code: string }> {
  const title = String(payload.title ?? 'Free School')
  const body = payload.body ? String(payload.body) : undefined
  const navigate = String(payload.navigate ?? '/')

  if (target.transport === 'web-push') {
    const keys = target.keys as { p256dh?: string; auth?: string } | null
    if (!keys?.p256dh || !keys.auth) return { ok: false, gone: true, code: 'bad_subscription' }
    const sub: PushSubscriptionRecord = { endpoint: target.address, keys: { p256dh: keys.p256dh, auth: keys.auth } }
    const res = await sendPush(sub, declarativePayload({ title, body, navigate }))
    return res.ok ? { ok: true } : { ok: false, gone: res.gone, code: res.code }
  }

  if (target.transport === 'email') {
    try {
      await sendMail({
        to: target.address,
        subject: title,
        text: `${body ?? title}\n\n${navigate}\n`,
        ...(typeof payload.ics === 'string' ? { ics: { filename: 'event.ics', content: payload.ics } } : {}),
      })
      return { ok: true }
    } catch {
      return { ok: false, gone: false, code: 'smtp_failed' }
    }
  }

  log.warn('unknown notification transport', { transport: target.transport })
  return { ok: false, gone: true, code: 'unknown_transport' }
}

/* targets & prefs */

export async function registerPushTarget(input: {
  did: string
  endpoint: string
  keys: { p256dh: string; auth: string }
}): Promise<{ id: string }> {
  const id = rowId()
  const rows = await getDb()
    .insert(notificationTarget)
    .values({ id, did: input.did, transport: 'web-push', address: input.endpoint, keys: input.keys })
    .onConflictDoUpdate({
      target: [notificationTarget.did, notificationTarget.transport, notificationTarget.address],
      set: { keys: input.keys, disabledAt: null, failures: 0 },
    })
    .returning({ id: notificationTarget.id })
  return { id: rows[0]?.id ?? id }
}

export async function registerEmailTarget(did: string, address: string): Promise<void> {
  await getDb()
    .insert(notificationTarget)
    .values({ id: rowId(), did, transport: 'email', address })
    .onConflictDoNothing()
}

export async function setPref(did: string, category: string, transport: Transport, enabled: boolean): Promise<void> {
  await getDb()
    .insert(notificationPref)
    .values({ did, category, transport, enabled })
    .onConflictDoUpdate({
      target: [notificationPref.did, notificationPref.category, notificationPref.transport],
      set: { enabled },
    })
}

/** This member's notifications FROM THIS SCHOOL. Only ever the viewer's own rows (MS §10). */
export async function listNotifications(did: string, limit = 50, schoolDid = legacySchoolDid()) {
  return getDb()
    .select()
    .from(notificationFeed)
    .where(and(eq(notificationFeed.did, did), schoolScope(notificationFeed.schoolDid, schoolDid)))
    .orderBy(sql`${notificationFeed.createdAt} DESC`)
    .limit(limit)
}

export async function markRead(did: string, ids: string[], schoolDid = legacySchoolDid()): Promise<void> {
  if (ids.length === 0) return
  await getDb()
    .update(notificationFeed)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notificationFeed.did, did),
        schoolScope(notificationFeed.schoolDid, schoolDid),
        inArray(notificationFeed.id, ids),
      ),
    )
}
