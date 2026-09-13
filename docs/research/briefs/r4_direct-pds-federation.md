---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r4"
type: "research"
title: "R4 \u2014 Direct-PDS federation"
projects: ["local-alternatives"]
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r4_direct-pds-federation"
parachute_id: "2026-09-12-19-38-42-713248"
tags: ["atproto", "federation", "free-school", "local-alternatives", "research"]
---

# R4 — Direct-PDS federation

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R4*


## TL;DR

Direct-PDS federation works, today, with stock `@atproto/*` packages, and I ran it.
The spike at `scratchpad/research/r4_federation/` followed **seven real
single-PDS hosts** simultaneously over `com.atproto.sync.subscribeRepos` with
per-host cursor persistence, backfilled **160 real calendar records** (42
`community.lexicon.calendar.event` + 118 `community.lexicon.calendar.rsvp`) from
four different PDSes by both `listRecords` and `getRepo`+CAR-verify, and —
via a cursor replay of 6.6 hours of one PDS's history — decoded **33 live
`community.lexicon.calendar.event` records** out of `#commit` CAR slices with
full signature and MST-proof verification, alongside 23 `#account`, 9
`#identity` and 7 `#sync` events. Zero errors, zero dropped connections.

Seven things worth knowing before we build on this:

1. **Everything in the 2026 sync spec is real and live.** `#sync` exists and
   fires on real PDSes. `tooBig` is deprecated-but-still-required and always
   `false`. `blobs` is always `[]`. `prevData` and per-op `prev` are present.
   `#account` status now includes `desynchronized` and `throttled`.
2. **Tap cannot do our federation model as-is.** Tap takes exactly one
   `TAP_RELAY_URL`. Its backfill is per-PDS (it resolves each DID and calls that
   PDS's `getRepo`), but its *live* stream is a single upstream firehose. One Tap
   instance per peer PDS is the only way to use it here.
3. **Cursor replay on a PDS is bounded to 24 hours** (`PDS_REPO_BACKFILL_LIMIT_MS`
   default = 1 day, verified empirically). Offline longer than that and you get
   `#info`/`OutdatedCursor` and a silent gap you must repair with `getRepo`.
4. **`getRepo` has no `collection` filter.** For a two-collection AppView,
   `listRecords` is the right backfill: 16.6 MB of CAR vs a few KB for the same
   records on the same repo.
5. **`@atproto/sync`'s `Firehose` hides reconnects entirely.** It never passes
   `onReconnectError` to its `Subscription`, so a host going down and coming back
   produces *no* log line. For AppView observability you need `@atproto/ws-client`
   directly or a patched Firehose.
6. **Following the whole calendar network directly does not scale.** 445 repos
   hold `community.lexicon.calendar.event`, and 30 sampled DIDs lived on 24
   distinct PDS hosts. The peer registry must be curated (Boulder-area schools),
   not network-wide — or we accept a relay for discovery only.
7. **`coop.lexicon.event.listing` has zero repos network-wide.** Nobody is
   writing it. Whatever we do with that NSID, we are the first mover.

---

## subscribeRepos on a PDS

### URL and auth

```
wss://<pds-host>/xrpc/com.atproto.sync.subscribeRepos[?cursor=<int>]
```

The lexicon says "Public and does not require auth; implemented by PDS and
Relay." Verified: no auth, no headers needed, `permessage-deflate` offered by
default. `@atproto/xrpc-server`'s `Subscription` builds the URL as
`` `${service}/xrpc/${method}?${query}` `` — so `service` is a bare **origin**
(`wss://pds.example`), no path, no `/xrpc`. Tap's Go consumer does the same
(`u.Path = "xrpc/com.atproto.sync.subscribeRepos"`), including the http→ws /
https→wss scheme swap.

Hosts I verified serve a live stream (2026-09-12/13):

| host | notes | seq at 01:22Z |
| --- | --- | --- |
| `https://eurosky.social` | community PDS, 6 calendar-event repos | 59,720,021 |
| `https://northsky.social` | community PDS, 2 calendar-event repos | 10,805,800 |
| `https://shiitake.us-east.host.bsky.network` | Bluesky fleet member, busy | 1,038,909,344 |
| `https://shimeji…`, `morel…`, `amanita…`, `lionsmane…` | Bluesky fleet | 0.99–1.04 B |
| `https://pds.cauda.cloud` | Smoke Signal's own PDS; socket opens, very low traffic | — |

`https://bsky.social` is **not** a PDS — it is the entryway that fans out to the
`*.host.bsky.network` fleet. Each fleet member *is* a single PDS with its own
independent `seq` space and its own public firehose, which is why they are
legitimate peers. `pds.smokesignal.events` does not exist; Smoke Signal and
`ngerakines.me` both live on `pds.cauda.cloud`. `atmo.rsvp` is on
`stropharia.us-west.host.bsky.network`.

`zio.blue` and `pds.witchcraft.systems` accept the WebSocket upgrade but emitted
nothing in a 12 s window — idle, not broken.

### `cursor` semantics

`cursor` is an **integer sequence number, scoped to that one host**. The PDS
handler (`packages/pds/src/api/com/atproto/sync/subscribeRepos.ts`) is explicit:

- `cursor` omitted → start at the live head, no replay.
- `cursor > current seq` → **fatal** `FutureCursor` error frame, connection
  closed. Verified verbatim:
  ```json
  {"header":{"op":-1},"body":{"error":"FutureCursor","message":"Cursor in the future."}}
  ```
  followed by WebSocket close `1008`.
- cursor older than the retention window → the server emits an `#info` frame
  **first**, then resumes from the oldest event it still has:
  ```json
  {"header":{"t":"#info","op":1},"body":{"name":"OutdatedCursor","message":"Requested cursor exceeded limit. Possibly missing events"}}
  ```
  The window is `PDS_REPO_BACKFILL_LIMIT_MS`, default `DAY`. Verified: with
  `cursor=1` at 01:25Z, `shiitake`'s oldest retained event was seq 1,038,031,522
  at `2026-09-12T01:22:11.211Z` — exactly 24 h.
- otherwise → replay from `cursor` forward, then continue live. The cursor is
  *exclusive*: passing 1,038,625,652 delivered 1,038,625,653 first.
- fall more than `PDS_MAX_SUBSCRIPTION_BUFFER` (default **500**) events behind
  and the server throws `ConsumerTooSlow` and drops you.

`seq` is monotonic per host and carries no cross-host meaning. Sharing a cursor
between hosts either replays from that host's beginning or earns `FutureCursor`.

### Message types

Wire format is two concatenated DAG-CBOR objects per binary frame: a header
`{op, t}` and a body. `op: 1` is a message whose `t` is the `#`-fragment; `op: -1`
is an error frame with `{error, message}`. (Sync 1.1 explicitly leaves this
framing alone — "out of scope".)

**`#commit`** — verified verbatim off `eurosky.social`:

```json
{"t":"#commit","op":1}
{"ops":[{"cid":"bafyrei…","path":"app.bsky.feed.post/3mvbvvjt72222","action":"create"}],
 "rev":"3mvbvvl3d5s2b","seq":59377770,"repo":"did:plc:vjrkajfmfo3ofinbgwy4c7v7",
 "time":"2026-09-12T01:17:31.426Z","blobs":[],"since":"3mvbvucadsj2a",
 "blocks":"<bytes 7286>","commit":"bafyrei…","rebase":false,"tooBig":false,
 "prevData":"bafyrei…"}
```

On the 2026 changes, which I asked about specifically:

- **`tooBig` still exists and is still `required`** in the lexicon, marked
  `DEPRECATED -- replaced by #sync event and data limits`. Every real frame I
  captured had `tooBig: false`. Treat it as always-false; do not implement
  `tooBig` handling.
- **`blocks` still exists and is still required** — this has not changed. It is
  the CAR slice you decode. `maxLength: 2000000`.
- **`rebase`** is `DEPRECATED -- unused`, always `false`.
- **`blobs`** is `DEPRECATED -- will soon always be empty`; every frame had `[]`.
- **`prevData`** (the previous MST root CID) is present and is what makes
  "inductive firehose" validation possible. Not signed; you verify it against
  the `data` CID you last saw.
- **`repoOp.prev`** carries the previous record CID for updates/deletes, so ops
  can be inverted. Absent on creates (and absent in the creates I captured).
- Note the field is `repo`, not `did`, on `#commit` only. Renaming it was
  explicitly listed as out of scope for Sync 1.1, so the inconsistency stays.

**`#sync`** — exists, and I caught 7 of them on a real PDS:

```json
{"t":"#sync","op":1}
{"did":"did:plc:pv4gvwd2ydxlqej5otesk6k7","rev":"3mvc37q5klz26","seq":59383777,
 "time":"2026-09-12T03:10:32.862Z","blocks":"<bytes 285>"}
```

285 bytes — the commit block alone, no MST nodes, no records (`maxLength: 10000`).
Semantics: "this is the current state of the repository", possibly discontinuous
from the last commit. Compare `rev` to what you have: older → ignore; equal →
no-op; **newer with a gap → resynchronize via `getRepo`**.

**`#identity`** / **`#account`** — both real, and the lifecycle pattern is
visible. Three consecutive seqs on one PDS, verbatim from my run:

```
seq 1038633878  #account  did:plc:dbkx…  active=true   status=null
seq 1038633879  #identity did:plc:dbkx…  handle=cooliohandle.bsky.social
seq 1038633880  #sync     did:plc:dbkx…  rev=3mqwtn64pv32g
```

and 97 seqs later the same DID: `#account active=false status=deactivated`.
That ordering is what proposal 0006 prescribes — `#sync` emitted *after*
`#account` at account creation, migration, and CAR-import recovery.

`#identity` carries only `{seq, did, time, handle?}`. The lexicon is blunt about
it: "Presence or absence of the `handle` field does not indicate that it is the
handle which has changed." It means **re-resolve the DID document**, nothing more.

`#account` is `{seq, did, time, active, status?}`. `status` `knownValues` are now
`takendown | suspended | deleted | deactivated | desynchronized | throttled` —
the last two are new in Sync 1.1. **`@atproto/sync` 0.4.10's `AccountStatus`
type only lists the first four**, so `desynchronized`/`throttled` arrive as
strings the TS type does not admit. In one 6.6 h replay I observed `deactivated`
(10), `deleted` (3), `takendown` (1) and `active=true` (9).

**`#info`** — `{name, message}`, `knownValues: ["OutdatedCursor"]`. Not a
sequenced event (no `seq`), so it is not cursor-trackable. `@atproto/sync`
silently ignores it — `parseEvt` has no `#info` branch and returns `[]`. **We
must handle it ourselves**: an `OutdatedCursor` is the signal that we have a gap
and every tracked repo on that host needs a `getRepo` re-sync.

### Decoding `blocks` to get each record

```ts
const { root, blocks } = await readCarWithRoot(evt.blocks)  // @atproto/repo
const bytes = blocks.get(op.cid)
const record = cborToLexRecord(bytes)                        // DAG-CBOR -> LexMap
```

The commit block's CID is the first entry in the CAR header `roots`. For the
authenticated path `@atproto/sync` calls
`verifyProofs(evt.blocks, claims, did, didKey)`, which checks the commit
signature against the account's signing key *and* that each claimed record is
reachable from the signed MST root — so a PDS cannot lie by omission. That is
on by default; `unauthenticatedCommits: true` turns it off.

Two serialization gotchas when emitting JSON: decoded records contain `CID`
objects (which `JSON.stringify` renders as `{}`) and `Uint8Array`s. Convert to
`{"$link": "bafy…"}` and `{"$bytes": "<base64>"}`. There is no `lexToJson`
helper exported from `@atproto/lex-data` — `src/lex-json.ts` in the spike is 40
lines doing it by hand.

### Reconnect / backoff

`@atproto/sync` → `@atproto/xrpc-server`'s `Subscription` → `@atproto/ws-client`'s
`websocket()`. The policy lives in `ws-client/dist/lib/reconnect-policy.js`:

```js
export function backoffMs(attempt, maxMs) {
  const baseSec = Math.pow(2, attempt)   // 1, 2, 4, 8, ...
  const jitterSec = Math.random() - 0.5  // -0.5 .. +0.5
  return Math.min(1000 * (baseSec + jitterSec), maxMs)
}
```

`maxReconnectSeconds` defaults to **64**. Backoff resets to base after any
connection that opens. Measured, by stopping a Docker PDS mid-stream:

| attempt | wait |
| --- | --- |
| 0 | 0.8 s |
| 1 | 2.3 s |
| 2 | 3.9 s |
| 3 | 8.0 s |
| 4 | 16.2 s |
| 5 | 32.4 s |

The URL is a *function*, re-invoked on every attempt, so the cursor is re-read
at dial time and a reconnect resumes where we left off. Retryability is typed:
`CloseError` by RFC 6455 close code, `SocketError` / `HeartbeatTimeoutError` /
`IdleTimeoutError` retryable, `BufferOverflowError` / `DataModeError` fatal.
Heartbeat is on by default at 10 s (Node only); flow control pauses the socket
past a 1 MiB `highWaterMark`.

**The operational trap:** `Firehose` constructs its `Subscription` *without*
`onReconnectError`, so every transient reconnect is swallowed. My 90-second run
across a 40-second PDS outage logged **nothing** — no error, no warning, and
`reconnects: 0` in my own stats because `FirehoseSubscriptionError` only fires
when the async iterator itself rejects. Second trap: with a 64 s cap you can sit
in backoff for up to a minute *after* a host recovers (observed: PDS came back at
41 s, reconnect landed at 69.6 s). For a small curated registry, set
`maxReconnectSeconds: 8–16`.

### `@atproto/sync` API notes

The published README is **stale**: it documents `handleEvt`, but the option is
`handleEvent`. Actual `FirehoseOptions` (0.4.10): `idResolver`, `handleEvent`,
`onError`, `getCursor?`, `runner?`, `service?`, `subscriptionReconnectDelay?`,
`maxReconnectSeconds?`, `heartbeatIntervalMs?`, `headers?`,
`unauthenticatedCommits?`, `unauthenticatedHandles?`, `filterCollections?`,
`excludeIdentity?`, `excludeAccount?`, `excludeCommit?`, `excludeSync?`.
`getCursor` and `runner` are mutually exclusive (it throws).

`filterCollections` is **client-side** — there is no server-side filter on
`subscribeRepos`. It does save the expensive part: `parseCommitAuthenticated`
filters ops first and returns `[]` before any crypto if nothing matches.
A trailing `.*` is a prefix wildcard, so `freeschool.draft.*` will work for the
sidecars.

`MemoryRunner` is the right default: a partitioned queue keyed by DID giving
concurrency across repos and strict order within a repo, with a cursor that only
advances past a contiguous completed prefix — so a crash replays rather than
skips. Indexing must be idempotent.

---

## Backfill (`getRepo` / `listRecords`)

### `getRepo`

```
GET /xrpc/com.atproto.sync.getRepo?did=<did>[&since=<rev>]
→ application/vnd.ipld.car
```

Lexicon parameters are **`did` and `since` only**. There is *no* `collection`
parameter. I tested it anyway: `…&collection=community.lexicon.calendar.event`
returned HTTP 200 and **139,688 bytes — byte-identical to the unfiltered call**.
The param is silently ignored. The collection-scoped `getRepo` variant is a
*future* item in Sync 1.1 ("a variant of `com.atproto.sync.getRepo`… will be
specified"), not shipped.

So collection scoping happens client-side after parsing:

```ts
const car = (await agent.com.atproto.sync.getRepo({ did })).data
const verified = await verifyRepoCar(car, did, signingKey)   // sig + MST proof
const { root, blocks } = await readCarWithRoot(car)
const repo = await Repo.load(new MemoryBlockstore(blocks), root)
const leaves = await repo.data.listWithPrefix(`${collection}/`)  // MST subtree walk
```

`ReadableRepo` is **not** re-exported from `@atproto/repo`'s index — use `Repo`,
which extends it. `MST.listWithPrefix()` walks only the subtree covering that
collection's keys rather than every leaf, which matters on a large repo.

Errors are typed XRPC errors: `RepoNotFound`, `RepoTakendown`, `RepoSuspended`,
`RepoDeactivated`. I hit a real one — `did:plc:t665tlaiems3tmaeily7czco` on
`northsky.social`:

```
{"error":"RepoDeactivated","message":"Repo has been deactivated: did:plc:t665…"}
```
with `getRepoStatus` confirming `{"active":false,"status":"deactivated"}`.
Note `listRecords` on the same repo reports only a generic
`Could not find repo` — the sync endpoints give better status signal than the
repo endpoints.

### `listRecords`

```
GET /xrpc/com.atproto.repo.listRecords?repo=<did|handle>&collection=<nsid>&limit=<1-100>&cursor=<rkey>
```

No auth. `limit` max 100, default 50. Cursor is the last `rkey`; newest-first by
default, `reverse=true` flips it. Records come back already in atproto JSON
(`$link`/`blob` form), so no CBOR decoding.

**This is what we should use.** Measured on the same repo
(`did:plc:cbkjy5n7bk3ax2wplmtjofq2`, 155 calendar records):

| method | bytes over the wire | records |
| --- | --- | --- |
| `getRepo` (whole CAR) | 16,605,695 | 155 |
| `listRecords` × 2 collections | ~120 KB | 155 |

Identical record sets. The CAR is 140× larger because it carries every
`app.bsky.*` record and every MST node in the repo. The trade is verifiability:
`listRecords` output is TLS-trusted-from-the-PDS, while a CAR is
cryptographically verifiable against the account's signing key. For v1 on public
records, served by the authoritative PDS, `listRecords` is the right default;
keep `getRepo` for the re-sync path where a proof is worth the bytes.

### `getRepoStatus` and `getLatestCommit`

Both public, both cheap, both useful:

```
getLatestCommit?did=… → {"cid":"bafyrei…","rev":"3mp2hyykqeq2k"}
getRepoStatus?did=…   → {"did":"…","active":true,"rev":"3mp2hyykqeq2k"}
```

Polling `getLatestCommit` and comparing `rev` to our stored `rev` is a
one-request staleness check per repo — cheaper than anything else and the right
periodic audit for a small registry.

### Discovery: `listReposByCollection`

```
GET /xrpc/com.atproto.sync.listReposByCollection?collection=<nsid>&limit=<n>
```

Public on a **relay** — `relay1.us-east.bsky.network` answered immediately.
**Requires auth on every PDS I tried** (`eurosky.social`, `northsky.social`,
`pds.cauda.cloud`, `shiitake…` all returned
`{"error":"AuthMissing","message":"Authentication Required"}`). Sync 1.1 calls it
"implemented by relays… an optional additional service", so this is expected,
not a misconfiguration — but it means per-peer collection discovery is not
available to us. Bootstrap against a relay once, then never need it again.

Network-wide counts, 2026-09-12 (relay, exhausted in one page):

| collection | repos |
| --- | --- |
| `community.lexicon.calendar.event` | **445** |
| `community.lexicon.calendar.rsvp` | **1,700** |
| `coop.lexicon.event.listing` | **0** |

### Ordering: closing the backfill/live gap

The mechanism is `rev`, a lexicographically sortable TID on every commit. The
pattern (same as Tap's, and what the backfilling guide describes):

1. Open the subscription first and **buffer** events for the DID.
2. `getRepo` / `listRecords` the repo; record the `rev` from the commit
   (`getRepo`) or from `getLatestCommit` (`listRecords`, which returns no rev).
3. Drain the buffer, discarding any event whose `rev` ≤ the checkpoint rev.
4. Go live.

Since our writes are idempotent upserts keyed by `(did, collection, rkey)` with
a `rev`/`cid` guard, we can use the lazier order — backfill, then subscribe from
a cursor taken *before* the backfill started — and let replay be harmless.

---

## Tap

**What it is:** a single Go binary in `bluesky-social/indigo/cmd/tap`, announced
December 2025, still labelled beta. Image `ghcr.io/bluesky-social/indigo/tap:latest`,
port 2480, SQLite (`./tap.db`) or Postgres. It terminates the sync protocol —
firehose connection, signature and MST verification, automatic backfill, and
collection filtering — and hands your app plain JSON record/identity events over
WebSocket (with acks), fire-and-forget, or webhook. TypeScript client:
`@atproto/tap` (`Tap`, `TapChannel`, `SimpleIndexer`, `LexIndexer`).

Guarantees it gives you: at-least-once delivery, per-repo ordering (live events
act as synchronization barriers; historical events run concurrently between
them), backfill-before-live cutover, and **no cursor management in your app**.
Good fit for our data shape: "designed for moderate scale (millions of repos,
30k+ events/sec)" against a tracked-DID set, which is exactly ours.

**Can it run against a PDS host list? No.** This is the load-bearing finding.
`cmd/tap/main.go` defines a single flag:

```go
Name:    "relay-url",
Sources: cli.EnvVars("TAP_RELAY_URL"),
```
default `https://relay1.us-east.bsky.network`, and `FirehoseProcessor` holds it
as one `relayUrl string`. `runConsumer` dials exactly that one host
(`u.Path = "xrpc/com.atproto.sync.subscribeRepos"`) and the cursor table is
keyed on it (`Where("url = ?", fp.relayUrl)`). There is no host list, no
per-repo host routing for the live stream.

What *is* per-PDS is backfill and repair: `resyncer.go` resolves each DID
(`ident.PDSEndpoint()`, `ident.PublicKey()`) and calls
`comatproto.SyncGetRepo(ctx, client, did, "")` against that account's own PDS.
Automatic re-sync on validation failure marks the repo `desynchronized` and
retries with 1 min → 1 h backoff.

**Three ways we could use it:**

| option | shape | verdict |
| --- | --- | --- |
| Point `TAP_RELAY_URL` at one peer PDS | one Tap instance + one DB per peer | works (a PDS serves the same lexicon), but N containers and N databases for N peers; the "no relay" property holds |
| One Tap on a relay, `TAP_SIGNAL_COLLECTION=community.lexicon.calendar.event` | one container, network-wide calendar discovery, collection-filtered | operationally by far the cheapest, but reintroduces a relay dependency we decided against |
| Don't use Tap; own the loop | the spike in this brief | ~450 lines, no extra service, no extra DB, peer registry is first-class |

My recommendation: **own the loop.** Our peer count is small and curated, the
`@atproto/sync` `Firehose` + `MemoryRunner` already gives us verification,
per-repo ordering and cursor tracking inside the AppView process and the same
Postgres transaction, and Tap's one-relay assumption is precisely the thing our
federation model rejects. Keep Tap in reserve: if we later want network-wide
calendar discovery, a single Tap with `TAP_SIGNAL_COLLECTION` +
`TAP_COLLECTION_FILTERS` is a two-env-var deployment and we should not rebuild it.

Useful config, should we change our minds: `TAP_SIGNAL_COLLECTION` (track every
repo holding at least one record of an NSID — the "declaration record" pattern),
`TAP_COLLECTION_FILTERS` (comma-separated, `.*`-wildcarded at NSID dot
boundaries), `TAP_FULL_NETWORK` (days/weeks of backfill; don't),
`TAP_NO_REPLAY` (local dev only), `TAP_ADMIN_PASSWORD` (Basic auth, user
`admin`, required if exposed), `TAP_WEBHOOK_URL` (serverless delivery).
Caveat on the WebSocket mode: multiple connected clients get events **sharded**
across them with no affinity guarantee — one consumer per Tap unless you want
that.

---

## The script

`scratchpad/research/r4_federation/` — Node 20+/ESM TypeScript, typechecks clean
under `strict` + `noUncheckedIndexedAccess`.

```
package.json     pinned: @atproto/sync 0.4.10, repo 0.10.14, identity 0.5.13, api 0.20.44
tsconfig.json    NodeNext, ES2023, strict
peers.json       the peer registry
src/config.ts    registry schema, host normalisation (strips trailing / and /xrpc)
src/cursors.ts   per-host cursor store; debounced, monotonic, temp-file+rename
src/identity.ts  handle->DID->PDS; hostsForDids(); hasMoved()
src/backfill.ts  listRecords and getRepo(+verifyRepoCar) paths
src/lex-json.ts  CID -> {$link}, Uint8Array -> {$bytes}
src/follow-pds.ts CLI: follow | backfill | resolve | discover
runs/            real output from every run quoted below
probes/          the throwaway scripts that produced the wire-level findings
```

### How to run

```bash
npm install
npx tsc -p tsconfig.json --noEmit

npx tsx src/follow-pds.ts resolve ngerakines.me smokesignal.events madrid.pydata.org
npx tsx src/follow-pds.ts backfill --method listRecords
npx tsx src/follow-pds.ts backfill --method getRepo --did did:plc:jck5nhbxwo5gnwgdfchdqzum
npx tsx src/follow-pds.ts follow --duration 210 > events.ndjson 2> follow.log
npx tsx src/follow-pds.ts discover --limit 30
```

NDJSON on stdout, logs on stderr. `--backfill` on `follow` does both in one
process. `--no-verify` disables commit signature / MST proof / handle
verification (local dev only).

### Config

```json
{
  "peers": [
    { "name": "eurosky",  "host": "https://eurosky.social" },
    { "name": "northsky", "host": "https://northsky.social" },
    { "name": "shiitake", "host": "https://shiitake.us-east.host.bsky.network" },
    { "name": "cauda",    "host": "https://pds.cauda.cloud", "enabled": false },
    { "name": "local-dev", "host": "http://localhost:3001", "enabled": false,
      "allowPrivateNetwork": true, "unauthenticatedCommits": true }
  ],
  "collections": ["community.lexicon.calendar.event", "community.lexicon.calendar.rsvp"],
  "backfillDids": ["did:plc:cbkjy5n7bk3ax2wplmtjofq2", "did:plc:jck5nhbxwo5gnwgdfchdqzum"],
  "cursorFile": "./.cursors.json",
  "backfillMethod": "listRecords",
  "plcUrl": "https://plc.directory",
  "maxReconnectSeconds": 64,
  "heartbeatIntervalMs": 10000
}
```

`allowPrivateNetwork` exists because `@atproto/identity` routes all HTTP
identity resolution through an SSRF-protected fetch that refuses private IPs,
plain `http:`, and custom ports. The escape hatch is passing your own `fetch`,
which it then uses as-is: `new IdResolver({ plcUrl, fetch: globalThis.fetch })`.
Without this, `http://localhost:3000` cannot resolve a DID at all.

### What actually ran (2026-09-12 / 2026-09-13 UTC)

**Public hosts worked; the Docker PDS was only needed for the fault injection.**

**1 — `resolve`.** Real output:

```json
{"kind":"resolve","actor":"ngerakines.me","did":"did:plc:cbkjy5n7bk3ax2wplmtjofq2","handle":"ngerakines.me","pds":"https://pds.cauda.cloud","signingKey":"did:key:zQ3shXvCK2RyPrSLYQjBEw5CExZkUhJH3n1K2Mb9sC7JbvRMF"}
{"kind":"resolve","actor":"smokesignal.events","did":"did:plc:tgudj2fjm77pzkuawquqhsxm","handle":"smokesignal.events","pds":"https://pds.cauda.cloud","signingKey":"did:key:zQ3shgHhfAi6jN9e92M6SXcV62f9C6VRREunZ276USQtZsgWS"}
{"kind":"resolve","actor":"madrid.pydata.org","did":"did:plc:jck5nhbxwo5gnwgdfchdqzum","handle":"madrid.pydata.org","pds":"https://eurosky.social","signingKey":"did:key:zQ3sht41882qfE6cM5hcLePG2zcxcSx8ckB2xuoz3He2h1qjL"}
{"kind":"peer-registry-suggestion","peers":[{"name":"pds.cauda","host":"https://pds.cauda.cloud","dids":["did:plc:cbkjy5n7bk3ax2wplmtjofq2","did:plc:tgudj2fjm77pzkuawquqhsxm"]},{"name":"eurosky","host":"https://eurosky.social","dids":["did:plc:jck5nhbxwo5gnwgdfchdqzum","did:plc:ooensn4mr5mhznzypvxelfa3"]}]}
```

**2 — `backfill --method listRecords`**, 5 DIDs across 4 real PDSes:

```
backfill: 5 did(s) via listRecords, collections=[community.lexicon.calendar.event, community.lexicon.calendar.rsvp]
backfill did:plc:cbkjy5n7bk3ax2wplmtjofq2 @ https://pds.cauda.cloud: 155 record(s)
backfill did:plc:jck5nhbxwo5gnwgdfchdqzum @ https://eurosky.social: 1 record(s)
backfill did:plc:ooensn4mr5mhznzypvxelfa3 @ https://eurosky.social: 1 record(s)
backfill did:plc:zi2k3ep3yzo34xjcwxcrkkzg @ https://northsky.social: 3 record(s)
! backfill did:plc:t665tlaiems3tmaeily7czco: error: Could not find repo: did:plc:t665tlaiems3tmaeily7czco
```
→ `{ community.lexicon.calendar.event: 42, community.lexicon.calendar.rsvp: 118 }`.
One real `community.lexicon.calendar.event`, unabridged:

```json
{"kind":"record","source":"backfill","via":"listRecords","did":"did:plc:cbkjy5n7bk3ax2wplmtjofq2","pds":"https://pds.cauda.cloud","collection":"community.lexicon.calendar.event","rkey":"3mqhzqij7sshu","uri":"at://did:plc:cbkjy5n7bk3ax2wplmtjofq2/community.lexicon.calendar.event/3mqhzqij7sshu","cid":"bafyreickoect35fesknmmtxalx4q7fbypxp22natef3kzr6lwzf7fuzewe","record":{"mode":"community.lexicon.calendar.event#inperson","name":"Game Night","$type":"community.lexicon.calendar.event","media":[{"role":"thumbnail","content":{"$type":"blob","ref":{"$link":"bafkreihwmo5eiptii7qczfi2r3yc63vmctaey32b7npga5go2mxndu7taa"},"mimeType":"image/png","size":5069058},"aspect_ratio":{"width":2048,"height":1463}}],"theme":{"name":"minimal","baseColor":"mist","accentColor":"indigo"},"endsAt":"2026-07-16T02:00:00.000Z","status":"community.lexicon.calendar.event#scheduled","startsAt":"2026-07-16T00:00:00.000Z","timezone":"America/New_York","createdAt":"2026-07-12T20:38:55.246Z","createdWith":"https://atmo.rsvp","description":"Playing some games with friends","preferences":{"showInDiscovery":true}}}
```

and an RSVP, showing the `subject` strongref we will need for join logic:

```json
{"kind":"record","source":"backfill","via":"listRecords","did":"did:plc:cbkjy5n7bk3ax2wplmtjofq2","pds":"https://pds.cauda.cloud","collection":"community.lexicon.calendar.rsvp","rkey":"eeab17d5ccf0d","uri":"at://did:plc:cbkjy5n7bk3ax2wplmtjofq2/community.lexicon.calendar.rsvp/eeab17d5ccf0d","cid":"bafyreig4ccuxcydrssgkpxqqgrgcptu5zemypxboob2ebxqzlh62snwflm","record":{"$type":"community.lexicon.calendar.rsvp","status":"community.lexicon.calendar.rsvp#going","subject":{"cid":"bafyreiflfb2v3igpb6z3l5m7ap535hmlrl63ejn5jybuefjfwhbesybud4","uri":"at://did:plc:4hodhjl2kposuchzvpiviwps/community.lexicon.calendar.event/3mqdau33ozs2n"},"createdAt":"2026-07-14T11:15:02.865Z"}}
```

**3 — `backfill --method getRepo`**, CAR parsed and cryptographically verified:

```
backfill did:plc:jck5nhbxwo5gnwgdfchdqzum @ https://eurosky.social: 1 record(s) from 139688 bytes of CAR rev=3mp2hyykqeq2k
backfill did:plc:cbkjy5n7bk3ax2wplmtjofq2 @ https://pds.cauda.cloud: 155 record(s) from 16605695 bytes of CAR rev=3mve2a2eqyc2a
! backfill did:plc:t665tlaiems3tmaeily7czco: RepoDeactivated: Repo has been deactivated: did:plc:t665tlaiems3tmaeily7czco
```

Same 155 records as `listRecords` on that repo — the two paths agree.

**4 — `follow`, 7 real PDS hosts, 3.5 minutes, calendar filter.** Final stats:

```
stats eurosky:   {"handled":0,"records":0,"identity":0,"account":0,"sync":0,"errors":0,"reconnects":0,"cursorSeq":59720021}
stats northsky:  {"handled":0,...,"cursorSeq":10805800}
stats shiitake:  {"handled":0,...,"cursorSeq":1038909344}
stats shimeji:   {"handled":0,...,"cursorSeq":1042829047}
stats morel:     {"handled":0,...,"cursorSeq":990499231}
stats amanita:   {"handled":0,...,"cursorSeq":1022507585}
stats lionsmane: {"handled":0,...,"cursorSeq":1031820837}
```

Zero matches, as expected — only 445 repos network-wide write calendar events,
so 3.5 minutes across 7 hosts is far too short a window. The point this run
proves is that all seven sockets were healthy (`cursorSeq` climbing
independently, zero errors, zero reconnects) and that cursors persisted per host:

```json
{"https://shiitake.us-east.host.bsky.network":{"cursor":1038909344,"updatedAt":"2026-09-13T01:22:15.045Z"},
 "https://northsky.social":{"cursor":10805800,"updatedAt":"2026-09-13T01:22:08.401Z"},
 "https://eurosky.social":{"cursor":59720021,"updatedAt":"2026-09-13T01:22:14.647Z"}, …}
```

**5 — `follow` with a broad filter**, same 2 community hosts, same window, to
prove the live decode path: **46 records** (45 `app.bsky.feed.post`, 1
`app.bsky.actor.profile`), each decoded from a `#commit` CAR slice with
signatures verified. Verbatim:

```json
{"kind":"record","source":"live","peer":"northsky","host":"https://northsky.social","seq":10805536,"time":"2026-09-13T01:18:52.107Z","action":"create","did":"did:plc:vajldmk2su62tzbzgnjaeklo","collection":"app.bsky.feed.post","rkey":"3mveggwv7qc2o","uri":"at://did:plc:vajldmk2su62tzbzgnjaeklo/app.bsky.feed.post/3mveggwv7qc2o","rev":"3mveggvhyio2i","commit":"bafyreicpauyofoktui33cgmwquwt4csmglgbsntecrvbqoh5xiz52hx7jy","cid":"bafyreidsgdrvrzpwkprgm6e7ypdxcajfnznlxyrtan4pqnltlryhodjg3y","record":{"text":"YES\n\nYES THIS IS IMPORTANT","$type":"app.bsky.feed.post","langs":["en"],"reply":{…},"createdAt":"2026-09-13T01:18:53.578Z"}}
```

**6 — the proof that matters: cursor replay with the calendar filter.**
I used `probes/find-recent.mjs` to find a `community.lexicon.calendar.event`
written 6.6 h earlier — inside the 24 h replay window — on
`shiitake.us-east.host.bsky.network`, then `probes/bisect-cursor.mjs` to binary
search that host's seq space for the cursor just before it (1,038,625,652 →
first replayed event at `18:39:58.254Z`). Seeded the cursor file and ran the real
script unmodified:

```
-> shiitake wss://shiitake.us-east.host.bsky.network/xrpc/com.atproto.sync.subscribeRepos cursor=1038625652
stats shiitake: {"handled":69,"records":33,"identity":8,"account":21,"sync":7,"errors":0,"reconnects":0,"cursorSeq":1038845209}
stats shiitake: {"handled":72,"records":33,"identity":9,"account":23,"sync":7,"errors":0,"reconnects":0,"cursorSeq":1038910420}
```

**~285,000 frames of real history consumed in ~50 seconds (≈5,700 frames/s**
including CBOR decode and client-side filtering), then caught up to the live
head and kept streaming. Final tally over 72 emitted events:

```
record:community.lexicon.calendar.event  33
account (active=true)                     9
account:deactivated                      10
account:deleted                           3
account:takendown                         1
identity                                  9
sync                                      7
```

One of the 33, verbatim — a real live `community.lexicon.calendar.event` pulled
out of a `#commit` CAR slice with signature and MST proof verified:

```json
{"kind":"record","source":"live","peer":"shiitake","host":"https://shiitake.us-east.host.bsky.network","seq":1038628336,"time":"2026-09-12T18:43:08.056Z","action":"create","did":"did:plc:vsnj4aaxyatiht4spdht2q2t","collection":"community.lexicon.calendar.event","rkey":"3mvdqdbf6es2v","uri":"at://did:plc:vsnj4aaxyatiht4spdht2q2t/community.lexicon.calendar.event/3mvdqdbf6es2v","rev":"3mvdqdbfg6s2v","commit":"bafyreiaz4nw54cxvs2hc63oibookqrgs6kntqcrhuv45zmfaeng7kyocy4","cid":"bafyreifhn7zvkjd3s4hvaz7r3o2y2uhbd4y4oyok65vwvupwk3j646slhi","record":{"mode":"community.lexicon.calendar.event#inperson","name":"Vancouver Farmers Markets","$type":"community.lexicon.calendar.event","status":"community.lexicon.calendar.event#scheduled","startsAt":"2026-09-13T18:32:23.922Z","createdAt":"2026-09-12T18:43:07.843Z","locations":[{"name":"Various locations in Vancouver, BC"}],"description":"Source: eventbrite | URL: https://www.eventbrite.ca/o/vancouver-farmers-markets-8597508605"}}
```

All 33 came from a single DID (`did:plc:vsnj4aaxyatiht4spdht2q2t`) doing a
bulk Eventbrite import — a useful reminder that one repo can emit a burst and
our per-repo partition will serialize it.

**7 — local reference PDS (Docker) and fault injection.**
`docker run ghcr.io/bluesky-social/pds:latest` on port 3001 with
`PDS_DEV_MODE=true`, `PDS_INVITE_REQUIRED=false`,
`PDS_DISABLE_SSRF_PROTECTION=true`. The follower attached over
`ws://localhost:3001/xrpc/com.atproto.sync.subscribeRepos` and held the socket
cleanly (empty PDS → no events, `errors: 0`), which exercises the `http:`→`ws:`
derivation and the `allowPrivateNetwork` resolver path. I deliberately did **not**
create an account on it: the stock image points `PDS_DID_PLC_URL` at the real
`https://plc.directory`, and account creation would have minted a permanent
public `did:plc` for a throwaway container. Writing local records end-to-end
needs a local PLC (`@did-plc/server`) alongside; that is a small follow-up, not a
blocker, because the public-host replay already proved the live calendar path.

Then I bounced that container mid-stream to measure reconnect behaviour — see
the backoff table above. `runs/follow_reconnect.log` is the evidence that
`Firehose` logs nothing at all across a 40-second outage;
`runs/reconnect_probe.log` is the same outage observed one layer down through
`@atproto/ws-client`.

**8 — `discover`** (relay for bootstrap only): 30 DIDs holding
`community.lexicon.calendar.event` resolved to **24 distinct PDS hosts**; 30
DIDs holding `community.lexicon.calendar.rsvp` also to 24 hosts. Top hosts held
2–3 repos each. That ratio is the scaling argument against network-wide direct
following.

---

## AppView notes

### Cursor storage

One row per peer host, not per repo, not global:

```sql
create table peer_host (
  host              text primary key,        -- 'https://eurosky.social', normalised origin
  name              text not null,
  enabled           boolean not null default true,
  cursor            bigint,                  -- last contiguous seq fully processed
  cursor_updated_at timestamptz,
  last_connected_at timestamptz,
  last_error        text,
  consecutive_failures int not null default 0,
  added_by          text,                    -- DID of the operator who added it
  added_at          timestamptz not null default now()
);
```

- **Per host, always.** `seq` spaces are independent. Key on the normalised
  origin so `https://eurosky.social/` and `https://eurosky.social/xrpc` cannot
  produce two rows.
- `bigint` — `shiitake` is already past 1.03 × 10⁹.
- Write it **debounced** (Tap uses 1 s; the spike uses 1 s), not per event.
  Monotonic: with a partitioned runner, a slow partition can finish after a fast
  one, so never let the stored cursor go backwards.
- The cursor must lag the *contiguous completed prefix*, which is exactly what
  `MemoryRunner` tracks. That guarantees at-least-once, never at-most-once, so
  **every write must be an idempotent upsert** on `(did, collection, rkey)` with
  a `rev`-or-`cid` guard to drop replays.
- Write the cursor in the same transaction as the records only if you need
  exactly-once; for our shape, idempotent upserts plus a periodic cursor write is
  cheaper and correct.
- Keep `last_error` and `consecutive_failures` on the row: since `Firehose`
  hides reconnects, a host that has been flapping for an hour is otherwise
  invisible.

Also store per-repo sync state, which is what makes repair possible:

```sql
create table peer_repo (
  did          text primary key,
  home_host    text not null references peer_host(host),
  last_rev     text,              -- TID; the `since` for the next re-sync
  last_commit  text,              -- CID
  status       text not null default 'active',
  -- active | deactivated | takendown | suspended | deleted | desynchronized | throttled
  status_at    timestamptz,
  backfilled_at timestamptz
);
```

### Ordering guarantees per repo

- **Within a repo: strictly ordered, and you must preserve it.** The sync spec:
  "Stream events can be processed concurrently across accounts, but they should
  be processed sequentially in-order for any given account." Partition by DID.
  `MemoryRunner` does this; so does Tap, where a live event is a synchronization
  barrier that must be acked before anything else for that repo is sent.
- **Across repos: no ordering.** And across *hosts*, no common clock at all —
  `seq` is incomparable between peers and `time` is the emitting host's wall
  clock. Never order records by `seq`; order by the record's own `createdAt` /
  `startsAt`, or by `rev` within a repo.
- `rev` is the per-repo version. Monotonic, lexicographically sortable. It is
  the right optimistic-concurrency token for our upserts, and the right `since`
  for a diff re-sync.
- Burst tolerance: one repo wrote 33 calendar events in a handful of commits in
  my replay. The per-DID partition serializes that, so a single chatty repo
  throttles only itself.

### Identity, deactivation, migration

**`#identity` → always re-resolve.** The field is advisory; the event means the
DID document may have changed. `forceRefresh: true` on `DidResolver.resolve`
bypasses the cache. Then compare the `#atproto_pds` endpoint to the host we
heard the event on. The spike does exactly this and emits
`movedOffThisPeer: true` — that flag is the migration trigger.

**`#account active=false` → stop expecting commits from that host**, and branch
on `status`:

| status | meaning | AppView action |
| --- | --- | --- |
| `deactivated` | user-initiated; very often step 1 of a PDS migration | keep records, mark `deactivated`, start watching the DID document for a new PDS |
| `suspended` / `takendown` | moderation at *that host* | hide from public views per our policy; keep the rows |
| `deleted` | gone | delete our rows for that DID |
| `desynchronized` | the emitting host has lost sync with the repo | don't trust its stream for that DID; `getRepo` from the authoritative PDS |
| `throttled` | the repo exceeded re-sync rate limits upstream | back off; do not hammer |

The lexicon is careful about whose status this is: "the status is at the host
which emitted the event, not necessarily that at the currently active PDS." A
relay takedown reports `active=false` while the PDS is fine. Store status
**per (did, host)** if we ever follow the same DID from two hosts.

**How to detect a repo moved to a new PDS** — four independent signals, in
order of how early they fire:

1. `#identity` on the old host, then re-resolve → `#atproto_pds` differs. Earliest.
2. `#account active=false status=deactivated` on the old host, then poll the DID
   document. (Migration is typically: deactivate on old → activate on new.)
3. `getRepo` / `listRecords` against the old host starts returning
   `RepoDeactivated` / `RepoNotFound` while the DID document still names it —
   the signature of a half-finished move. I hit this live on
   `did:plc:t665tlaiems3tmaeily7czco`.
4. A `#sync` event on the *new* host with a `rev` ahead of ours.

The authoritative history is the PLC audit log, `GET /{did}/log/audit` on
`plc.directory`, which lists every PDS endpoint the DID has ever had. Real
example from the deactivated repo above:

```
2023-09-19T13:56:24.547Z  https://bsky.social
2023-11-13T02:54:42.429Z  https://lionsmane.us-east.host.bsky.network
2024-02-07T22:59:53.772Z  https://lionsmane.us-east.host.bsky.network
2026-01-21T12:25:14.959Z  https://lionsmane.us-east.host.bsky.network
2026-01-22T14:10:38.410Z  https://northsky.social
```

Three PDS homes over three years. **Repos move, and a peer registry of hosts
will rot if it is not re-derived from DID documents.** The registry should store
DIDs as the source of truth and hosts as a derived index, refreshed on
`#identity`, on backfill, and on a slow periodic sweep.

Recovery procedure when a tracked DID moves to a host not in our registry:
re-resolve → add the new host (new `peer_host` row, cursor null → start at head)
→ `getRepo?did=…&since=<our last_rev>` against the new PDS to close the gap →
`peer_repo.home_host = new host`. Whether to *keep* following the old host
depends on whether other tracked DIDs still live there.

Also verify handles bidirectionally (`@atproto/sync` does this by default via
`unauthenticatedHandles: false`): handle → DID and DID document `alsoKnownAs` →
handle must agree, or the handle is `handle.invalid`. Never key anything on a
handle; key on the DID.

### Rate limits

Measured and sourced:

| surface | limit | source |
| --- | --- | --- |
| PDS XRPC, per IP (default route) | **3000 req / 300 s** | observed `ratelimit-policy: 3000;w=300` on `eurosky.social` and `shiitake…` |
| `com.atproto.sync.getRepo` | **6000 points / 5 min** | `packages/pds/src/api/com/atproto/sync/getRepo.ts` |
| `com.atproto.repo.listRecords` | no per-route limit; `limit` max 100, default 50 | route source + lexicon |
| `subscribeRepos` consumer lag | `PDS_MAX_SUBSCRIPTION_BUFFER`, default **500** events → `ConsumerTooSlow` | PDS config |
| `subscribeRepos` cursor replay | `PDS_REPO_BACKFILL_LIMIT_MS`, default **1 day** | PDS config; confirmed empirically |
| `#commit` `blocks` | 2 MB hard | lexicon `maxLength` |
| ops per `#commit` | 200 | lexicon `maxLength` |
| WebSocket frame | 5 MB | proposal 0006 |
| individual record | 1 MB | proposal 0006 |
| `#sync` `blocks` | 10 KB | lexicon `maxLength` |

`pds.cauda.cloud` returned **no** rate-limit headers, meaning
`PDS_RATE_LIMITS_ENABLED` is off there. Don't assume headers exist; implement
client-side pacing regardless. The backfilling guide is explicit: "Be careful
not to get rate limited. You will be making one call to `getRepo` per user…
client side rate limiting to prevent your requests from getting blocked by
firewalls on the PDS or relay."

Practical budget: a 24 h `OutdatedCursor` gap across a 50-repo registry is 50
`getRepo` calls — trivially inside 6000 points / 5 min, but if those repos are
Bluesky-active the CARs could be 16 MB each (800 MB). Prefer
`getLatestCommit` to check `rev` first, then `listRecords` for the collections
we care about, and reserve full-CAR `getRepo` for repos that genuinely need
proof.

WebSocket connection counts are the other budget: 7 concurrent sockets was
unremarkable, but a registry of 50 peers means 50 long-lived TLS connections
from one process. Pool them across workers, and send a real `User-Agent` via
`headers` so operators can identify us (Tap does; our spike currently does not —
**add this**).

### What a peer registry should look like

Two layers. **DIDs are the truth; hosts are a cache.**

```jsonc
{
  "version": 1,
  "self": { "did": "did:plc:<freeschool-boulder>", "name": "Free School Boulder" },
  "collections": [
    "community.lexicon.calendar.event",
    "community.lexicon.calendar.rsvp",
    "coop.lexicon.event.listing",
    "freeschool.draft.*"
  ],
  "peerSchools": [
    { "did": "did:plc:…", "handle": "freeschool.example.org", "trust": "full",
      "note": "reciprocal; indexes our events too" }
  ],
  "peerRepos": [
    { "did": "did:plc:cbkjy5n7bk3ax2wplmtjofq2", "handle": "ngerakines.me",
      "trust": "records-only", "addedBy": "did:plc:…", "addedAt": "2026-09-12" }
  ],
  "derivedHosts": [
    { "host": "https://pds.cauda.cloud", "dids": ["did:plc:cbkjy5n7bk3ax2wplmtjofq2"],
      "lastResolvedAt": "2026-09-12T01:16:05Z" }
  ],
  "discovery": { "relay": "https://relay1.us-east.bsky.network", "useFor": ["listReposByCollection"] }
}
```

- `peerSchools` vs `peerRepos` because a school DID is a federation partner
  (we trust its curation, maybe mirror its peer list) while an individual repo is
  just a data source.
- `derivedHosts` is regenerated, never hand-edited — `follow-pds.ts resolve`
  already emits exactly this shape as `peer-registry-suggestion`.
- `trust` matters once we index anything beyond public calendar records.
- Keep the discovery relay in the config, clearly scoped to
  `listReposByCollection`, so the relay dependency stays a bootstrap convenience
  rather than a runtime requirement.

**The registry should eventually be an atproto record in the school's own repo**
(`freeschool.peer.registry`, say) custodied by the app, so a new Free School can
subscribe to a neighbour's registry and inherit its peers — federation by
transitive subscription. That keeps the no-relay model and is the honest
mechanism for "a network of free schools" rather than "one AppView with a config
file". Not needed for v1; the shape above is forward-compatible with it.

**Scaling caveat, restated because it constrains the product:** 445 repos write
`community.lexicon.calendar.event`, spread over hundreds of PDSes (~0.8 distinct
hosts per repo in my sample). Direct-PDS federation is excellent for a curated
set of peers and does **not** work for "index every calendar event in the
atmosphere". If we want the latter, that is a relay or a single Tap with
`TAP_SIGNAL_COLLECTION`, and it is a separate, clearly-labelled ingest path.

### Concrete changes to make before this is production code

1. Send a `User-Agent` (`Firehose` accepts `headers`) so peer operators can
   identify and contact us.
2. Handle `#info` / `OutdatedCursor` — `@atproto/sync` drops it. Either patch
   the Firehose or run the `Subscription` ourselves. Without this we take a
   silent 24 h+ gap after any long outage.
3. Get reconnect observability: pass `onReconnectError` through, or drive
   `@atproto/ws-client` directly. Today a flapping peer is invisible.
4. Lower `maxReconnectSeconds` to 8–16 for a small registry.
5. Widen the `AccountStatus` type to include `desynchronized` and `throttled`.
6. Add the `#sync`-triggered repair path: on `#sync` with a `rev` ahead of
   `peer_repo.last_rev`, enqueue a `getRepo?since=last_rev` re-sync.
7. Implement the Sync 1.1 record-state table (did, collection, rkey, cid) so a
   re-sync can diff against it and emit synthetic deletes for records that
   disappeared — otherwise deletions missed during a gap are never noticed.

---

## Sources

Package versions, all latest on npm as of 2026-09-12 (published 2026-09-11),
and all installed and run in the spike:

| package | version |
| --- | --- |
| `@atproto/sync` | **0.4.10** |
| `@atproto/repo` | **0.10.14** |
| `@atproto/identity` | **0.5.13** |
| `@atproto/api` | **0.20.44** |
| `@atproto/xrpc` | **0.8.13** |
| `@atproto/xrpc-server` | **0.13.1** (transitive) |
| `@atproto/ws-client` | **0.2.1** (transitive; published 2026-08-11) |
| `@atproto/lex` | 0.3.11 · `@atproto/lex-cbor` 0.1.6 · `@atproto/lex-data` 0.1.7 |
| `@atproto/common` | 0.8.3 · `@atproto/syntax` 0.7.6 · `@atproto/crypto` 0.5.5 |
| `@atproto/tap` | client lib for Tap (not installed; README read) |

Repository state at time of reading:

- `bluesky-social/atproto` `main` @ **`2e1787c2bf5bd47b55c3df930d688bb40b5ae63d`**
  (2026-09-11, "Add tsconfig covering util config files (#5494)")
- `bluesky-social/indigo` `main` @ **`41278964ec8e3253e70d4e919dfb8e34211c543d`**
  (2026-09-03, "Add `updatedAt` to interests preference (#1470)")

Specifications and lexicons:

- Sync spec — https://atproto.com/specs/sync
- `com.atproto.sync.subscribeRepos` lexicon —
  https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/sync/subscribeRepos.json
- `com.atproto.sync.getRepo` lexicon —
  https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/sync/getRepo.json
- `com.atproto.repo.listRecords` lexicon —
  https://raw.githubusercontent.com/bluesky-social/atproto/main/lexicons/com/atproto/repo/listRecords.json
- Proposal 0006, AT Protocol Sync v1.1 —
  https://github.com/bluesky-social/proposals/tree/main/0006-sync-iteration
  (`#sync`, `prevData`, inductive firehose, size limits, `desynchronized`/`throttled`,
  `listReposByCollection`, streaming CAR ordering, deprecations)
- Backfilling guide — https://atproto.com/guides/backfilling

PDS implementation (the source of the cursor/retention/limit facts):

- `packages/pds/src/api/com/atproto/sync/subscribeRepos.ts` — `FutureCursor`,
  `#info`/`OutdatedCursor`, `backfillTime` logic
- `packages/pds/src/api/com/atproto/sync/getRepo.ts` — `rateLimit: { durationMs: 5 * MINUTE, points: 6000 }`
- `packages/pds/src/config/config.ts` — `maxBuffer: env.maxSubscriptionBuffer ?? 500`,
  `repoBackfillLimitMs: env.repoBackfillLimitMs ?? DAY`
- `packages/pds/src/sequencer/outbox.ts` — `ConsumerTooSlow`
- `packages/pds/src/api/com/atproto/repo/listRecords.ts`

Tap:

- `cmd/tap/README.md` — https://github.com/bluesky-social/indigo/blob/main/cmd/tap/README.md
- `cmd/tap/main.go`, `firehose.go`, `resyncer.go` at commit `4127896…` — the
  single `relay-url` flag, `fp.relayUrl` dial, `Where("url = ?", fp.relayUrl)`
  cursor key, and `SyncGetRepo(ctx, client, did, "")` per-DID backfill
- `@atproto/tap` client README —
  https://github.com/bluesky-social/atproto/blob/main/packages/tap/README.md
- Announcement — https://bsky.network/blog/introducing-tap (redirected from
  docs.bsky.app; fetched empty, so all Tap facts above come from the two READMEs
  and the Go source)

Live hosts and accounts exercised:

- PDS hosts: `eurosky.social`, `northsky.social`, `pds.cauda.cloud`,
  `shiitake.us-east.host.bsky.network`, `shimeji…`, `morel…`, `amanita…`,
  `lionsmane…` (all `*.us-east.host.bsky.network`)
- Repos with real `community.lexicon.calendar.*` records:
  `did:plc:cbkjy5n7bk3ax2wplmtjofq2` (`ngerakines.me`, Smoke Signal's author),
  `did:plc:tgudj2fjm77pzkuawquqhsxm` (`smokesignal.events`),
  `did:plc:jck5nhbxwo5gnwgdfchdqzum` (`madrid.pydata.org`),
  `did:plc:ooensn4mr5mhznzypvxelfa3` (`eurosky.social`),
  `did:plc:zi2k3ep3yzo34xjcwxcrkkzg` (`spookalucca.tv`),
  `did:plc:vsnj4aaxyatiht4spdht2q2t` (the 33 live events),
  `did:plc:t665tlaiems3tmaeily7czco` (`jdgoulet.northsky.social`, deactivated,
  three historical PDS homes)
- `did:plc:b63bmauox6z5rbibwrhxrdnw` = `atmo.rsvp`, on
  `stropharia.us-west.host.bsky.network`. Events carry
  `"createdWith": "https://atmo.rsvp"`. Smoke Signal's own site states it
  "indexes events from across the ATmosphere" and points creation at
  `atmo.rsvp` and `platform.openmeet.net` — worth noting as prior art for an
  index-plus-authoring split.
- Relay used for discovery only: `relay1.us-east.bsky.network`
- Local PDS image: `ghcr.io/bluesky-social/pds:latest`, digest
  `sha256:05e164855fa1a3cf251c002210c46f8c86e7ae27bddc7a96045da25483840826`

All raw output is in `scratchpad/research/r4_federation/runs/`; the wire-level
probes are in `scratchpad/research/r4_federation/probes/`.

---

## Confidence / not verified

**High confidence — directly observed on live hosts:**
`#commit` / `#sync` / `#identity` / `#account` / `#info` frame shapes and field
values; `tooBig: false`, `blobs: []`, `prevData` present; `FutureCursor` as a
fatal error frame with close 1008; `OutdatedCursor` as a leading `#info` frame;
the 24 h retention window; `getRepo` ignoring a `collection` param
(byte-identical responses); `RepoDeactivated` from both `getRepo` and
`getRepoStatus`; `listReposByCollection` requiring auth on four different PDSes
and being public on the relay; the 2^n ± 0.5 s backoff curve; `Firehose` logging
nothing across a reconnect; CAR decode + `verifyRepoCar` agreeing with
`listRecords` on 155 records; the PLC audit log showing three PDS homes;
`ratelimit-policy: 3000;w=300` headers.

**High confidence — read from pinned source:**
the 6000-points/5-min `getRepo` rate limit; `maxBuffer ?? 500`;
`repoBackfillLimitMs ?? DAY`; Tap's single `relay-url`; the `backoffMs`
implementation; `@atproto/sync` not wiring `onReconnectError`;
`@atproto/sync` having no `#info` branch; `AccountStatus` missing the two new
statuses.

**Medium confidence:**
- The 3000 req/300 s figure is the default route policy as advertised in
  response headers. Per-route overrides exist (getRepo is 6000/5 min) and
  operators can change or disable the whole thing — `pds.cauda.cloud` sends no
  headers at all. Treat it as an order of magnitude, not a contract.
- ~5,700 frames/s replay throughput was one run on one laptop against one PDS
  with a two-collection filter, and the filter means most frames skipped
  verification. A wider filter will be much slower.
- Network-wide repo counts (445 / 1,700 / 0) are what one relay knows. A relay's
  `listReposByCollection` index is explicitly optional and may be incomplete;
  the suspiciously round 1,700 could be a cap, though the response carried no
  cursor.
- The `#account` → `#identity` → `#sync` triple I observed was an account
  activation. I did not observe a real PDS **migration** end to end, so the
  migration-detection sequence above is assembled from proposal 0006, the
  lexicon, and the deactivated-repo plus audit-log evidence — not from watching
  one happen.

**Not verified:**
- **Writing a record to a local PDS and seeing it come back out of its own
  `subscribeRepos`.** The container ran and the follower attached to it, but I
  created no account (the stock image would have minted a permanent public
  `did:plc`). Needs a local `@did-plc/server`. This is the one gap in the
  end-to-end proof, and the public-host replay covers the same code path.
- Tap itself was never executed — no `tap run`, no `/repos/add`. All Tap claims
  come from its README and Go source. In particular I have not confirmed that
  pointing `TAP_RELAY_URL` at a bare PDS works in practice, only that the
  lexicon it dials is the one a PDS serves.
- `desynchronized` and `throttled` account statuses: in the lexicon, never seen
  on the wire.
- `#commit` ops with `prev` populated (updates/deletes) — every op I captured was
  a `create`.
- `tooBig: true`, a `ConsumerTooSlow` disconnect, and a >2 MB `blocks` field:
  none occurred, as intended.
- `getRepo?since=<rev>` diff behaviour. The code path exists in the spike and
  guards against missing record blocks, but no diff was actually fetched.
- Inductive-firehose validation via `prevData` operation inversion. We receive
  and log `prevData`; `@atproto/sync`'s `verifyProofs` checks signature and MST
  reachability but I did **not** confirm it performs full op-inversion against a
  retained previous `data` CID. If we want the Sync 1.1 guarantee rather than
  per-commit signature checking, this needs a closer read of
  `@atproto/repo`'s `verifyDiff` and probably our own `prevData` bookkeeping.
- `freeschool.draft.*` prefix filtering: the `.*` wildcard code path in
  `@atproto/sync` was read, not exercised (no such records exist yet).
- Whether `@atproto/identity` handle resolution works against a `.test` domain
  on a local PDS.
