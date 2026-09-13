/**
 * Backfill: everything a repo already held before we started listening.
 *
 * Two paths, both against the DID's *own* PDS (resolved from its DID document,
 * never assumed to be the peer host we happened to hear about it from):
 *
 *  - `listRecords` — `com.atproto.repo.listRecords` per collection, paged. No
 *    auth, no CAR, no crypto. Scales with the size of the collections we want
 *    rather than the size of the repo, which is the whole game: for
 *    `did:plc:cbkjy5n7bk3ax2wplmtjofq2` the full repo CAR is ~16.6 MB while its
 *    two calendar collections are a few KB. This is the default.
 *
 *  - `getRepo` — `com.atproto.sync.getRepo` returns the whole repo as one CAR
 *    (commit + MST nodes + every record). Verifiable end-to-end against the
 *    account's signing key, and the only way to get a proof the PDS is not
 *    lying by omission. Lexicon params are `did` and `since` only: there is no
 *    `collection` filter, so collection scoping happens after the CAR is
 *    parsed, client-side. `since=<rev>` asks for a diff from a known revision,
 *    which is the cheap way to re-sync a repo we have already seen.
 */

import { AtpAgent } from '@atproto/api'
import { MemoryBlockstore, Repo, cborToLexRecord, readCarWithRoot, verifyRepoCar } from '@atproto/repo'
import type { Identity } from './identity.js'
import { lexToJson } from './lex-json.js'

export type BackfilledRecord = {
  kind: 'record'
  source: 'backfill'
  via: 'listRecords' | 'getRepo'
  did: string
  pds: string
  collection: string
  rkey: string
  uri: string
  cid: string
  /** Repo revision the backfill observed. Store it: it is the `since` for the next re-sync. */
  rev?: string
  record: unknown
}

export type BackfillResult = {
  did: string
  pds: string
  rev?: string
  records: BackfilledRecord[]
  /** Set when the PDS reports the repo is not servable here (deactivated, takendown, moved). */
  status?: string
  error?: string
  bytesFetched?: number
}

const agentFor = (service: string) => new AtpAgent({ service })

/** Page `listRecords` for one collection until exhausted. */
async function viaListRecords(
  did: string,
  pds: string,
  collections: string[],
  opts: { pageSize: number; maxPages: number },
): Promise<BackfilledRecord[]> {
  const agent = agentFor(pds)
  const out: BackfilledRecord[] = []
  for (const collection of collections) {
    let cursor: string | undefined
    for (let page = 0; page < opts.maxPages; page++) {
      const res = await agent.com.atproto.repo.listRecords({
        repo: did,
        collection,
        limit: opts.pageSize,
        ...(cursor ? { cursor } : {}),
      })
      for (const rec of res.data.records) {
        // at://<did>/<collection>/<rkey>
        const rkey = rec.uri.split('/').pop() ?? ''
        out.push({
          kind: 'record',
          source: 'backfill',
          via: 'listRecords',
          did,
          pds,
          collection,
          rkey,
          uri: rec.uri,
          cid: rec.cid,
          record: rec.value,
        })
      }
      cursor = res.data.cursor
      if (!cursor || res.data.records.length === 0) break
    }
  }
  return out
}

/**
 * Fetch the full repo CAR, optionally verify it against the account's signing
 * key, then pull only the collections we want out of the MST.
 *
 * `MST.listWithPrefix('<nsid>/')` walks just the subtree covering that
 * collection's keys instead of every leaf in the repo — the reason to load a
 * `Repo` here rather than iterate the BlockMap blindly. (`Repo` extends
 * `ReadableRepo`, which is not itself re-exported from the package index.)
 */
async function viaGetRepo(
  did: string,
  pds: string,
  collections: string[],
  opts: { verify: boolean; signingKey?: string; since?: string },
): Promise<{ records: BackfilledRecord[]; rev?: string; bytes: number }> {
  const agent = agentFor(pds)
  const res = await agent.com.atproto.sync.getRepo({ did, ...(opts.since ? { since: opts.since } : {}) })
  const car = res.data
  let rev: string | undefined

  if (opts.verify) {
    // Checks the commit signature and that every record in the CAR is actually
    // reachable from the signed MST root. Throws RepoVerificationError otherwise.
    const verified = await verifyRepoCar(car, did, opts.signingKey)
    rev = verified.commit.rev
  }

  const { root, blocks } = await readCarWithRoot(car)
  const storage = new MemoryBlockstore(blocks)
  const repo = await Repo.load(storage, root)
  rev ??= repo.commit.rev

  const records: BackfilledRecord[] = []
  for (const collection of collections) {
    const leaves = await repo.data.listWithPrefix(`${collection}/`)
    for (const leaf of leaves) {
      const bytes = blocks.get(leaf.value)
      if (!bytes) continue // record block absent (only possible for a `since` diff)
      const rkey = leaf.key.slice(collection.length + 1)
      records.push({
        kind: 'record',
        source: 'backfill',
        via: 'getRepo',
        did,
        pds,
        collection,
        rkey,
        uri: `at://${did}/${collection}/${rkey}`,
        cid: leaf.value.toString(),
        rev,
        record: lexToJson(cborToLexRecord(bytes)),
      })
    }
  }
  return { records, rev, bytes: car.byteLength }
}

export async function backfillDid(
  identity: Identity,
  did: string,
  collections: string[],
  opts: {
    method: 'listRecords' | 'getRepo'
    verify?: boolean
    since?: string
    allowPrivateNetwork?: boolean
    pageSize?: number
    maxPages?: number
    /** Override the PDS instead of resolving it. Used for a local dev PDS. */
    pdsOverride?: string
  },
): Promise<BackfillResult> {
  let pds = opts.pdsOverride ?? ''
  let signingKey: string | undefined
  try {
    if (!pds) {
      const resolved = await identity.resolve(did, { allowPrivateNetwork: opts.allowPrivateNetwork })
      pds = resolved.pds
      signingKey = resolved.signingKey
    }
  } catch (err) {
    return { did, pds, records: [], error: `identity: ${err instanceof Error ? err.message : String(err)}` }
  }

  try {
    if (opts.method === 'getRepo') {
      const { records, rev, bytes } = await viaGetRepo(did, pds, collections, {
        verify: opts.verify ?? true,
        signingKey,
        since: opts.since,
      })
      return { did, pds, rev, records, bytesFetched: bytes }
    }
    const records = await viaListRecords(did, pds, collections, {
      pageSize: opts.pageSize ?? 100,
      maxPages: opts.maxPages ?? 50,
    })
    return { did, pds, records }
  } catch (err) {
    // A PDS answers `RepoDeactivated` / `RepoTakendown` / `RepoSuspended` /
    // `RepoNotFound` as XRPC errors. `RepoNotFound` on a host the DID document
    // still names is the signature of a half-finished migration; the others are
    // account-status facts worth persisting rather than retrying.
    const e = err as { error?: string; message?: string; status?: number }
    const known = ['RepoDeactivated', 'RepoTakendown', 'RepoSuspended', 'RepoNotFound']
    if (e.error && known.includes(e.error)) {
      return { did, pds, records: [], status: e.error, error: e.message }
    }
    return { did, pds, records: [], error: e.message ?? String(err) }
  }
}
