/**
 * "Someone should teach this" — a needs-board request, written into the ASKER's own repo
 * (a request is a personal statement of interest and must survive the school).
 *
 * Factored out of `http/routes/requests.ts`'s `POST /api/requests` so the route and
 * `scripts/seed-demo.ts` take the same path. `NoActorCredentialError` is left to
 * propagate: the route maps it to 401 `ReauthRequired`, the seed lets it fail loudly.
 *
 * ASKING A PARTICULAR PERSON (UX audit journey finding 13). `askedOf` addresses the
 * request to one member — and lives ENTIRELY app-side, in `fs_request_asked_of` and in
 * that member's own notifications. The record written to the asker's repo is byte-for-byte
 * what it would have been without it: a public record must never name a DID its holder
 * did not write (R9), and "Wren thinks Rosa should teach bicycle mechanics", published
 * under Wren's identity, is exactly that. The person asked finds out; nobody else does.
 */
import { eq } from 'drizzle-orm'
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { getIndexer } from '../index/indexer.js'
import { getDb } from '../db/index.js'
import { requestAskedOf } from '../db/schema.js'
import { displayNamesForDids, handlesForDids } from '../http/routes/me.js'
import { enqueueNotification } from '../notifications/dispatch.js'
import { legacySchoolDid } from './schools.js'
import { describeError, log } from './logging.js'

export interface CreateRequestInput {
  title: string
  description?: string
  /** AT-URI of a `freeschool.draft.skill`. */
  skill?: string
  /** How many interested people before a host may claim it. */
  threshold?: number
  /**
   * The member this request is addressed to. APP-SIDE ONLY — never written to the
   * record; see this file's header.
   */
  askedOf?: string
}

export async function createRequest(
  viewer: Viewer,
  input: CreateRequestInput,
  options: { schoolDid?: string } = {},
): Promise<{ uri: string; cid: string }> {
  const { askedOf, ...record } = input
  const agent = await actorAgent(viewer)
  const res = await agent.com.atproto.repo.putRecord({
    repo: viewer.did,
    collection: NSID.request,
    rkey: tid(),
    record: {
      $type: NSID.request,
      ...record,
      status: 'open',
      createdAt: new Date().toISOString(),
    } as Record<string, unknown>,
    validate: false,
  })
  // Read-your-writes: pull what we just wrote into the index immediately.
  const indexer = await getIndexer()
  await indexer.notify(res.data.uri).catch(() => {})

  // A member may not address a request to themselves — it would mean nothing and would
  // send them a notification about their own typing.
  if (askedOf && askedOf !== viewer.did) {
    // The request itself is already public and real. Failing the whole call because the
    // app-side half of an ask did not land would tell the member their request failed
    // when it did not, so this is logged and swallowed.
    try {
      await recordAsk(res.data.uri, viewer.did, askedOf, options.schoolDid ?? legacySchoolDid(), input.title)
    } catch (err) {
      log.warn('could not record askedOf', { detail: describeError(err) })
    }
  }
  return { uri: res.data.uri, cid: res.data.cid }
}

/** The app-side row, then the one notification the asked member gets. */
async function recordAsk(
  requestUri: string,
  askerDid: string,
  askedOfDid: string,
  schoolDid: string,
  title: string,
): Promise<void> {
  await getDb()
    .insert(requestAskedOf)
    .values({ requestUri, askedOfDid, schoolDid })
    .onConflictDoNothing()
  await enqueueNotification({
    did: askedOfDid,
    category: 'request.asked-of',
    // One notification per request, whatever else happens: the uri is minted per ask.
    dedupKey: `request-asked-of:${requestUri}`,
    title: `${await nameOf(askerDid)} asked if you would teach ${title}`,
    body: 'You can say yes by posting a class, or leave it for someone else. Nobody is told either way.',
    navigate: '/requests',
    schoolDid,
  })
}

/**
 * What to call the asker. A notification that says "Someone asked if you would teach
 * sourdough" is worse than useless — the whole point is that a person you know asked —
 * but a member with neither a name nor a handle on file must not turn into a raw DID in
 * somebody's inbox.
 */
async function nameOf(did: string): Promise<string> {
  const [names, handles] = await Promise.all([displayNamesForDids([did]), handlesForDids([did])])
  return names[did] ?? handles[did] ?? 'Someone at this school'
}

/** Who a request was addressed to, if anyone. App-side; never served over HTTP. */
export async function askedOfFor(requestUri: string): Promise<string | null> {
  const rows = await getDb()
    .select({ did: requestAskedOf.askedOfDid })
    .from(requestAskedOf)
    .where(eq(requestAskedOf.requestUri, requestUri))
    .limit(1)
  return rows[0]?.did ?? null
}
