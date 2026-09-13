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
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { Role } from '@freeschool/shared'
import type { AppEnv } from '../session.js'
import { requireRole, requireViewer } from '../session.js'
import { actorAgent, NoActorCredentialError } from '../../lib/actor-agent.js'
import { NSID } from '../../lexicons/nsids.js'
import { tid } from '../../lib/ids.js'
import { getIndexer } from '../../index/indexer.js'
import { getRecordByUri, listCollection, parseAtUri } from '../../index/queries.js'
import { getRecord } from '../../lib/pds.js'
import { resolvePdsEndpoint } from '../../lib/identity.js'
import { countInterested, isInterested, meetsThreshold, toggleInterest } from '../../lib/request-rsvp.js'

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
  const viewer = c.var.viewer
  const items = await Promise.all(
    records.map(async (r) => ({
      uri: r.uri,
      askedBy: r.did,
      title: r.value.title,
      description: r.value.description,
      skill: r.value.skill,
      threshold: r.value.threshold,
      status: r.value.status,
      claims: r.counts?.claim ?? r.counts?.claims ?? 0,
      // "I'm interested" — app-side (R9: no public roster), the count a `threshold`
      // gates claiming against. Never a list of who.
      rsvpCount: await countInterested(r.uri),
      viewerInterested: viewer ? await isInterested(r.uri, viewer.did) : false,
    })),
  )
  return c.json({ cursor, requests: items })
})

requests.post('/requests/:id/rsvp', requireViewer, async (c) => {
  const requestUri = decodeURIComponent(c.req.param('id'))
  const result = await toggleInterest(requestUri, c.var.viewer!.did)
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
    const agent = await actorAgent(viewer)
    const res = await agent.com.atproto.repo.putRecord({
      repo: viewer.did,
      collection: NSID.request,
      rkey: tid(),
      record: {
        $type: NSID.request,
        ...parsed.data,
        status: 'open',
        createdAt: new Date().toISOString(),
      } as Record<string, unknown>,
      validate: false,
    })
    const indexer = await getIndexer()
    await indexer.notify(res.data.uri).catch(() => {})
    return c.json({ uri: res.data.uri, cid: res.data.cid }, 201)
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

  const threshold = request?.value.threshold
  const interested = await countInterested(requestUri)
  if (!meetsThreshold(interested, threshold)) {
    return c.json(
      { error: 'ThresholdNotMet', message: `this request needs ${threshold} interested people; has ${interested}` },
      409,
    )
  }

  let eventRef: { uri: string; cid: string } | undefined
  if (parsed.data.eventUri) {
    const ev = await getRecordByUri(indexer, 'event', parsed.data.eventUri)
    const cid = ev?.cid ?? (await cidFromPds(parsed.data.eventUri))
    if (!cid) return c.json({ error: 'InvalidRequest', message: 'unknown event' }, 400)
    eventRef = { uri: parsed.data.eventUri, cid }
  }

  try {
    const agent = await actorAgent(viewer)
    const res = await agent.com.atproto.repo.putRecord({
      repo: viewer.did,
      collection: NSID.claim,
      rkey: tid(),
      record: {
        $type: NSID.claim,
        request: { uri: requestUri, cid: requestCid },
        ...(eventRef ? { event: eventRef } : {}),
        ...(parsed.data.note ? { note: parsed.data.note } : {}),
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
