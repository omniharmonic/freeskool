# `src/sync/` — live indexing from peer PDS hosts

## The hole this fills

contrail 0.23.0 ships exactly one live `ChangeSource`: `JetstreamChangeSource`, which
subscribes to a **Bluesky Jetstream v2** service. Jetstream is fed by the public relay
network, so it sees a record only once that record's PDS is crawled by a public relay.

Free School is peer-to-peer at the PDS level: the peer registry (`src/index/peers.ts`,
table `fs_peer`) is a list of PDS hosts, several of which will be private,
self-hosted, or — in development — `http://localhost:3000`. Jetstream can never see
those. The missing piece was a `ChangeSource` over **`com.atproto.sync.subscribeRepos`**
spoken directly to each peer PDS. The stack proposal flagged it as the highest-risk
build item; it is now implemented here.

## What runs today

| need | how |
|---|---|
| historical acquisition | `contrail.backfillAll()` → `com.atproto.repo.listRecords` per repo |
| repo discovery | `relays` → `listReposByCollection` per peer PDS, with a `listRepos` fallback (`src/index/discovery-fallback.ts`) |
| read-your-writes | `contrail.notify(uri)` right after every write we make |
| **other people's writes, live** | **`PdsChangeSource`** — one `subscribeRepos` socket per peer host |
| safety net | the 15-minute `backfillFromPeers` job, unchanged |

The backfill is deliberately still scheduled. Live sync is the fast path, never the
only path: a dropped socket, a cold start, or a peer whose stream retention expired
(default 24 h) all leave holes that the periodic backfill closes.

Registered at boot by `src/index/live-sync.ts` when `PEER_LIVE_SYNC` is on (the
default) **and** jobs are running — `FREESCHOOL_NO_JOBS=1`, which the smoke test uses,
gets a quiet HTTP-only process.

## The files

| file | responsibility |
|---|---|
| `pds-change-source.ts` | `PdsChangeSource`: the `ChangeSource` contract (`id`/`semantics`/`mark`/`read`) **and** the steady-state runner (`start`/`stop`/`flush`), plus frame dispatch |
| `host-subscription.ts` | one socket against one host: `Subscription` + `MemoryRunner`, backoff, `User-Agent`, `markHostHead()` |
| `frame-handlers.ts` | pure `subscribeRepos` frame validation and the `#account` → status mapping |
| `peer-state.ts` | durable per-host cursor (debounced, monotonic) and per-repo sync state, over `fs_app_meta` |
| `repair.ts` | `listRecords` gap repair, triggered by `#info OutdatedCursor` |
| `cursor-map.ts` | the cursor-map codec and host normalisation |

Production wiring lives in `src/index/live-sync.ts`; the source itself takes its
database, ingest path, repair queue and logger as injected seams, which is why
`test/pds-change-source.test.ts` needs neither Postgres nor the network.

## The interface, as implemented

`ChangeSource` is exported from the package root (`@atmo-dev/contrail`) — there is no
`core/sources.ts` in the published artifact, only a bundle. Its contract, verbatim
from `dist/sources-*.d.ts`:

```ts
interface ChangeSource {
  readonly id: string
  readonly semantics: SourceSemantics
  mark(options: { collections: string[]; snapshot?: PreparedSnapshot; signal?: AbortSignal }): Promise<SourcePosition>
  read(options: {
    collections: string[]
    snapshot?: PreparedSnapshot
    after: SourcePosition
    through: SourcePosition
    signal?: AbortSignal
  }): AsyncIterable<MutationBatch>
}
```

with `SourcePosition { source, epoch, cursor }` and
`MutationBatch { mutations, checkpoint, caughtUp }`.

`mark`/`read` are what `bootstrapFreshProjection()` consumes. Steady state does **not**
go through them: `contrail.ingest()` is hard-wired to Jetstream, so the live loop is
ours and feeds `ingestRecords` directly — the same admission path Jetstream and the PDS
backfill use, which is what makes the source-ordering guard dedupe live events against
the 15-minute backfill for free.

### How each hard part was resolved

1. **Per-host cursors.** `subscribeRepos` `seq` is per PDS, and `SourcePosition.cursor`
   is one opaque string, so `cursor-map.ts` encodes the whole map (`host=seq&…`,
   sorted so the encoding is canonical) and `epoch` is pinned to the peer set —
   `<CONTRAIL_ORDERED_SOURCE_EPOCH>-peers-<sha256 of the sorted host list>`
   (`peerSetEpoch()` in `src/index/live-sync.ts`). A **hash, not a count**: with a count,
   swapping one peer for another left the epoch identical, so `assertPosition()` would
   accept a cursor map whose seq belonged to a host no longer in the set and `caughtUp`
   could never be reached for the new one. Any change to the set is now a visible
   continuity break rather than a silent gap.
2. **`caughtUp` / `through`.** There is no head to ask for, so `mark()` opens one
   socket per peer, takes the first event's `seq`, and closes (`markHostHead()`). A
   host that says nothing inside the timeout contributes its last stored cursor, or
   nothing — inventing a coordinate from the wall clock would put a hole in the replay
   contrail then trusts.
3. **Semantics flags.**
   `{ ordinaryRecords, ordinaryDeletes, accountLifecycle, repositoryReplacement, verifiedCommits } = true`,
   `explicitHead: false` — which is what forces the `mark()` trick above.
4. **CAR decoding.** `#commit.blocks` is a CAR slice; `@atproto/sync`'s
   `parseCommitAuthenticated` / `parseCommitUnauthenticated` decode it (and, for public
   peers, verify the commit signature and MST proofs). `lexToJson` from
   `@freeschool/pds-follow` converts the DAG-CBOR record to the atproto JSON
   representation, because CIDs and `Uint8Array`s do not survive `JSON.stringify`.

### Why `Subscription` and not `@atproto/sync`'s `Firehose`

`Firehose` would have been less code, but it cannot do two of the seven
pre-production fixes R4 lists (§"Concrete changes to make before this is production
code"):

- it **drops `#info`**: with a runner attached, `didAndSeqForEvt()` returns undefined
  for an `#info` frame and the loop `continue`s, so an `OutdatedCursor` — the signal
  that a PDS could not replay as far back as we asked and there is a silent 24 h+ hole
  — never reaches us;
- it **cannot report reconnects**: `onReconnectError` is never wired through, so a
  flapping peer is invisible.

So we drive `@atproto/xrpc-server`'s `Subscription` ourselves (it owns the WebSocket,
the exponential backoff and the heartbeat, and exposes `validate` for every frame plus
`onReconnectError` per attempt) and keep everything else from `@atproto/sync`:
`MemoryRunner` for the partitioned per-DID queue and the contiguous-prefix cursor, and
the commit parsers above.

The other five fixes: a real `User-Agent` (1) ✓; reconnect observability (3) ✓;
`maxReconnectSeconds` 16 (4) ✓; the `desynchronized`/`throttled` statuses, which
`@atproto/sync`'s `parseAccount` silently discards, so `frame-handlers.ts` reads the
frame itself (5) ✓; the `#sync`-triggered repair (6) ✓. The Sync 1.1 record-state
table (7) is **not** done — see Limitations.

### Event handling

| frame | action |
|---|---|
| `#commit` | decode the CAR, filter to the configured collections, `ingestRecords` |
| *an event that will not index* | retry 3×, then enqueue a repo repair and let the cursor advance; a failed **delete** is also recorded in `peer:pending-delete:` for the repair to apply |
| `#account` | map all six lexicon statuses to the stored repo status; `desynchronized` also enqueues a repo repair |
| `#identity` | always re-resolve the DID document (the event is advisory and never says which field changed), compare `#atproto_pds` to this host, set `movedOffThisPeer` |
| `#sync` | store the `rev`; enqueue a repo repair when it is ahead of ours |
| `#info OutdatedCursor` | enqueue a `listRecords` repair for every repo on the host |

## Cursor and repo state storage

R4 §"AppView notes" specifies `peer_host(cursor, …)` and a `peer_repo(did, status,
last_rev, …)` table. **Neither exists yet**, and this step was not allowed to add a
drizzle migration, so the same state lives in `fs_app_meta` — the key/value table the
schema already describes as "small key/value for indexer bookkeeping we own (not
contrail's cursors)":

```
peer:cursor:<host>       → <seq>
peer:repo:<host>:<did>   → {"status","statusAt","movedOffThisPeer","pds","lastRev"}
```

The key layout mirrors the eventual columns one-to-one, so promoting it to real tables
is a data copy, not a redesign. What is lost in the meantime: indexed queries over
repo status, and the `last_error` / `consecutive_failures` columns R4 wanted on the
host row for flap visibility (reconnects are logged instead).

Cursor writes are debounced at 1 s and monotonic — a partitioned runner can hand back
a lower cursor when a slow partition finishes last, and walking backwards would
replay. The cursor therefore always lags the contiguous completed prefix, which makes
delivery **at-least-once**; every record write must be an idempotent upsert, which
contrail's source-ordering guard in `ingestRecords` provides.

## Privacy

R9 forbids DIDs, handles, emails, record contents and AT-URIs in logs. Every line this
directory emits goes through `src/lib/logging.ts` and names a peer only by its short
**host name** (`pds.example.org` → `pds`). Errors are reduced to their `name`, never
their message, because a message can carry a URI. The test suite asserts that no
`did:plc:` ever appears in captured output.

## Failure handling

Three distinct failures, three distinct answers:

- **A dropped socket** — `Subscription` reconnects on its own, capped at 16 s, and each
  attempt is logged by peer name.
- **A fatal error frame** (`FutureCursor`, op −1 + close 1008) ends that iterator
  instead. `HostSubscription` re-enters its read loop with its own exponential delay to
  the same 16 s ceiling, and after 10 consecutive fatals with no frame delivered it
  **quarantines** the host for 10 minutes behind a single `error` line. A delivered
  frame resets the escalation. Without this a permanently-broken peer re-dialled at a
  flat 1 s forever.
- **An event that will not index** — three attempts with a short backoff, then the
  source enqueues a repair for that repo, records any missed delete, logs at `error`
  and **lets the cursor advance**. Throwing instead would escape
  `MemoryRunner.trackEvent` before it commits the cursor, so the host would replay the
  same poisoned event forever and every other repo on that peer would starve behind it.

A cursor write that fails is neither fatal nor silent: the debounced flush never
rejects (an unhandled rejection exits Node 22), never poisons its serialization chain
(which would stop every later flush), re-queues the advance and reports the affected
peers. Worst case we re-read a few events, which the idempotent upsert absorbs.

## Limitations

- **Deletions missed during a gap are never noticed.** A `listRecords` repair only
  reports what is still there. Catching a record deleted during an outage needs the
  Sync 1.1 record-state table (did, collection, rkey, cid) to diff against — R4
  §"Concrete changes" item 7, not in this step. The 15-minute backfill has the same
  blind spot.
- **No per-host flap counters.** See "Cursor and repo state storage". Quarantine and
  reconnects are logged, but nothing is queryable.
- **The host set is snapshotted at boot.** `startPeerLiveSync()` reads `fs_peer` once
  and opens a socket per row; a peer added afterwards (via `PUT /api/admin/peers` or a
  refreshed school record) is picked up by the 15-minute backfill but gets no live
  socket until the process restarts. Hot-add would also have to re-epoch the cursor map
  — the two are the same change — and is out of scope here.
- **`mark()` on a quiet peer has no head.** Correct, but it means a bootstrap against a
  silent registry has nothing to catch up to.
- **Scale.** Direct-PDS federation suits a curated peer set. R4 measured 445 repos
  writing `community.lexicon.calendar.event` across hundreds of hosts; one socket each
  does not work for "index every calendar event in the atmosphere". That would be a
  relay or a Tap, as a separate and clearly-labelled ingest path.
