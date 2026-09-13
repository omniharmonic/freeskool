# Vendored from research brief R4 (2026-09-12). Runs standalone; see the AppView for the production PdsChangeSource that wraps it.

# follow-pds — direct-PDS federation spike

**R4 / Free School AppView.** Author of record: Benjamin Life (@omniharmonic).

Follows a **peer registry** of atproto PDS hosts directly — no relay, no
Jetstream, no firehose aggregator. One `com.atproto.sync.subscribeRepos`
WebSocket per host with its own persisted cursor, plus `getRepo` / `listRecords`
backfill, filtered down to the calendar collections, emitted as NDJSON.

Written to be lifted into the production AppView (TypeScript, Postgres): the
cursor store is the one file-backed shim, everything else is production shape.

```
src/config.ts      peer registry schema + normalisation
src/cursors.ts      per-host cursor persistence (the part that becomes a Postgres table)
src/identity.ts     handle -> DID -> PDS, and migration detection
src/backfill.ts     getRepo (CAR + verify) and listRecords paths
src/lex-json.ts     DAG-CBOR lex values -> atproto JSON ($link / $bytes)
src/follow-pds.ts   CLI + the per-peer follower
```

## Install & run

```bash
npm install
npx tsc -p tsconfig.json --noEmit   # typecheck

# 1. which PDS hosts do these accounts actually live on?
npx tsx src/follow-pds.ts resolve ngerakines.me smokesignal.events madrid.pydata.org

# 2. what's already in those repos? (cheap, per-collection)
npx tsx src/follow-pds.ts backfill --method listRecords

# 2b. same, but as a verifiable whole-repo CAR with signature + MST proof check
npx tsx src/follow-pds.ts backfill --method getRepo --did did:plc:jck5nhbxwo5gnwgdfchdqzum

# 3. hold a socket on every enabled peer, print matching records as they land
npx tsx src/follow-pds.ts follow --duration 210 > events.ndjson 2> follow.log

# 4. bootstrap a registry: ask a relay which repos hold our collections,
#    then resolve those DIDs to the PDS hosts we should subscribe to
npx tsx src/follow-pds.ts discover --limit 30
```

NDJSON goes to **stdout**, logs to **stderr**, so `> events.ndjson` gives a
clean event log. `--no-verify` turns off commit signature / MST proof checking
and handle bidirectional verification (only for a local dev PDS).

## Config: `peers.json`

```json
{
  "peers": [
    { "name": "eurosky",  "host": "https://eurosky.social" },
    { "name": "northsky", "host": "https://northsky.social" },
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

- `host` must be a **single PDS instance**. `https://bsky.social` is an entryway
  that fans out to dozens of `*.host.bsky.network` PDSes; its firehose is not
  the union of theirs. Verified live single-PDS hosts:
  `https://eurosky.social`, `https://northsky.social`,
  `https://shiitake.us-east.host.bsky.network`, `https://pds.cauda.cloud`
  (Smoke Signal's own PDS, low traffic).
- `collections` supports a trailing `.*` prefix wildcard (`@atproto/sync`
  semantics: `freeschool.draft.*` matches the whole sidecar namespace).
- `allowPrivateNetwork` is required for a local PDS (`http://localhost:3001`):
  `@atproto/identity` routes DID/handle resolution through an SSRF-protected
  fetch that refuses private IPs, plain HTTP, and custom ports unless you hand
  it your own `fetch`.
- Cursors are **per host**. A PDS's `seq` space is entirely its own; never share
  a cursor between hosts.

## Sample output

Live `#commit` on a real PDS, collection-filtered, signature + MST-proof
verified, decoded from the commit's CAR slice:

```json
{"kind":"record","source":"live","peer":"shiitake","host":"https://shiitake.us-east.host.bsky.network","seq":1038628336,"time":"2026-09-12T18:43:08.056Z","action":"create","did":"did:plc:vsnj4aaxyatiht4spdht2q2t","collection":"community.lexicon.calendar.event","rkey":"3mvdqdbf6es2v","uri":"at://did:plc:vsnj4aaxyatiht4spdht2q2t/community.lexicon.calendar.event/3mvdqdbf6es2v","rev":"3mvdqdbfg6s2v","commit":"bafyreiaz4nw54cxvs2hc63oibookqrgs6kntqcrhuv45zmfaeng7kyocy4","cid":"bafyreifhn7zvkjd3s4hvaz7r3o2y2uhbd4y4oyok65vwvupwk3j646slhi","record":{"mode":"community.lexicon.calendar.event#inperson","name":"Vancouver Farmers Markets","$type":"community.lexicon.calendar.event","status":"community.lexicon.calendar.event#scheduled","startsAt":"2026-09-13T18:32:23.922Z","createdAt":"2026-09-12T18:43:07.843Z","locations":[{"name":"Various locations in Vancouver, BC"}],"description":"Source: eventbrite | URL: https://www.eventbrite.ca/o/vancouver-farmers-markets-8597508605"}}
```

Account lifecycle, verbatim, three consecutive seqs on one PDS — the
`#account` / `#identity` / `#sync` triple the spec says to expect at account
creation and after a migration:

```json
{"kind":"account","seq":1038633878,"did":"did:plc:dbkx6emr7x2wbgzjn5kewso2","active":true,"status":null}
{"kind":"identity","seq":1038633879,"did":"did:plc:dbkx6emr7x2wbgzjn5kewso2","handle":"cooliohandle.bsky.social"}
{"kind":"sync","seq":1038633880,"did":"did:plc:dbkx6emr7x2wbgzjn5kewso2","rev":"3mqwtn64pv32g","cid":"bafyreibipft2stflw6osucpsq5h7oubz7p5pk5d4a2qz7rsqryiexainyu"}
```

Backfill, `getRepo` path, with the PDS refusing a deactivated repo:

```
backfill did:plc:jck5nhbxwo5gnwgdfchdqzum @ https://eurosky.social: 1 record(s) from 139688 bytes of CAR rev=3mp2hyykqeq2k
backfill did:plc:cbkjy5n7bk3ax2wplmtjofq2 @ https://pds.cauda.cloud: 155 record(s) from 16605695 bytes of CAR rev=3mve2a2eqyc2a
! backfill did:plc:t665tlaiems3tmaeily7czco: RepoDeactivated: Repo has been deactivated
```

## Notes that matter when this moves into the AppView

- **`subscribeRepos` has no server-side filter.** `filterCollections` drops
  non-matching ops client-side, so you pay the full bandwidth of every host you
  follow. On a busy PDS that is ~10 commits/s. The filter does save the
  expensive part: `@atproto/sync` returns early before signature/proof
  verification when no op in a commit matches.
- **Cursor replay is bounded.** A stock PDS retains
  `PDS_REPO_BACKFILL_LIMIT_MS` (default **1 day**) of events. Past that you get
  an `#info` / `OutdatedCursor` frame and the stream resumes at the oldest
  retained event — a silent gap you must repair with `getRepo`. A cursor above
  the host's current seq is a fatal `FutureCursor` error frame (close 1008).
- **Fall too far behind and you are dropped.** `PDS_MAX_SUBSCRIPTION_BUFFER`
  defaults to 500 events; exceeding it is `ConsumerTooSlow`.
- **`getRepo` has no `collection` parameter** (lexicon params are `did` and
  `since` only; passing `collection` is silently ignored — verified byte-for-byte
  identical responses). Prefer `listRecords` for collection-scoped backfill:
  16.6 MB of CAR vs a few KB for the same two collections.
- **Don't trust the peer host for a DID's location.** Always backfill from the
  PDS in the DID document. `#identity` means "re-resolve", not "the handle
  changed"; a changed `#atproto_pds` endpoint is how you detect a migration.
- `.cursors.json` is written temp-file-plus-rename and is monotonic per host.

## Evidence in this directory

`runs/` holds the real output quoted in the notes; `probes/` holds the
throwaway scripts that produced the lower-level findings (see
`probes/README.md`). Everything in both was run against live hosts on
2026-09-12/13.

| file | what it shows |
| --- | --- |
| `runs/backfill_list.{log,ndjson}` | 160 records (42 events + 118 RSVPs) from 4 real PDS hosts via `listRecords`; 1 `RepoDeactivated` |
| `runs/backfill_car.{log,ndjson}` | same repos via `getRepo` + `verifyRepoCar`; 139 KB and 16.6 MB CARs |
| `runs/follow_calendar.log` | 7 PDS hosts followed for 3.5 min, calendar filter, 0 matches, cursors all advancing |
| `runs/follow_broad.{log,ndjson}` | same 2 hosts, `app.bsky.feed.post` filter, 46 live records decoded |
| `runs/follow_replay.{log,ndjson}` | cursor replay of 6.6 h on one PDS: 33 live `community.lexicon.calendar.event` + 23 `#account` + 9 `#identity` + 7 `#sync` |
| `runs/follow_reconnect.log` | PDS bounced mid-stream: `Firehose` logged nothing (reconnects are invisible to `onError`) |
| `runs/reconnect_probe.log` | the same bounce through `@atproto/ws-client`: backoff 0.8, 2.3, 3.9, 8.0, 16.2, 32.4 s |

Alternate configs kept from the runs: `peers.fanout.json` (the 7-host fan-out),
`peers.broad.json` (2 hosts, `app.bsky.*` filter), `peers.replay.json` (1 host,
used with a seeded cursor), `peers.local.json` (local Docker PDS on :3001).
