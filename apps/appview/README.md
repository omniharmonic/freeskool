# `@freeschool/appview`

The Free School AppView: the ATProto indexer, the server-side auth/BFF, the app-side
privacy tables, and the jobs. Hono + Drizzle + pg-boss on Node 22, TypeScript ESM.

Author of record: Benjamin Life (@omniharmonic). AGPL-3.0-or-later.

```
src/
  config.ts              env parsing (zod). Nothing else reads process.env.
  contrail.config.ts     the projection: collections, references, relations, outbox, peers
  db/                    Drizzle schema + migrations for the fs_* tables
  index/                 contrail wiring: Postgres adapter, peers, backfill, outbox
  sync/                  where PdsChangeSource plugs in (README + stub). NOT implemented.
  spaces/                PostgresSpaceStore — the v1 backing for the Spaces shim
  lib/                   school-actor, roles, policy, custody, feedback, ics, crypto, pds
  http/                  the Hono app, sessions, OAuth, visibility rules, routes
  jobs/                  materialize-series, reminders, retention, newsletter
  notifications/         dispatch: targets, prefs, dedup ledger, outbox
scripts/
  create-school.ts       mints the school account + school/policy records
  smoke.ts               end-to-end against the live local stack
```

## Run it against the local compose stack

### 1. Start the stack

```bash
# from the repo root
./infra/setup-env.sh
docker compose -f infra/compose.yml -f apps/appview/compose.override.yml up -d
```

The extra `-f` matters. **`infra/pds.env` as shipped cannot create any account**:
it sets `PDS_SERVICE_HANDLE_DOMAINS=.localhost`, but `.localhost` is a RESERVED TLD in
`@atproto/syntax` — `isValidTld` rejects `.local .arpa .invalid .localhost .internal
.example .alt .onion` — and the PDS checks the TLD *before* its own service domains, so
`com.atproto.server.createAccount` fails with
`InvalidHandle: Handle TLD is invalid or disallowed` for every handle. `infra/` is
read-only for this step, so `apps/appview/compose.override.yml` adds `.test` (reserved by
RFC 6761 for exactly this, and not on atproto's disallowed list) as an extra `-f` overlay.

**Recommended fix for `infra/`:** set `PDS_SERVICE_HANDLE_DOMAINS=.test` in
`infra/pds.env` and drop the overlay.

**Also worth fixing in `infra/`:** `PDS_DID_PLC_URL=https://plc.directory` means every local
dev account is published to the *real public* PLC directory, with
`serviceEndpoint: http://localhost:3000`. It works (that is how DID resolution succeeds
locally) but it writes junk to a shared global registry. A local PLC mirror would be
better for development.

### 2. Configure

```bash
cp .env.example .env   # at the repo root
```

Then, beyond `.env.example`:

```bash
PDS_HANDLE_DOMAIN=test              # must match PDS_SERVICE_HANDLE_DOMAINS, no leading dot
SESSION_SECRET=<32+ random chars>
CUSTODY_KEYS=v1:<base64 of 32 random bytes>   # AES-256-GCM key for custodial passwords
CUSTODY_KEY_VERSION=v1
FEEDBACK_BALLOT_PEPPER=<random>
ALLOWED_PRIVATE_PDS_HOSTS=localhost,127.0.0.1  # lets contrail past its SSRF guard locally
```

Generate a custody key with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

### 3. Create the school

```bash
pnpm --filter @freeschool/appview create-school
```

It creates the school account on the PDS with an admin invite code, mints an **app
password** (the account password is never kept), writes `freeschool.draft.school` (rkey
`self`) and a default `freeschool.draft.policy` with Lex's open thresholds, and prints:

```
SCHOOL_DID=did:plc:...
SCHOOL_HANDLE=boulder.test
SCHOOL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
```

Paste those into `.env`. Set `FOUNDER_DID=did:plc:...` first if you want that DID recorded
as the bootstrap steward (the one role that cannot be derived from records).

These two records are the **only** writes in the codebase that use the school's session
directly instead of `SchoolActorPort` — the port authorizes against the policy record,
which does not exist yet. Bootstrap is the only moment that is true.

### 4. Migrate and run

```bash
pnpm --filter @freeschool/appview db:migrate   # fs_* via drizzle, then contrail.init()
pnpm --filter @freeschool/appview dev          # http + jobs on :4000
```

Three independent schemas share the database and migrate independently: our `fs_*` tables
(drizzle), contrail's projection (`contrail.init()`), and pg-boss's `pgboss` schema.
`drizzle.config.ts` pins `tablesFilter: ['fs_*']` so `db:generate` can never propose a
migration against the other two.

`FREESCHOOL_NO_JOBS=1` runs HTTP only.

### 5. A note on the secondary door (sign in with an existing account)

**It cannot work on `http://localhost`, and that is a protocol constraint, not a bug.** A
BFF holds a private signing key, so it must be a *confidential* OAuth client, and
`@atproto/oauth-types` requires a confidential `client_id` to be `https:` with a real
hostname — it rejects `http:` ("URL must use the https: protocol"), rejects an IP literal
("ClientID hostname must not be an IP address"), and RFC 8252 rejects the `localhost`
hostname. The `http://localhost?redirect_uri=...` development form is a *public* client and
cannot carry a keyset.

So with `APPVIEW_PUBLIC_URL=http://localhost:4000`, `/oauth/client-metadata.json`,
`/oauth/jwks.json` and `/api/auth/oauth/start` all answer **503 `OAuthNotConfigured`** with
that explanation rather than a validation dump. Set `APPVIEW_PUBLIC_URL` to an https origin
(a tunnel is fine) to exercise it. `config().oauthUsable` is the single check.

The **primary door** — `POST /api/auth/signup`, a new Free School identity on our own PDS —
has no such constraint and is what local development uses. It is also the door the project
wants people to walk through.

## Smoke test

```bash
pnpm --filter @freeschool/appview smoke
```

It drives the real Hono app in-process (`app.request()` — same routes, middleware and
cookies as a browser) against the **live** local PDS and Postgres. Nothing is mocked. Set
`SMOKE_SKIP_BACKFILL=1` to skip step 8, which is slow.

Output from the run of record:

```
Free School AppView smoke test
PDS      http://localhost:3000
Postgres postgres://***@localhost:5434/freeschool
    ok  migrations applied (fs_* via drizzle, contrail schema via contrail.init())
[1] create the school
    ok  school handle school-78y49.test
    ok  school did did:plc:sunna5nvj7rekdy6gzvlmm5y
    ok  school record at://did:plc:sunna5nvj7rekdy6gzvlmm5y/freeschool.draft.school/self
    ok  policy record at://did:plc:sunna5nvj7rekdy6gzvlmm5y/freeschool.draft.policy/3mveklrfp3c2s
    ok  health ok (postgres ok, pds ok)
[2] create a custodial member (primary door: email -> minted identity)
[appview] custodial account minted handleDomain=test
    ok  host handle openotter340.test
    ok  host did did:plc:kvmrjc5wznhhc5qmhwg4dnhy
    --  handle is generated, never derived from the email
    ok  derived role 20 (Host) from the default open policy
[3] publish a class as the host
[appview] school action action=publish-event decision=allow nsid=com.atproto.repo.putRecord
    ok  event    at://did:plc:kvmrjc5wznhhc5qmhwg4dnhy/community.lexicon.calendar.event/3mveklseigk2r
    ok  config   at://did:plc:kvmrjc5wznhhc5qmhwg4dnhy/coop.lexicon.event.config/3mveklsf4ws25
    ok  listing  at://did:plc:sunna5nvj7rekdy6gzvlmm5y/coop.lexicon.event.listing/3mveklsfjn22u  (written as the school via SchoolActorPort)
[4] three members RSVP (app-side only, no public record)
[appview] custodial account minted handleDomain=test
[appview] custodial account minted handleDomain=test
[appview] custodial account minted handleDomain=test
    ok  3 RSVPs recorded in fs_rsvp; zero community.lexicon.calendar.rsvp records written
    ok  visibility: public sees "North Boulder"; an RSVP sees the street address
[5] the host attests attendance
    ok  3 attendance rows in fs_attendance (no freeschool.draft.attendance records written)
[6] three anonymous feedbacks, then the k-anonymous summary
    --  before any feedback: released=false count=0
    --  after 1 of 3: released=false count=1  (k=3)
    ok  a second ballot from the same member is refused (409 AlreadyVoted)
    ok  summary released: count=3 positive=2 negative=1 k=3
    ok  free text withheld (textK=5, only 3 ballots)
    ok  summary contains no DIDs and no free text
[7] list the public calendar (indexed by read-your-writes notify)
    ok  calendar: 5 listed event(s); ours is "Sourdough for beginners (78y49)" in North Boulder
    --  indexed by contrail.notify() immediately after each write — no firehose involved
    ok  .ics served: text/calendar; charset=utf-8, 21 lines, full address included
    ok  .ics for an anonymous viewer carries only the neighborhood
[8] index from the peer registry (the liveness floor until PdsChangeSource exists)
[contrail] discovering users…
[contrail]   discovered 0 users
[contrail] backfilling…
[contrail]   0 records | 1/5 users
[contrail]   interrupted: 0 known accounts still need an initial attempt (56.6s)
    --  backfill: discovered=0 backfilled=5 seededByListReposFallback=432 identitiesPinned=27
    --  discovered=0 is expected: the reference PDS does not serve listReposByCollection (see README)
    ok  a full peer backfill is idempotent: the class is still listed exactly once
    ok  host notifications: feedback.received, feedback.received, feedback.received, rsvp.received, rsvp.received, rsvp.received
    ok  feedback.received notifications carry no actor
    ok  audit: 1 SchoolActorPort call(s), all with a written reason
SMOKE PASSED in 61.8s
```

Notes on that output:

- `discovered=0` in step 8 is expected and is the contrail divergence below: the reference
  PDS does not serve `com.atproto.sync.listReposByCollection`, so `listRepos` seeds the work
  queue instead (`seededByListReposFallback=432`, `identitiesPinned=27`).
- `backfilled=5` is small because step 7 already indexed everything through
  `contrail.notify()`. The backfill is re-run to prove it is idempotent.
- Step 8 takes about a minute: contrail's bulk pass walks every (repo x collection) pair on
  the host, and a dev PDS accumulates repos across runs.
- Each run creates five real accounts on the PDS (one school, one host, three learners) and
  therefore five DIDs in the public PLC directory. See the infra note above.

## Where contrail's real API diverged from the brief

Verified against `@atmo-dev/contrail@0.23.0` (MIT) as published.

1. **No `docs/` directory.** The published tarball is `dist/` + `README.md` + `LICENSE`
   (68 files). The 406-line README and the bundled `.d.ts` files are the whole of the
   documentation; there is nothing to read in `node_modules/@atmo-dev/contrail/docs`.

2. **`contrail init --prefix community.lexicon.calendar.` fails today.** It needs a fully
   verified, fully indexed catalogue snapshot from `https://lex.atmo.tools`, and that
   service currently answers
   `LexiconRegistryError: Lexicon catalog indexing is incomplete: 35 backfills exhausted`
   (`code: IncompleteIndexing`). `--allow-partial` does not help: missing required
   dependencies always fail. So no lexicons are pinned and **no collection sets
   `validate: true`** — that option requires a pinned runtime bundle which we cannot
   generate. `community.lexicon.calendar.*` shapes were taken from
   `lexicon-community/lexicon` directly; the `coop.lexicon.*` shapes are not public
   anywhere we could find and are documented as explicit assumptions in
   `src/lexicons/coop.ts`.

3. **`com.atproto.sync.listReposByCollection` is the load-bearing assumption behind
   "`relays` as a peer registry", and the reference PDS does not serve it.** The brief says
   a PDS serves it; `@atproto/pds@0.5.34` does not. The request falls through to the PDS's
   AppView proxy and returns `401 AuthMissing` (the same response as any unimplemented
   method). `com.atproto.sync.listRepos` *is* served and public.

   Everything else about the peer registry is exactly as described: `config.relays` is only
   ever used as a list of hosts to `GET /xrpc/com.atproto.sync.listReposByCollection`, with
   no relay protocol involved, so it really is a PDS list. We therefore added
   `src/index/discovery-fallback.ts`: for any peer that fails a `listReposByCollection`
   probe, enumerate with `listRepos` and seed contrail's own `backfills` table in contrail's
   own shape. `contrail.backfill()` then proceeds unchanged. For peers listed in
   `ALLOWED_PRIVATE_PDS_HOSTS` we also pin `identities(did, handle, pds)` from the host's own
   `describeRepo`, which skips two slow remote round trips (Slingshot, then PLC) per DID;
   this is deliberately *only* for explicitly trusted hosts, because taking an arbitrary
   peer's word for "I host this DID" would let it inject records attributed to someone
   else's repo.

4. **`ChangeSource` is exported from the package root, not `core/sources.ts`.** There is no
   `core/` path in the published artifact — only a bundle — so
   `import type { ChangeSource } from '@atmo-dev/contrail'` is the import. The brief's
   reference to `core/sources.ts` matches the upstream repository layout, not the package.

5. **The outbox is `changes.consumers`, exactly as briefed**, and `initial: 'future'` works
   as described. Two details the brief does not mention: the consumer must be `register()`ed
   before it can be claimed, and the low-level API is
   `claim -> hydrate -> ack | fail({code, nextAttemptAt})` with a lease, where `fail` only
   ever persists a bounded category and never the upstream error.

6. **Per-collection tables carry no `collection` column** (`records_<short>` has
   `uri, did, rkey, cid, record, time_us, indexed_at` plus generated count/FTS columns) —
   the table *is* the collection. Any hand-written SQL that wants a whole `RecordRow` has to
   supply it as a literal. Placeholders in `db.prepare()` are `?`, rewritten to `$n` by the
   Postgres adapter, and `record` always comes back as a JSON **string** even though the
   column is `jsonb`.

7. **`contrail.ingest()` is Jetstream-only.** It speaks Bluesky Jetstream v2 and checkpoints
   an instance-local `seq`. On a peered/private deployment that is pure cost, so live ingest
   is behind `CONTRAIL_LIVE_INGEST` (default off) and `src/sync/README.md` documents the
   hole.

`relays` as the peer registry, the Postgres adapter
(`createPostgresDatabase(pool)`), `references`/`relations` for sidecars, `listRecords`
backfill, and the transactional outbox all behave as the brief describes.

## What is stubbed

| thing | where | why |
|---|---|---|
| `PdsChangeSource` | `src/sync/pds-change-source.stub.ts` — throws `not implemented` | a later step adds it; `src/sync/README.md` documents the interface, the per-host cursor-map problem, the `mark()` trick `subscribeRepos` forces, and the wiring point. The cursor-map codec (`encodeCursorMap` / `decodeCursorMap` / `cursorMapReached`) is real and already testable. |
| `takeOwnership` | `src/lib/custody.ts` — throws 501 | the four steps are written out. Step 2 is genuinely open: the PDS's own reset flow emails the user (which is what we want) but invalidates the password we are holding mid-flight. |
| newsletter **sending** | `src/jobs/newsletter.ts` | composing is implemented and stores a draft; sending needs a consent table distinct from `fs_notification_target`, MJML templates, an unsubscribe token namespace, and a steward approval. A cron that mails the whole school unattended is not a feature. |
| `coop.lexicon.*` record shapes | `src/lexicons/coop.ts` | documented assumptions, not vendored lexicons — see divergence 2. |
| runtime lexicon validation | `src/contrail.config.ts` | no collection sets `validate: true`; it needs a pinned bundle `contrail init` could not produce. PDS writes also pass `validate: false`, because the PDS cannot resolve `freeschool.draft.*` either. |
| set-role / membership claims | — | `deriveRole` and `SchoolActorPort.authorize` are wired and tested, and `coop.lexicon.membership` is indexed, but nothing writes a membership claim yet. Roles are read live from evidence, which is correct but means the protocol cannot see them. |
| `fs_newsletter` send, appeals, `freeschool.draft.appeal` | — | not in this step's scope. |

## Design decisions worth knowing

**Whose repo does a class live in?** The event, its `coop.lexicon.event.config`, its
`freeschool.draft.skillLevel` sidecars and its `freeschool.draft.series` all go into the
**host's own repo** — for custodial hosts too, because we hold their credential and
authorship is the point. A class is something a person offered; if the school authored it,
leaving the school orphans it.

The **school** writes exactly two kinds of record, both through `SchoolActorPort`:
`coop.lexicon.event.listing` (curation — "this is on our calendar") and materialized series
occurrences. A school removing a listing therefore *structurally* cannot edit or delete the
host's event. If a viewer has no usable credential for their own repo, `POST /api/events`
returns `401 ReauthRequired` rather than quietly publishing as the school.

**The school session exists in one file.** `src/lib/school-actor.ts` is the only module that
reads `SCHOOL_APP_PASSWORD` or holds the school's agent. When Phase 2 swaps
`AppCustodyAdapter` for `ArbiterAdapter`, only that file changes.

**Privacy (R9), concretely.** RSVPs, attendance and feedback are app-side tables, never repo
records, with a per-event opt-in to also write `community.lexicon.calendar.rsvp` into the
member's own repo (default off). No endpoint enumerates members. There is **no request
logger** — a request log is a record of who looked at what — and `src/lib/logging.ts`
scrubs DIDs, emails and AT-URIs from anything that is printed. Every response carries
`Referrer-Policy: no-referrer`.

Feedback anonymity is structural, not procedural: `fs_feedback_ballot` holds only
`(event_uri, hmac(perEventKey, did))`, `fs_feedback` has **no author column at all** and a
`date` rather than a timestamp, and the per-event key is destroyed when the window closes.
After that the link is unrecoverable with the whole database in hand. Raw feedback is
deliberately **not** mirrored into the Spaces shim — the shim stores an `author` beside
every record — but the published aggregate is, authored by the school, so the migration path
to real Spaces stays on the live code path.

**Recurrence.** 90-day horizon, a floor of at least 4 occurrences so a monthly series is
never an empty calendar, an 18-month ceiling so an open-ended `FREQ=YEARLY` cannot write
unbounded records, `exdates` removed from the expansion rather than cancelled afterwards,
and a deterministic rkey `hash(series rkey + originalStartsAt)` so a re-run, two workers, or
a widened window all converge instead of duplicating.

## Endpoints

```
GET    /api/health
GET    /oauth/client-metadata.json      GET /oauth/jwks.json      GET /oauth/callback
POST   /api/auth/signup                 GET /api/auth/verify?token=
GET    /api/auth/oauth/start?confirm=1  POST /api/auth/logout     GET /api/auth/me
GET    /api/calendar?from&to&school
GET    /api/events/:id                  GET /api/events/:id.ics   POST /api/events
GET    /api/events/:id/feedback-summary
POST   /api/events/:id/attendance       GET /api/events/:id/attendance
POST   /api/rsvp    DELETE /api/rsvp    GET /api/rsvp?eventUri=
GET    /api/requests  POST /api/requests  POST /api/requests/:id/claim
GET    /api/skills    GET /api/skills/:id
POST   /api/feedback
GET    /api/me        PUT /api/me/skill-claims   GET /api/me/skill-claims
GET    /api/admin/policy      PUT /api/admin/policy
GET    /api/admin/moderation  POST /api/admin/moderation
POST   /api/admin/moderation/:id/approve   POST /api/admin/moderation/:id/execute
GET    /api/admin/peers       PUT /api/admin/peers
GET    /api/admin/newsletter  POST /api/admin/newsletter
POST   /api/push/subscribe    DELETE /api/push/subscribe   GET /api/push/vapid-public-key
GET    /api/notifications     POST /api/notifications/read
GET    /api/notifications/prefs  PUT /api/notifications/prefs
```

`:id` is a URL-encoded AT-URI. `GET /api/auth/oauth/start` returns **428** without
`?confirm=1`: bringing an existing identity in permanently ties everything you host to it,
so the PWA must confirm first and this endpoint refuses to be the accident.

## Tests

```bash
pnpm --filter @freeschool/appview test
```

63 tests, 6 files. Four are pure; two need a real Postgres at `DATABASE_URL` (default
`postgres://freeschool:freeschool@localhost:5434/freeschool`) and **skip with a clear
message** if it is unreachable, so `pnpm test` works without Docker.

| file | what it pins |
|---|---|
| `roles.test.ts` | policy thresholds feeding `deriveRole`; `AppCustodyAdapter` gating on the result, including the destructive-action approval threshold and the mandatory reason |
| `ics.test.ts` | RFC 5545 output, determinism, escape ordering, 75-**octet** folding without splitting a multi-byte character |
| `calendar-visibility.test.ts` | what is listed at all, what each viewer relation sees, and that a school removal beats the host's own config |
| `feedback-ballot.test.ts` | the author is never stored with the text — asserted against `information_schema` — plus ballot unlinkability, double-vote refusal, and key destruction |
| `reminders.test.ts` | the due window is exactly `[target, target + 30min)`, closed-open so adjacent windows cannot both match, and never after the event starts |
| `postgres-space-store.test.ts` | `spaces-shim`'s own memory suite re-pointed at Postgres, plus the cases only a database can get wrong |
