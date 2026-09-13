/**
 * `/api/rsvp` — app-side, per R9.
 *
 * POST   { eventUri, status, alsoPublicRecord? }
 * DELETE ?eventUri=
 *
 * `alsoPublicRecord: true` is the per-event opt-in that additionally writes
 * `community.lexicon.calendar.rsvp` into the MEMBER's own repo. Default off. Turning it
 * off again deletes that record.
 *
 * The response never includes anyone else's RSVP, only counts.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { deleteRsvp, myRsvp, rsvpCounts, upsertRsvp, RSVP_STATUSES, type RsvpStatus } from '../../lib/rsvp.js'
import { loadEvent } from './events.js'
import { actorAgent, NoActorCredentialError } from '../../lib/actor-agent.js'
import { NSID } from '../../lexicons/nsids.js'
import { tid } from '../../lib/ids.js'
import { enqueueNotification } from '../../notifications/dispatch.js'
import { getIndexer } from '../../index/indexer.js'
import { getRecordByUri, parseAtUri } from '../../index/queries.js'
import { getRecord } from '../../lib/pds.js'
import { resolvePdsEndpoint } from '../../lib/identity.js'
import { log } from '../../lib/logging.js'

export const rsvps = new Hono<AppEnv>()

const body = z.object({
  eventUri: z.string().startsWith('at://'),
  status: z.enum(['going', 'interested', 'notgoing']),
  alsoPublicRecord: z.boolean().default(false),
})

rsvps.post('/rsvp', requireViewer, async (c) => {
  const parsed = body.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest', allowed: RSVP_STATUSES }, 400)
  const viewer = c.var.viewer!
  const { eventUri, status, alsoPublicRecord } = parsed.data

  const loaded = await loadEvent(eventUri)
  if (!loaded) return c.json({ error: 'NotFound' }, 404)

  const existing = await myRsvp(eventUri, viewer.did)
  let publicRecordUri = existing?.publicRecordUri ?? null

  if (alsoPublicRecord) {
    try {
      publicRecordUri = await writePublicRsvp(viewer, eventUri, status, publicRecordUri)
    } catch (err) {
      if (err instanceof NoActorCredentialError) {
        return c.json({ error: 'ReauthRequired', message: 'sign in again to publish a public RSVP' }, 401)
      }
      throw err
    }
  } else if (publicRecordUri) {
    await deletePublicRsvp(viewer, publicRecordUri).catch(() => {
      /* best effort: the app-side row is the record of truth */
    })
    publicRecordUri = null
  }

  await upsertRsvp({ eventUri, did: viewer.did, status, alsoPublicRecord, publicRecordUri })

  // The host learns that someone RSVP'd. They are told WHO only because they will meet
  // them; the notification carries the DID in the body, not in a public record.
  if (status === 'going' && loaded.hostDid !== viewer.did) {
    await enqueueNotification({
      did: loaded.hostDid,
      category: 'rsvp.received',
      dedupKey: `rsvp.received:${eventUri}:${viewer.did}:going`,
      title: `Someone is coming to "${loaded.event.name ?? 'your class'}"`,
      navigate: `/events/${encodeURIComponent(eventUri)}`,
    })
  }

  return c.json({ ok: true, status, alsoPublicRecord, counts: await rsvpCounts(eventUri) })
})

rsvps.delete('/rsvp', requireViewer, async (c) => {
  const eventUri = c.req.query('eventUri')
  if (!eventUri) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  const removed = await deleteRsvp(eventUri, viewer.did)
  if (removed?.publicRecordUri) {
    await deletePublicRsvp(viewer, removed.publicRecordUri).catch(() => {})
  }
  return c.json({ ok: true, counts: await rsvpCounts(eventUri) })
})

/** My own RSVP for one event. A member may always read their own row. */
rsvps.get('/rsvp', requireViewer, async (c) => {
  const eventUri = c.req.query('eventUri')
  if (!eventUri) return c.json({ error: 'InvalidRequest' }, 400)
  const row = await myRsvp(eventUri, c.var.viewer!.did)
  return c.json({
    rsvp: row ? { status: row.status, alsoPublicRecord: row.alsoPublicRecord } : null,
    counts: await rsvpCounts(eventUri),
  })
})

async function writePublicRsvp(
  viewer: { did: string; kind: 'custodial' | 'oauth'; sessionId: string },
  eventUri: string,
  status: RsvpStatus,
  existingUri: string | null,
): Promise<string> {
  const agent = await actorAgent(viewer)
  const indexer = await getIndexer()
  // A strongRef needs the event's CID. The index has it; if it does not yet, the PDS does.
  const indexed = await getRecordByUri(indexer, 'event', eventUri)
  const cid = indexed?.cid ?? (await eventCidFromPds(eventUri))
  if (!cid) throw new Error('cannot pin a public RSVP: the event CID is unknown')
  const rkey = existingUri?.split('/').pop() ?? tid()
  const res = await agent.com.atproto.repo.putRecord({
    repo: viewer.did,
    collection: NSID.rsvp,
    rkey,
    record: {
      $type: NSID.rsvp,
      subject: { uri: eventUri, cid },
      status: `${NSID.rsvp}#${status}`,
      createdAt: new Date().toISOString(),
    } as Record<string, unknown>,
    validate: false,
  })
  await indexer.notify(res.data.uri).catch(() => {})
  return res.data.uri
}

async function deletePublicRsvp(
  viewer: { did: string; kind: 'custodial' | 'oauth'; sessionId: string },
  uri: string,
): Promise<void> {
  const rkey = uri.split('/').pop()
  if (!rkey) return
  const agent = await actorAgent(viewer)
  await agent.com.atproto.repo.deleteRecord({ repo: viewer.did, collection: NSID.rsvp, rkey })
  log.info('public rsvp withdrawn')
}

async function eventCidFromPds(eventUri: string): Promise<string | null> {
  const parts = parseAtUri(eventUri)
  if (!parts) return null
  const endpoint = await resolvePdsEndpoint(parts.did)
  if (!endpoint) return null
  const rec = await getRecord(parts.did, parts.collection, parts.rkey, endpoint)
  return rec?.cid ?? null
}
