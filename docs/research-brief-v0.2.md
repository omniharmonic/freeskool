---
title: "Free School — Research Brief & Build Plan (v0.2)"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-12
status: draft
project: local-alternatives
version: "0.2"
supersedes: vault/projects/local-alternatives/reports/2026-09-12_free-school-research-brief-v0.1
research: [r1_spaces-alpha-lab-notes, r2_lexicon-inventory, r3_arbiter-review, r4_direct-pds-federation, r5_skills-seed, r6_prior-art-review, r7_free-skool-values, r8_pwa-ios-checklist, r9_privacy-threat-model]
---

# Free School — Research Brief & Build Plan (v0.2)

*Prepared by Benjamin Life (@omniharmonic) · 12 September 2026 · Second pass, after the nine research briefs R1–R9. Keeps the v0.1 structure. Every section is marked **confirmed** (v0.1 held up against primary sources), **revised** (the research changed it), or **unchanged** (not re-examined). Settled decisions from 2026-09-12 are not reopened: sidecar composition; `freeschool.draft.*` approved for drafting; the hosted service custodies the school DID in v1; v1 on public records with anonymous feedback app-side behind a Spaces-shaped interface; reputation derived, never scored.*

---

## What changed the plan

Nine things, in order of consequence.

1. **Three v1 records were unsafe as specified and move app-side (R9).** A public `community.lexicon.calendar.rsvp` in the attendee's repo publishes a forward-looking co-presence graph; a host-written `attendance` record names a DID its holder cannot delete; public `coop.lexicon.membership` claims are a roster. Anyone can read all three for free from Jetstream, forever, with no legal process. New rule: **no public record may name a DID its holder did not write.** RSVPs, attendance, the roster and moderation content are app-side in v1 (they were already going to be Spaces-shaped); badges are still derived, but from app-side evidence plus an optional attendee-written "I attended" record. The v1 scope list keeps every feature; only the storage placement changes.
2. **The default front door flips (R8 + R9).** New users get a fresh Free School identity on our PDS; "sign in with Bluesky" becomes the secondary path with a hard confirm, because the link to a public identity is permanent and unredactable (PLC audit log). Separately, ATProto OAuth must run **server-side** with a cookie session: iOS copies only cookies at Add-to-Home-Screen, and the browser OAuth client keeps non-extractable DPoP keys in IndexedDB, so a browser-side flow signs the user out on install.
3. **The AppView is an import, not a build (R6 + R4).** `@atmo-dev/contrail` 0.23 (MIT) already does relay-free backfill from a host list, first-class sidecars, Postgres, and a transactional outbox. The one thing we write is a `PdsChangeSource` over `com.atproto.sync.subscribeRepos`, and R4 already ran that against seven real PDS hosts. Tap cannot do a multi-host model. The peer registry stores DIDs as truth and hosts as a derived cache, because repos move (one tracked repo has had three PDS homes). Following the whole calendar network directly does not scale; the registry is curated.
4. **The Arbiter is not what the blog post described (R3).** A September rewrite deleted its membership API and role model; what remains is a Rego-gated proxy that writes as a stewarded account, there is no license, and it is single-instance with plaintext credentials. We wrap: every school-authored write goes through one `SchoolActorPort` shaped like the Arbiter proxy body so it can be swapped in Phase 2 without call-site changes. Built and tested this session.
5. **Spaces will need two spaces, not two collections (R1).** Per-collection read policy is inexpressible in the alpha; one credential reads every collection of every member repo. Members and feedback are separate spaces. The authority can always read everything, unauthorized writes are silently unsynced rather than rejected, and revocation lags two hours. The alpha runs locally today (amd64 only, two undocumented env vars). Confirms v1's app-side placement; shapes Phase 2.
6. **Recurrence is ours to define (R2 + R6).** Nobody upstream has solved it: atmo writes a pointer it never reads, OpenMeet materializes lazily and loses cancellations, and there is no issue or PR on the community lexicon. Drafted and validated: `series` (RRULE string normative), `occurrence` (back-pointer with `originalStartsAt`), server-side daily materialization, 90-day window, deterministic occurrence rkeys, split-series for "this and following."
7. **Smoke Signal is sunset and the community lexicon moved (R2).** The lexicon repo is now on Tangled (byte-identical today). Smoke Signal's end state "links out to other services that speak the same lexicons," which makes its users our first interop audience. The base event requires only `name` and `createdAt`; RSVP has no `createdAt`, so waitlist order must come from the TID.
8. **Notifications are built in-app (R6 + R8).** atproto-notify has no license. Take its protocol shape only. iOS push is Home-Screen-only, silent push revokes the subscription, and Declarative Web Push (iOS 18.4+) removes that risk; no background sync exists, so reminders are server-timed and email is the floor.
9. **The v0.1 "Holmgren endorsed the Arbiter" framing was too strong (R3).** He endorses the governance *layer* and explicitly leaves hosting open; his stated priority is migration between arbiter implementations, which argues for a seam, not adoption.

All nine briefs are folded in. Skill taxonomy seeded from R5 (525 nodes); design constraints from R7 reconciled against the organizer's spec in §13.

---

## 0. TL;DR — the five things that change the plan — **revised**

1. **Spaces alpha** (20 Aug 2026) is real and runs locally; its shape is settled enough to design toward and too unstable to ship on. Two spaces per school (roster, feedback); the authority always reads everything. [confirmed by R1, hands-on]
2. **Group management**: the Arbiter is the right long-term home for write-as-school but currently has no membership API and no license. Wrap behind `SchoolActorPort`; pilot in Phase 2 when seven gate conditions hold (license first). [revised by R3]
3. **Admins can't co-edit records** remains the hard constraint; the app holds the school credential and every such write is audited through one chokepoint with a two-steward threshold kept in records. [confirmed]
4. **Federation without the firehose** is the normal pattern and was executed against seven real hosts. A curated peer registry of DIDs, hosts derived; contrail as the indexer. [confirmed by R4, R6]
5. **Reputation derived, never minted** holds, and the privacy review sharpened it: the *evidence* must also be safe, so attendance and RSVP never become public records naming others. [revised by R9]

**The decision this week** (build v1 on public records + app-held school credential + app-side private tables behind a Spaces-shaped interface) is confirmed by every brief that touched it.

---

## 1. What the vault already holds — **confirmed, with corrections**

- §1.1 Lex's requirements: unchanged as the product spec. The dictation's drift toward host *ratings* is reconciled in §7 (aggregate-only, k-anonymous, never public).
- §1.2 Lucian's building blocks: shapes verified from `technefoundation/regenOS@c3e34d4` (R2). Correction: `coop.lexicon.event.config` uses `attendance`, not `attendanceMode`. Placement is the record's location in a space, never a body field; our sidecars carry no visibility field.
- §1.3 Regen Hub session decisions: unchanged. The extend-vs-sidecar rule is now written down per type in the Lucian review packet.
- §1.4 Protocol posture: the Q1 2027 review trigger ("interoperable third-party space implementation usable") is closer to being met than v0.1 assumed — the alpha PDS serves spaces today — but the Arbiter regression cuts the other way. Keep the trigger.

## 2. AT Protocol mental model — **confirmed**

Unchanged, with one addition worth a sentence for non-developers: **deletion does not propagate.** A record deleted from your repo is already in third-party archives; the PLC directory's handle and PDS history is permanent and bulk-exportable (R9). Every member-facing promise must be phrased accordingly.

## 3. Spaces — **revised (R1, hands-on)**

What the lab established, against `ghcr.io/bluesky-social/atproto:pds-spaces-alpha` (revision `3827ed0a`, built 2026-09-10):

- Runs locally without an invite; amd64 only; needs `PDS_DEV_MODE=1` and `PDS_DISABLE_SSRF_PROTECTION=1`; the published `@atproto/lex-data@0.0.0` placeholder breaks a naive install (pin with `pnpm.overrides`).
- Address shape `at://{authority}/space/{type}/{skey}/{author}/{collection}/{rkey}`; space-type NSIDs need 3+ segments.
- **Read is per-space, all-or-nothing.** No collection claim in the credential, none in the member row, none expressible in the scope grammar. → **`org.freeschool.members` and `org.freeschool.feedback` are separate spaces.**
- **The authority always reads everything** (`if (userDid === spaceDid) return true`). Anonymity against the school is the app's construction, not the protocol's.
- **Write policy gates tracking, not the write.** A non-member's `putRecord` returns 200; it never enters the writer set. The writer set, never row existence, is truth.
- Issued credentials live 7200 s after `removeMember`. Any credential holder can `registerNotify` a third party (leaks who-wrote-when; mitigate with `appAccess: allowList`).
- Syncer path: credential → `getSpace` → `registerNotify` → `listRepos` → `listRepoOps?since` → `getRepo` fallback. Reads go to each member's own PDS.
- MAC-based commits make space records deniable on rebroadcast, unlike signed public records (R9 §6). That is a real privacy property public records cannot have.

Per Holmgren, one space per modality. Ours: members, feedback, moderation, plus `coop.lexicon.space.event.detail` per event. Declarations are in the Lucian packet.

## 4. Alignment rules with Lucian's work — **confirmed**

All seven hold. Two refinements: (4) skill references use **at-uri** (identity) while event sidecars use **strongRef** (version), because taxonomy nodes are edited in place; (7) the review packet exists and lists five questions plus three surfaced by research.

## 5. Federation model — **confirmed and made concrete (R4)**

- `subscribeRepos` on a PDS: `#commit` (CAR slice + ops with `prev`), `#sync`, `#identity`, `#account` (statuses now include `desynchronized`, `throttled`), `#info` for `OutdatedCursor`. Verified live.
- **Cursor replay is capped at 24 h** per PDS; after that you get a silent gap unless you repair with `getRepo`/`listRecords`. `@atproto/sync` drops `#info` and hides reconnects; we run the subscription ourselves or patch it.
- `getRepo` has no collection filter (16.6 MB CAR vs 120 KB `listRecords` for the same repo); backfill with `listRecords`, reserve CAR for proof.
- Rate limits measured: 3000 req/300 s per IP default; `getRepo` 6000 points/5 min; subscription buffer 500.
- **Peer registry**: `peer_host` (cursor per host) and `peer_repo` (home host, last rev, status) tables; DIDs are truth, hosts a cache refreshed on `#identity`; migration detected by four signals. Eventually a record in the school's repo (`freeschool.draft.school.peers` exists now) so schools federate by transitive subscription.
- Scale: 445 repos network-wide write calendar events across hundreds of hosts; direct following is for a curated set. `coop.lexicon.event.listing` has **zero repos** — we are the first mover on tag-routed listings.
- §5.2 portability and §5.3 cost: unchanged, with R9's caveat that portable *public* evidence must be attendee-written.

## 6. Draft data model — **revised**

Seventeen lexicons drafted and validated (`packages/lexicons`): `skill`, `skillClaim`, `skillAttestation`, `skillLevel`, `series`, `occurrence`, `attendance`, `hostFeedback`, `request`, `claim`, `resource`, `course`, `policy`, `moderationAction`, `approval`, `appeal`, `school`. Changes from v0.1:

| Type | Change | Source |
|---|---|---|
| `skillLevel` | new event sidecar (which skill, depth 1–3 as an ordered integer) | R2 |
| `series` + `occurrence` | recurrence as two records; RRULE string normative; `exdates` on the series; `originalStartsAt` as idempotency key | R2, R6 |
| `attendance` | kept for the members space and an attendee-written variant; **never public naming a DID** | R9 |
| `approval` | new: stewards' signed approvals so the two-steward threshold is verifiable from records | R3 |
| `school` | new: the scene's self-declaration with `peers[]` and routing `tags[]` | R4 |
| `moderationAction` | written reason mandatory but **never public**; public projection is state + enum | R9 |
| `skill` refs | at-uri, not strongRef | coordinator |

**Placement after R9:** public — events, listings, skill nodes, Tier-A skill claims, requests, resources, courses, policy, school. App-side in v1 (space later) — RSVP, attendance, roster, feedback, moderation, invites. Public only with double opt-in — attestations.

**Spaces to declare:** `members`, `feedback`, `moderation` (separate, per R1), plus per-event `coop.lexicon.space.event.detail`.

## 7. Trust graph & reputation — **confirmed, evidence placement revised**

Principle unchanged. The role ladder is implemented as a pure function (`deriveRole`) with Lex's defaults (open hosting on day one) and an opt-in gate. Evidence for roles comes from app-side attendance rows plus host confirmations; the public artifact stays counts. Feedback anonymity is strengthened: ballots in a separate table keyed by an HMAC with a per-event key destroyed at window close; k = 3 for numeric aspects, **k = 5 for text**; aggregates published once per window to block differencing. Sybil resistance unchanged.

## 8. Skill taxonomy — **confirmed in design; seeded (R5)**

Design unchanged (records, ESCO + Wikidata backbone, `broader` and `prerequisites`, levels on events). Added by R5: a third of real free-skool offerings are not skills at all (reading groups, socials, open shop hours), so events tolerate zero skill references and a separate topic vocabulary is likely later. Added by R9: a **two-tier list** — Tier A pre-checked for public; Tier B (legal-exposure adjacent) unchecked with an explicit confirm. **Seed (R5):** 525 nodes — 8 domains (practical trades, food, land, repair, care, arts, organizing, tech/digital) → 52 areas → 465 leaf skills; 219 canonical, 306 proposed. 159 leaves (34%) carry a verified ESCO URI, 417 nodes (79%) a Wikidata QID (87 hand-verified), 95 neither. Coverage is uneven by domain: practical trades 54% ESCO, food 20%; organizing and the free-skool-specific nodes (squatting, street medicine, know-your-rights, harm reduction, transformative justice, deschooling, running a free skool) are `proposed` with Wikidata anchors only. Nine nodes (hide tanning, flintknapping, compost toilets, cob/straw-bale, death doula, DIY gynaecology, dumpster diving, alley cat races, and one more) were **not confirmed in any archived free-skool catalog** and are flagged as first candidates for deletion. The seed is vendored at `infra/seed/skills/` with provenance and is written as `freeschool.draft.skill` records under Benjamin's authority DID, `rkey = slug`, `broader` resolved to at-uris at write time. ESCO requires attribution (text in R5 §Licensing); Wikidata is CC0.

## 9. Moderation & governance — **revised**

Toolset unchanged. Written reasons remain mandatory (the audit row) but are **never public**; the public surface is a state plus a fixed enum. Destructive actions require the policy's steward threshold with approvals as records (`approval`). Appeals live in the moderation space. Labelers stay default-off. Steward elections deferred.

## 10. Wiki & curriculum — **unchanged**

## 11. Identity & onboarding — **revised (R8, R9)**

Two doors, reordered: **primary = new Free School identity on our PDS** (custodial account, random password encrypted at rest, take-ownership path later — OpenMeet's pattern, Apache-2.0); secondary = existing ATProto account via **server-side** OAuth with a hard confirm about permanent linkage. Pseudonymous generated handles; never derived from email. Neutral PDS hostname and handle suffix (not `*.freeschool.com`) because the PDS endpoint in the DID document makes membership enumerable via `plc.directory/export`. Invite links stay app-side and carry nothing. The permanence sentence shows at the first public write.

## 12. Prior art — **revised (R6)**

| Project | License | Verdict |
|---|---|---|
| contrail 0.23 | MIT | **import**; write `PdsChangeSource` |
| atmo-events | MIT | read for granular OAuth scopes; copy `lib/notify/*` dedup ledger; its spaces code is pinned to a removed contrail version |
| atmo `events-ui` | MIT | import selectively (editor adapter, ical, pickers) |
| contrail PR #95 | MIT, private | does **not** republish space content; read later for the credentialed reader |
| atproto-notify | **none** | spec only; no code reuse |
| OpenMeet custodial signup + take-ownership | Apache-2.0 | **port** |
| OpenMeet mail templates (MJML) | Apache-2.0 | port the pipeline |
| OpenMeet event-series | Apache-2.0 | do not take (lazy materialization, lost cancellations) |
| Smoke Signal | sunset | historical; its users are the interop audience |
| The Arbiter | **none** | wrap, pilot Phase 2 |

"Do not build" list unchanged, with one reversal: we **do** build the notification service (protocol shape borrowed).

## 13. Product & PWA — **revised (R8)**

Baseline iOS 26.2. Install has zero requirements on iOS 26 (manifest still shipped). Push is Home-Screen-only, 4 KB payload, user-gesture required, silent push revokes; use **Declarative Web Push** with `mutable: true`. Badging Home-Screen-only. No Background Sync / Periodic Sync / Background Fetch; no scheduled local notifications; no `share_target`; no haptics (use a real switch control); no `prefers-reduced-transparency` (ship our own toggle). `display-mode: standalone` reports false in installed apps — detect with `navigator.standalone`. Storage is 60% of disk with no prompt; installed apps are exempt from the 7-day eviction. Print zine works (`@page` margins since 18.2; explicit sizes, not keywords; paper color on a wrapper). Install nudge after first RSVP, 14-day cooldown, in-app-browser detection, copy that names the menu not the icon. Profile defaults from R9 (no real-name prompt, no links field in v1, generated identicon, EXIF re-encode).

**Ten design constraints from the lineage (R7)**, with how v1 honors or deliberately departs from each (Lex's 09-10 requirements remain the product spec where they conflict):

| # | Constraint (R7) | v1 stance |
|---|---|---|
| 1 | The calendar is the school: a one-click print zine is the primary artifact | **Adopted.** `/zine` ships in v1; every surviving skool ran on a printed calendar, and the ones whose calendar lived only in a database left nothing |
| 2 | Needs board before class listings | **Adopted.** Requests tab works with zero events; "Requests" is the onboarding landing for new members |
| 3 | No money anywhere | **Adopted.** No payments, tickets, or donate button; only a free-text supplies note per class (pending Lex's answer) |
| 4 | No ratings, reviews, or credentials | **Adopted in spirit, departs on counts.** No stars, reviews, leaderboards, or "popular classes." Lex explicitly asked for Couchsurfing-style vouch counts and attendance badges, so v1 shows **counts and presence** (hosted, attended, vouched) and derived badges as plain labels — never averages, never rankings, never public per-person feedback |
| 5 | Radically open membership, asserted not granted | **Adopted as the default.** Lex's "if you say you're Free School, you're Free School" is the shipped default; the invite/vouch gate exists only as an opt-in switch in policy |
| 6 | Admin-free by default; moderation a removable overlay | **Adopted as the default, with a twist.** The steward role and moderation queue exist because Lex asked for graduated moderation and an admin dashboard, but the default policy requires no approval for anything; authors edit and delete their own posts; school-level actions are audited and need two stewards |
| 7 | Venue is first-class and the app assumes none | **Partially adopted.** "Venue needed" is a valid event state in v1; reusable venue records with capacity/accessibility/host-risk notes are Phase 2 (they interact with the tiered address disclosure from R9) |
| 8 | Failure-tolerant: an empty calendar is normal | **Adopted.** No engagement metrics, streaks, inactivity nags, or auto-unpublishing; the zine prints fine with three entries |
| 9 | Forkable | **Adopted by construction.** Records in members' own repos, AGPL code, CC0 lexicons and zine templates, documented self-hosting in Phase 3 |
| 10 | Continuity beyond founders | **Adopted.** No single-owner objects; the school DID's rotation keys split with a non-operator steward; a "hand this off" flow and an always-current printable "how this skool works" page (the `policy` record rendered) in v1; Hamilton Freeskool's overlapping organizer terms noted for Lex |

Two factual corrections from R7 for anyone writing copy: the lineage project was **Freeskool Asheville** (not "Asheville Free School"), and Baltimore Free School did not wind down — it lost its room in 2018 and is running again in 2026. Do not quote "any space can be a classroom" as Santa Cruz's words; the verifiable line is "there is no main campus or office."

## 14. Risks & open questions — **revised**

For Lucian (packet drafted): the five v0.1 questions plus (6) Smoke Signal sunset, (7) rsvp lacks `createdAt`, (8) no public record naming an unconsenting DID. For Lex (drafted, plain language): score-vs-attestation compromise, day-one hosting openness, profile defaults, freeschool.com and handle domains, supplies note. Technical: alpha churn (weekly), `PdsChangeSource` cursor semantics across hosts (highest-risk build item; spike first), retention-as-code needs counsel before shipping ballots-key-destruction and short PITR (R9 flags spoliation exposure), Arbiter license ask to zicklag, atproto-notify license ask to flo-bit.

## 15. Phased plan — **revised**

**Phase 0 (this week) — done or in progress:** repo scaffolded (workspace, 17 lexicons, shared policy engine, Spaces-shaped store, SchoolActorPort, R4 follower vendored, local PDS + Postgres running); stack proposal; Lucian packet and Lex questions drafted; PWA shell and AppView core being built.

**Phase 1 — v1 before COhere (October):** server-side OAuth + custodial signup (primary door) · profile + skillClaim (tiered visibility) · class creation on the base event + `config` + `skillLevel`, locations via `community.lexicon.location` with tiered address disclosure · RSVP app-side (per-event public opt-in) · host-attested attendance app-side · needs board with threshold → claim → event · derived badges and role ladder writing `membership` claims **app-side** (public only for consented public-facing roles) · invite links app-side · anonymous feedback with HMAC ballots, k=3/5 · admin dashboard v0 (policy, thresholds, moderation queue with mandatory reason + approvals, newsletter, peers) · tag-routed `coop.lexicon.event.listing` exchange with the COhere calendar (we are the first writer of that NSID) · monthly print zine · PWA with install nudge and declarative push.

**Phase 2 — Q4:** spaces on the sandbox (two spaces), `PdsChangeSource` hardened (`#info`, reconnect observability, `#sync` repair, record-state diff), Arbiter pilot if gates hold, appeals, resource records + skill pages, series editing UI, comail email transport.

**Phase 3 — Q1 2027:** peer registry as a record with transitive subscription, one-click hosted "start a free school", `docker compose` for self-hosters, second city, steward elections, optional labeler, Open Badges 3.0 export.

## 16. Research swarm — **complete**

R1–R9 delivered to `vault/projects/local-alternatives/free-school/research/`. Each carries Sources and Confidence / not verified sections. R9 is human-review-required.

## 17. Sources — **revised**

All v0.1 sources plus the nine briefs. Primary additions: `bluesky-social/atproto@permissioned-data` (`9d787eb`) and the alpha image (`3827ed0a`); `muni-town/arbiter@16583192`; `tangled.org/lexicon.community/lexicons@c8552ebb`; `technefoundation/regenOS@c3e34d4f`; `smokesignal.events/smokesignal@7bdfaf65` (`plan_sunset.md`); `flo-bit/contrail` 0.23.0, `flo-bit/atmo-events`, `flo-bit/atproto-notify`, `OpenMeet-Team/openmeet-api` at the commits in R6; atproto.com specs (repository, tid, sync, handle, blob, oauth), did:plc spec v0.1, Jetstream docs, Holmgren's "Boring Auth" and "Modeling communities on permissioned data"; WebKit/Safari 26.x and 27 release notes, MDN BCD, caniuse; live PDS hosts followed in R4 (eurosky.social, northsky.social, pds.cauda.cloud, five bsky.network fleet hosts).
