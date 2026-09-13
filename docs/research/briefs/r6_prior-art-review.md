---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r6"
type: "research"
title: "R6 \u2014 Prior-art code review"
projects: ["local-alternatives"]
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r6_prior-art-review"
parachute_id: "2026-09-12-19-32-06-253243"
tags: ["atproto", "free-school", "local-alternatives", "prior-art", "research"]
---



*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R6*
# R6 — Prior-art code review

Four repositories, cloned and read at fixed commits. Every claim below is from the
source tree, not from memory or from project descriptions.

| repo | commit read | date |
|---|---|---|
| `flo-bit/atmo-events` | `ed2fb4279a6ddec7c8c58380747463e9d15b725f` (main) | 2026-08-19 |
| `flo-bit/atproto-notify` | `4cc3ba7876dd6ed11410d3403c1d07967f171a37` (main) | 2026-05-26 |
| `flo-bit/contrail` | `09e4f77552c3bb2591fe354e99bf1b546e0a0d39` (main, v0.23.0) | 2026-09-02 |
| `flo-bit/contrail` PR #95 | `8de9ba01db1cea1b4f370bddf3fd909d74c55b76` (`pr-95`, v0.18.0) | 2026-08-27 |
| `OpenMeet-Team/openmeet-api` | `8fd54d90ef199c5f7e0d3b7a7624fb4481b72028` (main, v1.5.0) | 2026-09-05 |

Clones live at
`…/scratchpad/research/r6_prior-art/{atmo-events,atproto-notify,contrail,openmeet-api}`.
`contrail` is checked out to `pr-95`; `main` is available as the `main` ref.

---

## TL;DR

1. **Import contrail, don't fork anything.** `@atmo-dev/contrail` 0.23.0 is MIT, published
   to npm, actively maintained, and already describes our architecture almost exactly:
   "historical backfill from relays **and PDSes**; current updates from Jetstream; D1,
   SQLite, and **PostgreSQL** storage." Its quick-start command is literally
   `contrail init --prefix community.lexicon.calendar.`. Sidecars are first-class — each
   is a collection with `references`/`relations` back to the event, no schema migration.
   One gap we must fill ourselves: **a `PdsChangeSource`**. Backfill and DID discovery are
   already relay-free (`config.relays` is just a list of hosts serving
   `com.atproto.sync.listReposByCollection`, which a PDS serves too — so our peer registry
   drops in with zero code change), but the only built-in *live* `ChangeSource` is
   Jetstream. `core/sources.ts` defines the interface to implement.
2. **Nobody has solved recurrence. Both attempts are worse than the brief's plan.**
   atmo's is a 270-line browser modal that eagerly copies up to 52 events and stamps a
   `recurringEventOf` AT-URI that is **written once and read nowhere** (grep confirms a
   single occurrence in the whole repo, and it isn't in the projection config, so it can't
   even be queried). OpenMeet has a real series table but materializes **lazily on HTTP
   read with no background top-up**, stores the rule as bespoke JSON rather than an RRULE
   string (which is why its frontend rule mapper is stubbed out, hardcoding `DAILY`),
   and — the live bug — **records cancellation exceptions it never reads back**, so a
   cancelled occurrence reappears and can be re-materialized. Neither writes a series
   record to atproto; recurrence is invisible on the wire in both. The community calendar
   lexicon has no recurrence field and, verified by search, **no open issue or PR proposing
   one**. We have a clear run.
3. **atproto-notify is unusable as code and excellent as a specification.** No LICENSE
   file, no `license` field in any of its six package.json files, zero copyright statements
   anywhere — all rights reserved. Beyond that: its management half is hard-bound to a
   Cloudflare `WorkerEntrypoint` service binding *as the auth boundary*, every privileged
   capability sits behind a hardcoded one-entry allowlist requiring a PR plus redeploy,
   and `send` has **no idempotency at all** (`threadKey` is accepted by the lexicon and
   never read). Take the protocol shape, the routing grammar, and the channel-reaping
   policy; write our own.
4. **OpenMeet's custodial-PDS flow is the most valuable prior art in all four repos** and
   it is Apache-2.0. Mint an account on first email/Google login with a random 32-byte
   password the user never sees, AES-256-GCM at rest with key versioning, Redis-cached
   sessions, and a carefully-reasoned take-ownership handoff that flips `isCustodial` to
   false while preserving the DID. Its `takeOwnershipStatus` design note is the best-argued
   code in any of these repositories. Take it. Leave its mail delivery architecture
   (no queue, no retry, no digest, no throttle, no unsubscribe, unbounded fan-out) and its
   `event-series` module behind.
5. **PR #95 does not do what issue #78 says it does.** Issue #78 describes it as the reader
   that republishes a space's public content. It has **zero repo-write calls of any kind**
   — no `putRecord`, no `applyWrites`, no `com.atproto.repo.*` mutation. It projects into
   separate `isolated_*` tables and serves them only behind a method-bound auth gate with
   `cache-control: private, no-store`. Republishing space content as public records remains
   unimplemented by anyone.
6. **flo-bit already abandoned app-side spaces.** contrail 0.13.0 removed "the spaces,
   authority, record-host, community, realtime, sync … products" outright. atmo-events is
   pinned to **0.12.2, the last version that had them** — so the `rsvp.atmo.space.*`
   interface it ships (createSpace / addMember / putRecord / listRecords / invites with
   access levels, and a `community-owned spaces` concept) has no upstream. Main is now
   0.23.0. Our Spaces-shaped-interface decision is sound, but we must own that interface
   ourselves; there is no library to lean on in either direction.
7. **Licensing is only a problem in one place.** MIT (atmo-events, contrail) composes with
   either of our candidate licences. Apache-2.0 (OpenMeet) flows one-way into AGPL-3.0 and
   can also sit inside an MIT repo provided we keep its headers and add a NOTICE. Only
   atproto-notify is a hard block, and we are self-hosting that path anyway.

---

## Comparison table

| | **atmo-events** | **atproto-notify** | **contrail** | **openmeet-api** |
|---|---|---|---|---|
| **License (SPDX)** | `MIT` (LICENSE + package.json) | **none** — no LICENSE, no `license` field in any of 6 package.json, no copyright text anywhere | `MIT` (LICENSE + package.json) | `Apache-2.0` (LICENSE + package.json); no NOTICE file |
| **Stack** | TypeScript; SvelteKit 2.55 / Svelte 5.55 / Tailwind 4; `@sveltejs/adapter-cloudflare`; pnpm monorepo (`apps/web`, `packages/ui`) | TypeScript; Cloudflare Workers (Hono-less, hand-rolled router); SvelteKit dashboards; pnpm monorepo (4 apps, 1 package) | TypeScript; library + CLI (`contrail` bin); Workers primary, Node supported; tsup build | TypeScript; NestJS 11; Node ≥ 24; TypeORM 0.3.27 |
| **Size** | 50 MB (13 MB `.git`); 720 tracked files, 244 `.ts` + 88 `.svelte`; 186 `.vtt` + 23 `.jpg` of conference media | 2.4 MB; 255 tracked files, 121 `.ts` + 32 `.svelte` | 6.7 MB; 352 tracked files, 210 `.ts` | 21 MB; 1100 tracked files, 825 `.ts`, 20 `.ejs`, 80 `.md` |
| **Activity** | 208 commits since 2026-03-17; last 2026-08-19; 6 contributors (Florian 123, Tom Scanlan 78); 29★, 11 forks, 22 open issues | 35 commits, all 2026-05-23 → 2026-05-26; **1 contributor**; no PRs ever; last commit 3½ months ago; 14★, 0 forks, 0 open issues | 359 commits since 2026-03-17; last 2026-09-02; Florian 278, bot 41, Tom Scanlan 39; 56★, 5 forks, 4 open issues | 792 commits since 2024-09-18; last 2026-09-05; 11 contributors (Tom Scanlan 547); 26★, 7 forks, 12 open issues |
| **Maintainer posture** | Solo-led, PR-friendly (external contributors merged), changesets + release workflow, `packages/ui` published to npm. 6 open PRs, oldest from April. | **Dormant.** Zero commits in 3½ months, zero PRs, zero issues, `todo.md` with 5 unimplemented items. Committed dev keys flagged in its own docs as pre-prod tasks. | Most active of the four. "**Pre-alpha. Expect breaking changes.**" 0.12→0.23 in ~4 months with deliberate breakage (spaces removed, cursors invalidated, Jetstream v1→v2). | Steady commercial-ish cadence, conventional commits, commitlint, k6 load tests, Grafana dashboards, CODE_OF_CONDUCT. Mid-migration toward contrail. |
| **Indexing** | **Jetstream, pulled on a 1-minute cron** (not a long socket — Workers). `notifyOfUpdate` write-through for immediacy. Backfill = `contrail backfill` direct-PDS walk. D1 + optional Meilisearch sink. | **None.** No firehose, no repo records. Explicitly: "No firehose, no repo records, no signing." | Jetstream v2 (`@bsky/jetstream`) for live; **direct PDS `com.atproto.repo.listRecords` for backfill**; DID discovery via `com.atproto.sync.listReposByCollection` against `config.relays`. `com.atproto.sync.subscribeRepos` is **never used** — zero hits repo-wide. Optional "Alluvium" HTTP archive bootstrap. | **Two planes.** (a) Inbound HTTP from an *external* firehose processor → `POST integration/events` behind a service key, emitting `event.ingested` (deliberately distinct from `event.created` so ingest doesn't mail everyone). (b) Vendored contrail 0.6.0 run **out-of-process** (`contrail:ingest` / `contrail:sync` npm scripts) over `CONTRAIL_JETSTREAM_URLS`, with its own Postgres DB/schema/pool. |
| **Storage** | Cloudflare D1 (SQLite) + KV (OAuth sessions/states) | Cloudflare **D1** (one migration, 10 tables) + **KV** (rate-limit counters, DID cache, session cache) + **Queues** (all delivery) | **D1, SQLite (`node:sqlite`), PostgreSQL (`pg`)** — three adapters behind one `Database` interface + `dialect.ts` | PostgreSQL, **schema-per-tenant** (`tenant_<id>`) with a separate `pg.Pool` per tenant; tenant roster from a JSON file, not the DB |
| **Auth** | `@atcute/oauth-node-client` confidential client; `client_id` = hosted `oauth-client-metadata.json`, `jwks_uri`, `CLIENT_ASSERTION_KEY`. **Granular 2026 scopes**: `scope.repo({collection})`, `scope.blob({accept})`, `include:rsvp.atmo.permissionSet`, `rpc?lxm=…&aud=*`. Signup points at a *third-party* PDS (`pds.rip` dev / `selfhosted.social` prod). | **atproto service-auth JWTs only** (ES256, `@atcute/xrpc-server/auth` `ServiceJwtVerifier`, `maxAge: 300`). Sender = app's own DID key + `did:web` doc. User = token minted on the user's PDS via `com.atproto.server.getServiceAuth`. No passwords, no API keys, no OAuth in the relay. | Verifies inbound service-auth JWTs (`createServiceAuthGate`, audience must be `did#fragment`, cached DID-doc resolver, 5 s timeout). No OAuth — it's a read-side AppView. | Four-way: local JWT, Google, GitHub, **Bluesky OAuth** (`@atproto/oauth-client-node` 0.2.5, Redis-backed state/session stores). Plus it *is* an OIDC provider (`src/oidc/`). Verifies inbound service auth gated to `lxm === 'net.openmeet.auth'`. |
| **Groups / organizers** | No group primitive. Conferences are faked via `additionalData.parentEvent.uri` + a `listTalks` pipeline query. Private events use contrail-hosted spaces (`tools.atmo.event.space`, `ats://` URIs) — **pinned to contrail 0.12.2, removed upstream in 0.13.0**. | n/a | **Removed in 0.13.0.** 0.12.x had `spaces.{authority,recordHost}`, space credentials (ES256, 2 h TTL), and a `community` package. PR #95 replaces all of it with a reader for the PDS-native permissioned-data alpha. | Real first-class `GroupEntity` + `group-member` + `group-role` + `group-permission` + `group-did-follow`, in Postgres. Admins genuinely co-edit group events — which is exactly the capability the atproto side can't reproduce (issue #78). |

---

## atmo-events

`…/r6_prior-art/atmo-events` @ `ed2fb42`. MIT. Monorepo: `apps/web` (the app) +
`packages/ui` (`@atmo-dev/events-ui` 0.1.0, MIT, publishable via `svelte-package` +
`publint`).

Dependencies that matter: `@atmo-dev/contrail` **0.12.2** and
`@atmo-dev/contrail-appview` 0.12.2, `@atcute/{client,atproto,crypto,identity-resolver,
lexicons,oauth-node-client,tid,xrpc-server,jetstream}`, `@foxui/*` design system,
`bits-ui`, `valibot`, `svelte-tiptap`, `maplibre-gl`, `@internationalized/date`.

### Indexing and projection

`apps/web/src/lib/contrail.config.ts` is the whole projection, declaratively:
`namespace: 'rsvp.atmo'`; collections `event` (→ `community.lexicon.calendar.event`) and
`rsvp` (→ `community.lexicon.calendar.rsvp`); `queryable` fields with `type: 'range'` for
`startsAt`/`endsAt`/`createdAt`; `relations.rsvps` with `groupBy: 'status'` and the three
status NSIDs as groups (this is what produces `rsvpsGoingCount` etc.);
`references.event` on `subject.uri`; a `feeds.network` with per-collection `maxItems` caps;
`notify: true`; and four `pipelineQueries` that inject raw SQL conditions
(`listDiscoverable`, `listDiscoverableByUris`, `listTalks`, `listAuthored`).

`apps/web/src/routes/api/cron/+server.ts` is the most instructive file in the repo. It runs
every minute and carries a 35-line comment explaining a hard-won bug: contrail saves the
Jetstream cursor **last** in `runIngestCycle`, so if the handler aborts before that save,
the cursor never advances and the next tick replays the same window forever. The fix is two
deliberately-split budgets — `DRAIN_TIMEOUT_MS = 20_000` (contrail's internal deadline) and
`HARD_TIMEOUT_MS = 55_000` (backstop only) — with arming raced *alongside* ingest rather
than awaited before it, so a stalling search endpoint can't push a tick past the cron
interval. We will hit this exact problem; read the comment before we do.

Ordering in the tick: reply-bot first (isolated, "must not be starved"), then ingest,
then notifications, then the geocode drip, each in its own try/catch so one failure can't
500 the tick.

### Event / RSVP data flow

Writes happen **client-side**, from the PWA, straight to the user's PDS, then a
`notifyOfUpdate` call tells the AppView to re-fetch immediately rather than wait for
Jetstream.

- Event: `packages/ui/src/editor/save.ts` `buildEventRecord()`. It spreads the *previous*
  record forward to preserve unspecced fields, then writes
  `community.lexicon.calendar.event` with a pile of **out-of-lexicon fields inline**:
  `createdWith`, `timezone`, `theme`, `media`, `facets`, `preferences.showInDiscovery`,
  `additionalData.parentEvent`, `recurringEventOf`. It strips the flattened AppView fields
  (`cid`, `did`, `rkey`, `uri`, `rsvps*Count`) before writing.
- RSVP: `packages/ui/src/EventRsvp.svelte` `submitRsvp()` writes
  `community.lexicon.calendar.rsvp` with `subject: {uri, cid?}` (a `strongRef`), the status
  token, and `createdWith`; then `adapter.notifyUpdate(...)`. Cancel is `deleteRecord`.
  Re-RSVP reuses the same rkey.

This inline-extension habit is the direct opposite of our settled sidecar rule, and it is
worth being precise about why. The community lexicon's event record (read at
`apps/web/lexicons/pulled/community/lexicon/calendar/event.json`) requires only
`createdAt` + `name` and defines `mode, name, uris, endsAt, status, startsAt, createdAt,
locations, description`. **There is no `timezone` field** — yet atmo writes one, and it is
load-bearing for every recurring-event and DST calculation in the codebase. So the
practical rule for us: **read inline extensions for interop, never write them.** `timezone`
in particular is a de-facto standard we should consume.

One sharp edge inherited from the lexicon: `rsvp.subject` is a `com.atproto.repo.strongRef`
(`uri` + `cid`), so a pinned `cid` goes stale every time the event is edited. atmo writes
the cid when it has one and tolerates the drift; contrail matches on `subject.uri`. We
should do the same and treat the cid as advisory.

### The host seam worth taking

`packages/ui/src/editor/adapter.ts` defines `EditorAdapter` — and its doc comment states
the intent plainly: "The package never reaches into atproto/session/navigation directly.
Consumers implement this interface … The atmo app provides `createInAppAdapter`; other
hosts (e.g. blento) provide their own."

```
features: { delete, recurring, privateMode }
putRecord / createRecord / deleteRecord / uploadBlob / getRecord / resolveHandle
onSaved / onDeleted / requestLogin / notifyUpdate?
createPrivateEvent? / putSpaceRecord? / deleteSpaceRecord? / createSpaceInvite?
```

The optional tail is exactly a Spaces-shaped interface, already factored so the same UI
writes either to a public PDS or into a space. That is the pattern our brief calls for, and
it is MIT.

### Recurrence — the whole of it

`packages/ui/src/editor/RecurringModal.svelte`, 270 lines, entirely client-side. UI offers
`count` (1–52), `interval` (1–99), `unit` ∈ days|weeks|months|years, and "number in title".
`handleCreate()` then loops `count` times, and the one genuinely good idea is in a comment
at lines 76–78:

> Recurring instances advance by wall-clock duration (e.g. "every week at 10am"), so
> operate on `CalendarDateTime` — not absolute instants — to preserve the wall time across
> DST transitions.

So it parses with `@internationalized/date` `parseDateTime`, advances in calendar units,
preserves the original *absolute* duration in ms for `endsAt`, mints a fresh TID per
occurrence, copies name/description/mode/status/media/uris/locations, and sets
`recurringEventOf: at://<did>/community.lexicon.calendar.event/<parentRkey>`.

What is absent: no RRULE, no series record, no exceptions, no "edit this and following",
no series delete, no timezone field in the lexicon to hang any of it on. And
`recurringEventOf` is **dead data** — `grep -rn recurringEventOf` over the entire repo
returns exactly one hit, the line that writes it. It is not in `contrail.config.ts`'s
`queryable`, so it isn't even indexed. flo-bit's own words on issue #78: "those are just
loosely linked copies of the original event." tompscanlan's reply states the user
requirement we should design to: "They are happy if they set it once and events keep
scheduling until they make a change."

Failure mode worth noting: the loop writes one record per iteration and on error sets
`errorMsg = 'Failed to create event N. Stopping.'` and returns. A dropped connection
halfway through leaves a half-materialized series with no record of intent. This is the
structural argument for server-side materialization, independent of everything else.

### OAuth and client metadata

`apps/web/src/lib/atproto/server/oauth.ts` builds an `@atcute/oauth-node-client`
`OAuthClient`. In production: `client_id = <site>/oauth-client-metadata.json`,
`redirect_uris = [<site>/oauth/callback]`, `jwks_uri = <site>/oauth/jwks.json`,
`keyset: [JSON.parse(env.CLIENT_ASSERTION_KEY)]`, sessions and states in Cloudflare KV
(`server/kv-store.ts`, states with `expirationTtl: 600`). In dev without a tunnel it falls
back to a loopback client (`http://127.0.0.1:<port>`) and `MemoryStore`. Three routes
serve it: `(oauth)/oauth-client-metadata.json`, `(oauth)/oauth/jwks.json`,
`(oauth)/oauth/callback`.

`apps/web/src/lib/atproto/settings.ts` is the best live example of atproto's granular
permission scopes I found anywhere in these four repos:

```
'atproto',
scope.repo({ collection: ['community.lexicon.calendar.event', '…rsvp'] }),
scope.blob({ accept: ['image/*'] }),
'include:rsvp.atmo.permissionSet',
'include:app.bsky.authCreatePosts',
'rpc?lxm=pub.atmo.notify.requestPermission&aud=*',
'rpc?lxm=pub.atmo.notify.revokeSelf&aud=*',
```

With a comment explaining a real constraint: permission-set lexicons can only reference
NSIDs inside their own namespace, so repo writes for `community.lexicon.*` and blob uploads
must be standalone `scope.repo(...)` / `scope.blob(...)` entries. And `aud=*` is used
deliberately so one consent covers both the dev tunnel DID and the published prod DID.

Signup: `ALLOW_SIGNUP = true`, `signUpPDS` = `https://pds.rip/` in dev,
`https://selfhosted.social/` in prod. **atmo does not run a PDS** — it points new users at
someone else's. Our hosted-signup requirement has no prior art here; it has one in OpenMeet.

### UI stack

Yes, Svelte — Svelte 5 with runes (`$state`, `$derived`, `$props`, `$effect`) and SvelteKit
remote functions (`query`/`command` from `$app/server`, used throughout `*.remote.ts`).
Styling is Tailwind 4 plus `@foxui/{core,colors,social,text,time,visual}` as a design
system, `bits-ui` for primitives, `mode-watcher` for light/dark. `.impeccable.md` documents
a deliberate two-color (base + accent) theme contract that users set per event page.

`packages/ui` is genuinely packaged: proper `exports`, `svelte` condition, `sideEffects`
for CSS, peer deps on `@foxui/*` + `bits-ui` + `svelte` + `tailwindcss`, optional peers for
`maplibre-gl`/`hls.js`/`plyr`. Contents worth knowing: `EventEditor`, `EventView`,
`EventCard`, `EventRsvp`, `EventAttendees`, `EventComments`, `DateTimePicker`,
`TimePicker`, `DatePicker`, `TimezonePicker`, `Map`, `ImageDropper`, `ShareModal`,
`PostToBlueskyModal`, `cal/{helper,ical,sanitize}.ts`, `event-view/AddToCalendarButton`,
`schedule/ConferenceTimetable`, and five animated theme backgrounds.

### Reusable as a package vs copy-paste

**As a package:** `@atmo-dev/events-ui` via npm, implementing `EditorAdapter` ourselves.
Gets the editor, viewer, pickers and iCal helpers for free. Cost: a hard commitment to
Svelte 5 + Tailwind 4 + `@foxui/*`, at version 0.1.0 with no changelog and no stability
promise.

**Copy-paste (MIT, attribution preserved):** `editor/adapter.ts` (the seam itself),
`cal/ical.ts` + `cal/sanitize.ts`, `TimezonePicker.svelte`, `DateTimePicker.svelte`,
`event-view/AddToCalendarButton.svelte`, `date-format.ts`, and the *comment* in
`api/cron/+server.ts`.

**Do not take:** `editor/save.ts` (writes inline non-lexicon fields — violates our sidecar
rule) and `RecurringModal.svelte` (the design we're rejecting). Also don't fork `apps/web`
wholesale: it's D1/Workers-shaped, pinned to a contrail version whose spaces product no
longer exists upstream, and carries ~50 MB of conference VOD transcripts.

---

## contrail (main, v0.23.0)

`…/r6_prior-art/contrail` @ `main` = `09e4f77`. MIT. One published package,
`@atmo-dev/contrail`, with `bin: contrail` and exports `.`, `./server`, `./client`,
`./sqlite`, `./postgres`, `./alluvium`, `./workers`, `./worker`, `./cli-config`,
`./lexicons`. README self-description: "atproto backend in a bottle", "**Pre-alpha.
Expect breaking changes.**"

Its stated feature list is our requirements document: historical backfill from relays **and
PDSes**; current updates from Jetstream; **D1, SQLite, and PostgreSQL** storage;
`getRecord`/`listRecords` endpoints; filters, sorting, search, pagination; custom queries;
relationship counts and hydration; profile and label hydration. Quick start:

```
pnpx @atmo-dev/contrail init my-appview \
  --prefix community.lexicon.calendar. \
  --namespace com.example.calendar
```

### Config surface (`packages/contrail/src/core/types.ts`)

```
ContrailConfig { namespace, collections, validation, profiles, relays, jetstreams,
                 orderedSource, changes, feeds, logger, notify, serviceAuth, labels,
                 constellation, networkOverrides, maintenance, dialect }

CollectionConfig { collection, discover, validate, queryable, relations, references,
                   queries, pipelineQueries, searchable, methods, timeField,
                   subjectField, recordFilter }
```

**Sidecars are first-class.** Each sidecar is its own collection with `references` pointing
back at the event (forward refs: "fields on this collection's records that point at another
collection") and `relations` for counts/grouping. Adding a sidecar is a config entry, not a
migration. `recordFilter` lets us drop records pre-persistence; `subjectField` trims
network-wide graphs to subjects we care about; `timeField` picks the record-time field and
clamps it to source observation time.

### The indexing seam — how we go relay-free

`packages/contrail/src/core/sources.ts` (426 lines) is the abstraction:

```
SourcePosition   { source, epoch, cursor }   // epochs are never comparable across
SourceSemantics  { ordinaryRecords, ordinaryDeletes, accountLifecycle,
                   repositoryReplacement, verifiedCommits, explicitHead }
SnapshotSource   { prepare(collections), read({snapshot, progress}) → AsyncIterable }
ChangeSource     { id, semantics, mark({collections, snapshot}), read({after, through}) }
BootstrapTarget  { load, beginCapture, setSnapshot, applySnapshotBatch,
                   beginCatchup, applyMutationBatch, complete, recordFailure? }
```

`BootstrapTarget` commits records **and** progress **and** the checkpoint atomically in the
destination DB — which is the property that makes a cron-driven loop safe.

- **`core/pds-snapshot.ts`** (596 lines) already *is* direct-PDS reading: resolve each DID's
  PDS, page `com.atproto.repo.listRecords` per (did, collection), `PAGE_SIZE = 100`,
  `DEFAULT_RESOLUTION_CONCURRENCY = 100`, `DEFAULT_PDS_CONCURRENCY = 20`,
  `DEFAULT_DIDS_PER_PDS = 3`, with a resumable per-partition cursor and a
  `PdsSnapshotIncompleteError` that keeps a failed snapshot resumable-but-not-ready.
- **`core/backfill.ts:906–925`** is the only `com.atproto.sync.*` call in the package:
  `GET <host>/xrpc/com.atproto.sync.listReposByCollection?collection=&limit=1000&cursor=`
  for each host in `config.relays` (default `['https://relay1.us-east.bsky.network']`,
  `types.ts:226`). **A PDS serves `listReposByCollection` too.** So setting
  `relays: [<our peer registry of PDS hosts>]` makes discovery and backfill relay-free with
  no code change at all. This is the single most useful thing I found for our architecture.
- **`core/jetstream-source.ts`** (337 lines) is the only built-in `ChangeSource`, and as of
  0.22.0 it uses Jetstream v2 via `@bsky/jetstream` with instance-local sequence cursors.
  `com.atproto.sync.subscribeRepos` appears **nowhere** in the package.

**So our one piece of new infrastructure is a `PdsChangeSource`** — poll each registered PDS
for new commits (or hold a `subscribeRepos` socket per host) and emit `MutationBatch`es with
`checkpoint` positions. `jetstream-source.ts` is the worked reference for the interface;
`pds-snapshot.ts` we use as-is for backfill.

### The outbox — our notification trigger

`docs/advanced/outbox.md` + `config.changes.consumers`:

```
changes: { consumers: { notify: { collections: ['community.lexicon.calendar.event', …],
                                  phases: ['historical','live'],
                                  initial: 'history' | 'future' | 'current' } } }
```

"Contrail appends each change in the same database transaction as the canonical record and
source cursor; destination failures never roll back ingestion." Delivery handlers are
registered on `createWorker({ deliveries: { notify: async (batch, {env, signal}) => … } })`
and receive `batch.{cursor, currentRecords, absentUris}`; throwing retries with backoff.
Delivery is **at-least-once** and claims coalesce repeated changes to one URI, so handlers
must be idempotent and must upsert/delete by URI rather than increment. For a long-lived
Node process: `runPersistent()` + `runPersistentDeliveries()`.

`initial: 'future'` is the knob that prevents the classic "turn on notifications, mail the
entire backfill" disaster — which is precisely the hazard OpenMeet works around with its
`event.ingested` vs `event.created` event-name split, and atmo works around by seeding its
RSVP cursor to "now" on first run. Three independent codebases, same problem. Use `'future'`.

Caveat: 0.14.1 **removed** the older best-effort post-commit "sink" API. atmo-events'
Meilisearch sink uses that removed API, so that integration doesn't port forward as-is.

### Service auth

`core/service-auth.ts` + `service-auth-contract.ts`: `ServiceJwtVerifier` from
`@atcute/xrpc-server/auth` behind a cached DID-doc resolver (`AUTH_TIMEOUT_MS = 5_000`,
`DID_CACHE_TTL_MS = 5 min`, `DID_CACHE_MAX = 1000`, with in-flight dedup and a `noCache`
escape hatch for key rotation). Audiences must be a fragmented
`did:…#fragment` (`parseServiceAudience` rejects anything else). Methods are bound
per-token — a token minted for one `lxm` is rejected on another.

### Spaces: removed

contrail **0.13.0**, changeset `8c5cea6`: "Collapse Contrail into one public package and one
AppView implementation. **Remove the spaces, authority, record-host, community, realtime,
sync, and custom Lexicon-tooling products.**" Same release intentionally invalidated all
0.12 pagination cursors.

History worth knowing, from `packages/contrail/CHANGELOG.md`: 0.8.0 had a full spaces
product — `spaces.{authority, recordHost}` split into independently runnable roles, space
credentials as short-lived ES256 JWTs (default 2 h TTL) via `<ns>.space.getCredential` /
`refreshCredential` passed as `X-Space-Credential`, authority resolution from three sources
including a DID-doc `#atproto_space_authority` service entry, and a `community` package
extracted separately. 0.9.x moved space URIs from `at://` to **`ats://`** explicitly
"tracking the permissioned data spec … which floats `ats://` as a distinct scheme so spaces
can't be confused with atproto record URIs at any layer."

All of that is gone from main. It survives only in atmo-events' pinned 0.12.2 dependency
and its committed generated lexicons.

---

## contrail PR #95 — "spaces alpha"

`…/r6_prior-art/contrail` @ `pr-95` = `8de9ba0`. **OPEN** since 2026-08-21, never merged,
61 files, +8304/−23, branch at v0.18.0 while main is v0.23.0. PR **#111** ("Merge main
(0.23.0) into spaces-alpha so #95 applies again") exists solely because it has bitrotted.

Shape: one new workspace package (`packages/contrail-spaces-alpha`), one demo app
(`apps/spaces-demo`), two new core modules, two small core modifications, two dependency
patches.

`packages/contrail-spaces-alpha/package.json` is **`"private": true`** and pins
`@atproto/{common-web,identity,space}` at `0.0.0-spaces-alpha-20260818163953`. It is not on
npm and structurally cannot be. Its README states the compatibility tuple explicitly:
"supported Lexicons: permissioned-data/Spaces alpha from 2026-08-18", and "intentionally
workspace-private while the upstream protocol is alpha."

### How the reader authenticates

Two deliberately separated credentials. `docs/experimental-spaces-alpha.md:5–10`:
"a DPoP-bound Space credential allows the runtime to synchronize one Space; and the
integrated application's authenticated session principal plus exact-Space authorization
allows a caller to query its cached projection. **A successful sync credential is never
treated as caller authorization.**"

**The sync credential** is a DPoP-bound bearer token, obtained by exchanging a one-time
delegation token:

1. The app, holding the user's OAuth session, calls **the user's own PDS**:
   `com.atproto.space.getDelegationToken?space=<uri>` → `{token}` (`src/consumer.ts:242`).
2. The runtime sanity-checks the delegation's claims **without verifying the signature**
   (`src/worker.ts:811–825`): issuer must equal the asserted user DID, `sub` must equal the
   space URI, `exp` must be future.
3. It is exchanged at the **authority's** PDS for the real credential
   (`src/protocol.ts:227–275`): generate a fresh **ES256** DPoP keypair
   (`JoseKey.generate(['ES256'])`), POST `com.atproto.space.getSpaceCredential` with the
   delegation as a plain `Bearer`, plus a DPoP proof over `{htm, htu}`.
4. Every later call uses `Authorization: DPoP <credential>` plus a per-request proof bound
   to method, URL **and the credential itself** (`src/protocol.ts:147–167`).
5. The credential *and its DPoP private JWK* are AES-256-GCM encrypted with associated data
   `contrail-spaces-alpha:credential:<spaceUri>\0<generation>` (`src/crypto.ts`,
   `src/storage.ts:285`) and stored one row per space generation. The README is candid:
   "The D1 projection and backups still contain plaintext private records; **this is access
   control, not end-to-end encryption**."

So: not a service-auth JWT, not a contrail-minted token, not an invite key. A PDS-issued,
sender-constrained, short-lived capability scoped to exactly one space.

**Caller authorization is separate**: the default "integrated" mode passes `userDid`
in-process and checks an `spaces_access_leases` row (minted only on a successful delegation
exchange, capped at `min(credential expiry, now + 15 min)`); the opt-in standalone mode uses
exact method-bound service auth via the new `createExactServiceAuthGate`.

### How it syncs

Push-notified polling with scheduled reconciliation as the authority. **No WebSocket and no
`subscribeRepos` against the space host.** XRPC calls: on the authority —
`getSpaceCredential`, `simplespace.getSpace`, `space.listRepos`, `space.registerNotify`;
on each writer's own PDS — `space.listRepoOps`, `space.getRepo` (CAR). Inbound,
service-authenticated: `notifyWrite`, `notifySpaceDeleted`, `simplespace.checkUserAccess`.

The cursor is a **per-writer checkpoint**, not a stream cursor: `spaces_repo_state` holds
`(rev, lt_hash, commit_hash)` per `(space, generation, writer)`, where `lt_hash` is a
homomorphic set hash of the whole repo. `reconcileSpace` (`src/sync.ts:254–353`) re-fetches
`getSpace` and asserts the policy `$type` still matches config, renews `registerNotify`,
pages the authority's **complete** `listRepos`, syncs each writer whose `(rev, hash)`
differs, and schedules the next pass (default 5 min). A writer absent from `listRepos`
increments `removal_observations` and is removed **only at ≥2 observations** — "One stale
authority omission cannot erase a verified writer."

Incremental sync applies **every** op to the LtHash including collections the projection
excludes (they still consume the op budget, default 10, hard-clamped ≤50), verifies with
`verifyCommit` **and** LtHash equality, retries once with a force-refreshed signing key for
rotation, and projects only the *last* op per `(collection, rkey)`. Full recovery downloads
the whole CAR with streaming size enforcement (16 MiB cap, cancels mid-stream), verifies
it, ingests into a **staged generation**, then flips visibility + rebuilds counts + writes
the checkpoint in **one** `db.batch`. Sync is fenced by owner-stamped leases (90 s TTL,
CAS-style SQL, renewed at every durable stage, `SyncLeaseLostError` on loss).

### How it "republishes" — it does not

This is the correction to issue #78. Verified exhaustively:
`grep -rn "putRecord|applyWrites|com.atproto.repo\." packages/contrail-spaces-alpha/src/`
→ **no matches**. There is no repo-write method of any kind in the package. The docs say it
outright: "Public records remain in `records_*` and `record_versions`. Private rows use
extension-initialized `isolated_records_*` … **Anonymous public code cannot address these
tables.**" Reads come out only through `queryIsolatedRecords` behind the access gate, every
response `cache-control: private, no-store`.

`packages/contrail/src/core/isolated-projection.ts` (1259 lines, new) is the
protocol-neutral half: "Core deliberately does not interpret isolated keys; an extension
maps its authority/generation identity to one." Three nested isolation levels — parallel
table families (`isolated_*`), an opaque `scope_key` per space *incarnation* prepended to
every query, and a partition-per-writer with staged generations behind a visibility pointer
table that a single statement flips. `packages/contrail/tests/isolated-projection.test.ts`
proves two different scopes with the *same* writer DID don't collide, and ends by asserting
the **public** query sees nothing.

The core `ingest.ts` change is a 38-line seam: a new `IngestProjection` interface
(`selectCurrent`, `project`) so validation/CID-checks/filters stay canonical while only
*persistence* becomes pluggable. Clean, small, and exactly the right shape.

### The demo does not custody a space identity

`apps/spaces-demo` ("Atmo Circle"): `createSpace` POSTs
`com.atproto.simplespace.createSpace` **to the signed-in user's own PDS**, so the space URI
is `at://<the user's DID>/space/garden.atmo.circle/self`. Membership is native PDS
member-list policy — never stored in the AppView. `createSpaceRecord` sets
`repo: session.did`: **each member writes into their own permissioned repo as themselves**,
using their own OAuth session, never the app's credential.

The most instructive 20 lines in the PR, from `+page.server.ts:132–152`: the load function
tries the query, and on failure re-exchanges a delegation token and retries, with the
comment "Native PDS policy remains authoritative. Renew the short projection lease only
when cached access expires; **removed members fail here**." That is how removal propagates
without the AppView tracking membership at all. Elegant, and a direct answer to issue #78's
"membership data itself … is application data" — in this design, it isn't.

Two dependency patches, both integration friction rather than protocol: a genuine upstream
bug in `@atcute/multibase`'s Node base64 fast path (unbounded `_base64Slice.call(bytes)`
corrupts subarray views — i.e. every CID and commit-hash round trip), and a `dev?: boolean`
override for `@svelte-atproto/oauth` because the demo builds SvelteKit *into* a Worker so
build-time `dev` is always false.

### Maturity

Warns loudly in five places. 937 lines of tests over 3368 of source, and the tests are
adversarial rather than happy-path: anonymous 401, wrong-`lxm` 401, cross-scope
invisibility, public-table emptiness, lease fencing, deadline aborts, budget overruns, AEAD
context mismatch, oversized-CAR cancellation. Real SQLite, real secp256k1 signatures, real
LtHash, real service JWTs. Essentially zero code TODOs.

Untested: the full `reconcileSpace` path, CAR recovery end-to-end, the DPoP header
construction, the three inbound route handlers, the two-observation writer removal. The demo
has **zero tests** and hardcodes one deployment's domains, D1 id and KV ids.
Deliberately deferred per its README: blobs, private feeds and labels, profile hydration,
arbitrary private custom SQL, combined public/private pagination, client-attested
`appAccess` allow-lists, and **generic membership or invitation semantics**. PostgreSQL
"uses the same protocol-neutral isolated schema/query code but has not yet received a live
Spaces deployment test."

Judgement: a credible reference implementation and the clearest available reading of the
permissioned-data proposal's shape. Not something to depend on.

---

## atproto-notify

`…/r6_prior-art/atproto-notify` @ `4cc3ba7`. **No license.** Four apps
(`relay`, `web`, `homepage`, `example-sender`) + `packages/lexicons`. Dormant since
2026-05-26 — 35 commits over four days, one contributor, never a PR.

### Licensing, confirmed

No LICENSE or COPYING file in 258 tracked files. No `license` field in any of the six
package.json files (all `"private": true`). A repo-wide case-insensitive grep for
`copyright|MIT|license` over every `.md/.json/.txt/.svelte/.ts` returns **nothing**. No
NOTICE, no headers. All rights reserved by default. We can read it and reimplement from the
lexicons; we cannot copy the code.

### The notification model

Cloudflare **D1**, one migration (`apps/relay/migrations/0001_init.sql`, 163 lines,
declared canonical). Timestamps are unix ms; booleans are 0/1. All access through raw SQL
in `apps/relay/src/db/queries.ts` (1093 lines), no ORM.

Ten tables. The load-bearing ones:

- **`grants`** — PK `(recipient_did, sender_did)`, plus `granted_at, muted, title,
  description, icon_url, manage ∈ none|self|full`. **This is the entire authorization
  model for sending**: `send.ts:94–97` checks for a grant row and 403s otherwise. Nothing
  else gates it — no allowlist, no registration.
- **`delivery_targets`** — the unified channel table. `id` is an **opaque stable 12-char
  nanoid** referenced by routes as `channel:<id>`; `channel ∈ push|telegram|email|dm|
  webhook`; `ref` is the natural dedup key per channel; `UNIQUE (channel, ref)`. The upsert
  (`queries.ts:184–214`) updates `did`/`verified`/`config` but **keeps the original `id`,
  `label`, `named`** — so a route pinned to a device survives a push re-subscribe. That one
  detail is the best design decision in the repo and we should copy it.
- **`users`** — `default_route` (default `'inbox'`), `auto_allow ∈ all|trusted|none`,
  `pending_route` (default `'off'`). New accounts start at `inbox`: recorded, no alerts.
- **`routing`** PK `(recipient, sender, category)` and **`app_routing`** PK
  `(recipient, sender)` — the override levels.
- **`app_categories`** PK `(recipient, sender, category)` — **per-user by construction**,
  never shared.
- **`notifications`** — the inbox. **`delivery_log`** — one row per accepted send,
  30-day retention; inbox rows 90-day.

There is **no apps/senders registry table** (the registry is hardcoded TypeScript) and no
`channels` table (unified into `delivery_targets`). Rate limits are not in D1 — they are KV
counters.

**Three concepts.** A *grant* is an approved `(recipient, sender)` pair. A *category* is a
free-form string the sender supplies on `send` (≤64 chars); the relay **learns** categories
as they arrive, upserting `app_categories` *before* routing so a category stays configurable
even when the notification is dropped. A *route* is a `'+'`-joined token set where each
token is either a bare channel (all instances) or `channel:<id>` (one instance), with
sentinels `off` (drop entirely), `inbox` (record, no alerts), `default` (inherit account),
`app` (inherit app-wide). Grammar and validators in `packages/lexicons/src/rpc.ts:102–229`.

**Three-level resolution, bottom-up** (`send.ts:137–149`): per-category → app-wide →
account default, where a **missing row means inherit** and writing a sentinel *deletes* the
row rather than storing it (`rpc/ops.ts:614–641`). Clean.

### The API surface

23 lexicon JSONs under `packages/lexicons/lexicons/pub/atmo/notify/`; **14 published** at
`/lexicons/<nsid>`; **13 wired onto the public XRPC router** (`apps/relay/src/router.ts:67–79`).
The other nine exist only as type-generation input and are reachable **only over the
Cloudflare service binding**.

Public: `requestPermission`, `send`, `setRouting`, `getRouting`, `listNotifications`,
`markRead`, `revokeSelf`, `muteSelf`, `setCategories`, `addCategory`, `removeCategory`,
`getCategories`, `manage`. Published-but-app-implemented: `subscriberChanged`.
Binding-only: `grant`, `revoke`, `denyPending`, `muteGrant`, `linkChannel`, `listGrants`,
`listPending`, `getSettings`, `updateSettings`.

Note a deliberate design choice: every dual-auth *read* is a **procedure, not a query**, so
the user's consent JWT travels in the body rather than the URL. The lexicon descriptions say
so explicitly.

`send` payload: `{recipient, title ≤100, body ≤500, uri?, threadKey?, category? ≤64,
categoryDescription? ≤200, actors? [≤8]}` → `{id, delivered: int}`.

`send.ts` order of operations is worth copying as a checklist: auth → grant check → **URI
hardening before any side effect** (rejects >2048 chars, non-absolute, and any non-`http(s)`
scheme, because the `uri` becomes an inbox `href`, a Telegram button and a Bluesky DM link
facet — a `javascript:` URI would be stored XSS on the dashboard origin) → rate limits
before any write → category upsert → route resolution → `off` drops without recording →
**always insert the inbox row** → muted/`inbox` stops here → select targets → per-channel
daily caps applied sequentially → enqueue one job per target → delivery log.

**There is no idempotency.** No dedup, no idempotency key, no replay store for `send`.
`threadKey` is in the lexicon ("Optional opaque key for grouping related notifications") and
is **never read** — not in the job type, not stored, not referenced anywhere in the relay.
Grouping is an open `todo.md` item. The only dedup pressure is a 1/sec/pair limit.

### How an app registers — two senses

**To send: no registration, permissionless.** Any app with a resolvable DID and a signing
key can call `requestPermission` then `send`. `SELF-HOSTING.md` says it plainly: "The relay
serves **any** app a user grants. To hard-restrict it to only your DID, gate
`requestPermission`/`send` on your sender DID (a few lines in `src/xrpc/`)."

**To get privileges: a hardcoded allowlist.** `apps/relay/src/lib/apps.ts` exports
`APPS: readonly RegisteredApp[]` with `{did, title, description?, iconUrl?, callbackUrl?,
trusted?, manage?}`. **At HEAD it contains exactly one entry — the demo app — and nothing
is `trusted: true`.** Being in it gates: auto-grant, the `subscriberChanged` callback,
dashboard catalog presence, and relay-wide `manage` designation. Getting in requires a PR
to flo-bit's repo and a redeploy.

Auth is atproto service auth throughout: `ServiceJwtVerifier` with
`acceptAudiences: [relayDid, '<relayDid>#notif_relay']`, `maxAge: 300`, `clockLeeway: 5`,
over a KV-cached plc+web resolver. Sender and user auth are **the same verification** —
the only difference is which field the caller reads. The app side is three lines
(`mintSenderJwt` → `createServiceJwt({keypair, issuer, audience, lxm, expiresIn: 60})`) plus
a `did:web` document exposing a `Multikey` verification method.

The one security-critical check, on the app's callback receiver:
`if (issuer !== RELAY_DID) error(403)` — with the comment "Critical: trust ONLY the relay. A
valid signature from anyone else is not enough."

### Transports

One Cloudflare Queue, `max_batch_size: 10`, `max_retries: 3`. The dispatcher switches on
`job.channel.platform`; **channel selection already happened at send time** via route
resolution.

- **`webpush.ts` + `push-crypto.ts`** (234 lines) — hand-rolled RFC 8291 `aes128gcm` +
  RFC 8292 VAPID on pure WebCrypto, no `web-push` package (because Workers). Env
  `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`, `VAPID_PRIVATE_JWK`.
- **`email.ts`** — **not Resend/SES/MailChannels**. It posts to
  `https://smtp.atmos.email/v1/send` with `Authorization: Bearer ${COMAIL_API_KEY}` and
  `x-atmos-did: ${COMAIL_DID}` — i.e. **comail / atmospheremail**, the cooperative
  atproto-native email infrastructure. A 2xx with an empty `accepted[]` is treated as
  failure.
- **`telegram.ts`** — Bot API; webhook mounted at `POST /telegram/webhook/:secret` with the
  secret as the last path segment. Renders inline ✅ Allow / ❌ Deny buttons for permission
  requests, so a user can grant from the chat.
- **`bluesky-dm.ts`** — DMs from a bot account via app password, proxied with
  `atproto-proxy: did:web:api.bsky.chat#bsky_chat`, sessions cached in KV for 30 days
  because `createSession` is "heavily rate-limited (a few per day)".
- **`webhook.ts`** — POST to a user https URL, 10 s timeout, **no signing or HMAC**. SSRF
  defence is at creation time instead (rejects localhost, `.local`, RFC1918, link-local,
  IPv6 ULA).

`reapIfDead` (`dispatcher.ts:43–106`) is the most valuable 60 lines in the repo — a
per-channel permanent-vs-transient policy: push 404/410 → **delete the target**; Telegram
403 or "chat not found" → delete; email ≥400 except 429 → stop retrying but **keep** the
target so the user can fix it; DM 4xx except 401/429 → stop, keep; webhook 4xx except 429 →
stop, **never auto-reap** (the user owns the URL); `subscriberChanged` 4xx → drop, 5xx →
retry. Pure policy, freely reimplementable.

Rate limits, complete inventory: `send` 1/sec + 100/day **per (sender, recipient)**;
`requestPermission` 50/hr per recipient + 100/hr per sender; email 10/day per recipient +
100/day relay-global (configured to 10). Nothing else is limited. Implemented as KV
fixed-window counters with the window end in metadata, because **KV enforces a 60-second
minimum TTL** while the send limiter needs one second. `checkAndIncrementAll` is
all-or-nothing so a blocked global cap doesn't burn the per-recipient slot.

### Client-side web push

`apps/web/src/lib/push.ts` + `service-worker.ts`. `pushSupported()` gates on
`serviceWorker`/`PushManager`/`Notification` **and** a non-empty VAPID key;
`registration()` prefers `getRegistration()` over `.ready` because `.ready` hangs before a
worker is active; `iosNeedsInstallForPush()` detects iOS Safari in a tab (including the
iPadOS desktop-UA case via `maxTouchPoints`) so the UI can say "Add to Home Screen" rather
than "unsupported". The service worker's `fetch` handler is deliberately narrow — **only
precached build/static paths are served from cache**, so no stale or cross-user content.
`notificationclick` routes external links through an in-scope `/go?to=…&n=…` handoff page,
because a PWA cannot render an out-of-scope URL and `client.navigate` can't cross origins;
the `n` param lets the opened page mark the inbox row read, since iOS doesn't do that on
foregrounding. Every one of those is a real-world lesson we'd otherwise learn the hard way.

**Subscriptions are stored server-side in D1**, not in the browser — one `delivery_targets`
row per device, `ref` = the push endpoint, `config` = `{p256dh, auth}`.

### Point at our AppView, or self-host?

Both are possible; neither is good.

**Hosted:** we could send through `relay.atmo.pub` today without asking anyone. We could
*not* get auto-approval, the `subscriberChanged` callback, catalog presence, or account
management without flo-bit merging our DID. Concretely: **atmo-events' own DID is not in
`APPS`**, so `callbackAppFor` returns undefined and `notifySubscriberChanged` is a no-op —
atmo built and verified the receiver and it is dead in production today. That is the
clearest possible demonstration of the allowlist friction.

**Self-host:** requires a Cloudflare account **on the Workers paid plan** (Queues), a domain
in that account, D1 + KV + a Queue, relay and VAPID keypairs, **a source edit** to paste the
relay public multikey into `src/well-known.ts`, and `RELAY_DID` matching the domain.
`SELF-HOSTING.md`: "It runs on Cloudflare Workers (D1 + KV + Queues); that's the only
supported target for now."

Portability assessment: D1 → Postgres is one 1093-line SQL file (the `ON CONFLICT` syntax
already matches). KV → Redis is trivial and *better* (no 60-second-TTL wart). Queues →
pg-boss/BullMQ is medium. The real lock-in is that **the entire first-party management API
(29 methods) is a Cloudflare `WorkerEntrypoint` service binding, and the binding itself is
the auth boundary** — `rpc/entrypoint.ts` trusts the `did` argument with no JWT at all. Off
Cloudflare we'd have to invent auth for all 29. Good news: zero `node:*` imports, all
WebCrypto, so the code is runtime-neutral otherwise. `MANAGEMENT-AUTH.md` is candid that
this is known debt, and the `manage` XRPC envelope is the partial fix.

### How atmo-events consumes it

Seven files, ~23 KB, `apps/web/src/lib/notify/` — and this is MIT, so it *is* copyable.
What an app must implement:

1. A P-256 keypair, server-side only (`keypair.ts`): `parsePrivateMultikey(env.ATMO_NOTIFY_PRIVATE_KEY)`,
   must be `p256`, cached per process keyed on the secret so rotation re-imports.
   `notifyConfigured(env)` makes the whole feature cleanly no-op when unset.
2. A `did:web` **derived from the origin** — `did:web:${new URL(env.OAUTH_PUBLIC_URL).host}`
   — so it can never drift from where the document is served. Served from a **hook**, not a
   route, because SvelteKit ignores dot-directories.
3. Signing + three calls (`relay.ts`): `mintAppToken` → `createServiceJwt({expiresIn: 60})`;
   `relaySend` (app token), `relayRequestPermission` (**user** token as bearer),
   `relayRevokeSelf` (dual: app token header + `{userToken}` body). Status semantics
   documented inline: 403 = no grant, 429 = back off, 401 = bad token.
4. User-token minting from the OAuth session via `com.atproto.server.getServiceAuth`.
5. The `subscriberChanged` receiver with the `issuer !== RELAY_DID` check.
6. **Its own dedup ledger**, because the relay has none: `notify_sent(key PK, recipient,
   kind, created_at)` with `claimNotification` as an atomic `INSERT OR IGNORE` returning
   whether this caller won, and `releaseNotification` to un-claim after a 429 so it retries.

What it notifies about today: **event reminders** at **24 h / 1 h / at start** for events
the subscriber RSVP'd going-or-interested, with a 30-minute catch-up window so worker
downtime doesn't drop them, a candidate window padded ±36 h so non-UTC offsets can't slip
past an ISO string comparison, and `threadKey = <event uri>`; and **host RSVP alerts** when
someone else RSVPs, cursor-based over `indexed_at` in microseconds, **seeded to "now" on
first run so history isn't replayed**. Both respect the relay's limits explicitly
(`MAX_SENDS_PER_TICK = 40`, `MAX_NEW_RSVPS_PER_TICK = 100`), a 429 **stops the tick** and
releases the claim, and a 403 marks the subscriber disabled — the fallback for a revoke that
missed the dead webhook.

### Maturity

24 test files, **146 cases, zero skipped**, run *inside workerd* via
`@cloudflare/vitest-pool-workers` against a real in-memory D1 with migrations applied, using
**real P-256 identities, real DID documents and real signed service-auth JWTs** (no auth
stubbing) and a fetch mock that **throws on any unmocked request**. Coverage is
security-weighted: XSS via `uri`, SSRF on webhooks, JWT replay, cross-user scoping, wrong
audience, wrong `lxm`, webhook-secret mismatch, an RFC 8291 encrypt/decrypt round-trip, and
VAPID JWT verification. Genuinely good.

Gaps: the queue consumer and cron handler have no direct tests; `bluesky-dm.ts`'s KV session
reuse and 401-refresh — its two riskiest paths — are untested (only `linkFacet` is covered);
19 of 21 `manage` dispatch entries are untyped casts with no coverage.

Unfinished: committed dev keys (flagged in its own docs as a pre-prod task), `trusted`
unused, email behind a **two-DID hardcoded allowlist** in the dashboard with the global
daily cap configured to 10 (pilot-only), and one open item in `MANAGEMENT-AUTH.md`:
off-Cloudflare `verifyAppLogin` over XRPC.

One wire-contract warning: **`send.actors` is inconsistent between the lexicon and the
published docs.** `send.json` requires objects (`items: {ref: '#actor'}`, `#actor` requires
`did`), but `llms.txt` documents strings (`"actors": ["alice.bsky.social"]`), and
atmo-events — three months newer — types it `string[]` and passes bare handles and DIDs.
Probe the live `GET https://relay.atmo.pub/lexicons/pub.atmo.notify.send` before building
against this clone.

---

## openmeet-api

`…/r6_prior-art/openmeet-api` @ `8fd54d9`. **Apache-2.0** (LICENSE + package.json;
no NOTICE file). NestJS 11, Node ≥ 24, PostgreSQL + TypeORM, 73 modules under `src/`.
Tenancy is **schema-per-tenant** (`tenant_<id>`) with a separate `pg.Pool` per tenant, a
global `TenantGuard` that 401s without `x-tenant-id`, and the tenant roster in a JSON file
rather than the database.

### `src/event-series/`

**Entity** — `EventSeriesEntity`, table `eventSeries`
(`src/event-series/infrastructure/persistence/relational/entities/event-series.entity.ts`):
`id`, `createdAt`, `updatedAt`, `ulid char(26)` unique, `name varchar(255)`,
`slug varchar(255)` unique (generated `slugify(name + '-' + shortCode)`),
`description varchar(255)` (only 255 chars), `timeZone varchar(100)` default `'UTC'`,
`image` (OneToOne File), **`recurrenceRule jsonb NOT NULL`**,
**`recurrenceExceptions jsonb` (string[] of ISO datetimes)**, `matrixRoomId`,
`user` (ManyToOne, `SET NULL`), `group` (ManyToOne), `events` (OneToMany inverse),
the four `source*` provenance columns (`sourceType/Id/Url/Data` — `sourceType` is e.g.
`'bluesky'`), **`templateEventSlug varchar(255)`** with a `OneToOne` joined
**by slug, not id**, and a *virtual* `recurrenceDescription` computed in memory only.
No `externalId`. No atproto columns on the series.

**Rule storage is bespoke JSON, not an RRULE string.**
`src/event-series/interfaces/recurrence.interface.ts:15–32` defines
`{frequency, interval?, count?, until?, byweekday?: string[], bymonthday?, bymonth?,
bysetpos?}`. A *second*, camel-cased frontend shape exists
(`frontend-recurrence-rule.interface.ts`) and the mapper between them,
`RecurrencePatternService.mapFrontendToBackendRule` (`recurrence-pattern.service.ts:486`),
is **currently broken**: it hardcodes `frequency: RecurrenceFrequency.DAILY` at line 499
with the real mapping commented out. This is the direct cost of not using a string.

**Library:** `rrule` **^2.8.1** (installed 2.8.1). No `rrule-rust`, no `@rschedule/*`, no
`ical.js`. `luxon` is only transitive; date math is `date-fns` 4.1.0 + `date-fns-tz` 3.2.0;
iCal is `ical-generator` 8.1.1 + `node-ical` + `@touch4it/ical-timezones`. **One import
site**, `recurrence-pattern.service.ts:2`.

It deliberately **does not use RRule's `tzid`** (omission noted at line 152). It converts
the start to a wall-clock UTC `Date`, calls `rrule.between(start, end, true)`, then
re-localises each result through `toDate(localDateTimeString, {timeZone})` and
force-rewrites every occurrence to the template's local `HH:mm:ss` so DST never shifts the
local time. This is the *same conclusion* atmo reached independently with
`CalendarDateTime`. Two independent codebases, same answer: **expand on wall-clock, then
localise.** Take that as settled.

**Materialization is lazy-on-read with no background top-up.** Repo-wide there are exactly
four `@Cron` decorators — metrics, database metrics, external-calendar sync, atproto sync —
and **nothing in `src/event-series/` is scheduled**. Occurrences appear when someone hits
`GET event-series/:slug/:occurrenceDate`, whose Swagger text says: "This is known as
'vivification' or 'lazy materialization' — events are only created when needed." Both
`POST /` and `POST create-from-event/:eventSlug` pass `generateFutureEvents = false`, so
series creation materializes nothing at all.

The window constants are a mess worth learning from:

```ts
// event-series-occurrence.service.ts:55-60
private readonly materializationConfig = {
  blueskyEventCount: 2,   // used
  normalEventMonths: 2,   // DECLARED BUT NEVER READ
};
// :870-872 — the actual default
let count = isBlueskyEvent ? this.materializationConfig.blueskyEventCount : 2;
```

Plus `MAX_OCCURRENCES = 2000`, a default `count = 10`, a read cap of
`Math.min(count, 50)`, a 3-month past look-back, a 500-row existing query limit, a
15-second wall-clock abort, `maxOccurrences = 5` in `generateFutureOccurrences`, batches of
2 with a 5-second per-occurrence timeout, and an expansion horizon of
`yearsToLookAhead = rule.frequency === 'YEARLY' ? 5 : 1`. The net effect: **what events
exist in the database is a function of who browsed the page.**

**Occurrence → series link.** An occurrence is an ordinary `EventEntity` row in the `events`
table with full attendee machinery, its own slug, chat room and atproto publish lifecycle.
The FK is **`seriesSlug varchar(255)` joined slug→slug** — there is no `seriesId`.
`isRecurring` is a getter (`!!this.seriesSlug`). There is an `originalDate timestamp`
column (indexed) but it is **not named `originalOccurrenceDate`** and
`materializeOccurrence` **never sets it** — only the deprecated
`EventOccurrenceService.createOccurrence` does. The codebase is visibly anxious about this
link: `[SERIES_SLUG_LOST]` error logs appear in five places.

**"Edit this and following"** — `updateFutureOccurrences(seriesSlug, fromDate, updates,
userId)` at `event-series-occurrence.service.ts:1055`, exposed as
`PATCH event-series/:slug/future-from/:date`. It does **not** split the series and does
**not** delete+recreate. It rewrites the template event, then loops the already-materialized
future occurrences (inclusive of the reference date) and updates each. The propagatable
field allow-list is exactly `description, location, locationOnline, maxAttendees,
requireApproval, approvalQuestion, allowWaitlist, categories` — so **time, date, recurrence
rule, name, visibility and status cannot be propagated at all**. Unmaterialized future
occurrences pick up changes automatically because materialization copies from the template.
There is no `splitSeriesAt`, no second series, and **no per-occurrence override record** —
a single-occurrence edit is an ordinary Event edit that silently diverges with nothing
marking it as an exception.

Series-level edits (`EventSeriesService.update`, `:964`) replace `recurrenceRule` with a
plain `repository.save` and **do not reconcile already-materialized occurrences against the
new rule**.

**The exception bug.** `EventManagementService.remove()` correctly pushes the deleted
occurrence's `startDate.toISOString()` onto `series.recurrenceExceptions` inside a
transaction. But `recurrenceExceptions` is **never read back during generation**.
`RecurrencePatternService.generateOccurrences` accepts an `excludeDates` option and applies
it — but the two live call sites pass only `timeZone`/`count`/`startAfterDate`. A repo-wide
grep shows `excludeDates` is consumed only by iCal export (EXDATE lines) and by the
**deprecated** occurrence service. **So a cancelled occurrence is excluded from `.ics`
exports but will be re-offered by `getUpcomingOccurrences` and can be re-materialized.**
This is the single most important thing to not repeat.

**Deletion.** Whole series: `deleteEvents: true` removes every event and **aborts series
deletion entirely if any event failed** ("to maintain data consistency"); `deleteEvents:
false` (the default) **orphans** the events by nulling `seriesSlug` then deletes the series.
The orphan default is right and we should copy it. Single occurrence: no series-aware
endpoint — you delete the Event (attendees deleted, exception recorded-but-unread) or set
`status = Cancelled`, which routes to a cancellation announcement and republishes the
atproto record as `community.lexicon.calendar.event#cancelled`.

**atproto in this module: none.** Zero `@atproto/*` imports, zero lexicon NSIDs. The series
is **never written as an atproto record**. Repo-wide the only NSIDs are
`community.lexicon.calendar.event` and `…rsvp`; **there is no `*.series*` NSID anywhere**,
and grepping `recurrence|rrule|RRULE` across `src/atproto-publisher`, `src/bluesky`,
`src/contrail`, `src/did-api` returns nothing. Recurrence is invisible on the wire. The only
series signal is an app-namespaced side-channel on the event record
(`bluesky.service.ts:556–559`): `openMeetMeta.seriesSlug` and `openMeetMeta.isRecurring`.
`src/event-series/TESTING.md` flags the gap as future work: "Syncing series with Bluesky
(which doesn't natively support recurrence)."

Also worth knowing: **two competing recurrence implementations coexist**.
`src/event/services/occurrences/event-occurrence.service.ts` has every method marked
`@deprecated` but is still registered, and is still the only thing that writes `originalDate`
and reads `excludeDates`.

### `src/event-mail/`

**Triggers.** Emitter-driven via `@nestjs/event-emitter`:
`event.created` → `EventAnnouncementService.handleEventCreated` (template
`event/new-event-announcement`, sent with a per-recipient `.ics`);
`event.updated` → `handleEventUpdated`, **gated on `params.sendNotifications === true`**,
delegating to `sendCancellationAnnouncement` when status is `Cancelled`;
`event.deleted` → `handleEventDeleted`;
`event.rsvp.added` → `CalendarInviteListener`, only for `Confirmed`.
Plus direct service calls for guest-joined, attendee-status-changed, admin-broadcast,
attendee-contacts-organizer, four group equivalents, and five auth emails.

Note the request-scope workaround every listener needs, since emitter callbacks run outside
the HTTP request: `ContextIdFactory.create()` +
`moduleRef.registerRequestByContextId({tenantId, headers: {'x-tenant-id': tenantId}}, contextId)`
then `moduleRef.resolve(…, {strict: false})`. Anyone building per-tenant + event-driven on
Nest will hit this.

**Templates.** `src/mail/mail-templates/`, read **from the source tree at runtime** (not a
build artifact). Pipeline is **EJS → MJML → HTML**, plus auto plain-text:
`ejs.render(file, ctx, {filename})` → `mjml(rendered, {validationLevel: 'strict'})` →
`html-to-text convert()`. Packages: `ejs` 3.1.10, `mjml` 5.0.0-beta.1, `html-to-text` 9.0.5.
Files are `*.mjml.ejs`: `layouts/{header,footer}`, `auth/{activation,confirm-new-email,
email-verification,login-code,reset-password}`, `event/{admin-message-to-attendees,
attendee-contact-notification,attendee-guest-joined,attendee-status-changed,
event-cancellation-announcement,event-update-announcement,new-event-announcement}`,
`events/calendar-invite`, `group/{admin-message-to-members,group-guest-joined,
group-member-joined,group-member-role-updated,member-contact-notification}`. One orphaned
`group-member-joined.hbs` with no caller.

One bug to not copy: `renderTemplate` caches on
`` `${templateName}:${JSON.stringify(context)}` `` in an **unbounded `Map`**. Per-recipient
contexts mean a near-zero hit rate and unbounded growth for the process lifetime.

**Transport.** Raw `nodemailer` 7.0.12 over SMTP. No `@nestjs-modules/mailer`, no
Mailgun/SES/Postmark/Resend. Env: `MAIL_HOST` (required), `MAIL_PORT` (default 587),
`MAIL_USER`, `MAIL_PASSWORD`, `MAIL_DEFAULT_EMAIL`, `MAIL_DEFAULT_NAME`, `MAIL_IGNORE_TLS`,
`MAIL_SECURE`, `MAIL_REQUIRE_TLS`, with per-tenant From overrides. Calendar invites ride as
a proper `text/calendar` part via nodemailer's `icalEvent` with `method: 'REQUEST'` — worth
copying verbatim.

**Digest logic: there is none.** No digest, no batching, no throttling, no rate limiting,
no per-message dedup, no unsubscribe tokens, no suppression list, no outbox, no send log, no
retry. `bull`/`bullmq` are **not installed**. Failures are logged and swallowed. Fan-out
concurrency is **unbounded**: `recipients.map(async …)` then `Promise.allSettled` — a
5,000-member group is 5,000 simultaneous SMTP sends. The only preference in the entire
system is a single nullable `jsonb` column on the user row, read as
`user.preferences?.notifications?.email !== false` (default-allow). The nearest thing to
noise control is that `event.updated` mails nothing unless the caller opts in.

**Reminders before events: none.** A repo-wide grep for `reminder` yields exactly two hits,
both inside the generated `.ics` — a `VALARM` that the *recipient's own calendar client*
fires. The server never schedules a pre-event message. This is consistent with there being
no cron in any mail module, and it is the feature flo-bit independently identified as the
real value ("the real value i think is in reminders", atmo-events#29).

### The custodial atproto signup — take this

Packages: `@atproto/api` 0.13.31, `@atproto/crypto` 0.4.5, `@atproto/identity` 0.4.7,
`@atproto/oauth-client-node` 0.2.5, `@atproto/jwk-jose` 0.1.2, `@atproto/lexicon` 0.6.1,
`@atcute/identity-resolver` 1.2.3, plus five **vendored tarball** `@atmo-dev/contrail*`
packages.

**Hook.** Every successful login funnels through
`AuthService.ensureAtprotoIdentity(user, authProvider, socialData, tenantId)`
(`src/auth/auth.service.ts:1637`), explicitly non-blocking — the whole body is wrapped so
"PDS failures don't prevent login". It short-circuits if an identity row already exists, then
branches: Bluesky OAuth → `linkBlueskyIdentity` (non-custodial); Google/GitHub/email →
`createCustodialPdsAccount` (mint).

**Minting** (`createCustodialPdsAccount`, `:1748`): silently skips if `PDS_URL` is unset,
then up to **5 attempts**, each generating a unique handle (truncated to 18 chars minus 2
reserved for a collision suffix, default domain `.opnmt.me`), a **fresh
`crypto.randomBytes(32).toString('hex')` password never shown to the user**, calling
`PdsAccountService.createAccount`, encrypting the password, and inserting the identity row.
Email falls back to a synthetic `${user.ulid}@openmeet.net` when the user has none. Retries
only on handle collision; an "email already taken" error returns quietly so the user can
recover via settings.

**The wire call** (`src/pds/pds-account.service.ts:106–131`):

```ts
const url = `${this.pdsUrl}/xrpc/com.atproto.server.createAccount`;
const body = { email, handle, password };
if (this.inviteCode) { body.inviteCode = this.inviteCode; }
const response = await firstValueFrom(this.httpService.post(url, body, {headers}));
return { did, handle, accessJwt, refreshJwt };
```

wrapped in `withRetry` (exponential backoff, `maxRetries = 3`, `baseDelay = 1000`).

**Which PDS:** one operator-configured self-hosted PDS, no per-user choice. Config keys:
`PDS_URL`, `PDS_SERVICE_HANDLE_DOMAINS`, `PDS_ADMIN_PASSWORD`, `PDS_CREDENTIAL_KEY_1`,
`PDS_CREDENTIAL_KEY_2` (each validated as base64 decoding to **exactly 32 bytes**),
`PDS_INVITE_CODE`.

**Who holds keys:** the signing key lives on the PDS (standard hosted `did:plc` model);
OpenMeet holds the **account password**, encrypted at rest. `PdsCredentialService`:
**AES-256-GCM**, 12-byte random IV, 16-byte auth tag, **versioned for rotation** —
`{v: 1|2, iv, ciphertext, authTag}`, new encryptions always using KEY_1. The user never
learns the password; there is no user-visible app password.

**Storage** is a sibling table, not the user row: `userAtprotoIdentities` —
`userUlid char(26)` unique (joined on `users.ulid`, `onDelete: CASCADE`), `did` unique,
`handle`, `pdsUrl`, **`pdsCredentials text`** (the AES-GCM envelope; "SECURITY: Never log or
expose this value"), **`isCustodial boolean` default true**, and
`takeOwnershipStatus varchar(16)` ∈ `pending|ambiguous|confirmed`.

**Writing on the user's behalf:** `PdsSessionService.getSessionForUser` trifurcates —
non-custodial → resume the OAuth session; custodial with credentials → check the
Redis/ElastiCache session cache, else **decrypt the stored password and
`com.atproto.server.createSession`**, then cache; custodial with null credentials
("orphan") → return null. The result is an `@atproto/api` `Agent` over a `CredentialSession`,
and callers do `agent.com.atproto.repo.createRecord(...)`. So: **stored encrypted account
password → minted session → cached session.** Not an app password, not service auth.

**Take-ownership is fully implemented** (`src/atproto-identity/atproto-identity-recovery.service.ts`):
`GET recovery-status`, `POST recover-as-custodial`, `POST take-ownership/initiate`,
`POST take-ownership/complete`, `POST reset-pds-password`, `POST update-handle`,
`DELETE session`. The careful part: `initiate` resolves the destination email **from the DID
via `getAccountInfo(identity.did)`, never from the OpenMeet user row**, because the two can
drift and mailing a drifted address would send a reset code for an account the user doesn't
own. It warns on mismatch, then calls `requestPasswordReset` so **the user sets their own
password directly with the PDS**. `complete` is one write plus a cache kill:

```ts
await this.userAtprotoIdentityService.update(tenantId, identity.id, {
  pdsCredentials: null, isCustodial: false, takeOwnershipStatus: null,
});
await this.pdsSessionService.invalidateSession(tenantId, identity.did);
```

**The DID is preserved across the handoff**, so the user keeps their identity and all their
records. The `takeOwnershipStatus` column carries a 30-line design note explaining why the
marker is written *before* the reset is submitted and advanced monotonically through a
compare-and-set: the PDS returns the same 401 for an unknown account as for a changed
password, so a bare 401 is ambiguous, and only `'confirmed'` authorizes auto-ending custody.
That note is the best-reasoned code in any of these four repositories.

### The contrail migration, and a warning for us

Signals are strong: five vendored `@atmo-dev/contrail*` tarballs with four forced through
`overrides` to 0.6.0; a Jest transform-ignore exclusion for a checked-out upstream PR branch
(`contrail-pr30`); `CONTRAIL_SPACE_TYPE` defaulting to **`tools.atmo.event.space`** and
`SERVICE_DID` to `did:web:api.openmeet.net`; a community layer whose
`CONTRAIL_COMMUNITY_ENCRYPTION_KEY` is "the AES-GCM key that envelope-encrypts stored
rotation keys + app passwords" — i.e. poised to take over exactly the custodial-credential
job `PdsCredentialService` does today, and **with rotation keys, which the current model
lacks**; and a default-deny one-shot provisioning flag
(`CONTRAIL_ALLOW_PROVISIONING === 'true'`, with a comment referencing a "Step-3 provision
window") implying a written multi-step runbook. Nothing in `docs/` mentions contrail at all;
the migration lives in code and env vars.

**The warning:** contrail there is a forklift, not a bolt-on. It has its own
`CONTRAIL_DATABASE_URL`, its own `contrail` schema, its own pool, runs out-of-process, and
is mounted in `main.ts` at `/xrpc` **ahead of Nest's tenant guard**, because — the comment
says — "the new XRPC layer is single-tenant by design". OpenMeet's schema-per-tenant model
does not survive the move unchanged. **If we want multiple free schools in one deployment,
we must decide that before we stand up the AppView, not after.** That belongs in the
federation brief.

---

## Fork / reimplement / import matrix

| what | verdict | reasoning | concrete files / functions to take |
|---|---|---|---|
| **`@atmo-dev/contrail`** (core AppView) | **Import as dependency**, pin exactly | MIT, on npm, most active of the four, Postgres adapter, sidecars first-class, backfill already direct-PDS, and `init --prefix community.lexicon.calendar.` is our exact use case. Forking a pre-alpha library moving 0.12→0.23 in four months is the worse risk. | Config shape: `core/types.ts` (`ContrailConfig`, `CollectionConfig`). Use as-is: `core/pds-snapshot.ts`, `core/backfill.ts` (set `relays` = our peer registry), `adapters/postgres.ts`, `core/service-auth.ts`. Read as template: `docs/03-configure-and-query.md`, `docs/advanced/outbox.md`. |
| **A `PdsChangeSource` for contrail** | **Write it** (the one real build) | Only built-in live `ChangeSource` is Jetstream; we've settled on no relay. The interface is documented and stable-ish. Offer it upstream — flo-bit merges external PRs. | Implement `ChangeSource {id, semantics, mark, read}` from `core/sources.ts:112–131`. Model on `core/jetstream-source.ts` (337 lines). Reuse `core/scheduling.ts` (`createStreamingHostScheduler`, `drainQueue`) and `core/client.ts` (`createPdsClient`, `getPDS`). |
| **`@atmo-dev/events-ui`** | **Import for the prototype; plan to copy 6 files** | MIT, properly packaged, and `EditorAdapter` is the seam we want. But v0.1.0, no changelog, and hard peer deps on Svelte 5 + Tailwind 4 + `@foxui/*` — a design-system commitment we may not want for a free school's visual identity. | `editor/adapter.ts`, `cal/ical.ts`, `cal/sanitize.ts`, `TimezonePicker.svelte`, `DateTimePicker.svelte`, `event-view/AddToCalendarButton.svelte`, `date-format.ts`. **Not** `editor/save.ts` (inline non-lexicon fields) or `RecurringModal.svelte`. |
| **atmo-events `apps/web`** | **Reimplement; read for patterns** | D1/Workers-shaped, pinned to contrail 0.12.2 whose spaces product is gone upstream, 50 MB of conference media. But it's the best live reference for granular OAuth. | `lib/atproto/server/oauth.ts` + `settings.ts` (granular scopes: `scope.repo`, `scope.blob`, `include:<permissionSet>`, `rpc?lxm=…&aud=*`); `routes/(oauth)/*`; `lib/contrail.config.ts` as the projection template; **the 35-line budget comment in `routes/api/cron/+server.ts`**. |
| **atmo-events `lib/notify/*`** | **Copy (MIT), adapt off the relay** | 7 files, ~23 KB, a working sender: keypair, origin-derived `did:web`, JWT minting, **and the dedup ledger the relay lacks**. The dedup and cursor logic is transport-independent. | `notify/db.ts` (`claimNotification` / `releaseNotification` — atomic INSERT-OR-IGNORE claim, release on 429); `notify/process.ts` (due-window + 30-min catch-up, ±36 h candidate padding, cursor seeded to "now" on first run, per-tick caps, 403→disable); `notify/keypair.ts`, `notify/did-document.ts`. |
| **contrail PR #95 / `contrail-spaces-alpha`** | **Reimplement later; depend never** | `"private": true`, pinned to an unpublished dated `@atproto/space` snapshot, open since August, already bitrotted (PR #111 exists to fix that). But it's the clearest reading of the permissioned-data proposal's shape. | When spaces land: `src/protocol.ts:147–167` (DPoP header), `src/sync.ts:254–353` (reconcile + 2-observation removal), `src/crypto.ts` (context-bound AEAD), `packages/contrail/src/core/isolated-projection.ts` (the isolation model), `core/ingest.ts` `IngestProjection` seam, and `apps/spaces-demo/src/routes/+page.server.ts:132–152` (the lease-refresh retry that makes membership the PDS's job). |
| **atmo-events contrail-spaces (`rsvp.atmo.space.*`)** | **Reimplement as our own Spaces-shaped interface** | The generated lexicons are a complete, coherent interface spec for app-custodied spaces — including **community-owned spaces with access levels** and an `appPolicy {mode: allow\|deny, apps[]}` — and it matches our settled "app custodies school DID in v1". But it's generated by a contrail version whose spaces product was deleted in 0.13.0. No upstream, so we own it. | `apps/web/lexicons/generated/rsvp/atmo/space/*.json` + `invite/*.json` as the interface spec (16 space methods + 4 invite methods, `spaceView`/`memberView`/`recordView`/`blobInfo`/`inviteView`/`appPolicy`). `lib/spaces/server/client.ts` `mintServiceJwt` (per-`lxm` service-auth JWT, `exp +300s`, cached 250 s). `lib/spaces/server/spaces.remote.ts` as the call-shape reference. |
| **atproto-notify relay** | **Reimplement (forced)** | **No license** — hard block. Plus: Cloudflare `WorkerEntrypoint` binding *as* the auth boundary for 29 methods, one-entry hardcoded allowlist, no idempotency, dormant 3½ months. | From the **lexicon JSONs** (`packages/lexicons/lexicons/pub/atmo/notify/*.json`) and docs, not the TS: the route token grammar (`rpc.ts:102–229` semantics), the `delivery_targets` upsert-keeps-`id` rule, the three-level missing-row-means-inherit resolution, `send`'s order-of-operations checklist, and `reapIfDead`'s per-channel permanent-vs-transient table. Re-derive `push.ts`/`service-worker.ts` behaviours from the spec. |
| **OpenMeet custodial PDS + take-ownership** | **Port (Apache-2.0)** — highest-value take | The only working hosted-signup-that-mints-an-atproto-account in any of these repos, and the reasoning is better than the code around it. Directly satisfies our reference-PDS requirement. | `src/pds/pds-account.service.ts:106–131` (`createAccount` + `inviteCode` + `withRetry`); `src/pds/pds-credential.service.ts` (AES-256-GCM, key versioning — **add rotation keys, which it lacks**); `src/auth/auth.service.ts:1637` (`ensureAtprotoIdentity`, non-blocking) and `:1748` (`createCustodialPdsAccount`); `src/pds/pds-session.service.ts` (the three-way session resolution); `src/atproto-identity/atproto-identity-recovery.service.ts:221–330`; the `takeOwnershipStatus` design note at `user-atproto-identity.entity.ts:100–127`. |
| **OpenMeet mail templates** | **Port the pipeline + templates (Apache-2.0)** | MJML is the right answer for email HTML and the template set covers our cases. Keep Apache headers + add a NOTICE. | `src/mailer/mailer.service.ts` `renderTemplate` (EJS→MJML→`html-to-text`) **minus the unbounded render cache**; the `icalEvent {method: 'REQUEST'}` attachment; `src/mail/mail-templates/event/*` and `events/calendar-invite`. |
| **OpenMeet `event-series`** | **Reimplement; read as a catalogue of hazards** | Lazy-on-read materialization, JSON rule instead of an RRULE string (already broke its own frontend mapper), exceptions recorded-but-never-read, no split, a dead `normalEventMonths` constant, two competing implementations one of which is deprecated-but-wired, and `[SERIES_SLUG_LOST]` logs in five places. | Take only: the wall-clock-expand-then-localise technique (`recurrence-pattern.service.ts:182–379`) and the **orphan-on-series-delete default** (`event-series.service.ts:1091–1100`). |
| **OpenMeet mail delivery** | **Do not take** | No queue, no outbox, no retry, no digest, no throttle, no unsubscribe, one global boolean, unbounded `Promise.allSettled` fan-out, no reminders at all. Its own most conspicuous gap. | — |
| **OpenMeet tenancy** | **Read with caution** | Schema-per-tenant + per-tenant pool works, but its own contrail layer is explicitly single-tenant and mounted ahead of the tenant guard. Decide multi-school-per-deployment *before* the AppView. | `src/tenant/tenant.guard.ts`, `src/database/data-source.ts:291–352`, and `src/main.ts:88–134` as the cautionary tale. |

---

## Recurrence approach to adopt

Confirming and specifying the brief's settled plan (series sidecar + materialized
occurrences), with the details the two prior attempts got wrong.

### Library

**`rrule` ^2.8.1**, server-side, plus a zone library for localisation. This is the same
version OpenMeet runs in production, it's pure TypeScript with no native deps (so it works
on Node and in Workers), and crucially `RRule.fromString` / `rrule.toString()` round-trip
RFC 5545 — which is what makes iCal import/export and Google Calendar interop free.

**Store the rule as an RRULE *string*, not a JSON struct.** OpenMeet's bespoke JSON is
precisely why it ended up with two incompatible rule shapes and a mapper that hardcodes
`DAILY` with the real logic commented out. A string has one representation.

**Expansion technique (settled by two independent codebases reaching the same answer):**
expand on **wall-clock**, then localise. Do *not* pass `tzid` to RRule. Convert
`dtstart` to a floating local datetime, expand with `rrule.between(...)`, then map each
result through the series' IANA `timezone` to an instant, forcing the template's local
`HH:mm:ss` so a DST boundary never shifts "7pm Thursday" to 6pm or 8pm. atmo does this with
`@internationalized/date` `CalendarDateTime` (and documents why in a comment);
OpenMeet does it with `date-fns-tz` `toDate`/`formatInTimeZone`. Use `luxon` or
`date-fns-tz` on the AppView; reuse `@internationalized/date` in the PWA for the editor's
live preview, since the UI package we're borrowing already depends on it.

### Data model — what is a record

Three record types, all public in v1, none of them adding fields to the community lexicon.

**1. The series sidecar** (one record, the organizer's or the school's repo). NSID to be
fixed by the lexicon brief; shape:

```
$type:        <ns>.calendar.eventSeries
rrule:        string        # RFC 5545 RRULE line, e.g. "FREQ=WEEKLY;BYDAY=TH;INTERVAL=1"
dtstart:      datetime      # the anchor instant
timezone:     string        # IANA tz id — REQUIRED; the community lexicon has no tz field
exdates:      datetime[]    # cancelled/skipped occurrences — MUST be fed into expansion
templateEvent: at-uri       # the event record occurrences are cloned from
name:         string?       # optional series label, distinct from occurrence names
createdAt:    datetime
```

`timezone` is required and load-bearing: the community lexicon has no timezone field, atmo
writes one inline as a de-facto extension, and every DST calculation depends on it. Putting
it on the series sidecar is how we honour the sidecar rule without losing the information.

**2. Each occurrence** is an ordinary, unmodified `community.lexicon.calendar.event`. No
`recurringEventOf`, no `openMeetMeta`, no inline extension of any kind. This is what keeps
atmo, OpenMeet and every other calendar consumer reading our events unchanged, and it is
what lets RSVPs attach (the RSVP `subject` is a `strongRef` and needs a real record).

**3. An occurrence-link sidecar**, one per occurrence:

```
$type:        <ns>.calendar.eventOccurrence
event:        at-uri        # the occurrence event record
series:       at-uri        # the series sidecar
originalStart: datetime     # the instant the rule produced, before any edit
detached:     boolean?      # true once a human edited this occurrence alone
```

**Make the rkey deterministic** — derive it from `(series rkey, originalStart)`. Then
re-running materialization is idempotent via `putRecord` with no read-before-write, which is
what lets a cron top-up be safely re-entrant. This is the one genuinely new idea here and
it's cheap.

Why a sidecar rather than atmo's inline `recurringEventOf`: it's queryable (contrail indexes
it as its own collection with `references` back to `event` and `series`, which is exactly
what `CollectionConfig.references` is for), it survives another app editing the event
record, and it carries `detached` and `originalStart` which have nowhere to live otherwise.
Cost is one extra write per occurrence — at a 90-day window and weekly cadence, 13
occurrences means 26 writes. Acceptable.

### Data model — what is app state

Postgres only, disposable, re-derivable from repos:

- `series_materialization(series_uri PK, materialized_through, next_run_at, last_error)` —
  the cursor.
- A per-series advisory lock or lease while a materialization pass runs (contrail's
  `spaces_sync_leases` pattern: owner-stamped, TTL'd, renewed, CAS on acquire).
- The expansion cache.
- **Placeholder occurrences beyond the window**, computed on the fly from the rule for
  display only — never persisted, never RSVP-able. OpenMeet gets this right
  (`getUpcomingOccurrences` returns materialized events plus `{date, materialized: false}`
  markers) and it's the correct UX: the calendar looks infinite, the repo doesn't.

### Materialization: server-side, scheduled, rolling window

Not client-side — atmo's browser loop fails halfway with
`errorMsg = 'Failed to create event N. Stopping.'` and leaves a partial series with no record
of intent. Not lazy-on-read — OpenMeet's means what exists in the database depends on who
browsed the page.

- **Window: the next 90 days**, topped up on a **daily cron**, with a floor of **at least
  the next 4 occurrences** materialized regardless of window so a monthly or quarterly
  series is never empty. 90 days covers a free-school term and the horizon within which
  people actually RSVP; a longer window just means more stale copies to fix when an
  organizer edits.
- **Hard ceiling: never materialize more than 18 months ahead**, even when `COUNT`/`UNTIL`
  permits it.
- **Bound every pass**: max occurrences per series per run (~20), max series per run, and a
  wall-clock deadline — and save the cursor *last*, the lesson from atmo's cron comment.
- **Feed `exdates` into every expansion call.** This is the explicit fix for OpenMeet's live
  bug, and it needs a test: cancel an occurrence, run materialization twice, assert it does
  not come back.
- Skip any occurrence whose link sidecar has `detached: true`.

### Edit semantics

- **Edit this one only** → edit that occurrence's own event record, and set `detached: true`
  on its link sidecar. Materialization then leaves it alone forever. OpenMeet has no such
  marker, so its single-occurrence edits silently diverge with nothing recording that they
  did; this one boolean is the whole fix.
- **Edit this and following** → **split the series.** Set `UNTIL` on the existing series
  record to just before this occurrence; create a **new series record** with the new rule
  and template starting at this occurrence; re-point the affected occurrence links. This is
  strictly better than OpenMeet's rewrite-the-template-and-fan-out, which cannot propagate
  time, date, rule, name, visibility or status *at all* (its allow-list is eight
  presentational fields) and which loses the history of which rule produced which past
  occurrence.
- **Cancel one occurrence** → add its `originalStart` to `exdates` **and** set the
  occurrence event's `status` to `community.lexicon.calendar.event#cancelled` rather than
  deleting the record. RSVP holders' `subject` URIs still resolve, and the AppView can show
  "cancelled" instead of a dangling reference. OpenMeet deletes the row and orphans
  attendees. Reap the record later, or never.
- **Delete the series** → delete the series record and **leave materialized occurrences as
  ordinary standalone events**. OpenMeet's `deleteEvents: false` orphan default is right;
  offer "also cancel future occurrences" as an explicit second action.

### Upstream

Propose the series sidecar to `lexicon-community/lexicon`. There is no recurrence field
today and — verified by search — **no open issue or PR proposing one**, so the design space
is open. tompscanlan asked the exact question on atmo-events#78: "Maybe there is a new
lexicon for expressing this instead of materializing events into the future?" Our answer is
**both, and here's why**: a rule record is the truth and survives edits, but RSVP's
`subject` is a `strongRef` that needs a real record to point at, so occurrences must also
exist. Reply on #78 — he offered to share what he knows, and OpenMeet's 102-of-212-events-in-a-series
statistic is the best available evidence that this matters.

---

## Notification approach to adopt

Build it in-app. Adopt atproto-notify's **protocol shape**; depend on neither its code (no
licence) nor its hosting (Cloudflare-locked, allowlist-gated, dormant).

### Triggers — two paths, because one is not enough

**Path 1: contrail's outbox, for record-change notifications.**

```
changes: { consumers: { notify: {
  collections: ['community.lexicon.calendar.event', '<rsvp nsid>', '<our sidecars>'],
  phases: ['live'],
  initial: 'future',
}}}
```

Changes are appended **in the same transaction as the canonical record and source cursor**,
so nothing is lost and nothing is invented. `initial: 'future'` is the critical knob — it
prevents the "turn on notifications, mail the entire backfill" disaster that all three of
the other codebases had to engineer around independently (OpenMeet with its
`event.ingested` vs `event.created` event-name split; atmo by seeding its RSVP cursor to
"now" on first run; atproto-notify with its `initial` mode). Delivery is at-least-once and
coalesces repeated changes per URI, so handlers must be idempotent and upsert by URI.

Covers: a new offering published, an event changed, an event cancelled, an RSVP received,
anonymous feedback received.

**Path 2: a minutely cron, for time-based notifications.** An outbox cannot fire on "24
hours before an event" — nothing changed. So scan upcoming occurrences joined to RSVPs, with
a **due window plus a 30-minute catch-up** so worker downtime doesn't silently drop
reminders (atmo's pattern, and its ±36 h candidate-window padding to stop non-UTC offsets
slipping past an ISO string comparison is worth copying verbatim).

**Milestones: 24 h and 1 h before start, plus a day-of-morning digest.** Drop atmo's
"at start" milestone — it arrives when the recipient is already late. flo-bit's judgement on
atmo-events#29 is right: "the real value i think is in reminders." OpenMeet, with a real
mail stack, has **no reminders at all**; this is the gap both projects name.

### Data model — app state in v1, not records

Notification preferences must **not** be public records. Public records are settled for v1,
and a world-readable list of who gets emailed about which free-school class is exactly the
wrong thing to publish. Postgres:

- **`notification_target(id, did, channel, ref, label, named, verified, config, created_at)`**
  with `UNIQUE (channel, ref)` and a stable opaque `id`. Copy atproto-notify's upsert rule
  exactly: on conflict, update `did`/`verified`/`config` but **keep the original `id`,
  `label` and `named`** — that's why a user's routing survives a push re-subscribe, and it's
  the single best design decision in that repo.
- **`notification_pref(did, category, route)`** + **`notification_pref_default(did, route)`**
  — **two levels, not three.** atproto-notify needs an app level because it's multi-tenant
  across apps; we are one app. Keep the rest of the grammar: a missing row means *inherit*,
  writing a sentinel *deletes* the row, and the sentinels are `off` (drop entirely) /
  `inbox` (record, no alert) / `default` (inherit).
- **`notification_sent(key PK, did, kind, created_at)`** — the dedup ledger, with an atomic
  `INSERT … ON CONFLICT DO NOTHING` claim returning whether this caller won, and an explicit
  release on *retryable* failure so it retries. **Non-negotiable**, given atproto-notify has
  no idempotency whatsoever and OpenMeet has no send log at all. atmo-events' implementation
  is MIT; copy it.
- **`notification_outbox(id, did, channel, payload, attempts, next_attempt_at, status)`** —
  a durable send path with a worker. atproto-notify solved this with a Cloudflare Queue we
  can't portably use; OpenMeet didn't solve it at all (its single most conspicuous gap). A
  Postgres outbox is the portable equivalent and we already have Postgres.
- **An in-app inbox row for every notification, always**, even when no channel fires. This
  is what makes `off` safe and what makes `inbox` a sensible default for new accounts.

**Categories, declared up front** (we're one app, so no discovery needed):
`event.reminder`, `event.changed`, `event.cancelled`, `rsvp.received`, `offering.published`,
`member.joined`, `feedback.received`.

### Transports — web push **and** email, both in v1

Not one. The PWA is the product, but web push is unreliable on iOS unless the app is
installed to the home screen, and a free school's membership skews non-technical.

- **Web push:** RFC 8291 `aes128gcm` + RFC 8292 VAPID. We're on Node, not Workers, so use
  the **`web-push` npm package** rather than hand-rolling WebCrypto the way atproto-notify
  had to. Re-derive the client behaviours from the spec, and specifically reproduce three of
  its hard-won details: gate the UI on a non-empty VAPID key *and* API support; prefer
  `getRegistration()` over `.ready` (which hangs before a worker is active); and detect iOS
  Safari-in-a-tab (including the iPadOS desktop-UA case via `maxTouchPoints`) so the UI says
  "Add to Home Screen" rather than "unsupported". Also: route notification clicks through an
  **in-scope handoff page** (`/go?to=…&n=…`), because a PWA cannot render an out-of-scope URL
  and `client.navigate` can't cross origins — and pass the notification id so the opened page
  can mark it read, since iOS won't on foregrounding. Store subscriptions server-side, one
  `notification_target` row per device.
- **Email: comail / atmospheremail**, the cooperative atproto-native email infrastructure —
  `POST https://atmosphereemail.org/v1/send` with `X-Atmos-DID` + `Authorization: Bearer`, or
  SMTP at `smtp.atmos.email:587`. This is independently corroborated: it's atproto-notify's
  *only* email transport (`COMAIL_SEND_API = 'https://smtp.atmos.email/v1/send'`), and
  slanos offered hands-on integration help on atmo-events#29 and already built a working
  fork. **Abstract behind a transport interface** with plain SMTP via nodemailer as the
  fallback, which is the right escape hatch for a free school self-hosting its own instance.
- **Templates:** OpenMeet's EJS → MJML → `html-to-text` pipeline (Apache-2.0), and attach
  the `.ics` via nodemailer's `icalEvent` with `method: 'REQUEST'` — a calendar invite in the
  reminder email is exactly what this audience needs. Skip its unbounded render cache.

Explicitly **not** in v1: Telegram, Bluesky DM, webhooks. atproto-notify has all three and
they're fine; they're not what a Boulder free school needs first.

### Delivery policy

- **At-least-once with idempotent handlers**, per contrail's outbox contract. Upsert and
  delete by URI; never increment.
- **Per-channel permanent-vs-transient reaping.** atproto-notify's `reapIfDead` is pure
  policy and freely reimplementable: push 404/410 → delete the subscription; email ≥400
  except 429 → stop retrying but **keep** the target so the user can fix the address; 429 and
  5xx → retry with backoff. The asymmetry matters — deleting an email target on a bounce
  loses the user's only channel.
- **Rate limits:** per-(recipient, category) caps, starting from atproto-notify's 1/sec +
  100/day per pair; plus email caps per recipient/day and a global daily cap, because a
  cooperative relay has a quota we're borrowing. Apply caps **before** any write, and make a
  multi-key check all-or-nothing so a blocked global cap doesn't burn the per-recipient slot.
- **Bound every tick** and release the dedup claim on a 429 (atmo: `MAX_SENDS_PER_TICK = 40`,
  a 429 stops the tick).
- **Harden every outbound URI at the single send boundary** — reject non-`http(s)` schemes
  and over-long URLs. atproto-notify's reasoning applies to us identically: the URI becomes
  an `href` in an inbox and in an email, so a `javascript:` URI is stored XSS on our origin.
- **Anonymous host feedback:** `feedback.received` must carry no actor, no handle, and no
  back-reference that could deanonymise the sender. One line of policy, easy to get wrong
  once the notification payload starts carrying "actors" for avatars.

### Consent

We don't need atproto-notify's grant model in v1 — we are one app, the recipient is our
user, and consent is "you enabled notifications in settings" plus a verified channel. But
**keep the shape** (per-(user, category) routes resolved bottom-up, missing-row-means-inherit,
`off`/`inbox` sentinels), because it's correct and because it's what we'd need the day we
want to emit through a relay.

### The later door, left open

If cross-app notifications become worth it: adopt `pub.atmo.notify.*` as a **client** —
atmo-events' `lib/notify/*` is MIT and is a 7-file working reference — and ask flo-bit for
two things: **(a) add a licence to atproto-notify**, and **(b) add our DID to
`apps/relay/src/lib/apps.ts`** so we can receive `subscriberChanged`. Both are asks, not
blockers, precisely because we're self-hosting the path that matters. Worth raising now
while issue #78 is live: the licence question is a two-minute fix for flo-bit and it
unblocks everyone, not just us.

---

## Sources

**Repositories, read at fixed commits** (clones retained under
`…/scratchpad/research/r6_prior-art/`):

- `flo-bit/atmo-events` @ `ed2fb4279a6ddec7c8c58380747463e9d15b725f` — MIT, 2026-08-19.
- `flo-bit/atproto-notify` @ `4cc3ba7876dd6ed11410d3403c1d07967f171a37` — unlicensed, 2026-05-26.
- `flo-bit/contrail` @ `09e4f77552c3bb2591fe354e99bf1b546e0a0d39` (main, v0.23.0) — MIT, 2026-09-02.
- `flo-bit/contrail` PR #95 @ `8de9ba01db1cea1b4f370bddf3fd909d74c55b76` (branch `pr-95`, v0.18.0) — 2026-08-27, still OPEN.
- `OpenMeet-Team/openmeet-api` @ `8fd54d90ef199c5f7e0d3b7a7624fb4481b72028` (v1.5.0) — Apache-2.0, 2026-09-05.

**Key files cited** (paths relative to each clone root):

- atmo-events: `apps/web/src/lib/contrail.config.ts`; `apps/web/src/routes/api/cron/+server.ts`; `apps/web/src/lib/atproto/server/oauth.ts`; `apps/web/src/lib/atproto/settings.ts`; `apps/web/src/lib/spaces/{config.ts,server/client.ts,server/spaces.remote.ts}`; `apps/web/lexicons/generated/rsvp/atmo/space/*.json`; `apps/web/lexicons/pulled/community/lexicon/calendar/{event,rsvp}.json`; `packages/ui/src/editor/{adapter.ts,save.ts,RecurringModal.svelte}`; `packages/ui/src/EventRsvp.svelte`; `packages/ui/package.json`; `.impeccable.md`.
- atproto-notify: `apps/relay/migrations/0001_init.sql`; `apps/relay/src/{router.ts,ratelimit.ts,well-known.ts,index.ts}`; `apps/relay/src/xrpc/{send.ts,requestPermission.ts,setRouting.ts,manage.ts}`; `apps/relay/src/auth/{verifier.ts,sender.ts,user.ts,management.ts,appLogin.ts,relay-signer.ts}`; `apps/relay/src/delivery/{dispatcher.ts,webpush.ts,push-crypto.ts,email.ts,telegram.ts,bluesky-dm.ts,webhook.ts,channel.ts,limits.ts}`; `apps/relay/src/lib/apps.ts`; `apps/relay/src/rpc/{entrypoint.ts,ops.ts}`; `apps/relay/wrangler.toml`; `apps/web/src/lib/push.ts`; `apps/web/src/service-worker.ts`; `packages/lexicons/lexicons/pub/atmo/notify/*.json`; `packages/lexicons/src/rpc.ts`; `docs/{SELF-HOSTING,MANAGEMENT-AUTH,CROSS-APP-AUTH,ENABLE-FROM-WEB,REDESIGN,DEVELOPMENT}.md`; `todo.md`; `apps/homepage/static/llms.txt`.
- contrail (main): `packages/contrail/package.json`; `packages/contrail/CHANGELOG.md`; `packages/contrail/src/core/{sources.ts,pds-snapshot.ts,jetstream-source.ts,ingest.ts,backfill.ts,types.ts,service-auth.ts,bootstrap.ts}`; `packages/contrail/src/service-auth-contract.ts`; `packages/contrail/src/adapters/{postgres.ts,sqlite.ts,alluvium.ts}`; `README.md`; `docs/advanced/outbox.md`.
- contrail (pr-95): `docs/experimental-spaces-alpha.md`; `packages/contrail-spaces-alpha/{README.md,package.json}`; `packages/contrail-spaces-alpha/src/{protocol.ts,sync.ts,storage.ts,crypto.ts,uri.ts,worker.ts,consumer.ts,index.ts}`; `packages/contrail-spaces-alpha/tests/*.test.ts`; `packages/contrail/src/core/isolated-projection.ts`; `packages/contrail/tests/isolated-projection.test.ts`; `apps/spaces-demo/src/routes/+page.server.ts`; `apps/spaces-demo/src/lib/{constants.ts,lexicons.ts,server/{auth.ts,spaces.ts}}`; `apps/spaces-demo/{worker.ts,wrangler.jsonc}`; `patches/*.patch`; `todo/spaces.md`.
- openmeet-api: `src/event-series/infrastructure/persistence/relational/entities/event-series.entity.ts`; `src/event-series/services/{recurrence-pattern.service.ts,event-series-occurrence.service.ts}`; `src/event-series/event-series.service.ts`; `src/event-series/controllers/event-series.controller.ts`; `src/event-series/interfaces/{recurrence.interface.ts,frontend-recurrence-rule.interface.ts,recurrence-frequency.enum.ts}`; `src/event/infrastructure/persistence/relational/entities/event.entity.ts`; `src/event/services/{event-management.service.ts,ical/ical.service.ts,occurrences/event-occurrence.service.ts,event-integration.service.ts}`; `src/event-mail/{event-mail.service.ts,services/event-announcement.service.ts}`; `src/mail/{mail.service.ts,listeners/calendar-invite.listener.ts,mail-templates/**}`; `src/mailer/mailer.service.ts`; `src/pds/{pds-account.service.ts,pds-credential.service.ts,pds-session.service.ts,config/pds.config.ts}`; `src/auth/auth.service.ts`; `src/atproto-identity/{atproto-identity-recovery.service.ts,atproto-identity.controller.ts}`; `src/user-atproto-identity/infrastructure/persistence/relational/entities/user-atproto-identity.entity.ts`; `src/bluesky/bluesky.service.ts`; `src/contrail/{contrail.config.ts,contrail.provider.ts,ingest.ts,sync.ts}`; `src/tenant/tenant.guard.ts`; `src/database/data-source.ts`; `src/main.ts`; `src/database/migrations/1743371499235-RedesignRecurringEvents.ts`.

**GitHub, via `gh`:**

- `flo-bit/atmo-events` issue **#78** "Porting roadmap: OpenMeet features that are not in atmo yet" — tompscanlan, 2026-09-05, OPEN, 4 comments (flo-bit, tompscanlan, teonbrooks, erlend-sh), read in full.
- `flo-bit/atmo-events` issue **#29** "Email notifications" — OPEN, 6 comments including slanos' working fork and tompscanlan's four-point bug review.
- `flo-bit/contrail` PR **#95** "spaces alpha" — OPEN, 61 files, +8304/−23, `mergedAt: null`.
- `flo-bit/contrail` PR **#111** "Merge main (0.23.0) into spaces-alpha so #95 applies again" — OPEN.
- Repo metadata (stars, forks, licence SPDX, pushed-at, open issues) via `gh api repos/{owner}/{repo}` for all four.
- `lexicon-community/lexicon` — `gh api` contents listing of `community/lexicon/calendar/` (exactly `event.json` + `rsvp.json`) and `gh search issues` for `recurrence` / `recurring` (both empty).

---

## Confidence / not verified

**High confidence** (read directly in the source at the stated commits): every licence
determination; all four architectures; atmo's complete recurrence implementation and the fact
that `recurringEventOf` is never read; OpenMeet's series entity, rrule version and
lazy-materialization design; OpenMeet's exceptions-never-read-back bug; OpenMeet's custodial
mint and take-ownership flow; atproto-notify's schema, lexicon surface, rate limits and
transports; atproto-notify's absence of `send` idempotency; PR #95's absence of any
repo-write call; contrail's `relays` → `listReposByCollection` discovery path and its
PDS snapshot source; the contrail 0.13.0 spaces removal.

**Medium confidence — judgements, not facts:**

- The **90-day materialization window** and the **4-occurrence floor** are my
  recommendations, not anyone's measured result. OpenMeet's effective default is 2
  occurrences and atmo's cap is 52; neither published a rationale. Worth revisiting once we
  know real free-school cadences.
- **Deterministic occurrence-sidecar rkeys** are my design, not prior art. I'm confident in
  the idempotency property; I have not checked it against any rkey-format constraint beyond
  the general record-key syntax rules.
- That **`@atmo-dev/events-ui` is importable in practice** — I read its `package.json`,
  `exports` map and peer deps, but did not `pnpm install` it into a fresh project or build
  anything against it. The `@foxui/*` coupling is real but I have not assessed how deep it
  goes per-component.
- That a **`PdsChangeSource` is a tractable build**. The interface is clean and small, but I
  did not implement a spike. Cursor/epoch semantics across many independent PDS hosts
  (each with its own sequence space) is the part I'd expect to be harder than it looks —
  `SourcePosition` has one `cursor` string per source, so a multi-host change source
  probably needs to encode per-host positions into it, or register one source per host.
  **This is the highest-risk item in the plan and deserves a spike before we commit.**

**Not verified:**

- **No network calls to any live service.** I did not hit `relay.atmo.pub`,
  `atmo.rsvp`, `circle.atmo.garden`, `atmosphereemail.org` or any PDS. So: whether the
  deployed atmo.pub relay's `send` lexicon still matches the clone (see the `actors`
  discrepancy below); whether comail/atmospheremail's documented endpoints are current;
  whether `pds.rip` or `selfhosted.social` still accept signups.
- **The `send.actors` wire contract is genuinely ambiguous and I could not resolve it
  offline.** `packages/lexicons/lexicons/pub/atmo/notify/send.json` requires objects
  (`items: {ref: '#actor'}`, `#actor` requires `did`), its own published `llms.txt`
  documents strings, and atmo-events — three months newer — types it `string[]` and sends
  bare handles and DIDs. One of the three is wrong. Probe
  `GET https://relay.atmo.pub/lexicons/pub.atmo.notify.send` before building against it.
- **PR #95's relationship to `bluesky-social/atproto` PR #5187 and proposal 0016.** The
  contrail repo **never mentions either identifier** — I grepped every `.md`, `.ts`, `.json`,
  `.jsonc`, `.svelte` and `.yaml` for `5187`, `0016`, `proposal` and
  `bluesky-social/atproto`. It identifies upstream only as "the permissioned-data proposal"
  and pins a dated snapshot, `@atproto/space@0.0.0-spaces-alpha-20260818163953`. The single
  external link anywhere is historical (`CHANGELOG.md:341`, pointing at dholms' leaflet post
  about the `ats://` scheme, describing a since-removed implementation). **The mapping to
  #5187 / proposal 0016 comes from issue #78's framing, not from the code** — I did not
  verify it, and a reader should not treat PR #95 as a known-faithful implementation of
  those specific documents. Note also that the `ats://` scheme experiment has been
  **reverted**: `pr-95` uses `at://…/space/…`.
- **Whether `@atproto/space@0.0.0-spaces-alpha-*` is publicly installable.** It resolves in
  `pnpm-lock.yaml` with sha512 integrity, so it exists in *some* registry, but I did not
  attempt to fetch it.
- **`tools.atmo.event.space` appearing in both atmo-events and OpenMeet** is interesting —
  it suggests a shared convention or a copied config — but I did not trace which direction
  the borrowing went.
- **Nothing was installed or executed.** No `pnpm install`, no builds, no test runs in any
  of the four repos. Test-coverage claims are from reading test files and counting cases,
  not from observing a green run.
- **Our own NSIDs.** I used `<ns>.calendar.eventSeries` / `<ns>.calendar.eventOccurrence` as
  placeholders. The real namespace and field names belong to the lexicon brief (R2), which
  should also decide whether `exdates` belongs on the series record or in a separate
  exception sidecar — I chose the series record for atomicity with the rule, but a separate
  record would let a co-organizer cancel an occurrence without write access to the series.
  **That tension interacts directly with the app-custody decision and is worth a deliberate
  call.**
- **The MIT-vs-AGPL choice.** Both work. Neither forecloses anything here: MIT deps compose
  with either, and Apache-2.0 flows one-way into AGPL-3.0 while also sitting legally inside
  an MIT repo provided we keep Apache headers on those files and add a NOTICE. The only
  asymmetry worth weighing: if we expect to take substantial OpenMeet code (the custodial
  PDS flow, the mail templates), AGPL keeps the licence story single-valued, whereas MIT
  makes the repo honestly mixed-licence. That's a values call, not a technical one.
