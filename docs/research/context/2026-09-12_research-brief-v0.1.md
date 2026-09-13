---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
type: "report"
version: "0.1"
parachute_path: "vault/projects/local-alternatives/reports/2026-09-12_free-school-research-brief-v0.1"
parachute_id: "2026-09-12-18-51-20-567232"
tags: ["atproto", "free-school", "local-alternatives", "report", "research-brief"]
---

---
title: "Free School — Research Brief & Build Plan (v0.1)"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-12
status: draft
project: local-alternatives
tags: [free-school, atproto, spaces, lexicons, skills-taxonomy, research-brief]
related:
  - vault/projects/local-alternatives/reports/2026-09-10_lex-free-school-boulder-report
  - vault/projects/local-alternatives/reports/2026-09-12_regenos-free-school-building-blocks-handoff
  - vault/agent/reports/2026-09-11_regen-hub-atproto-session
  - vault/projects/local-alternatives/reports/2026-09-11_local-alternatives-interview-week-synthesis
  - gitcoin-brain: knowledge/atproto-vs-nostr-for-regenos
  - gitcoin-brain: knowledge/project-weave-kaliya-young-atproto-groups
---

# Free School — Research Brief & Build Plan (v0.1)

*Prepared by Benjamin Life (@omniharmonic) · 12 September 2026 · First-pass synthesis. Sections marked **[verified]** were checked against primary sources today; **[vault]** comes from Parachute / Gitcoin Brain; **[inferred]** is my own design reasoning and needs a second look before anyone builds against it.*

**Decisions taken 2026-09-12 (Benjamin):** (1) sidecar composition is the rule — never extend borrowed records; (2) the net-new record types in §6 are approved for drafting under `freeschool.draft.*`, pending Lucian's review before canonical; (3) the hosted service (us) custodies the school DID for v1.

---

## 0. TL;DR — the five things that change the plan

1. **Bluesky shipped the Spaces alpha on 20 August 2026.** [verified] "Permissioned data" is now called **Atproto Spaces**: hosted alpha PDS, tagged Docker image (`ghcr.io/bluesky-social/atproto:pds-spaces-alpha`), alpha TypeScript SDK, a sample app (`bulletin.my`), weekly Thursday drops, launch target "later this year." Explicitly not for production. This is the thing Lucian was implementing ahead of the PDS; the PDS is now catching up.

2. **Group management on Spaces already has an emerging standard — The Arbiter (Muni Town / Roomy).** [verified] It hosts community DIDs and their spaces and exposes a standard API for membership and roles. Daniel Holmgren (Bluesky) has endorsed it as the natural place for a community-management standard. A Free School is a *group*; we should not invent our own membership service.

3. **The hardest architectural constraint is one nobody has solved yet: admins can't co-edit a group's records.** [verified] Every record is signed by its author's DID. For "moderators can edit/remove any class" the app must hold the *free school's* credential and write as the school, deciding who may trigger that write. The atmo-events / OpenMeet / Contrail crew hit exactly this on the alpha last week. It shapes moderation, appeals, and the "host approves attendance" flow.

4. **Federation without the firehose is already the normal pattern for small apps.** [verified] Relays are an optimization, not a requirement; an AppView can subscribe to and backfill from individual PDSes directly (`com.atproto.sync.subscribeRepos` on the PDS, `getRepo`/`listRecords` for backfill). Space data *never* touches the firehose — apps sync it directly from PDS hosts by design. So "free schools on different PDSes talking to each other" = a **registry of peer PDS hosts**, not a relay. Benjamin's "nested-scales federation" idea from 09-11 is the right frame.

5. **Reputation must be derived, never minted.** [vault + inferred] Lex and Benjamin both rejected Uber-style scores on 09-10; Lucian's `coop.lexicon.evaluation` already encodes "negative never routes public." Badges, host eligibility, and trust levels should be **re-derivable views over attestation records**, not tokens. This is also what makes them portable: a new city re-derives your standing from your own repo.

**The one decision to make this week:** build v1 (before COhere in October) on **public records + a thin app-held "school" credential**, with anonymous feedback stored in the app's DB behind a Spaces-shaped interface — then migrate that one table into a real Space when the alpha stabilizes. Everything else can be protocol-native from day one.

---

## 1. What the vault already holds (so we don't re-research it)

### 1.1 Lex's requirements (09-10 interview) [vault]
The interview report is the product spec. The parts that constrain architecture:

- **Everything public except membership and feedback.** Calendar and classes fully public; profile creation slowed by vouch/referral; feedback "stays totally internal."
- **No money in the app.** Donations for *supplies* only, per-class; open question whether even a Venmo field is wise. (Benjamin's ask today — a donation-link field with free-by-default — should be scoped as *collective* donations via fiscal host, not per-class ticketing.)
- **Graduated moderation.** Admin approval for new posters, lifting once someone has hosted enough. Lex: "Absolutely."
- **Badges = Couchsurfing-style vouch counts and attendance**, never ratings. Both explicitly rejected star ratings. **Tension to resolve:** today's dictation asks attendees to *rate* hosts on knowledge, teaching, and experience. Reconcile as: attendees submit anonymous structured feedback (a `positive|negative` evaluation with optional free text) that is *visible to the host as aggregate* and to moderators, never as a public score. See §7.
- **Needs board is the #1 entry point** ("I want to learn X" → "I can teach that"). Today's dictation adds the threshold mechanic (N RSVPs unlocks "claim to host"). Good.
- **Tag-routed calendar interoperability** with COhere (Aaron Gabriel) and the "punk rock community calendar" — separate interfaces, shared event data, routed by tag in both directions.
- **Analog-first.** Printable monthly zine of the calendar is more on-brand than push notifications.
- **Activist exposure.** Lex's network includes people in legal trouble. ATProto repos are public and DIDs are globally indexable. Membership graphs must not be public.
- **Replicability.** Lex owns `freeschool.com`; imagined Craigslist-style per-city subdomains.

### 1.2 Lucian's building blocks (planbot handoff, verified against `regenos` main c3e34d4) [vault]

| Existing type | Use in Free School |
|---|---|
| `community.lexicon.calendar.event` + `.rsvp` (adopted, not owned) | A class is a base event. Keeps us visible to Smoke Signal, atmo.rsvp, Dandelion, Beacon. |
| `coop.lexicon.event.config` (sidecar) | attendance mode `open|approval`, maxAttendees, waitlist |
| `coop.lexicon.event.detail` (gated sidecar) | exact address / attendee-only notes — lives only in the event's space |
| `coop.lexicon.event.listing` | how a scene curates a borrowed event onto its calendar — **this is the tag-routing primitive** |
| `coop.lexicon.membership` `{subject, role:int}` | roles 10/20/30/40 = Member/Builder/Facilitator/Steward → **graduated moderation hangs off role claims, not counters** |
| `coop.lexicon.evaluation` `direction: positive|negative` | vouches, event feedback. Negative structurally never routes public. |
| `coop.lexicon.invite` / `.share` | named invite vs bearer join-link → vouch/referral onboarding |
| `coop.lexicon.profile`, `.interest` | display profile; private interest box |
| `coop.lexicon.feed.recipe` | publicly declared ranking algorithms evaluated per-viewer over their own visible claims |
| Spaces model: `at://{authority}/{spaceType}/{skey}` + `{spaceType}.policy` | declarative read/write/manage predicates; no per-person grants; `memberRole`, `invited`, `sharedWith`, etc. |
| **No skill, attendance, badge, request, or wiki-resource type exists.** | Net-new for Free School. Extend-vs-sidecar is **Lucian's call** before building deep. |

Sidecar rule Lucian set: never edit the borrowed event; compose with strongRef sidecars; **placement follows audience** (public stuff on the base record or an open sidecar; gated stuff in a space).

### 1.3 Decisions from the 09-11 Regen Hub session [vault]
- Backend renamed **Syntropic**; canonical lexicon namespace leaning toward `lexicon.coop` / `coop.lexicon.*`; new types carry a **`.draft` suffix** until normalized.
- **Benjamin gets a sandbox PDS** (Lucian to stand up; networked with the Techne PDS; SQLite export of public data if ever shut down). Build against it with own draft lexicons. Not waiting on Gitcoin budget.
- Roadmap: Q3–Q4 one shared PDS with several apps; end Q4–Q1 self-hostable PDS images and federation; global firehose deferred.
- Open question Benjamin named as his biggest risk: **the written rule for extend-a-record vs attach-a-sidecar**. Still unwritten.
- Portable export of *permissioned* data is unsolved.
- Zero-knowledge collective credentials ("sign in as a verified member without revealing which") — Lucian: "not that hard." Relevant to anonymous feedback.

### 1.4 Protocol posture (Gitcoin Brain) [vault]
- ATProto chosen for **identity recoverability** (did:plc separates identity from key — a plumber who loses a key doesn't lose a reputation), **repo completeness** (re-derivable access), and **lexicons as namespaced schema**. Not because 0016 would absorb the permission layer.
- "The community is not a first-class citizen" was the #1 blocker; The Arbiter + Spaces alpha are closing it. **Review trigger** stated in the brain: if no interoperable third-party space implementation is usable by ~Q1 2027, revisit.
- Kaliya Young / Project Weave: authenticate *as a group* via a verifiable membership credential. IIW #43 is Nov 3–5 (after COhere).

---

## 2. AT Protocol — the mental model you actually need [verified]

Pitched at a technical non-developer. Everything below is stable, documented at atproto.com.

**Identity.** Every person is a **DID** (permanent). `did:plc:…` is the common kind (recoverable via rotation keys registered with the PLC directory); `did:web:…` ties identity to a domain. A **handle** (`lex.freeschool.com`) is a DNS name that resolves to the DID — it's a label, not the identity. Handles can change; DIDs don't.

**Storage.** Each DID has a **repository** hosted on a **PDS** (Personal Data Server). A repo is a signed Merkle tree of **records**. Records are JSON, typed by a **Lexicon** (schema) and stored in **collections** named by NSID (`community.lexicon.calendar.event`). A record's address is `at://did/collection/rkey`. A **strongRef** is `{uri, cid}` — a pointer to a specific version of another record.

**Moving.** An account can migrate to another PDS with its full repo (CAR export/import) and keep its DID. This is the "take my profile from Asheville to Boulder" promise, and it's real today.

**Reading.** Apps don't read repos one by one at scale; they subscribe to a change stream. A **Relay** aggregates all PDSes into a **firehose**. **Jetstream** is a lighter JSON version. **Tap** (2026) is Bluesky's new sync helper: point it at the repos and collections you care about and it handles backfill + filtering. **But relays are optional.** A small AppView can subscribe directly to a handful of PDSes.

**Writing.** Clients always write to the user's PDS (never to an AppView). Apps get permission via **OAuth** — the user authorizes the app for specific scopes; **permission sets** (2026) let an app publish a named, human-readable bundle of scopes as a lexicon record.

**AppView.** The app's own index + API over the records it cares about. It's swappable: two AppViews indexing the same lexicons produce two products over one dataset. This is the mechanism behind "separate calendars, shared events."

**Labelers.** ATProto's native moderation primitive — a service that publishes labels on records/accounts that apps choose to subscribe to. Each free school could run (or share) a labeler for policy enforcement without touching anyone's repo.

**Lexicon resolution.** NSIDs resolve via DNS: `coop.lexicon.event.config` → `lexicon.coop` → TXT record → DID → the schema record. This is why the co-op owning `lexicon.coop` matters — it's the authority.

---

## 3. Spaces (permissioned data) — state of play, 12 Sep 2026 [verified]

From the 20 Aug announcement and the proposal:

- A **space** is "a miniature atproto network that can be gated." Same shape as public: DIDs, per-user repos, lexicon records, apps that crawl. Different repo format, sync, addressing: `at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`.
- **Access control, not confidentiality.** Data in a space is readable by anyone with access; it is not encrypted. Services can read what they handle (search, notifications, moderation).
- A **space authority** is just a DID. It decides which DIDs are members. **The member list is the narrow waist**; roles, approval, appeals are application-layer (Holmgren, "Boring Auth," June 2026).
- Members present a short-lived **delegation token** (JWT bound to the space) to read/write; clients may need a **client attestation**.
- **No relay for spaces.** Apps sync directly from PDS hosts. Public discovery of anything in a space requires the app to read with a credential and republish.
- A space is deleted by its authority; syncers are notified best-effort. Moderation services are "just another reader."
- Holmgren argues **against universal community spaces**: one space per *modality* (events, forum, photos), because consent screens must be legible and access is all-or-nothing per space.
- Ecosystem PDS implementations already tracking the spec: ZDS (Zig), atproto-crates (Rust), rsky (Blacksky, Rust), HappyView (AppView framework).

**What this means for us:**
- Lucian's spaces implementation is spec-shaped but currently writes to the index, not the PDS. When the reference PDS ships spaces, his model should migrate; our records should be shaped so that migration is mechanical.
- For v1 (October), do **not** depend on the alpha for anything a user can't afford to lose. Use it in the sandbox to prove the shape.
- Per Holmgren, model the Free School as **several spaces**: `freeschool.members` (roster + roles), `freeschool.feedback` (evaluations), `freeschool.event.detail` per event (address). Not one big "community" space.

---

## 4. Alignment rules with Lucian's work [inferred, grounded in §1.2–§1.3]

1. **Adopt before extending.** Base event = `community.lexicon.calendar.event`. RSVP = `community.lexicon.calendar.rsvp`. Profile = `app.bsky.actor.profile` + `coop.lexicon.profile`. Roles = `coop.lexicon.membership`. Feedback/vouch = `coop.lexicon.evaluation`. Invites = `coop.lexicon.invite`/`.share`.
2. **Compose, never mutate.** Every Free School concept attached to an event is a sidecar with a strongRef back. Never add fields to the borrowed event. **(Decided 09-12.)**
3. **Placement follows audience.** Public: events, listings, skill declarations, needs-board posts, wiki resources, *positive* attestations. Space: membership roster, negative evaluations, exact addresses, appeals.
4. **Namespace as `.draft` under Benjamin's own authority** until Lucian normalizes: e.g. `life.benjamin.freeschool.draft.skill`. Then rename to `coop.lexicon.*` (or whatever `lexicon.coop` becomes). Design records so the rename is a find-and-replace.
5. **Derive, don't mint.** Badges and trust levels are AppView-computed views over evaluation + attendance records. If we later want a portable credential, emit an Open Badges 3.0 / W3C VC from the derivation — never store the badge as the source of truth.
6. **Roles over counters.** "Can host" = holds `membership.role ≥ 20` in the school's space. The *policy* for reaching 20 (attended 2 events with positive host confirmation) is app logic that writes the role claim; the protocol only sees the claim.
7. **Lucian reviews new types before they go canonical.** Not blocking v1 (decided 09-12), but the §6 proposal goes to him as a review packet.

---

## 5. Federation model [verified + inferred]

### 5.1 "There are no instances in atproto"
A free school is not a server. It is a **scene**: a DID (the school) that owns some spaces and publishes some listings. People are DIDs on whatever PDS they like. The *app* is an AppView that indexes records from many PDSes. So:

- **Hosted path:** we run a PDS (`pds.freeschool.com` or per-city `boulder.freeschool.com`) where non-technical people sign up with email, and an AppView + PWA. A new city = a new school DID + spaces, created from the admin dashboard in minutes. Same AppView can serve every city.
- **Self-hosted path:** a community runs its own PDS (reference PDS runs on a tiny VPS; the `pdsadmin` installer is one script) and *either* points at our public AppView or runs their own AppView from the same open-source repo. Their school DID lives on their PDS.
- **Cross-school visibility without the firehose:** each AppView keeps a **peer registry** — a list of PDS hosts and school DIDs it follows — and subscribes to those PDSes' `subscribeRepos` streams directly, backfilling with `getRepo`. Free schools opt into each other by exchanging `event.listing` records (curation) rather than by network topology. This is exactly the "inner nodes share directly, one heavier node bridges to the global firehose" shape Benjamin proposed on 09-11.
- **Forking a school:** because everything public lives in members' own repos, a breakaway school is a new DID + new spaces + new listings pointing at the same events. Membership and feedback don't transfer (they're in the old school's spaces) — which is the correct default; standing is re-earned, but the *evidence* (your attendance records, your positive attestations) travels in your repo.

### 5.2 Profile portability across cities
Your skills, your attendance records, the positive attestations others wrote *about you* (in their repos, pointing at your DID) are all public records. A new school's AppView indexes them the moment you log in and can grant a starting role by policy (e.g. "verified attendee elsewhere → skip the first gate"). Negative feedback stays behind in the old school's space. This satisfies "reputation is new here but your history comes with you."

### 5.3 Hosting cost reality
Reference PDS: ~1 vCPU / 1 GB RAM for hundreds of accounts. AppView for a city: similar. The heavy thing is only the global relay, which we're not running.

---

## 6. Draft data model — the net-new records [inferred; approved for drafting 09-12]

All placeholders under `freeschool.draft.*`. Public unless noted.

| Record | Author | Key fields | Notes |
|---|---|---|---|
| `skill` | the taxonomy authority (school or co-op DID) | `id` (stable NSID-like slug), `label`, `description`, `broader[]` (strongRefs), `prerequisites[]`, `externalIds{esco, wikidata, onet}` | Skills are records too, so they're forkable and mergeable. See §8. |
| `skillClaim` | the person | `skill` (strongRef), `level` (`learning|practicing|proficient|teaching`), `note` | Self-reported. Lives in the person's repo → portable. |
| `skillAttestation` | a peer | `subject` (DID), `skill` (strongRef), `direction: positive` | Use `coop.lexicon.evaluation` if it fits; else a sidecar typed by subject. Public and positive only. |
| `attendance` | the **host** (or the school, via app credential) | `event` (strongRef), `attendee` (DID), `participated: bool`, `level` | Host-attested. This is the evidence badges derive from. |
| `hostFeedback` | attendee | `event`, `host`, `direction`, `aspects{knowledge, teaching, experience}` (3-point, optional), `text` | **Space only** (`freeschool.feedback`). Never public. Aggregated by the AppView; host sees aggregate. |
| `request` | anyone with a profile | `skill`, `title`, `description`, `threshold` (RSVPs to unlock claim), `status` | Needs-board post. `rsvp` records point at it just like an event. A host `claim` sidecar converts it into an event. |
| `resource` | course host | `skill[]`, `title`, `uri|blob`, `license`, `event?` | Wiki input. See §10. |
| `policy` | the school DID | `text`, `version`, `effectiveAt` | Each school's rules. Public. |
| `moderationAction` | the school DID (app-held credential) | `subject` (record or DID), `action`, `reason`, `policyRef` | Written reason is mandatory — Lex/Benjamin requirement. Public or space per school policy. |
| `appeal` | the affected person | `action` (strongRef), `text` | Space (`freeschool.moderation`). |
| `course` | host | `title`, `sessions[]` (strongRefs to events), `skill[]` | Multi-event grouping. |

**Derived (AppView, not records):** badge set, trust level, "can host" flag, per-skill practitioner directory, per-skill wiki page, guild suggestions ("5 people list auto mechanics — form a guild?").

**Recurrence:** the community calendar lexicon has no recurrence field [verified]. atmo/OpenMeet materialize occurrences as ordinary events from a series template. Do the same; propose a `series` sidecar to Lucian.

**Spaces to declare (each a `.draft` space type):**
- `freeschool.members` — roster + `membership` role claims; read: members; manage: role ≥ 40.
- `freeschool.feedback` — `hostFeedback`; write: attendees of the referenced event; read: moderators + the AppView (for aggregation); the host never reads raw rows.
- `freeschool.moderation` — actions + appeals.
- per-event `event.detail` — Lucian's existing pattern.

---

## 7. Trust graph & reputation design [inferred]

**Principle: attestations, not scores.** Public artifacts are counts and presence ("attended 7 sessions, 3 at level 2, vouched for auto mechanics by 4 people"), never averages.

**Bootstrap ladder** (all app policy writing `membership.role` claims):

| Role | How you get it | Unlocks |
|---|---|---|
| 0 — visitor | none | browse calendar, RSVP (events are public) |
| 10 — member | log in with any DID **and** (invite link ∨ vouch ∨ attended 1 event) | profile, skill claims, needs-board posts, attest to others |
| 20 — host | attended ≥ 2 events with host-confirmed `participated: true` | create events; claim requests; upload resources |
| 30 — facilitator | hosted ≥ N events with no upheld negative feedback | approve new hosts' first events (if school policy requires approval) |
| 40 — steward | elected annually by role ≥ 10 (post-bootstrap) or founder-appointed (bootstrap) | moderation actions, policy edits, appeals |

Each threshold is a **per-school policy parameter**, editable in the admin dashboard. Some schools will want "anyone can host on day one" (Lex's "if you say you're Free School you're Free School"). Default to Lex's openness; make the gate opt-in.

**Anonymity of feedback:** the `hostFeedback` record is signed by the attendee's DID — the *protocol* knows who wrote it. Anonymity is an *access* property: the space policy prevents the host from reading rows; the AppView releases only aggregates and only once ≥ k responses exist (k-anonymity, k=3 default). Moderators can see authorship for abuse handling. Lucian's ZK collective-credential idea would upgrade this to true unlinkability later; not needed for v1.

**Sybil resistance:** the invite/vouch gate + the attendance requirement (you must physically show up and a host must confirm) is a strong, cheap proof-of-personhood for a local network. Don't add more.

**Host-side attestation abuse:** a host confirming fake attendees inflates their friends. Mitigation: attendance confirmations are public records — visible patterns are socially checkable, and `moderationAction` can void them. Good enough for v1.

---

## 8. Skill taxonomy [verified facts + inferred design]

**Requirements:** universal IDs; hierarchy (oil change ⊂ mechanic); prerequisites; community-extensible; cross-school mergeable; cross-references to people, events, requests, resources.

**Backbone candidates:**
- **ESCO** (EU) — ~14k skills with URIs and a hierarchy (skill pillar), multilingual, free to use with attribution. Strong for trades and practical skills. Best fit as the seed.
- **O*NET** (US DOL) — occupation-centric; skills are broad. Use for cross-reference only.
- **Lightcast Open Skills** — ~30k skills, free API, industry-oriented; weaker on crafts, foraging, hide tanning.
- **Wikidata** — a QID for nearly any concept ("hide tanning" exists); good as the universal join key when ESCO lacks a node.

**Recommendation:** skills are **records** (`skill`) authored by a taxonomy authority DID (initially Benjamin's sandbox; later the co-op). Seed ~300–500 nodes relevant to a free school (trades, food, land, repair, care, arts, organizing) from ESCO, each carrying `externalIds.esco` and `externalIds.wikidata` where they exist. Communities propose new nodes (a `skill` record in the *school's* repo with `status: proposed`); the AppView shows them immediately; periodic merge into the canonical set by the co-op. Two relations only for v1: `broader` (is-a / part-of, single tree with multi-parent allowed) and `prerequisite`. Levels (1–3) live on the *event*, not the skill, so "Auto mechanics, level 2" is an event attribute that badges inherit.

**Why records rather than a JSON file:** portability and forkability — a self-hosted school can carry its own taxonomy, and the merge story is the same as for any other record.

**Credential interop:** if we ever emit portable badges, map to **Open Badges 3.0** (1EdTech, built on W3C Verifiable Credentials 2.0). Kaliya's stack (Project Weave) speaks VCs natively; this is the bridge to "authenticate as a group."

---

## 9. Moderation & governance [inferred, from Lex + today's dictation]

- **Per-school policy** is a public `policy` record; the app renders it on join.
- **Minimal toolset, toggleable per school:** remove a record from the school's listing (never from the author's repo — we *can't*), suspend a role, require first-event approval, close a needs-board post. Each action requires a written reason (`moderationAction.reason`) and is appealable (`appeal`).
- **Appeals:** any affected person may file; stewards must answer in writing within a school-set window. Both live in the moderation space.
- **Annual steward election** after bootstrap: role ≥ 10 members vote; simplest viable mechanism is approval voting via signed `vote` records in the members space, tallied by the AppView. Defer the record type; note it for Lucian.
- **Exit = fork.** A new school DID can `event.listing` the same public events and re-index the same public attestations. Nothing to "pull" except what's already public.
- **Labelers** are the ATProto-native way to share moderation *signals* across schools ("this account was removed for harassment at Boulder") without sharing private data. Optional, later, and politically delicate given Lex's network — default off.

---

## 10. Wiki & curriculum [inferred]

- Hosts attach `resource` records (link or blob) to a course/event, tagged by skill.
- The **skill page** is derived: resources tagged with the skill ∪ practitioners with a `skillClaim` ∪ upcoming events ∪ open requests, with submitter attribution.
- Don't build a wiki engine. The skill page is a rendered view; if a school wants editable long-form pages, adapter to an external wiki (Outline, Wiki.js, or Leaflet on ATProto) keyed by the skill ID. Leaflet (`site.standard.document`) is the ATProto-native option and keeps documents in authors' repos — worth a look before choosing.
- Licensing: default resources to CC BY-SA; capture `license` on the record.

---

## 11. Identity & onboarding [verified + inferred]

Two front doors, both landing on a DID:

1. **"I have a Bluesky/ATProto account"** → standard ATProto OAuth (login by handle). Their PDS stays wherever it is. We publish a **permission set** lexicon so the consent screen reads "Free School: create classes, RSVPs, and skill claims."
2. **"I'm new"** → email (or Google) signup that creates an account **on our PDS** behind the scenes — the pattern Roomy and OpenMeet use, and what atproto.com recommends for first-time users. They can claim/migrate the account later.

Then: **invite link or vouch** (Lucian's `invite`/`share`) gates the *profile*, not the calendar. Set a **home school** on first login; the PWA scopes to it.

**Correlation risk (flag for Lex):** a DID is globally indexable and public records are public forever-ish. Guidance for the school: pseudonymous handles are fine; don't put legal names in profiles; membership roster lives in a space. Ask Lex whether the *skill claims* themselves should default to public — for most people yes, for some no. Offer a per-claim visibility toggle by placing private claims in the person's own single-member space.

---

## 12. Prior art to reuse (open source, ATProto) [verified]

| Project | What to take |
|---|---|
| **atmo.rsvp / atmo-events** (flo-bit) | Meetup alternative on `community.lexicon.calendar`; recurring events (rough); notifications via **atproto-notify** (`atmo.pub`). Active, friendly, hit the same groups wall last week. |
| **Contrail** (flo-bit) | Reads spaces from the alpha and republishes public content — the "credentialed reader" we'll need. |
| **OpenMeet** (Tom Scanlan) | Series object for recurrence; email notifications; email/Google signup that mints an atproto account. Migrating toward atmo. |
| **Smoke Signal** (Nick Gerakines) | Origin of the calendar lexicon; RSVP acceptance/ticket pattern; `eventConfiguration`. Rust. |
| **Roomy / The Arbiter** (Muni Town, zicklag) | Group DIDs + membership/roles API over spaces. The likely standard. `github.com/muni-town/arbiter`. |
| **bulletin.my** (Bluesky) | Reference spaces app + alpha SDK usage. |
| **HappyView** | AppView framework with experimental spaces support. |
| **Dandelion** (Stephen Reid) | One-way publish to ATProto today; Benjamin is connecting him with Lucian for two-way. |
| **Beacon / Almanac** (Lucian) | Place normalization, Overture places, event publishing pipeline. Our locations should use `community.lexicon.location` exactly as Beacon does. |

**Do not build:** our own membership service, our own relay, our own wiki engine, our own notification transport.

---

## 13. Product & PWA notes [inferred]

- Luma-grade event pages: hero, host card (with attestation counts, not scores), skill chips, level, materials list, RSVP, "bring a friend" invite link, supplies-donation note (school-policy gated), add-to-calendar, share.
- iOS-native feel: translucent frosted surfaces, large-title headers, bottom tab bar (Calendar · Skills · Requests · Me), sheet-style modals, haptic-feeling transitions. Respect `prefers-reduced-transparency`.
- PWA: installable; web push works on iOS only after Add-to-Home-Screen (16.4+) — onboarding must nudge install *before* promising reminders. Offline: cache the next 30 days of the home school's calendar for the parking-lot moment.
- Print view: monthly zine layout (Lex's analog ethos). Cheap, on-brand, differentiating.
- Admin dashboard: policy editor, role thresholds, moderation queue, newsletter (monthly "upcoming classes"), peer-school registry, export (SQLite/CAR).

---

## 14. Risks & open questions

**For Lucian (review packet, not blocking v1):**
1. Extend-vs-sidecar rule, in writing (we are proceeding on sidecar).
2. Review of the net-new types in §6, and whether `skillAttestation` should just be `coop.lexicon.evaluation`.
3. Sandbox PDS: is it the spaces-alpha image? If not, feedback goes to the app DB behind a spaces-shaped interface for v1.
4. School DID custody long-term — Syntropic's harness, an Arbiter instance, or the app (v1: the app).
5. Series/recurrence sidecar.

**For Lex:**
1. Score-vs-attestation reconciliation (§7) — today's dictation drifts toward ratings; confirm the anonymous-aggregate compromise.
2. Default openness of hosting (day-one hosts vs. two-events gate).
3. Which profile data is public by default.
4. `freeschool.com` — confirm ownership; per-city subdomains as handle domains? (Aaron's caution: user handles on the core domain are gone forever.)

**Technical:**
- Spaces alpha will break weekly; nothing user-facing may depend on it before COhere.
- Permissioned-data export unsolved → a school migrating PDS today loses feedback/roster unless we keep an app-side export.
- Admin co-edit requires the app to custody the school credential — a real trust concentration. Mitigate with audit-logged `moderationAction` records and a threshold (two stewards) for destructive actions.

---

## 15. Phased plan

**Phase 0 — this week.** Stand up sandbox PDS. Repo scaffold (open source, Echo + Lex as co-admins). Seed skill taxonomy from ESCO. Send Lucian the review packet.

**Phase 1 — v1 before COhere (October).** Public-record core: OAuth + email signup on our PDS; profiles + `skillClaim`; events on `community.lexicon.calendar.event` with `config` sidecar and skill/level sidecar; RSVP; host-attested `attendance`; needs board with threshold-claim; derived badges; invite-link onboarding; role ladder as app policy writing `membership` claims; monthly newsletter; print zine view; admin dashboard v0; **tag-routed `event.listing` exchange with the COhere calendar (Aaron Gabriel)**. Anonymous feedback stored app-side behind a spaces-shaped interface. PWA.

**Phase 2 — Q4.** Move feedback, roster, and event detail into real spaces on the sandbox as the alpha stabilizes; Arbiter (or Syntropic harness) custody of the school DID; appeals; resource records + derived skill pages; courses/series.

**Phase 3 — Q1 2027.** Peer-PDS registry + direct subscribe; one-click "start a free school" (hosted) and a `docker compose` for self-hosters; second city; steward elections; optional labeler; Open Badges 3.0 export.

---

## 16. Research swarm plan

The nine briefs (R1–R9) with dispatch commands live in [[vault/projects/local-alternatives/free-school/2026-09-12_claude-code-handoff]]. Summary: R1 Spaces alpha hands-on · R2 calendar lexicon & sidecar inventory (+ `skillLevel`, `series` drafts) · R3 The Arbiter · R4 direct-PDS federation script · R5 ESCO/Wikidata skill seed · R6 prior-art code review · R7 free-skool history → ten design constraints · R8 PWA on iOS · R9 privacy threat model.

---

## 17. Sources

**Vault (Parachute):** `vault/projects/local-alternatives/reports/2026-09-10_lex-free-school-boulder-report`; `…/2026-09-12_regenos-free-school-building-blocks-handoff`; `vault/agent/reports/2026-09-11_regen-hub-atproto-session`; `…/2026-09-11_local-alternatives-interview-week-synthesis` (summary only); `vault/organizations/Free School Boulder`; active tasks `build-free-school-boulder-app-v1-before-cohere`, `wire-free-school-and-cohere-calendars-together`, `fiscally-host-free-school-donations`.

**Gitcoin Brain:** `knowledge/atproto-vs-nostr-for-regenos`; `knowledge/project-weave-kaliya-young-atproto-groups` (summary); `knowledge/actualize-juicy-partnership-analysis` (summary); `projects/regenos-senius`.

**Primary web (read 2026-09-12):** atproto.com — "The Atproto Spaces Alpha is Live" (20 Aug 2026), glossary, self-hosting guide, The AT Stack; `bluesky-social/proposals` 0016 (search snippets; GitHub blocks fetch); D. Holmgren, "Modeling communities on permissioned data" and "Permissioned Data Diary 6: Boring Auth" (Jun 2026); zicklag, "The Arbiter"; Roomy GA post; `flo-bit/atmo-events` issue #78 (Sep 2026); Smoke Signal repo + "Community Lexicons"; plyr.fm permission-sets research note; Neighborhood Anarchists "Grow Your Own Free Skool"; PM Press / Shantz, "Spaces of Learning: The Anarchist Free Skool."

**Not yet read (swarm):** the full 0016 README; `muni-town/arbiter`; `bluesky-social/bulletin`; ESCO API docs; Open Badges 3.0 spec; Lucian's `regenos` repo directly.
