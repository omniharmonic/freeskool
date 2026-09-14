/**
 * "Someone should teach this" — a needs-board request, written into the ASKER's own repo
 * (a request is a personal statement of interest and must survive the school).
 *
 * Factored out of `http/routes/requests.ts`'s `POST /api/requests` so the route and
 * `scripts/seed-demo.ts` take the same path. `NoActorCredentialError` is left to
 * propagate: the route maps it to 401 `ReauthRequired`, the seed lets it fail loudly.
 */
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { getIndexer } from '../index/indexer.js'

export interface CreateRequestInput {
  title: string
  description?: string
  /** AT-URI of a `freeschool.draft.skill`. */
  skill?: string
  /** How many interested people before a host may claim it. */
  threshold?: number
}

export async function createRequest(viewer: Viewer, input: CreateRequestInput): Promise<{ uri: string; cid: string }> {
  const agent = await actorAgent(viewer)
  const res = await agent.com.atproto.repo.putRecord({
    repo: viewer.did,
    collection: NSID.request,
    rkey: tid(),
    record: {
      $type: NSID.request,
      ...input,
      status: 'open',
      createdAt: new Date().toISOString(),
    } as Record<string, unknown>,
    validate: false,
  })
  // Read-your-writes: pull what we just wrote into the index immediately.
  const indexer = await getIndexer()
  await indexer.notify(res.data.uri).catch(() => {})
  return { uri: res.data.uri, cid: res.data.cid }
}
