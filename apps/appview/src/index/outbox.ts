/**
 * The transactional outbox consumer.
 *
 * contrail appends one compact URI/version reference per winning put/delete inside the
 * same transaction as the projection, then lets us lease a batch
 * (`changes.claim` → `changes.hydrate` → `changes.ack` / `changes.fail`). Delivery is
 * AT LEAST ONCE, so every handler below is keyed by a stable record URI and is safe to
 * re-run.
 *
 * `initial: 'future'` (see src/contrail.config.ts) means the consumer's first durable
 * position is the current head: we never replay history into notifications.
 */
import { NSID } from '../lexicons/nsids.js'
import { describeError, log } from '../lib/logging.js'
import type { Indexer } from './indexer.js'
import { refreshPolicyCache } from '../lib/policy.js'
import { syncPeersFromSchoolRecord } from './peers.js'
import { enqueueNotification } from '../notifications/dispatch.js'
import { openFeedbackWindow } from '../lib/feedback.js'
import { rsvpDidsFor } from '../lib/rsvp.js'

export interface OutboxResult {
  claimed: number
  handled: number
}

export async function drainOutbox(indexer: Indexer, limit = 200): Promise<OutboxResult> {
  const claim = await indexer.contrail.changes.claim(
    'notify',
    { maxChanges: limit, leaseMs: 30_000 },
    indexer.db,
  )
  if (!claim) return { claimed: 0, handled: 0 }
  try {
    const batch = await indexer.contrail.changes.hydrate(claim, indexer.db)
    const byUri = new Map(batch.currentRecords.map((r) => [r.uri, r]))
    let handled = 0
    for (const change of batch.changes) {
      const current = byUri.get(change.uri)
      await handleChange(change.collection, change.uri, change.operation, current?.value ?? null)
      handled++
    }
    await indexer.contrail.changes.ack(claim, undefined, indexer.db)
    return { claimed: batch.changes.length, handled }
  } catch (err) {
    // Only a bounded category is ever persisted — never the upstream error text.
    await indexer.contrail.changes.fail(
      claim,
      { code: 'handler_failed', nextAttemptAt: Date.now() + 30_000 },
      undefined,
      indexer.db,
    )
    log.warn('outbox batch failed', { code: 'handler_failed', detail: describeError(err) })
    return { claimed: 0, handled: 0 }
  }
}

async function handleChange(
  collection: string,
  uri: string,
  operation: 'put' | 'delete',
  record: unknown,
): Promise<void> {
  const value = (record ?? {}) as Record<string, unknown>
  switch (collection) {
    case NSID.school: {
      const peers = Array.isArray(value.peers) ? (value.peers as string[]) : []
      const schoolDid = uri.slice('at://'.length).split('/')[0]
      if (schoolDid) await syncPeersFromSchoolRecord(peers, schoolDid)
      return
    }
    case NSID.policy: {
      await refreshPolicyCache()
      return
    }
    case NSID.event: {
      if (operation === 'delete') {
        await fanOut(uri, 'event.cancelled', String(value.name ?? 'A class'))
        return
      }
      const status = typeof value.status === 'string' ? value.status : ''
      if (status.endsWith('#cancelled')) {
        await fanOut(uri, 'event.cancelled', String(value.name ?? 'A class'))
        return
      }
      if (typeof value.endsAt === 'string' || typeof value.startsAt === 'string') {
        await openFeedbackWindow(uri, String(value.endsAt ?? value.startsAt))
      }
      await fanOut(uri, 'event.changed', String(value.name ?? 'A class'))
      return
    }
    case NSID.eventListing: {
      const eventUri = refUri(value.event)
      if (operation === 'put' && value.status !== 'removed' && eventUri) {
        await fanOut(eventUri, 'offering.published', 'A new class was listed')
      }
      return
    }
    case NSID.membership: {
      if (operation === 'put' && typeof value.subject === 'string') {
        await enqueueNotification({
          did: value.subject,
          category: 'member.joined',
          dedupKey: `member.joined:${value.subject}:${uri}`,
          title: 'Welcome to Free School',
          body: 'Your membership is recorded.',
          navigate: '/me',
        })
      }
      return
    }
    default:
      return
  }
}

/** Notify everyone who RSVP'd app-side. RSVPs never leave our tables to do this. */
async function fanOut(eventUri: string, category: 'event.changed' | 'event.cancelled' | 'offering.published', title: string): Promise<void> {
  const dids = await rsvpDidsFor(eventUri)
  for (const did of dids) {
    await enqueueNotification({
      did,
      category,
      dedupKey: `${category}:${eventUri}:${did}`,
      title,
      body: category === 'event.cancelled' ? 'This class was cancelled.' : 'Details changed.',
      navigate: `/events/${encodeURIComponent(eventUri)}`,
    })
  }
}

function refUri(ref: unknown): string | null {
  if (ref && typeof ref === 'object' && typeof (ref as { uri?: unknown }).uri === 'string') {
    return (ref as { uri: string }).uri
  }
  return null
}
