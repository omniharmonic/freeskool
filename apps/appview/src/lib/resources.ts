/**
 * Public, author-owned knowledge records (`freeschool.draft.resource`) — the "field
 * notes" a host shares after a class.
 *
 * This is the record-writing core of `http/routes/knowledge.ts`'s `writeResource`, in a
 * lib so `scripts/seed-demo.ts` writes notes exactly the way a real host does rather than
 * hand-rolling a second `putRecord`. The route keeps the HTTP-shaped half — the
 * `resourceInput` zod parse, the OAuth-door refusal, the skill/event ownership checks and
 * the edit path.
 *
 * KNOWN DUPLICATION, deliberate and temporary: `writeResource` still inlines the same two
 * calls. Task 14 was not allowed to edit `routes/knowledge.ts` (another change was in
 * flight against it), so pointing the route at this function is a one-line follow-up.
 */
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { getIndexer } from '../index/indexer.js'

export interface CreateResourceInput {
  title: string
  description?: string
  /** AT-URIs of `freeschool.draft.skill` records; at least one. */
  skills: string[]
  /** An http(s) link to the resource, when it lives elsewhere. */
  uri?: string
  license?: string
  /** The class these notes came out of. */
  event?: { uri: string; cid: string }
}

export async function createResource(viewer: Viewer, input: CreateResourceInput): Promise<{ id: string }> {
  const agent = await actorAgent(viewer)
  const res = await agent.com.atproto.repo.putRecord({
    repo: viewer.did,
    collection: NSID.resource,
    rkey: tid(),
    record: {
      $type: NSID.resource,
      ...input,
      createdAt: new Date().toISOString(),
    } as Record<string, unknown>,
    validate: false,
  })
  const indexer = await getIndexer()
  await indexer.notify(res.data.uri).catch(() => {})
  return { id: res.data.uri }
}
