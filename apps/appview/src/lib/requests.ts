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
 *
 * THREE LIMITS ON THE ASK (Task 10 report, concern 3 — twenty members could each ask the
 * same person for the same thing, and each ask was a separate public request and a
 * separate notification):
 *
 *   1. It MERGES. An open request for the same skill in the same school, already
 *      addressed to the same person, is the request this ask belongs on — the asker joins
 *      it as interested (`lib/request-rsvp.ts#addInterest`) and no second record is
 *      written. One need, one row on the board, and the interest count becomes the thing
 *      that says how many people want it.
 *   2. It notifies AT MOST ONCE per (skill, person) per seven days. The dedup key is the
 *      pair, not the request URI, so the tenth asker does not become the tenth ping.
 *   3. It is rate-limited to `MAX_ASKS_PER_DAY` per member per school. 429 `TooManyAsks`,
 *      and nothing is written — not even the public request, because a request nobody
 *      meant as a request is still litter on somebody's board.
 */
import { and, eq, gte, like } from 'drizzle-orm'
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { getIndexer } from '../index/indexer.js'
import { listCollection } from '../index/queries.js'
import { getDb } from '../db/index.js'
import { notificationSent, requestAskedOf } from '../db/schema.js'
import { displayNamesForDids, handlesForDids } from '../http/routes/me.js'
import { enqueueNotification } from '../notifications/dispatch.js'
import { addInterest } from './request-rsvp.js'
import { legacySchoolDid } from './schools.js'
import { schoolScope } from './school-scope.js'
import { describeError, log } from './logging.js'

/** How many asks one member may make in one school in a day before the door closes. */
export const MAX_ASKS_PER_DAY = 10
const DAY_MS = 86_400_000
/** How long one (skill, person) pair stays quiet after the member has been told once. */
const ASK_NOTICE_WINDOW_MS = 7 * DAY_MS

/** Thrown before anything is written. The route answers 429 `TooManyAsks`. */
export class TooManyAsksError extends Error {
  readonly code = 'TooManyAsks'
  constructor() {
    super(`you can ask for up to ${MAX_ASKS_PER_DAY} things a day`)
    this.name = 'TooManyAsksError'
  }
}

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

export interface CreateRequestResult {
  uri: string
  cid: string
  /** True when this ask joined a request that already existed instead of writing one. */
  merged?: boolean
}

export async function createRequest(
  viewer: Viewer,
  input: CreateRequestInput,
  options: { schoolDid?: string } = {},
): Promise<CreateRequestResult> {
  const { askedOf, ...record } = input
  const schoolDid = options.schoolDid ?? legacySchoolDid()
  // A member may not address a request to themselves — it would mean nothing and would
  // send them a notification about their own typing.
  const asking = Boolean(askedOf) && askedOf !== viewer.did

  if (asking) {
    if ((await asksToday(viewer.did, schoolDid)) >= MAX_ASKS_PER_DAY) throw new TooManyAsksError()
    const open = await openAskFor(input.skill, askedOf!, schoolDid)
    if (open) {
      // Merging, not asking again: the board keeps ONE row for this need and the asker
      // becomes one of the people waiting on it.
      await addInterest(open.uri, viewer.did, schoolDid)
      await notifyAsked(viewer.did, askedOf!, schoolDid, input)
      return { uri: open.uri, cid: open.cid ?? '', merged: true }
    }
  }

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

  if (asking) {
    // The request itself is already public and real. Failing the whole call because the
    // app-side half of an ask did not land would tell the member their request failed
    // when it did not, so this is logged and swallowed.
    try {
      await recordAsk(res.data.uri, viewer.did, askedOf!, schoolDid, input)
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
  input: CreateRequestInput,
): Promise<void> {
  await getDb()
    .insert(requestAskedOf)
    .values({ requestUri, askedOfDid, schoolDid })
    .onConflictDoNothing()
  await notifyAsked(askerDid, askedOfDid, schoolDid, input)
}

/**
 * How many asks this member has made in this school in the last twenty-four hours.
 *
 * `fs_request_asked_of` carries no asker column and does not need one: the request's
 * AT-URI IS the asker's repo, so a prefix match over the primary key answers it. Per
 * SCHOOL, like every other app-side count here.
 */
async function asksToday(askerDid: string, schoolDid: string): Promise<number> {
  const rows = await getDb()
    .select({ uri: requestAskedOf.requestUri })
    .from(requestAskedOf)
    .where(
      and(
        like(requestAskedOf.requestUri, `at://${askerDid}/%`),
        schoolScope(requestAskedOf.schoolDid, schoolDid),
        gte(requestAskedOf.createdAt, new Date(Date.now() - DAY_MS)),
      ),
    )
  return rows.length
}

/**
 * The open request this ask belongs on, if there is one: same school, same skill, already
 * addressed to this person. One index query (open requests for that skill) intersected
 * with one app-side query (what this member has been asked), rather than a walk per row.
 *
 * Without a skill there is nothing to match on — two people typing "sourdough" and
 * "Sourdough bread" mean the same thing and we have no way to know it — so an ask with no
 * skill always writes its own request.
 */
async function openAskFor(
  skill: string | undefined,
  askedOfDid: string,
  schoolDid: string,
): Promise<{ uri: string; cid: string | null } | null> {
  if (!skill) return null
  const asked = await getDb()
    .select({ uri: requestAskedOf.requestUri })
    .from(requestAskedOf)
    .where(and(eq(requestAskedOf.askedOfDid, askedOfDid), schoolScope(requestAskedOf.schoolDid, schoolDid)))
  if (asked.length === 0) return null
  const uris = new Set(asked.map((row) => row.uri))

  const indexer = await getIndexer()
  const { records } = await listCollection(indexer, 'request', {
    filters: { status: 'open', skill },
    limit: 200,
  })
  const hit = records.find((record) => uris.has(record.uri))
  return hit ? { uri: hit.uri, cid: hit.cid } : null
}

/**
 * Tell the member asked — at most once per (skill, person) per seven days.
 *
 * The dedup key is the PAIR and a seven-day bucket, so the claim stays atomic (the
 * ledger's insert-or-nothing is still what decides a race). A bucket alone would let two
 * notices land a second apart across a boundary, so the PREVIOUS bucket is checked for a
 * claim inside the rolling window first; the two together are exactly "once per seven
 * days" with no lock and no extra table.
 */
async function notifyAsked(
  askerDid: string,
  askedOfDid: string,
  schoolDid: string,
  input: CreateRequestInput,
): Promise<void> {
  const now = Date.now()
  const subject = input.skill ?? `title:${input.title.trim().toLowerCase()}`
  const base = `request-asked-of:${schoolDid}:${askedOfDid}:${subject}`
  const bucket = Math.floor(now / ASK_NOTICE_WINDOW_MS)
  const recent = await getDb()
    .select({ key: notificationSent.dedupKey })
    .from(notificationSent)
    .where(
      and(
        eq(notificationSent.dedupKey, `${base}:${bucket - 1}`),
        gte(notificationSent.claimedAt, new Date(now - ASK_NOTICE_WINDOW_MS)),
      ),
    )
    .limit(1)
  if (recent.length > 0) return

  await enqueueNotification({
    did: askedOfDid,
    category: 'request.asked-of',
    dedupKey: `${base}:${bucket}`,
    title: `${await nameOf(askerDid)} asked if you would teach ${input.title}`,
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
