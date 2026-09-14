---
title: "Free School — multi-school (multi-city) design"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-13
status: design only — no code in this phase
version: "0.1"
---

# Free School — multi-school (multi-city) design

*Benjamin Life (@omniharmonic) · 2026-09-13 · refinement phase, task 17. Written to spec §4.7 of `docs/superpowers/specs/2026-09-13-refinement-phase-design.md`. Companions: `docs/architecture.md`, `docs/prd.md` §4.1 (11, 14), `docs/interop-audit.md`, `docs/deployment.md`. **Nothing here is built in this phase.** It is built later, on its own branch, after the core infrastructure work lands.*

## 1. Goals and non-goals

### Goals

1. **One AppView, one Postgres, one PDS, many schools.** Denver, Fort Collins and Boulder run on the same box from the same deployment, each with its own DID, policy, stewards, calendar and moderation queue.
2. **A member belongs to several schools** with one identity, one sign-in and one skill profile. Moving to another city is joining a second school, not making a second account.
3. **Governance is per school and never platform-wide.** A Boulder steward has zero authority in Denver. There is no super-admin role in the product; the only cross-school power is the operator's, and it stays out of the UI.
4. **R9 holds *between* schools as strictly as between a school and the public.** A Boulder member must not be able to enumerate Denver's roster, read Denver's vouches, or learn that someone they know in Boulder also belongs to Denver.
5. **Boulder migrates with zero downtime** and a flag that can be turned off again.
6. **Federation stays honest.** Two schools co-hosted on one AppView exchange listings through the same public records a genuinely remote peer would use, so "we host both" is an operational fact and never a protocol shortcut — consistent with the tier matrix in `docs/interop-audit.md` §2.
7. **Rename-safe.** Everything below is `freeschool.draft.*`; the Lucian namespace rename stays a find-and-replace (CLAUDE.md, settled).

### Non-goals

- **Multiple AppView deployments.** A community running its own box is the one-click self-host story, out of v1 and out of this document. This is multi-*tenant*, not multi-*instance*.
- **Sharding, per-tenant databases or schemas.** One database, `school_did` columns, one pool. At "a dozen cities and a few thousand people" anything else is cost without benefit.
- **Cross-school reputation.** Roles and badges are derived per school from that school's evidence under that school's policy (CLAUDE.md: derived, never minted). No global standing, no portable rank, no score.
- **Cross-school moderation.** No shared blocklist, no federated labeler, no "removed everywhere" button — not without an explicit governance decision.
- **Billing, tenant plans, metering.** Free School is free.
- **Real Spaces, elections, wiki adapter.** Unchanged from CLAUDE.md.

## 2. Tenancy model

A school stays what `docs/architecture.md` §1 says it is: **a scene, not a server** — a DID that owns a policy, curates listings and holds custody decisions. Multi-school changes only that the AppView stops assuming there is exactly one.

**A school is** a DID, a `freeschool.draft.school` record at `rkey=self` in that DID's repo, a `freeschool.draft.policy` it points at, and a row in a new `fs_school` table carrying the app-side facts (hostnames, credential reference, creation state) that have no business on the record. **A membership is** a row in `fs_membership(did, school_did, …)`, replacing `fs_member`.

### The dividing rule

> **What the member wrote about themselves is global. What a school observed, decided, or was told in confidence is per-school.**

This one rule decides every table in §4, and it falls out of the placement rules we already follow: a member's identity and claims live in their own repo and travel with them (interop audit §3(c), §3(d)); everything a school holds about a member is app-side precisely because it is the school's observation, not the member's statement.

| Concern | Scope | Why |
|---|---|---|
| DID, handle, custodial credentials, email | **global** | one identity; the PDS account is not per-city |
| Member profile (`fs_app_meta profile:<did>`) — display name, bio, avatar | **global** | the member wrote it; re-typing a bio per city is absurd, and a per-city bio would be a per-city persona we have not designed |
| Skill claims (repo records + `fs_skill_claim_index`) | **global** | they are records in the member's own repo; they already travel to any AppView that indexes that repo |
| Skill taxonomy + authority DID | **global** | a shared vocabulary is the entire value; see §6 |
| Notification transports (`fs_notification_target`) | **global** | one push subscription, one inbox |
| Sessions, OAuth state | **global**, with a *current school* | §3, §4 |
| Policy, thresholds, policy cache | **per school** | the school's own rules as data |
| Stewards | **per school** | `fs_steward` already carries `school_did` |
| Roster / directory listing / membership | **per school** | R9's hardest rule |
| Invites and invite links | **per school** | `fs_invite_link` already carries `school_did`; an invite admits you to one school |
| RSVPs, attendance, tallies, feedback | **per school** (via the event) | evidence for a per-school role ladder |
| Moderation queue, audit log | **per school** | a steward sees their own school's case file and no other |
| Peer registry, routing tags, listings | **per school** | each school chooses who it federates with |
| Vouches (`fs_attestation`) | **per school** — see below | a cross-school vouch discloses cross-school membership |
| Skill proposals | **global record, per-school attribution** | §6 |
| Events | **per school by authorship**, cross-listable | §7 |

### The two decisions inside that table that are not obvious

**Vouches are per-school.** The tempting design is global: Ana vouched that Maya can weld, so that ought to be true everywhere. Under R9 it cannot be — rendering a Boulder vouch on Maya's Denver profile tells every Denver member that Maya and Ana both belong to Boulder, a membership disclosure neither made. So `fs_attestation` gains `school_did`, counts are per-school, and no cross-school aggregate exists. The honest cross-school path is already specified: the double opt-in `freeschool.draft.skillAttestation` pair (interop audit §3(d), gap 15), where a vouch both parties published travels everywhere by being a record — an explicit member choice rather than a platform default.

**Directory opt-out is per-membership.** `fs_member_prefs.directoryListing` becomes `fs_membership.directory_listing`. Spec §3 R-1 makes the directory listed-by-default and opt-out; someone who hides in Boulder because they know people there has said nothing about Denver, and a global switch would carry a decision silently from one social context into another.

## 3. URL and DNS scheme

### Recommendation

**Per-school subdomains of the web origin — `boulder.freeskool.xyz`, `denver.freeskool.xyz` — with authentication centralised on the apex `freeskool.xyz`, one shared PDS on one neutral hostname for every school, and custom domains added later as aliases.** Path prefixes are rejected; per-school PDSes are rejected.

### Why not path prefixes (`freeskool.xyz/s/boulder`)

Cheapest by far — no DNS, no certificates, one origin, one cookie, one OAuth client — and they lose on three counts. The PWA's service worker scope, install manifest and `start_url` are per-origin and would all have to become prefix-aware, which is exactly where iOS is least forgiving (`docs/architecture.md` §2.1). Every route, print-zine URL and share link grows a segment whose absence is a 404 rather than a redirect. And a school gets no name of its own to print on a flyer, nor a migration path to `denverfreeskool.org`.

### Why not a PDS per school

The fatal reason is **R9's neutral-hostname constraint**. A DID document is world-readable forever and names its PDS endpoint. One shared PDS means a member's DID document says nothing about which city they belong to; a PDS per school means **every member's DID document permanently discloses their school membership** — the fact §2 and §10 work hardest to protect, leaked where we cannot take it back. (`pds.freeskool.xyz` is already not neutral enough, per `docs/deployment.md`; per-school PDSes make that much worse, not slightly worse.) The operational reason is that it multiplies rotation keys, backups and invite-code admin by N, for a system whose premise is one small VPS.

So: **one PDS, one hostname, one handle domain by default, N school repos on it.** A peer following our PDS host distinguishes the schools by reading each `freeschool.draft.school` record — the Boulder-plus-demo case the interop audit already flags (§3(b)), whose fix is gap 4a. Multi-school turns that gap from a nicety into a requirement: `GET /api/school` becomes `GET /api/schools` and `GET /api/schools/:did`.

### The collision nobody has noticed yet

`infra/production/Caddyfile` today has two site blocks that matter:

```
{$WEB_HOST}                          → the PWA + /api/*        (freeskool.xyz)
{$PDS_HOST}, *.{$PDS_HANDLE_DOMAIN}  → the PDS                 (pds.freeskool.xyz, *.freeskool.xyz)
```

With `PDS_HANDLE_DOMAIN=freeskool.xyz`, **`boulder.freeskool.xyz` currently resolves to the PDS** — it has a member-handle name shape, and it *is* the school account's handle. A naive `<city>.freeskool.xyz` scheme collides head-on with the handle namespace.

The fix is small and worth making even before multi-school. A handle host needs to answer exactly **one** path, `/.well-known/atproto-did`; everything else a PDS serves lives on `{$PDS_HOST}`. So invert the wildcard block:

```
*.{$PDS_HANDLE_DOMAIN} {
	tls { on_demand }
	@www host www.{$WEB_HOST}
	redir @www https://{$WEB_HOST}{uri} permanent
	@handle path /.well-known/atproto-did
	handle @handle { reverse_proxy pds:3000 }   # handle resolution, for every name
	handle { reverse_proxy web_or_appview }     # everything else: the school PWA
}
```

Now `boulder.freeskool.xyz` serves the Boulder PWA *and* still resolves the Boulder school account's handle, and `calmalder301.freeskool.xyz/.well-known/atproto-did` keeps working as it does today. Two consequences:

- **Reserve city labels in the handle generator.** `lib/handles.ts` must refuse to mint a handle whose first label is a live or reserved school slug, and school creation must refuse a slug already taken by a handle. One shared reserved-names table, checked from both sides.
- **On-demand TLS `ask`.** The endpoint at `127.0.0.1:9000` says yes for `www` and defers to the PDS's `/tls-check`; it gains a second deferral — yes for any host in `fs_school_domain` — via a container-local `GET /internal/tls-check?domain=` on the AppView, which is also what custom domains need. It answers from the table and never from a pattern, so Let's Encrypt's 50-certificates-per-registered-domain-per-week ceiling cannot be reached by a runaway ask.

### Cookies, OAuth and the current school

The session cookie is `fs_session` on the apex with `Path=/`. Under subdomains, set `Domain=.freeskool.xyz` so one sign-in is one identity across every city — otherwise §1.2 is a lie the first time someone joins a second school. The widened scope is acceptable because every host under it is ours and served by the same AppView; it keeps `HttpOnly; Secure; SameSite=Lax` and depends on the reserved-names rule above (handles are PDS-issued names, not member-served origins).

**OAuth must stay on one origin.** `config.ts` derives `oauthClientId` as `${APPVIEW_PUBLIC_URL}/oauth/client-metadata.json`, and a confidential client's `client_id` *is* its metadata URL, with `redirect_uri` on the same origin. One client per city would mean N metadata documents, N key registrations and a confusing consent screen. Instead: **the apex is the front door.** `freeskool.xyz` serves sign-in, sign-up, the OAuth dance and the school picker; the callback lands there, sets the domain-scoped cookie, and redirects to the subdomain the member came from (carried in `state`, validated against `fs_school_domain`, never reflected raw).

**Current school** is a server-side session field, never a cookie or a URL parse: `fs_session.current_school_did`, set from the `Host` header when that host maps to a school the viewer belongs to and otherwise from the session's last value, with `?school=<did>` as an explicit override for tooling and the apex's cross-school views. A request for a school the viewer does not belong to gets the *public* projection — the same one a stranger gets — never a 403 that confirms a private form of the school exists.

### Custom domains

`boulderfreeskool.org` becomes an `fs_school_domain` row with `kind='alias'`: the ask endpoint says yes, Caddy issues a certificate on demand, and the alias 301s to the canonical `boulder.freeskool.xyz`, so there stays exactly one cookie origin and one OAuth origin. Serving a custom domain as a full origin is a later phase; the redirect is a day's work and gets a city its name in print.

## 4. Data model, table by table

### New tables

```sql
CREATE TABLE fs_school (
  did               text PRIMARY KEY,
  slug              text NOT NULL,                -- 'boulder'; the subdomain label
  name              text NOT NULL,
  region            text,
  handle            text NOT NULL,                -- boulder.freeskool.xyz
  pds_url           text NOT NULL,                -- shared PDS by default
  custody           text NOT NULL DEFAULT 'app',  -- 'app' | 'external'
  status            text NOT NULL DEFAULT 'active', -- 'provisioning'|'active'|'archived'
  created_by_did    text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX fs_school_slug_idx ON fs_school (slug);

CREATE TABLE fs_school_domain (
  host        text PRIMARY KEY,                   -- boulder.freeskool.xyz | boulderfreeskool.org
  school_did  text NOT NULL REFERENCES fs_school(did),
  kind        text NOT NULL,                      -- 'canonical' | 'alias'
  verified_at timestamptz
);

CREATE TABLE fs_membership (
  did               text NOT NULL,
  school_did        text NOT NULL REFERENCES fs_school(did),
  door              text NOT NULL,                -- from fs_member
  directory_listing boolean NOT NULL DEFAULT true,
  public_role       boolean NOT NULL DEFAULT false,
  onboarded_at      timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  left_at           timestamptz,
  PRIMARY KEY (did, school_did)
);
CREATE INDEX fs_membership_school_idx ON fs_membership (school_did, last_seen_at DESC);

CREATE TABLE fs_school_credential (                -- §5
  school_did   text PRIMARY KEY REFERENCES fs_school(did),
  identifier   text NOT NULL,                      -- handle or DID used to log in
  key_version  text NOT NULL,
  wrapped      bytea NOT NULL,                     -- AES-256-GCM under CUSTODY_KEYS
  rotated_at   timestamptz NOT NULL DEFAULT now(),
  last_ok_at   timestamptz,
  last_error_at timestamptz
);

CREATE TABLE fs_event_school (                     -- which school a class was created in
  event_uri  text PRIMARY KEY,
  school_did text NOT NULL REFERENCES fs_school(did)
);
```

`fs_event_school` is the one genuinely new concept. Today calendar membership is decided by authorship (`visibility.ts#calendarInclusion` over `roles.ts#isOwnMember`), which works because "our member" and "our school" are the same set. With several schools a host may belong to two, so authorship no longer identifies the calendar. The row is written at creation time from the session's current school; the event record itself is unchanged (sidecar composition only — no field is added to the borrowed event, CLAUDE.md), and cross-listing to another school remains a `coop.lexicon.event.listing` written by that other school (§7).

### Every existing table

| Table | Change | Note |
|---|---|---|
| `fs_session` | **+ `current_school_did`** | nullable; resolved per request from `Host` |
| `fs_oauth_state` / `fs_oauth_session` / `fs_oauth_client_key` | global | one confidential client on the apex (§3) |
| `fs_custodial_account` | global | one identity; handle + email are not per-city |
| `fs_email_verification`, `fs_ownership_reveal` | global | identity lifecycle |
| `fs_member` | **replaced by `fs_membership`**; kept as a view for one release | §9 |
| `fs_member_prefs` | **split**: `directory_listing`, `public_role`, `onboarded_at` → `fs_membership`; nothing else remains, so the table is dropped | per-school by §2 |
| `fs_invite` | **+ `school_did`** | the invite-or-vouch gate is a per-school evidence check |
| `fs_invite_link` | already has `school_did` | redemption grants membership in that school only |
| `fs_skill_tier` | global, **+ `fs_school_skill_tier` override** | §6 |
| `fs_request_rsvp` | per-school **via the request's school**; add `school_did` denormalised | needed to count a threshold within one city |
| `fs_rsvp` | **+ `school_did`** (denormalised from `fs_event_school`) | so a capacity/waitlist query never crosses schools |
| `fs_attendance` | **+ `school_did`** | evidence for a per-school role |
| `fs_attendance_rollup` | keyed by event → implicitly scoped; **+ `school_did`** for retention jobs | |
| `fs_attendance_tally` | **PK becomes `(did, school_did)`** | the single most important change in this table: a global tally would make Boulder attendance grant Denver hosting rights |
| `fs_feedback_window`, `fs_feedback_ballot`, `fs_feedback` | keyed by event; **+ `school_did` on `fs_feedback`** for the host summary query | k-anonymity is computed within one school |
| `fs_audit` | already has `school_did` | add `INDEX (school_did, at DESC)` |
| `fs_moderation_queue` | **+ `school_did`** | `INDEX (school_did, status)` replaces `fs_moderation_status_idx` |
| `fs_steward` | already has `school_did`; **PK becomes `(did, school_did)`** | today `did` alone is the PK, which silently forbids being a steward of two schools |
| `fs_policy_cache` | already keyed by `school_did` | no change |
| `fs_peer` | **PK becomes `(school_did, host)`** | each school federates with whom it chooses; contrail's `relays` gets the union |
| `fs_event_extra` | keyed by event | no column needed; reached only through a school-scoped event |
| `fs_series_occurrence` | keyed by series | the materializer resolves the school from `fs_event_school` of the template |
| `fs_notification_target` / `_pref` | global | one device, one inbox; preferences are per category, not per city |
| `fs_notification_sent` / `_outbox` / `_feed` | **+ `school_did`** | so a feed row can say *which* school, and so a school's notifications can be paused independently |
| `fs_newsletter_issue` | **+ `school_did`** | one monthly digest per city |
| `fs_newsletter_subscription` | **PK becomes `(did, school_did)`** | subscribing to Boulder's digest is not subscribing to Denver's |
| `fs_skill_claim_index` | **global** | a projection of the member's own claims; §2 |
| `fs_attestation` | **+ `school_did`**, unique index becomes `(attester, subject, skill, school_did)` | §2, §10 |
| `fs_skill_proposal` | **+ `school_did`** (attribution only) | §6 |
| `fs_handoff` | **+ `school_did`** | a steward hand-off is for one school |
| `fs_space` / `_member` / `_record` | `authority` already carries the school DID | the shim is accidentally multi-tenant already |
| `fs_app_meta` | mixed: `profile:<did>` and `skill-claims:<did>` stay global; any school-scoped key becomes `<school_did>:<key>` | audit the key space before the migration |

### Indexes

Every per-school table gets its hot index rebuilt with `school_did` **first**: `(school_did, …)`, not `(…, school_did)`. Tenant filtering is the leading predicate on essentially every query, and a trailing column does not serve it.

### Contrail: one index, many schools

The contrail namespace (`CONTRAIL_NAMESPACE`, `CONTRAIL_ORDERED_SOURCE_EPOCH`) stays **global and singular**. The index is a projection of *repos*, and a repo belongs to a DID, not to a school; two schools may follow the same PDS host, and a member of both must not be indexed twice. Per-school views are computed at read time from `fs_event_school`, listings and authorship. Splitting the index per school would duplicate every shared repo and double the sync sockets for no gain.

## 5. School actor: one port per school

`SchoolActorPort` is already multi-school in its interface — **every method takes `schoolDid`** (`packages/school-actor/src/port.ts`). What is single-school is the wiring in `apps/appview/src/lib/school-actor.ts`: one module-scoped `port`, one `AppPasswordSchoolSession` built from `config().SCHOOL_HANDLE`/`SCHOOL_APP_PASSWORD`, and `schoolDid()` reading the env. That is the whole change.

```ts
// apps/appview/src/lib/school-actor.ts (sketch)
const ports = new Map<Did, { port: SchoolActorPort; at: number }>()
const TTL_MS = 30 * 60_000

export async function schoolActor(schoolDid: Did): Promise<SchoolActorPort> {
  const hit = ports.get(schoolDid)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.port
  const cred = await loadCredential(schoolDid)          // fs_school_credential
  const port = new AppCustodyAdapter({
    roles, policy,                                       // already take schoolDid
    audit: new PostgresAuditSink(),
    session: new AppPasswordSchoolSession(cred.identifier, cred.password, cred.pdsUrl),
    pdsEndpoint: cred.pdsUrl,
  })
  ports.set(schoolDid, { port, at: Date.now() })
  return port
}

export function evictSchoolActor(schoolDid: Did): void { ports.delete(schoolDid) }
```

**Credentials move from env to `fs_school_credential`**, wrapped with the existing `wrapSecret`/`unwrapSecret` (`lib/crypto.ts`) under the versioned `CUSTODY_KEYS` — the same AES-256-GCM envelope custodial passwords use, so rotation re-wraps rather than resets and there is no second key-management story. The plaintext exists only inside `AppPasswordSchoolSession`; nothing else may read the column, exactly as nothing else may read `SCHOOL_APP_PASSWORD` today (R3 invariant 1).

**Cache and eviction.** Keyed by school DID, bounded (LRU cap ~64 alongside the TTL — an unbounded map is still a leak). Evicted on TTL, credential rotation, persistent auth failure and school archival. The existing per-session 401 retry stays.

**Isolation.** A school whose credential is revoked fails only its own writes: `loadCredential` throwing is caught at the call site, surfaced as the port's own deny envelope, `last_error_at` stamped, and a steward-visible banner says this school cannot write to its repo right now. Today the same failure takes the process's only actor down.

**Rotation.** `scripts/rotate-school-credential.ts <school-did>`: log in with the current app password, `createAppPassword` a new one, write the wrapped blob, evict the cache, verify with a no-op `describeActor`, revoke the old one. Idempotent, and safe with the app up because the new password is live before the old one dies.

**Bootstrap.** `SCHOOL_DID`/`SCHOOL_HANDLE`/`SCHOOL_APP_PASSWORD` become the *import* path: at boot, if they are set and `fs_school` has no row for that DID, the values are inserted and wrapped with a log line. That is what makes Boulder's migration (§9) a no-op for the operator.

## 6. Taxonomy: one authority, many proposers

**Skills are never school-scoped.** The taxonomy is a shared vocabulary anchored to ESCO and Wikidata; its value is that a claim made in Boulder resolves to the same node in Denver, or in a peer AppView that has never heard of us (interop audit §3(d)). A per-school skill would be an at-uri under a school DID nobody else can interpret, and would fork the tree on day one. So: **one authority DID, one `freeschool.draft.skill` collection, `rkey = slug`, unchanged.** What becomes per-school is everything *around* the tree:

- **Proposal attribution.** `fs_skill_proposal` gains `school_did` beside `proposer_did`. Neither reaches the record — spec §3 R-6 already keeps the proposer app-side, and a school named on a record it did not write is the same R9 problem in a different costume. The record stays `{id, label, broader, status: "proposed"}` written by the authority; who asked, and where, is ours.
- **Per-school visibility.** `fs_school_skill(school_did, skill_id, state)`, `state ∈ {hidden, featured}`, keeps a city's picker legible without forking anything. Default: everything visible, so a new school inherits the whole tree.
- **Tier B overrides.** `fs_skill_tier` is the global floor; `fs_school_skill_tier(school_did, skill_id, tier)` may **raise** a skill to Tier B for one school and never lower it. A city in a different legal climate can be more careful; none can be less careful than the platform default. Effective tier is `max(global, school)` in one helper, so no route can get it wrong.
- **Steward actions.** Deprecate and move are authority-wide and therefore stay *operator* actions — a Boulder steward retiring a proposed skill would be editing Denver's vocabulary. Spec §3 R-6's steward "retire" becomes "hide it here" (`fs_school_skill.state='hidden'`); removal from the tree escalates to the taxonomy operator. That is a real reduction in steward power, flagged in §12.

## 7. Calendar exchange: between schools, and with COhere

### Between two schools we host ourselves

**The rule: co-hosted schools federate through records, not through the database.** When Denver lists a Boulder class, Denver's `SchoolActorPort` writes a `coop.lexicon.event.listing` into *Denver's* repo pointing at the host's event with a full strongRef (`{uri, cid}` — interop audit gap 3). Nothing short-circuits that with a direct row insert, for three reasons: a remote peer sees exactly what we see; a steward's removal is a real, propagating record; and the day a city leaves our box, nothing about its published history changes.

Mechanically this is a small generalisation. `routesOnTags` (`lib/events.ts:167`) already matches an event's config tags against `freeschool.draft.school#tags` with `DEFAULT_ROUTING_TAGS` as the fallback; it takes a school's tags as an argument instead of the singleton's. `routeListing` is then called once per **subscribing school**: the originating school (always, per `fs_event_school`) plus every school whose routing tags match and that has the originator in its peer list. `decideListingEdit`'s sticky removal stays per school — Denver removing a class from Denver's calendar must not remove it from Boulder's.

Two hazards:

- **Listing loops.** A school must never list a class *because* a peer listed it. Inclusion is authorship plus tag routing from the originator, never the presence of a peer's listing — already true at `http/visibility.ts:104-111`, and it must survive the generalisation.
- **Duplicate occurrences.** The materializer writes occurrences into the *school's* repo. Only the **originating** school materializes; peers list the originator's occurrences. Otherwise every recurring class multiplies by the number of subscribing schools.

### With COhere

Unchanged in shape (PRD §4.1 item 11, F12): tag-routed listing exchange. What changes is plurality. COhere follows our PDS host and finds several school repos; it needs `GET /api/schools` (gap 4a, generalised) to answer "who are you and what do you route on?" per school. Each school publishes its own `#tags`, so Boulder can route `skillshare` while Denver routes `skillshare, mutual-aid` with no coordination.

The new interop question is **double-listing**: a class listed by both Boulder and Denver appears twice on COhere unless COhere dedupes on the event strongRef rather than the listing. That is a question for the COhere mail (§12); our side is cheap — never two listings for one event from one school, and the listing's `event` ref is the stable identity.

What a peer reads from us is the tier matrix in `docs/interop-audit.md` §2, per school repo, with one addition and no subtractions: the school record's `peers` array becomes per-school and maintained (gap 4b), which is what makes federation transitive. Everything in the "Not published" column stays not published — and §10 adds that it stays unreadable *across* schools inside our own database too.

## 8. Onboarding a new city

### The flow

```
POST /api/schools { slug, name, region, handleDomain?, identity: 'hosted'|'byo' }
```

1. **Gate.** `SCHOOL_CREATION`: `closed` (operator only, the initial default), `invite` (a school-creation code minted by the operator), `open`. Self-service creation under our domain is a reputational surface — anyone could mint an ugly name at a `freeskool.xyz` hostname — so it starts closed and opens on Benjamin's call.
2. **Reserve the slug** against both `fs_school.slug` and the handle reserved-names table (§3).
3. **Mint or adopt the identity.** *hosted*: create the school account on the shared PDS with handle `<slug>.<PDS_HANDLE_DOMAIN>`, exactly as `scripts/create-school.ts` does now, mint an app password, wrap it into `fs_school_credential`. *bring your own*: the founder supplies a DID and an app password for it (later OAuth, later still the Arbiter); `custody='external'`, `pds_url` resolved from the DID document. Same port, same audit, different repo.
4. **Write the founding records** — `freeschool.draft.policy` (default thresholds, default text with this school's name) then `freeschool.draft.school` at `rkey=self` pointing at it. This stays the one documented exception to the port (it authorizes against a policy that does not exist yet), confined to this flow.
5. **Appoint the founder steward** — `fs_steward(did, school_did)` plus a `fs_membership` row for the creator. This is the meaningful change from today: `scripts/appoint-steward.ts` exists because the first steward is deliberately an operator action on the host, and that does not scale to a dozen cities. *The person who created the school is its first steward*, and step 1's gate is what makes that safe.
6. **Provision the hostname** — `fs_school_domain(host='<slug>.freeskool.xyz', kind='canonical')`; Caddy mints the certificate on first request through the ask endpoint. No reload, no deploy.
7. **Seed** — policy cache, skill tiers (already global), nothing else. A new school starts empty on purpose.

### Policy defaults

`defaultThresholds` from `@freeschool/shared` — hosting open on day one — plus the existing default policy text with the school's name substituted. `STRICT_THRESHOLDS` applies until the policy record has been read successfully once (`lib/policy.ts`), which is right for a school whose PDS write may still be propagating.

### What the operator still does by hand

| Task | Why it cannot be self-service |
|---|---|
| Flipping `SCHOOL_CREATION` | a platform-level decision |
| A **custom handle domain** for a city (`*.denverskool.org`) | `PDS_SERVICE_HANDLE_DOMAINS` is PDS container env: editing it needs a compose restart |
| DNS for a custom web domain | the city owns the zone; we publish the target and verify |
| The relay decision (`PDS_CRAWLERS`) | one switch for the whole PDS, all schools at once (interop audit gap 1) |
| Backup sizing, Postgres capacity | one box, N cities |
| Archiving or deleting a school | destructive, and DIDs are forever |

## 9. Migration plan for Boulder

Additive first, backfill second, constrain third, switch last. Every step is independently deployable and the flag is off until the end.

**Phase A — additive schema (no behaviour change).**

```sql
ALTER TABLE fs_rsvp        ADD COLUMN school_did text;
ALTER TABLE fs_attendance  ADD COLUMN school_did text;
-- …one per table in §4; all nullable, no defaults, no rewrites
CREATE TABLE fs_school (…); CREATE TABLE fs_membership (…); CREATE TABLE fs_school_credential (…);
```

A nullable column with no default is metadata-only in Postgres — no rewrite, no long lock. Deploy; nothing reads the columns yet.

**Phase B — seed and backfill.**

```sql
INSERT INTO fs_school (did, slug, name, region, handle, pds_url)
VALUES (:school_did, 'boulder', 'Boulder Free School', 'Boulder, Colorado',
        :school_handle, :pds_url)
ON CONFLICT DO NOTHING;

INSERT INTO fs_school_domain (host, school_did, kind)
VALUES ('freeskool.xyz', :school_did, 'canonical');   -- the apex IS Boulder, for now

INSERT INTO fs_membership (did, school_did, door, directory_listing, public_role,
                           onboarded_at, first_seen_at, last_seen_at)
SELECT m.did, :school_did, m.door,
       COALESCE(p.directory_listing, true), COALESCE(p.public_role, false),
       p.onboarded_at, m.first_seen_at, m.last_seen_at
FROM fs_member m LEFT JOIN fs_member_prefs p USING (did)
ON CONFLICT DO NOTHING;

-- batched, so no statement holds a long lock:
UPDATE fs_rsvp SET school_did = :school_did
WHERE school_did IS NULL AND ctid IN (
  SELECT ctid FROM fs_rsvp WHERE school_did IS NULL LIMIT 5000);
```

Every existing row belongs to Boulder, so each backfill is a single constant and takes minutes. The credential import happens here too, from the still-present `SCHOOL_APP_PASSWORD` (§5).

**Phase C — constrain, without a long lock.**

```sql
ALTER TABLE fs_rsvp ADD CONSTRAINT fs_rsvp_school_not_null
  CHECK (school_did IS NOT NULL) NOT VALID;
ALTER TABLE fs_rsvp VALIDATE CONSTRAINT fs_rsvp_school_not_null;   -- SHARE UPDATE EXCLUSIVE
ALTER TABLE fs_rsvp ALTER COLUMN school_did SET NOT NULL;          -- fast: the check proves it
CREATE INDEX CONCURRENTLY fs_rsvp_school_event_idx ON fs_rsvp (school_did, event_uri);
```

`NOT VALID` then `VALIDATE` avoids the full-table `ACCESS EXCLUSIVE` scan; `CREATE INDEX CONCURRENTLY` avoids blocking writes.

**Phase D — the flag.** `MULTI_SCHOOL=0|1`. With `0`, `currentSchool(req)` returns `config().SCHOOL_DID` unconditionally while every new code path still runs — school-scoped queries, the actor registry, per-school policy lookups — against a single tenant. That is the point: the multi-school code is exercised in production for weeks against Boulder alone before a second school exists. With `1`, `currentSchool` resolves from `Host`/session/`?school=` and `POST /api/schools` is reachable.

**Phase E — cut over `fs_member`.** For one release it survives as a view, so any missed read still compiles and returns the truth:

```sql
ALTER TABLE fs_member RENAME TO fs_member_legacy;
CREATE VIEW fs_member AS
  SELECT DISTINCT ON (did) did, door, first_seen_at, last_seen_at FROM fs_membership;
```

The view is read-only, so a *write* still pointed at `fs_member` fails loudly in staging rather than silently hitting a dead table. Drop `fs_member_legacy` one release later, after checking it has not been written to.

**Rollback.** A–C are additive and roll back by doing nothing. D rolls back with `MULTI_SCHOOL=0` — a restart, no data change. E is the only forward-only step, which is why it is last and why the view exists; rolling it back is a rename plus the previous image, and the window is one release long.

**Zero downtime** holds because no step rewrites a table, holds `ACCESS EXCLUSIVE` longer than a catalogue update, or makes old and new code disagree about a column: the old code ignores `school_did`, and the new code with the flag off writes the value the old code implied.

## 10. Security review against R9, per table

The R9 rule stands verbatim: **no public record may name a DID its holder did not write; the roster is never public; moderation reasons are never public.** Multi-school adds one obligation: *another school is the public.* A Boulder member has no more right to Denver's roster than a stranger does.

| Data | What a member of school A may learn about school B | Enforcement |
|---|---|---|
| `fs_membership` | **nothing** — not that a person is in B, not how many people are in B | every directory query filters `school_did = current`; `GET /api/members/:did` returns **404**, not 403, for a DID with no shared school (403 confirms existence) |
| `fs_membership.directory_listing` | nothing | per-membership, §2 |
| `fs_attestation` | nothing — a vouch made in B is invisible in A | `school_did` in the unique index and in every count query; §2's reasoning |
| `fs_rsvp`, `fs_attendance`, `fs_attendance_tally` | counts on a class A can see, and nothing else; a B-only attendance never contributes to an A role | `(did, school_did)` PK on the tally is what makes this true |
| `fs_feedback*` | nothing; k-anonymity is computed within one school, so a small school's k is not helped by a large one's | school-scoped aggregate query |
| `fs_moderation_queue`, `fs_audit` | nothing: not the reason, not the subject, not that a case exists | `requireRole(Steward)` is already per school via `fs_steward(did, school_did)`; the queries gain the filter |
| `fs_invite`, `fs_invite_link` | nothing; a link admits to exactly one school | `school_did` on both |
| `fs_skill_claim_index`, profile, avatar | **global and shared, deliberately** — a member's own statements about themselves, shown to anyone who shares *a* school with them | this is the one intentional cross-school read, and it is safe because the member wrote it; it must still never be a *list*: "who claims welding" is answered only within the viewer's school |
| `fs_event_school`, listings | public per the tier matrix | unchanged |
| Handles, DIDs, DID documents | **that the person has an account on our PDS — never which school** | the shared neutral PDS in §3 is what buys this; per-school PDSes or per-school handle domains would give it away permanently |
| `coop.lexicon.membership` role claims | that a DID consented to be named at role ≥ Host **in a named school** | three gates, now per school: the school's `publishRoles`, the per-membership opt-in, the derived role. The record names the school it belongs to and no other |
| `fs_notification_feed` | only the viewer's own rows | `school_did` lets the UI say which school, and lets one school's notifications be paused |
| `fs_newsletter_subscription` | nothing | `(did, school_did)` PK |

Three further rulings:

1. **No cross-school aggregate is ever rendered.** Not "member of 3 schools", not a global vouch count, not a network leaderboard. A member's own Me screen may list their schools — they already know; no other view may.
2. **The school picker shows the schools you belong to, plus publicly discoverable ones.** A school's *existence* is public (its record is on the network); its *membership* is not. `GET /api/schools` returns public school records and never member counts.
3. **`privacy-audit.ts` becomes per-school and loops.** It already accepts `options.schoolDid` and builds a `schoolDids` set (`scripts/privacy-audit.ts:449-450`). It runs once per school and adds two cross-tenant assertions: no scoped `fs_*` row with a NULL `school_did`, and no API response containing a DID whose only membership is in another school.

## 11. Rollout in phases, with a test plan

| Phase | Ships | Flag state |
|---|---|---|
| 1 | Caddy wildcard inversion + reserved handle labels + `GET /internal/tls-check` | pre-requisite; ships on its own, benefits single-school too |
| 2 | Schema (§9 A–C), `fs_school`/`fs_membership`/`fs_school_credential`, credential import | `MULTI_SCHOOL=0` |
| 3 | `currentSchool()` threaded through every read site in Appendix A; actor registry (§5); per-school policy/roles/peers | `0` — single tenant, new code paths live |
| 4 | Session `current_school_did`, subdomain routing, apex front door, school picker | `1` in staging with two schools |
| 5 | `POST /api/schools`, founder-steward bootstrap, `GET /api/schools` | `1`, `SCHOOL_CREATION=closed` |
| 6 | Cross-school listing routing (§7), per-school peer registry, COhere plurality | `1` |
| 7 | Custom domain aliases, `fs_school_skill` curation, per-school Tier B overrides | `1`, `SCHOOL_CREATION=invite` |

### Test plan

**Unit.** `deriveRole`/`getThresholds` against two schools with different policies and one member — the same evidence must yield Member in one and Host in the other. `roleOf(did, A) !== roleOf(did, B)` when tallies differ. `routesOnTags` over two tag sets. Effective Tier B = `max(global, school)`. `schoolActor()` cache: eviction on rotation, isolation when one credential fails.

**Tenant isolation suite (the one that matters).** Seed two schools, a member of both and a member of each alone; then for **every** list endpoint assert the response contains no row from the other school, driven by a route table so a new route that forgets the filter fails the suite. Plus a lint rule: any `db.select().from(<scoped table>)` with no `school_did` predicate is an error — the privacy audit's fail-closed posture applied to tenancy.

**E2E personas across two schools** (`apps/web/e2e/multi-school.spec.ts`, on the spec §4.1 demo harness). Maya is in Boulder and Denver: identical profile and claims, different vouches, RSVPs and role. A Denver steward on `boulder.freeskool.xyz` gets no steward affordances. A Boulder-only member on `denver.freeskool.xyz` sees the public calendar and a "join this school" offer, not a 403. Sign-in on the apex returns to the subdomain it started from. A Boulder class with a routed tag appears on Denver's calendar as a Denver listing record, and a Denver steward's removal leaves Boulder's calendar untouched.

**Privacy audit per school.** `privacy-audit --school=<did>` for each, plus §10's two new assertions, in CI and in the release script.

**Migration test.** A fixture database at the pre-migration schema, Phases A–E run against it, then the whole existing appview suite green against the result — and a rollback test with the flag back at `0`.

## 12. Open questions for Benjamin

1. **Who may start a school?** `SCHOOL_CREATION` starts `closed` (operator only). Does it ever become `invite`, and ever `open`? Anything at `*.freeskool.xyz` reads as endorsed by us.
2. **Is the apex Boulder, or the network?** Today `freeskool.xyz` *is* Boulder. It can stay Boulder with `boulder.freeskool.xyz` as an alias, or become a front door that lists cities. The second is right long-term and costs Boulder its short URL.
3. **Do we move the handle domain?** §3's wildcard inversion lets city subdomains and member handles coexist under `freeskool.xyz`; a separate neutral handle domain would also close the R9 question in `docs/deployment.md`. Handles are mutable and DIDs are not, so this is decidable later — but cheaper before more members exist.
4. **Per-school handle domains at all?** A city that wants `*.denverskool.org` gets handles that permanently announce their members' school in every DID document. Offer it with that warning, or refuse?
5. **Cross-school vouches.** §2 scopes them per school on R9 grounds. Showing them everywhere needs the double opt-in record pair (gap 15) and your ruling on gap 11's "did not write" versus "did not consent to" — the same decision, twice.
6. **Taxonomy power.** §6 replaces a steward's "retire a proposed skill" with "hide it here", escalating real deprecation to the taxonomy operator. Right trade, or may a trusted school prune the shared tree?
7. **Does a school ever see another school's aggregate?** "Denver has 40 members" is a nice signal and a membership-count disclosure. §10 says no. Confirm.
8. **COhere double-listing.** If Boulder and Denver both list one class, does COhere dedupe on the event ref? A question for Aaron Gabriel, in the same mail as the `coop.lexicon.*` shapes (gap 7).
9. **Publishing `peers` per school.** Gap 4b is already yours for one school; with several, a public peer array also states that Boulder and Denver are affiliated. Same answer for all, or per school?
10. **Leaving a school.** `fs_membership.left_at` exists in §4 but the behaviour is undesigned: does leaving only hide you from the directory, does it retract your published role claim, and do your past classes stay on that calendar? (They should — they are the host's own records — but by decision, not by default.)
11. **When?** Specified now, built later on its own branch. Before or after the COhere test in October?

---

## Appendix A — every `SCHOOL_DID` read site

Regenerated with `grep -rn "config().SCHOOL_DID\|SCHOOL_DID" apps packages --include='*.ts' | grep -v '\.test\.'` on branch `refinement`, 2026-09-13. Thirty matches in seventeen files. Each is a place where Phase 3 threads a `schoolDid` parameter through instead of reading the singleton.

**Definition and lifecycle**

| File:line | What it does |
|---|---|
| `apps/appview/src/config.ts:44` | `SCHOOL_DID: z.string().default('')` — the declaration |
| `apps/appview/src/config.ts:200` | `redactedConfig`: `schoolConfigured: Boolean(c.SCHOOL_DID && c.SCHOOL_APP_PASSWORD)` |
| `apps/appview/src/config.ts:215` | doc comment on `resetConfig()` (bootstrap re-read) |
| `apps/appview/src/index.ts:34` | boot: `if (c.SCHOOL_DID) await refreshPolicyCache(c.SCHOOL_DID)` → becomes a loop over `fs_school` |

**The actor and its credential**

| File:line | What it does |
|---|---|
| `apps/appview/src/lib/school-actor.ts:12` | doc comment: the app-password session for `SCHOOL_DID` |
| `apps/appview/src/lib/school-actor.ts:88` | error text when the credential is unconfigured |
| `apps/appview/src/lib/school-actor.ts:138` | `new AppPasswordSchoolSession(c.SCHOOL_HANDLE \|\| c.SCHOOL_DID, …)` — the singleton wiring (§5) |
| `apps/appview/src/lib/school-actor.ts:150-151` | `schoolDid()` — the function every call site uses to name the school |

**Policy, roles, membership**

| File:line | What it does |
|---|---|
| `apps/appview/src/lib/policy.ts:70` | `getThresholds(schoolDid = config().SCHOOL_DID)` |
| `apps/appview/src/lib/policy.ts:87` | `currentPolicyUri(schoolDid = config().SCHOOL_DID)` |
| `apps/appview/src/lib/policy.ts:94` | `refreshPolicyCache(schoolDid = config().SCHOOL_DID)` |
| `apps/appview/src/lib/roles.ts:65` | `evidenceFor(did, schoolDid = config().SCHOOL_DID)` |
| `apps/appview/src/lib/roles.ts:131` | `roleOf(did, schoolDid = config().SCHOOL_DID)` |
| `apps/appview/src/lib/roles.ts:139` | `bumpTally(did, delta, schoolDid = config().SCHOOL_DID)` |
| `apps/appview/src/lib/membership-claims.ts:79` | `setPublicRoleOptIn(did, publicRole, schoolDid = config().SCHOOL_DID)` |

These six already take the school as a parameter and only *default* to the singleton. Phase 3 deletes the defaults, which turns every unthreaded call site into a compile error — the cheapest possible migration check.

**HTTP routes**

| File:line | What it does |
|---|---|
| `apps/appview/src/http/routes/health.ts:30` | `school: Boolean(config().SCHOOL_DID)` in the health payload |
| `apps/appview/src/http/routes/invites.ts:78` | `schoolDid: config().SCHOOL_DID` when minting an invite link |
| `apps/appview/src/http/routes/me.ts:276` | `if (parsed.data.publicRole && config().SCHOOL_DID)` |
| `apps/appview/src/http/routes/me.ts:278` | `publishRoleClaim(config().SCHOOL_DID, viewer.did, role)` |
| `apps/appview/src/http/routes/zine.ts:63` | `const did = config().SCHOOL_DID` — the zine's school |
| `apps/appview/src/http/routes/handoff.ts` | steward hand-off, via `schoolDid()` (file listed in the controller's `school-singletons-files.txt`) |
| `apps/appview/src/http/routes/admin.ts` | policy/moderation/peers, via `schoolDid()` (same) |

**Jobs, indexing, derived views**

| File:line | What it does |
|---|---|
| `apps/appview/src/jobs/retention.ts:133` | `const authority = config().SCHOOL_DID` |
| `apps/appview/src/lib/how-it-works.ts:100` | `buildHowItWorks(schoolDid = config().SCHOOL_DID)` |
| `apps/appview/src/index/outbox.ts` | listed in `school-singletons-files.txt` |
| `apps/appview/src/index/peers.ts` | peer registry seeded from env + the school record |
| `apps/appview/src/jobs/materialize-series.ts` | occurrence materialization as the school |
| `apps/appview/src/lib/events.ts` | listing routing and school writes |
| `apps/appview/src/db/schema.ts` | `school_did` columns (`fs_steward`, `fs_audit`, `fs_policy_cache`, `fs_peer`, `fs_invite_link`) |

**Scripts and packages**

| File:line | What it does |
|---|---|
| `apps/appview/scripts/create-school.ts:186` | prints `SCHOOL_DID=…` for the operator to paste |
| `apps/appview/scripts/appoint-steward.ts:22,24` | `appointSteward(did, schoolDid = config().SCHOOL_DID)` and its guard |
| `apps/appview/scripts/privacy-audit.ts:449-450` | already accepts `options.schoolDid` and builds a `schoolDids` set — the seam §10.3 uses |
| `apps/appview/scripts/smoke.ts:90` | `process.env.SCHOOL_DID = school.did` |
| `packages/school-actor/src/port.ts` | `schoolDid` on every method — already multi-school |
| `packages/school-actor/src/app-custody.ts` | the adapter; takes `schoolDid` per call |
| `apps/web/src/lib/types.ts` | the `school` flag in the client's health/config types |
| `apps/web/e2e/mvp.spec.ts:22,292` | e2e env documentation and a `listRecords(config().SCHOOL_DID, …)` assertion |

## Appendix B — env and config changes

**Removed from the runtime path** (kept as a one-time bootstrap import, §5):

| Variable | Becomes |
|---|---|
| `SCHOOL_DID` | `fs_school.did` |
| `SCHOOL_HANDLE` | `fs_school.handle` |
| `SCHOOL_APP_PASSWORD` | `fs_school_credential.wrapped` (AES-256-GCM under `CUSTODY_KEYS`) |
| `SCHOOL_NAME`, `SCHOOL_REGION`, `SCHOOL_EMAIL` | arguments to `POST /api/schools` |
| `PEER_PDS_HOSTS` | seeds `fs_peer` for the **default** school; per-school after that |

**New**

| Variable | Default | Meaning |
|---|---|---|
| `MULTI_SCHOOL` | `0` | the §9 Phase D flag |
| `SCHOOL_CREATION` | `closed` | `closed` \| `invite` \| `open` (§8) |
| `DEFAULT_SCHOOL_DID` | *(empty)* | which school the apex serves when `MULTI_SCHOOL=1` and the Host matches no subdomain |
| `SESSION_COOKIE_DOMAIN` | *(empty)* | `.freeskool.xyz` under subdomains; empty keeps today's host-only cookie |
| `SCHOOL_ACTOR_CACHE_TTL_MS` | `1800000` | §5 eviction |

**Unchanged and deliberately still global:** `CUSTODY_KEYS`, `CUSTODY_KEY_VERSION`, `SESSION_SECRET`, `FEEDBACK_BALLOT_PEPPER`, `OAUTH_PRIVATE_JWK`, `PDS_URL`, `PDS_HANDLE_DOMAIN`, `AUTHORITY_*`, `CONTRAIL_NAMESPACE`, `CONTRAIL_ORDERED_SOURCE_EPOCH`, `SMTP_URL`, `MAIL_FROM`, `VAPID_*`.

**Infrastructure**

- `infra/production/Caddyfile` — the wildcard inversion in §3; the ask endpoint gains the `fs_school_domain` deferral.
- `infra/production/compose.yml` — unchanged except that `PDS_SERVICE_HANDLE_DOMAINS` becomes a list when a city brings its own handle domain.
- `infra/production/.env.example` — the table above, with the `SCHOOL_*` block relabelled "bootstrap only; imported into `fs_school` on first boot".
