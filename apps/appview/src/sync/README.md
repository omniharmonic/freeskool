# `src/sync/` — where the live PDS change source plugs in

## The hole

contrail 0.23.0 ships exactly one live `ChangeSource`: `JetstreamChangeSource`, which
subscribes to a **Bluesky Jetstream v2** service. Jetstream is fed by the public relay
network, so it sees a record only once that record's PDS is crawled by a public relay.

Free School is peer-to-peer at the PDS level: the peer registry is a list of PDS hosts
(`src/index/peers.ts`), several of which will be private, self-hosted, or — in
development — `http://localhost:3000`. Jetstream can never see those. The missing piece
is a `ChangeSource` over **`com.atproto.sync.subscribeRepos`** spoken directly to each
peer PDS. That is the one item the stack proposal flags as the highest-risk build item,
and it is deliberately **not** implemented in this step.

## What runs today instead

| need | today | later |
|---|---|---|
| historical acquisition | `contrail.backfillAll()` → `com.atproto.repo.listRecords` per repo | unchanged |
| repo discovery | `relays` → `com.atproto.sync.listReposByCollection` per peer PDS, with a `listRepos` fallback (see README "Divergences") | unchanged |
| read-your-writes | `contrail.notify(uri)` right after every write we make | unchanged |
| **other people's writes, live** | **nothing** — a `pnpm db:migrate`-style periodic backfill is the floor | `PdsChangeSource` |

`src/index/indexer.ts` never calls `contrail.ingest()` unless `CONTRAIL_LIVE_INGEST` is
set, because on a private deployment a Jetstream cycle is pure cost.

## The interface to implement

`ChangeSource` is exported from the package root (`@atmo-dev/contrail`) — there is no
`core/sources.ts` in the published artifact, only a bundle. Its contract, verbatim from
`dist/sources-*.d.ts`:

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

with

```ts
interface SourcePosition { source: string; epoch: string; cursor: string }
interface MutationBatch { mutations: SourceMutation[]; checkpoint: SourcePosition; caughtUp: boolean }
```

### The hard parts, in order of risk

1. **Per-host cursors.** `subscribeRepos` `seq` is *per PDS*. `SourcePosition.cursor` is
   one opaque string, so a multi-peer source must encode a cursor **map**
   (`{"host":seq,...}`) into that one string and keep `epoch` pinned to the peer set's
   identity, so that adding a peer is a visible continuity break rather than a silent
   gap.
2. **`caughtUp` / `through`.** `subscribeRepos` has no "head" to ask for. `mark()` must
   open a socket, take the first `#commit`'s `seq` per host, and close — that is the only
   honest head. Contrail's coordinator then replays `after → through` exactly.
3. **Semantics flags.** `subscribeRepos` delivers `#commit`, `#sync`, `#identity`,
   `#account`. A truthful `SourceSemantics` is
   `{ ordinaryRecords: true, ordinaryDeletes: true, accountLifecycle: true, repositoryReplacement: true, verifiedCommits: true, explicitHead: false }`.
   `explicitHead: false` is what forces the `mark()` trick above.
4. **CAR decoding.** `#commit.blocks` is a CAR slice; the record bytes must be decoded to
   get a `cid` + `value` for each `op`. contrail's own deps (`@atcute/cbor`, `@atcute/cid`)
   already cover this.

### Wiring point

`bootstrapFreshProjection({ collections, snapshotSource, changeSource, target })` takes
it directly, paired with contrail's `PdsSnapshotSource` and `DatabaseBootstrapTarget`:

```ts
import { bootstrapFreshProjection, DatabaseBootstrapTarget, PdsSnapshotSource } from '@atmo-dev/contrail'
import { PdsChangeSource } from './pds-change-source.js' // <- the file this step does not write

await bootstrapFreshProjection({
  collections: getCollectionNsids(contrailConfig),
  snapshotSource: new PdsSnapshotSource(/* … */),
  changeSource: new PdsChangeSource({ hosts: await activePeerHosts(), epoch: 'freeschool-peers-1' }),
  target: new DatabaseBootstrapTarget(db, contrailConfig, { deferDerivedProjections: true }),
})
```

For steady-state (non-bootstrap) operation the source is driven by our own loop rather
than `contrail.ingest()`, because `ingest()` is hard-wired to Jetstream.

## The stub

`src/sync/pds-change-source.stub.ts` exports a `PdsChangeSource` that satisfies the
interface and throws `not implemented` from both methods, plus the cursor-map codec the
real implementation will need (`encodeCursorMap` / `decodeCursorMap`), which is already
unit-testable.

**Do not rename the stub to `pds-change-source.ts`** until the real implementation lands:
the filename is the signal that this is unfinished.
