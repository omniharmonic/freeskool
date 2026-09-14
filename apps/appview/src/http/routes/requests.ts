/**
 * `/api/requests` — "someone should teach this".
 *
 *   GET  /requests                   open requests, from the index
 *   POST /requests                   a member asks for a class (their OWN repo)
 *   POST /requests/:id/claim         a host says "I'll teach it" (their OWN repo), and
 *                                    optionally links the event they just created
 *
 * Requests and claims live in the asker's / claimer's repo, not the school's: a request
 * is a personal statement of interest and must survive the school.
 *
 * `GET /requests` IS PUBLIC AND STAYS PUBLIC — the needs board is the front door of the
 * whole idea — but it does not hand out `askedBy` (A7). Only the asker themselves and a
 * steward (who needs it to moderate) get that field. The record it comes from is public and
 * self-authored, so nothing here is secret; what was wrong was serving an identified ROSTER
 * as a field of its own, which is what makes scraping one.
 *
 * KNOWN AND DELIBERATE LIMIT: `uri` is an AT-URI, and its authority segment is the asker's
 * DID. It cannot be withheld — it is the record's address, and every follow-up call
 * (`/requests/:id/rsvp`, `/requests/:id/claim`) takes it — so a determined reader can still
 * parse an asker out of it. Hiding that would mean an AppView-local opaque id, i.e. a second
 * identity namespace to keep in sync, which this codebase has deliberately not built (see
 * `routes/events.ts`'s note on `:id`). What A7 closes is the easy path: a field literally
 * named "who asked for this", present on every row, served to anyone.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireRole, requireViewer } from '../session.js'
import { roleOf } from '../../lib/roles.js'
import { actorAgent, NoActorCredentialError } from '../../lib/actor-agent.js'
import { NSID } from '../../lexicons/nsids.js'
import { tid } from '../../lib/ids.js'
import { getIndexer } from '../../index/indexer.js'
import { getRecordByUri, listCollection, parseAtUri, sidecarsForEvent } from '../../index/queries.js'
import { getRecord } from '../../lib/pds.js'
import { resolvePdsEndpoint } from '../../lib/identity.js'
import { countInterested, isInterested, meetsThreshold, toggleInterest } from '../../lib/request-rsvp.js'
import { createRequest } from '../../lib/requests.js'
import { currentSchool } from '../school-context.js'
import { schoolsOfEvents } from '../../lib/event-school.js'

export const requests = new Hono<AppEnv>()

interface RequestRecord {
  title: string
  description?: string
  skill?: string
  threshold?: number
  status: 'open' | 'claimed' | 'scheduled' | 'closed'
  createdAt: string
}

requests.get('/requests', async (c) => {
  const status = c.req.query('status') ?? 'open'
  const skill = c.req.query('skill')
  const indexer = await getIndexer()
  const { records, cursor } = await listCollection<RequestRecord>(indexer, 'request', {
    filters: { status, ...(skill ? { skill } : {}) },
    limit: Number(c.req.query('limit') ?? 50),
    ...(c.req.query('cursor') ? { cursor: c.req.query('cursor')! } : {}),
  })
  // The optional-session pattern, as in `calendar.ts`: `c.var.viewer` is set by
  // `withViewer` for a signed-in caller and absent otherwise — the route itself is not
  // gated. One role lookup for the page, not one per row.
  const viewer = c.var.viewer
  const schoolDid = currentSchool(c).did
  const viewerIsSteward = viewer ? (await roleOf(viewer.did, schoolDid)) >= Role.Steward : false
  const items = await Promise.all(records.map(async r => {
    const claims = await sidecarsForEvent<{ event?: { uri: string } }>(indexer, 'claim', r.uri, 'request.uri')
    const scheduled = claims.find(claim => claim.value.event?.uri)
    return {
      uri: r.uri,
      ...(viewerIsSteward || viewer?.did === r.did ? { askedBy: r.did } : {}),
      title: r.value.title,
      description: r.value.description,
      skill: r.value.skill,
      threshold: r.value.threshold,
      status: r.value.status === 'closed' ? 'closed' : scheduled ? 'scheduled' : claims.length ? 'claimed' : r.value.status,
      claims: claims.length,
      ...(scheduled ? { scheduledEventUri: scheduled.value.event!.uri } : {}),
      viewerClaimed: claims.some(claim => claim.did === viewer?.did),
      rsvpCount: await countInterested(r.uri, schoolDid),
      viewerInterested: viewer ? await isInterested(r.uri, viewer.did, schoolDid) : false,
    }
  }))
  return c.json({ cursor, requests: items })
})

requests.post('/requests/:id/rsvp', requireViewer, async (c) => {
  const requestUri = decodeURIComponent(c.req.param('id'))
  const result = await toggleInterest(requestUri, c.var.viewer!.did, currentSchool(c).did)
  return c.json(result)
})

const createBody = z.object({
  title: z.string().min(3).max(300),
  description: z.string().max(20_000).optional(),
  skill: z.string().startsWith('at://').optional(),
  threshold: z.number().int().min(1).max(1000).optional(),
})

requests.post('/requests', requireViewer, async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  try {
    return c.json(await createRequest(viewer, parsed.data), 201)
  } catch (err) {
    if (err instanceof NoActorCredentialError) return c.json({ error: 'ReauthRequired' }, 401)
    throw err
  }
})

const claimBody = z.object({
  note: z.string().max(2560).optional(),
  /** The event the claimer has created to satisfy the request, if any. */
  eventUri: z.string().startsWith('at://').optional(),
})

requests.post('/requests/:id/claim', requireViewer, requireRole(Role.Host), async (c) => {
  const requestUri = decodeURIComponent(c.req.param('id'))
  const parsed = claimBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  const indexer = await getIndexer()

  const request = await getRecordByUri<RequestRecord>(indexer, 'request', requestUri)
  const requestCid = request?.cid ?? (await cidFromPds(requestUri))
  if (!requestCid) return c.json({ error: 'NotFound', message: 'unknown request' }, 404)
  if (request?.value.status === 'closed') return c.json({ error: 'RequestClosed' }, 409)

  const threshold = request?.value.threshold
  const interested = await countInterested(requestUri, currentSchool(c).did)
  if (!meetsThreshold(interested, threshold)) {
    return c.json(
      { error: 'ThresholdNotMet', message: `this request needs ${threshold} interested people; has ${interested}` },
      409,
    )
  }

  let eventRef: { uri: string; cid: string } | undefined
  if (parsed.data.eventUri) {
    const parts = parseAtUri(parsed.data.eventUri)
    if (parts?.did !== viewer.did || parts.collection !== NSID.event) {
      return c.json({ error: 'PermissionDenied', message: 'Connect a class you posted yourself.' }, 403)
    }
    const ev = await getRecordByUri(indexer, 'event', parsed.data.eventUri)
    const cid = ev?.cid ?? (await cidFromPds(parsed.data.eventUri))
    if (!cid) return c.json({ error: 'InvalidRequest', message: 'unknown event' }, 400)
    eventRef = { uri: parsed.data.eventUri, cid }
  }

  try {
    const agent = await actorAgent(viewer)
    // Completing the class updates the host's existing offer. Retrying a response
    // must not turn one teacher into several claims on the needs board.
    const previous = (await sidecarsForEvent<{ event?: { uri: string; cid: string }; note?: string }>(
      indexer, 'claim', requestUri, 'request.uri',
    )).find(claim => claim.did === viewer.did)
    const res = await agent.com.atproto.repo.putRecord({
      repo: viewer.did,
      collection: NSID.claim,
      rkey: previous ? parseAtUri(previous.uri)!.rkey : tid(),
      record: {
        $type: NSID.claim,
        request: { uri: requestUri, cid: requestCid },
        ...(eventRef ?? previous?.value.event ? { event: eventRef ?? previous?.value.event } : {}),
        ...(parsed.data.note ?? previous?.value.note ? { note: parsed.data.note ?? previous?.value.note } : {}),
        createdAt: new Date().toISOString(),
      } as Record<string, unknown>,
      validate: false,
    })
    await indexer.notify(res.data.uri).catch(() => {})
    return c.json({ uri: res.data.uri, cid: res.data.cid }, 201)
  } catch (err) {
    if (err instanceof NoActorCredentialError) return c.json({ error: 'ReauthRequired' }, 401)
    throw err
  }
})

async function cidFromPds(uri: string): Promise<string | null> {
  const parts = parseAtUri(uri)
  if (!parts) return null
  const endpoint = await resolvePdsEndpoint(parts.did)
  if (!endpoint) return null
  const rec = await getRecord(parts.did, parts.collection, parts.rkey, endpoint)
  return rec?.cid ?? null
}
