---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r9"
type: "research"
title: "R9 \u2014 Privacy threat model (human-review-required)"
review: "human-review-required"
projects: ["local-alternatives"]
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r9_privacy-threat-model"
parachute_id: "2026-09-12-19-24-00-091240"
tags: ["atproto", "free-school", "human-review-required", "local-alternatives", "privacy", "research"]
---

# R9 — Privacy threat model (human-review-required)

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R9 · review: human-review-required*

> **HUMAN REVIEW REQUIRED.** This document makes recommendations that affect the physical
> safety and legal exposure of people in Palestine solidarity, anti-fascist, and
> encampment-support organizing. Nothing here should be shipped as a default, published as a
> privacy policy, or quoted to members before review by (a) the organizer, (b) at least two
> members who carry legal exposure, and (c) a lawyer (CLDC / EFF / NLG Colorado are the
> obvious calls). Several recommendations below reverse settled-looking product instincts.
> Where I am uncertain I say so in **Confidence / not verified**.

---

## TL;DR

1. **The protocol is the adversary's best tool, and it costs them nothing.** Anyone can open an
   unauthenticated WebSocket to `wss://jetstream.us-west.bsky.network`, filter on up to 100
   collection NSIDs, and receive every Free School record written anywhere on the network, in
   real time, with the full record body, forever. Jetstream describes itself as a
   "Full-network archive, replay, and streaming service for atproto." No subpoena, no account,
   no relationship with us. Every mitigation discussion has to start here: **a public record is
   a permanent, globally-indexed, cryptographically signed disclosure.**

2. **Three records in the v1 design are, as specified, unacceptable for this community.**
   (a) `community.lexicon.calendar.rsvp` in the attendee's repo pointing at a school event —
   this *is* the co-presence graph, published by the person it endangers. (b)
   `freeschool.draft.attendance` written by the host naming the attendee DID — a signed
   third-party assertion that a named person was at a named place at a named time, which the
   named person cannot delete because it is not in their repo. (c) `coop.lexicon.membership`
   role claims written by the school — a literal public membership roster. Recommendation: RSVP
   and attendance go app-side by default; attendance is never a public record naming a DID;
   membership claims are app-side with narrow individual opt-in.

3. **The default sign-in door should be a fresh DID on our PDS, not their Bluesky DID.** Signing
   in with an existing atproto account puts Free School records in the same repo as that
   person's public Bluesky posts, under the same DID, permanently, and the linkage cannot be
   retracted. Flip the button order and the visual weight.

4. **Deletion does not exist at the network layer.** Repo deletes leave no tombstone, but the
   commit already went to the relay and into third-party archives. The PLC directory is worse:
   its audit log is unauthenticated, bulk-exportable, append-only, and the spec states outright
   that PII in `alsoKnownAs` "will be publicly visible even after DID deactivation, and can not
   be redacted or purged." Handle history and PDS-move history are permanent. Tell members this
   in plain words *before* their first public write, not in a policy page.

5. **Spaces will not save us, and we should stop planning as if they will.** Proposal 0016 is
   explicit: "The permissioned data protocol provides access control, not confidentiality. It
   is not end-to-end encrypted." The author's PDS host reads everything; the space authority
   (us, in v1) reads everything; every member reads everything; and per Holmgren, every app any
   *one* member authorizes gets the whole space — "AtmoBoards doesn't just get Alice's slice.
   It gets the whole forum." Spaces do buy one real privacy property (see §6: deniability from
   MAC-based commits) and they are not relayed. But safety-report narratives and anonymous
   feedback must never go in one.

6. **Our own Postgres is the subpoena target, so the engineering goal is to not hold the
   answer.** "Anonymous" feedback with an `author_did` column is not anonymous; it is
   deanonymizable by us, by a breach, and by legal process. Make it structurally unlinkable
   (§ default #12), cap PITR and snapshot retention (long backup windows silently void every
   retention promise), and log almost nothing.

7. **One non-obvious structural leak: hosting members on our own PDS makes membership globally
   enumerable.** The PDS endpoint lives in the public DID document, and `plc.directory/export`
   streams the whole directory to anyone. "List every DID whose service endpoint is
   `pds.freeschool.example`" is a membership roster that no amount of private-record discipline
   can suppress. Mitigation is a neutral, non-descriptive PDS hostname shared with unrelated
   communities — mitigation, not a fix.

---

## Assets and adversaries

### Assets, ranked by harm if lost

| # | Asset | Why it matters | Worst realistic outcome |
|---|---|---|---|
| A1 | **Membership graph** — who is part of this school | Associational; the thing a grand jury subpoena or a doxxing campaign actually wants | Mass doxxing; conspiracy-framing of an association; employer/visa/school retaliation at scale |
| A2 | **Co-presence graph** — who was physically where, when | RSVP × event(place, time); attendance records | Placing a specific person at a specific action; corroborating a charge; stalker intercept |
| A3 | **Identity linkage** — pseudonym ↔ legal name ↔ other accounts | One link collapses every other protection | Full deanonymization of an organizer operating under a pseudonym |
| A4 | **Feedback authorship** — who criticized whom | Small community, power asymmetry with hosts | Retaliation, expulsion, chilling of safety reporting |
| A5 | **Skill/interest disclosure** | The *taxonomy* is political: "ICE raid response", "street medic", "doxx defense", "encrypted comms" | Declared capability read as declared intent; used as evidence of planning |
| A6 | **Contact and device data** — email, IP, push endpoints | Bridges to subpoenable third parties (Google, Apple, ISP) | Device/location identification via a second subpoena |
| A7 | **Invite / vouch graph** | The recruitment tree *is* the organizing structure | Maps leadership and trust relationships; targets the hubs |
| A8 | **Moderation and safety-report content** | Most sensitive free text in the system; allegations about named people | Survivor outing; defamation exposure; weaponization by the accused |
| A9 | **School identity and DID custody** | Operator holds signing + rotation keys in v1 | Compelled or breached signing *as the school*; retroactive fabrication of membership/attendance records |
| A10 | **Operational continuity and trust** | People stop using the tool, or stop organizing | Platform abandonment; the safest members leave first |

### Adversaries and capabilities

| ID | Adversary | Capabilities | Cost to them | Legal process needed |
|---|---|---|---|---|
| D1 | **State / law enforcement** (Boulder PD, CSP, FBI/JTTF, DHS I&A, grand jury, USCIS vetting) | Subpoena us; subpoena the member's PDS host (for OAuth-door members, a US company); subpoena Google/Apple/registrar; 2703(d) orders; NSLs with gag; search warrants; physical surveillance at published events; **and, for everything public, simply scraping — no process at all** | Low for public data; moderate for compelled data | None for public records; varies otherwise |
| D2 | **Doxxers / far-right "researchers"** (Canary-Mission-style lists, Telegram/Discord research collectives) | Bulk scrape, cross-reference, archive, publish dossiers, contact employers/landlords/universities, tip off ICE | Near zero | None |
| D3 | **Abusive ex-member / stalker** | Legitimate insider access (was on the member list); knows pseudonyms; uses RSVPs to *predict a target's future physical location* | Zero | None |
| D4 | **Hostile or compromised PDS operator** | Reads all repo content including permissioned/space records; holds the repo signing key → can forge records attributed to the user; sees IPs and session metadata; can withhold or tamper | Varies | None (they hold the data) |
| D5 | **Us — the app operator** | Custodies the school DID; runs Postgres; sees feedback authorship, emails, IPs, invite graph; can deanonymize k-anonymity aggregates; can be breached, compelled, or socially captured; insider volunteers with DB access | Zero | None |
| D6 | **Data brokers / scrapers / AI training corpora** | Bulk firehose ingest, permanent retention, resale, republication; third-party indexers (pdsls.dev, atproto-browser, clearsky) already do this as a public service | Near zero | None |
| D7 | **Ambient / opportunistic** — employers, landlords, university conduct offices, journalists, immigration adjudicators | Google a name; read a public repo; use a third-party viewer | Near zero | None |

**The asymmetry to internalize:** D1 is the adversary we write policies about, but D2, D3, and D7
are the adversaries who will actually cause harm, and they need no legal process at all — only
public records. Designing for subpoena resistance while publishing the co-presence graph is
backwards.

---

## What each surface reveals

### 1. A member's public atproto repo

| What | What it reveals | Notes / citation |
|---|---|---|
| Set of collection NSIDs in the repo | **Membership itself.** The mere presence of a `freeschool.*` collection declares affiliation before any content is read | Repos are "entirely public and verifiable"; `com.atproto.sync.listReposByCollection` enumerates every DID that has written a given collection |
| Record key (TID) | **Microsecond-precision creation time** plus a 10-bit random "clock identifier" | TID = 0 bit + 53 bits µs since epoch + 10 bits clock id, base32-sortable, 13 chars |
| `createdAt` / `startsAt` / `endsAt` fields | Client-declared times; timezone offset if included; may disagree with the TID (reveals backdating) | `community.lexicon.calendar.event` fields |
| Signed commit + MST | **Non-repudiation.** Each record sits in a signed Merkle tree with a signed root. A screenshot is deniable; a relay-witnessed signed commit is not | "self-certifying storage for public account content" |
| Blob references | `{cid, mimeType, size}`; originals fetchable via `com.atproto.sync.getBlob` | Spec: servers "might" block blobs with sensitive EXIF — **not required**, and the reference implementation has long-standing TODOs |
| Avatar / photo blobs | **EXIF GPS → home address**; faces → cross-platform perceptual-hash linkage; device model and software from EXIF | Spec acknowledges "EXIF metadata in JPEG image files may contain GPS coordinates" |
| Deleted records | Repo delete leaves "without leaving a trace or 'tombstone'" — but the creating commit already shipped on the firehose and into archives | Deletion is local; propagation is not |
| `rev` on commits | Another TID → timeline of *all* activity, including non-Free-School activity, in the same repo | Activity-pattern fingerprinting (sleep schedule, timezone, employment) |

### 2. The PLC directory (`plc.directory` / `web.plc.directory`)

| Endpoint | Auth | What it gives an adversary |
|---|---|---|
| `GET /:did` | none | Current DID document: PDS endpoint, verification methods, `alsoKnownAs` handles |
| `GET /:did/data` | none | Current PLC state |
| `GET /:did/log/audit` | none | **Full, permanent operation history**: every handle ever used, every PDS endpoint ever used, every rotation-key set, every timestamp, tombstones |
| `GET /export` (JSONL, paginated) and `WSS /export/stream` | none | **The entire directory, in bulk, streamed.** No targeting required |

What this yields concretely:

- **Handle history is permanent and public.** "you can see the past history of all handles that
  were assigned to this DID, and **this information can't be erased**" — the privacy/OPSEC
  warning is in the community documentation itself. A member who organized under their real
  name in 2025 and renamed to a pseudonym in 2026 is linked forever.
- **PII in `alsoKnownAs` is unredactable.** The spec: "personally identifiable information (PII)
  encoded in `alsoKnownAs` URIs will be publicly visible even after DID deactivation, and can
  not be redacted or purged."
- **PDS-move history is a jurisdiction and affiliation trail.** "moved from bsky.social to
  pds.freeschool.example at 2026-10-04T18:22Z" is both a membership signal and a subpoena target
  list.
- **Rotation-key reuse links pseudonyms.** Up to 5 priority-ordered rotation keys per DID, all
  published as `did:key`. Two "unrelated" DIDs sharing a rotation key are the same operator.
  Anyone with the `/export` feed can build that index trivially.
- **DID genesis timestamp** = account age = "this pseudonym was created three days after the
  encampment."
- `did:web` avoids the audit log entirely ("do not store a history of previous versions ...
  there's no way to view past handles") but permanently binds the identity to a domain you must
  keep alive, and surfaces you in WHOIS and Certificate Transparency. Not a win here.

### 3. Relay / firehose / Jetstream / third-party indexers

| Surface | Auth | Retention | What it yields |
|---|---|---|---|
| Relay firehose (`com.atproto.sync.subscribeRepos`) | none for public relays | Relay-dependent backfill window | `#commit` events carry a **CAR slice with the actual record bytes**, plus `#identity`, `#account`, `#sync` events |
| **Jetstream** (`wss://jetstream.us-west.bsky.network`, `...us-east...`) | **"No authentication is required for the live tail; these instances serve the full network."** | Self-described "**Full-network archive, replay, and streaming service**"; cursor-based replay, at-least-once delivery | Decoded JSON records, filterable by **up to 100 collection NSIDs** (wildcards like `freeschool.*` allowed) and **up to 10,000 DIDs** per subscription |
| `com.atproto.sync.listReposByCollection` | none | live | **Enumerate every DID that has ever written collection X** = instant roster |
| `com.atproto.sync.getRepo` (CAR) | none | live + history | Full repo snapshot including history blocks |
| pdsls.dev / forks | none | n/a | Browse any repo: collections, records as JSON *and raw CBOR*, blobs, full CAR export |
| atproto-browser | none | n/a | Browse any PDS by handle or DID with rich previews |
| clearsky.app | none | historical | Demonstrates the correlation class: who blocks/blocked/unfollowed you, *retroactively*, because "the evidence sits in public, permanently" |
| web.plc.directory / internect-class viewers | none | permanent | DID docs and audit logs in a human-readable UI |

**The load-bearing conclusion:** we do not control distribution of any public record for one
second after it is written. Retention is not ours to set. "We'll delete it" is not a true
sentence about public records, and saying it to a member is a safety failure.

### 4. An RSVP and an attendance record, specifically

`community.lexicon.calendar.rsvp` (verified against the lexicon JSON) has exactly two required
fields: `subject` (a `com.atproto.repo.strongRef`, i.e. `{uri, cid}`) and `status` (`going` /
`interested` / `notgoing`). The `uri` is
`at://<schoolDID>/community.lexicon.calendar.event/<rkey>`.

`community.lexicon.calendar.event` carries `name`, `description`, `createdAt`, `startsAt`,
`endsAt`, `mode`, `status`, `rsvpExpected`, `uris`, and `locations[]` — a union of
`event#uri`, `community.lexicon.location.address`, **`community.lexicon.location.fsq`**
(Foursquare venue ID), **`community.lexicon.location.geo`** (lat/long), and
`community.lexicon.location.hthree` (H3 cell).

So a public RSVP yields:

- **attendee DID × event URI × intent × decision timestamp (from the rkey TID)**
- joined to the public event: **event name, description, precise start/end, and precise place**
  (street address, or lat/long, or a stable Foursquare venue ID that joins to other datasets)
- = a **co-presence graph**: for any pair of members, the set of places and times they were
  both present. This is the exact artifact that conspiracy theories, both journalistic and
  prosecutorial, are built from.
- `notgoing` leaks too: it proves awareness of, and invitation to, the event.
- `interested` leaks curiosity about a topic the member never attended.
- **Forward-looking:** an RSVP to a *future* event publishes where a person will be, at a known
  time. For D3 (abusive ex-member) this is the single most dangerous field in the system.

A host-written `freeschool.draft.attendance` record naming the attendee DID is worse on three
axes: it is a **third party's signed assertion** about someone's physical presence; the subject
**cannot delete it** because it lives in the school's repo; and it is **retrospective and
therefore corroborative** — exactly what a warrant affidavit or a dossier wants. Same logic
applies to `coop.lexicon.evaluation` ("I attest X taught me Y" implies co-presence and publishes
a named social edge) and to `coop.lexicon.membership` (a public roster).

### 5. What a space leaks

| Who | What they can read | Source |
|---|---|---|
| Everyone on the member list | **Everything in the space.** "If your DID is on the list, you can read and sync everything in the space" | Holmgren, *Boring Auth* |
| The author's PDS host | All permissioned records that author writes, unencrypted. "Records live in per-space permissioned repos on the author's PDS" — so an OAuth-door member on a commercial PDS has their Free School space records on that company's servers | Spaces alpha |
| The space authority (= us, in v1) | **The full member list** (required, to issue space credentials) and the credential-issuance log: which app, for which member, at what time → access-pattern metadata | 0016; Arbiter |
| Any app *any one member* authorizes | The **whole space**, not that member's slice. "AtmoBoards doesn't just get Alice's slice. It gets the whole forum." One member installing a sketchy client exfiltrates the entire space | Holmgren, *Boring Auth* |
| Nobody, via the firehose | "there is no concept of a relay for data stored in a space ... Applications will sync space data directly from PDS hosts" — **spaces are not archived by the public firehose.** This is the single biggest real win | Spaces alpha |

Two further notes:

- **Spaces are explicitly not confidential.** 0016: "The permissioned data protocol provides
  access control, not confidentiality. It is not end-to-end encrypted." And: "Services (both
  PDSes and authorized applications) can read the data they handle, which is required for
  server-side features such as search, indexing, notifications, aggregation, and moderation."
  E2EE is declared out of scope.
- **Permissioned commits are deniable, and that is worth real money.** 0016: "A user does not
  sign the digest directly since a signature over the content digest would be a rebroadcastable
  proof" — commits use symmetric MACs bound to random nonces. A leaked *space* record is a
  screenshot-grade artifact; a leaked *public* record is a signed, verifiable one. When arguing
  the public-vs-space question internally, this is the strongest technical argument after
  archiving.
- **Alpha means alpha.** The announcement warns the code "lacks security review," data "isn't
  backed up," and "we may do destructive data migrations." Do not put life-safety data there
  yet. (Consistent with the settled decision: v1 is Postgres behind a Spaces-shaped interface.)

### 6. Our Postgres

| Holding | Leak | Adversary |
|---|---|---|
| Feedback rows with `author_did` (even where the UI says "anonymous") | We are the deanonymization oracle, by breach, insider, or subpoena | D1, D5, D3-via-D5 |
| k-anonymity aggregates published over time | **Differencing attack**: a host who knows the attendee list and watches a live counter, or sees an n=4 then an n=3 cohort, recovers individual feedback | D3, hosts |
| Email addresses (email-signup door) | Often contains a legal name; bridges to Google/Microsoft → second subpoena → IP history, recovery phone | D1, D7 |
| IP logs / platform request logs (Vercel, Neon, CDN) | Home address via ISP subpoena; co-location of two "unrelated" accounts | D1, D5 |
| Push subscription endpoints (FCM/APNs) | Stable device identifiers → Apple/Google subpoena → device and location | D1 |
| Invite tokens with `inviter_did` | The recruitment/vouch tree | D1, D2 |
| Moderation case files with written narratives | The most damaging free text in the system; survivor identity | D1, D2, D3 |
| Backups, PITR windows, Neon branches/snapshots | **Silently defeat every retention and deletion promise.** "Deleted" rows live in a 30-day PITR window and in every branch | all |
| Analytics / error reporting (Sentry, etc.) | DIDs, emails, and event URLs in breadcrumbs and referrers | D5, D6 |
| Referrer leakage from third-party assets on authenticated pages | Event URLs and handles leaked to CDNs, font hosts, tag managers | D6 |

---

## Attack paths with ratings

Likelihood (L) and Impact (I) on 1–5. Risk = L × I. Bands: **Critical 20–25**, **High 12–19**,
**Moderate 6–11**, **Low 1–5**.

| # | Path | Adversary | L | I | Risk | Notes |
|---|---|---|---|---|---|---|
| P1 | Subscribe Jetstream to `freeschool.*` + `community.lexicon.calendar.rsvp`; build full roster and co-presence graph; archive permanently | D2, D6, D1 | 5 | 5 | **25 Critical** | Free, unauthenticated, no relationship to us, retroactive via replay. Assume it is already happening the week we launch |
| P2 | Host-written public attendance records naming attendee DIDs → signed third-party proof of physical presence, undeletable by the subject | D1, D2, D3 | 4 | 5 | **20 Critical** | Converts a community record into an evidentiary one |
| P3 | Member signs in with existing Bluesky DID → Free School records share a repo and DID with their named public identity; linkage is permanent | D2, D7, D1 | 5 | 4 | **20 Critical** | The default button determines this outcome for most users |
| P4 | Abusive ex-member reads public/forward RSVPs to predict a target's future location and time | D3 | 4 | 5 | **20 Critical** | Most likely severe *individual* harm; no legal process, no sophistication |
| P5 | Doxxing dossier: scrape skill claims + attendance + avatar + handle history → publish → employer/landlord/visa/harassment | D2, D7 | 4 | 4 | **16 High** | Skill taxonomy does much of the work ("ICE raid response") |
| P6 | Public event record with `location.geo` or `location.fsq` + `startsAt` → physical disruption, counter-protest, or police presence at the event | D2, D1 | 3 | 5 | **15 High** | Partly inherent ("events are public by design"); answer is tiered location disclosure |
| P7 | Member requests deletion; we can only delete our copy; archives and PLC log persist → expectation violated at the worst moment | D6 (structural) | 5 | 3 | **15 High** | Guaranteed to occur. Only mitigation is honesty up front + a "burn and re-pseudonymize" flow |
| P8 | PLC audit log pseudonym linkage: former handles + rotation-key reuse + PDS-move timestamps + DID genesis time | D2, D1 | 3 | 4 | **12 High** | Unfixable; guidance-only. Rotation-key reuse across identities is the sharpest edge |
| P9 | PDS-endpoint enumeration via `plc.directory/export` → "every DID hosted on our PDS" = membership roster | D2, D1 | 3 | 4 | **12 High** | Structural consequence of hosting. Mitigate with a neutral shared hostname |
| P10 | Vanity/self-owned handle → DNS → registrar WHOIS / Certificate Transparency → legal name, address, phone | D2, D7 | 3 | 4 | **12 High** | Only affects self-domain users; so don't offer it in the signup flow |
| P11 | Subpoena (possibly gagged) to us for Postgres: feedback authorship, emails, IPs, invite graph, attendance | D1 | 2 | 5 | **10 High** | Mitigation is minimization, not policy. Don't hold the answer |
| P12 | Avatar EXIF GPS → home address | D2, D3 | 2 | 5 | **10 High** | Cheapest fix in the document; do it unconditionally |
| P13 | Insider: a volunteer admin with DB access becomes the hostile party (D3 pattern, or is socially captured) | D5 | 2 | 5 | **10 High** | Access control, 2-person rule on moderation data, audit trails |
| P14 | k-anonymity differencing on feedback aggregates by a host who knows the attendee list | hosts, D3 | 3 | 3 | **9 Moderate** | Chills safety reporting, which is how the worst outcomes go unreported |
| P15 | Invite bearer token leaked (screenshot, group chat, scrape) → infiltration, and inviter exposure if the token or landing page names them | D2, D3 | 3 | 3 | **9 Moderate** | Design the token to carry nothing |
| P16 | Profile-photo perceptual hashing links the Free School pseudonym to other platforms | D2 | 3 | 3 | **9 Moderate** | Default to a generated identicon; never nudge for a photo |
| P17 | Operator custody of the school DID: compelled or breached signing *as the school*; retroactive fabrication of membership/attendance records | D1, D5 | 2 | 4 | **8 Moderate** | Split rotation keys with a second steward; a forced handover shows as a PLC op, which is itself a canary |
| P18 | Hostile/compromised PDS operator reads space data and/or forges records using the repo signing key | D4 | 2 | 4 | **8 Moderate** | Higher for members on commercial PDSes; unfixable at the protocol layer |
| P19 | Email/push-endpoint pivot: subpoena Google/Apple/ISP using identifiers we handed them | D1 | 2 | 4 | **8 Moderate** | Minimize, and never use tracking pixels in email |
| P20 | Public `coop.lexicon.evaluation` attestations → named social graph edges + implied co-presence | D2, D1 | 3 | 3 | **9 Moderate** | A disclosure *about a third party*; needs double opt-in |
| P21 | TID clock-id + write-timing correlation to link two accounts operated by the same person/client | D6 | 1 | 3 | **3 Low** | Speculative; flagged in **not verified** |

---

## Mitigations by layer

### Layer 0 — Protocol-level: what cannot be fixed

State these as facts in design docs and in member-facing copy. Do not design as if they are
negotiable.

1. Public records are globally readable, permanently archived by third parties, **signed**
   (hence non-repudiable), and **deletion does not propagate**.
2. The PLC audit log is **permanent, unauthenticated, and bulk-exportable**. Handle history,
   PDS history, rotation-key history, and timestamps cannot be erased. PII in `alsoKnownAs`
   cannot be redacted.
3. A DID's **PDS endpoint is public**, so *where you are hosted* is a visible affiliation, and
   it is enumerable in bulk.
4. **The existence of a record is a disclosure**, independent of its contents: collection NSIDs
   are listable, and `listReposByCollection` enumerates writers.
5. **Spaces provide access control, not confidentiality**, and are not E2EE. The PDS host, the
   space authority, every member, and every app any member authorizes can read everything.
6. **One member's app choice is everyone's exposure** inside a space.
7. We cannot stop anyone from running a Free School indexer and republishing whatever is public.
8. We cannot make a public record deniable. (We *can* choose spaces, where MAC-based commits
   give deniability on rebroadcast.)

### Layer 1 — App defaults: what we choose

The decisive list is the next section. The governing principles:

- **Private by default, public by deliberate act.** One `visibility` field, one write path.
- **Never publish a record about a person that the person did not write.** If it names a DID,
  that DID's holder writes it, or it isn't public.
- **Don't hold the answer.** Structural unlinkability beats policy promises under subpoena.
- **Do the thinking for the member.** A sensitive-skill taxonomy flag we maintain beats a
  toggle a tired person clicks at 11pm.
- **Never say "we'll delete it"** about anything that touched the network.

### Layer 2 — User guidance

Short, concrete, and delivered at the decision point rather than in a document:

1. Create a **new Free School account**; do not sign in with Bluesky if you need to stay
   unlinked.
2. Use a **made-up handle and display name** with no relationship to your other usernames
   (adversaries search username reuse first).
3. **No photo of yourself, no photo from your phone** as an avatar. Use the generated icon.
4. **Do not use your own domain** as your handle.
5. **Never reuse a rotation key or recovery key** between identities; if you already have an
   atproto identity you want kept separate, generate fresh keys.
6. If you must use a pseudonym seriously: separate browser profile, separate email (not your
   main provider), consider Tor or a VPN, and do not log in to both identities from the same
   session.
7. **Don't publicly RSVP to anything you would not put on a flyer with your name on it.**
8. Assume the event title, time, and neighborhood are public. Ask an organizer for the exact
   location.
9. If you changed your handle in the past, **assume the old one is still findable** — check
   `plc.directory/<your-did>/log/audit` yourself.
10. If you are deciding whether to join under a pseudonym or not at all: talk to an organizer
    offline first. Some people should not have an account.

---

## Default-settings recommendations (decisive)

Each is a decision, not an option. Where a decision trades away a real capability, the trade is
named.

1. **`visibility` is a first-class field on every record type from day one**, enum
   `private | school | public`, defaulting to `private`, with exactly one code path that decides
   where a write lands. Retrofitting visibility is how leaks happen.

2. **RSVP: app-side only by default.** Do not write `community.lexicon.calendar.rsvp` to the
   member's repo unless they opt in *per event*, with a one-sentence warning that names the
   consequence ("anyone will be able to see, permanently, that you planned to be at this place
   at this time"). *Trade:* we lose RSVP interop with Smoke Signal and other calendar apps by
   default. Accept it; offer it per event for genuinely open public events.

3. **Attendance: never a public record naming a DID. Ever.** Replace public
   `freeschool.draft.attendance` with three things: (a) app-side attendance in Postgres for
   v1 / the school's space later; (b) a public **aggregate only** on the event
   (`attendeeCount`, bucketed, suppressed below 5); (c) for reputation, an **attendee-written,
   opt-in** "I attended this" record in the attendee's own repo — so the person bearing the risk
   is the one who writes it and can delete it. If verifiable attendance is ever needed, use a
   host-signed attestation over `HMAC(per-event key, attendee DID)` so the attendee can prove it
   on presentation but nobody can enumerate it; the per-event key stays app-side and out of any
   exported dataset.

4. **Default new users to a fresh DID on our PDS.** Primary button = new Free School identity;
   secondary text link = existing atproto account. Suggested copy (needs review):

   > **Create a new Free School identity** *(recommended)*
   > A brand-new account, just for Free School. It won't be connected to your Bluesky or other
   > accounts.
   >
   > *Use an existing AT Protocol account* — faster, but your Free School activity will be
   > publicly and permanently linked to that account, including the posts on it.

   And a hard confirm on the OAuth path, before consent:

   > **Before you continue:** anyone on the internet will be able to see that this account is
   > part of Free School, and that link can't be undone later — not by us, and not by you. If
   > you'd rather keep Free School separate, go back and create a new identity instead.

5. **All public-record toggles are forced off at signup for OAuth-door users.** They have
   already accepted identity linkage; do not compound it with content linkage by default.

6. **Pseudonymous handles by default.** Suggest `<word><word><3 digits>` handles. **Never**
   derive a handle from the email local-part, display name, or any name the user typed. Do not
   offer custom-domain handles anywhere in the signup flow; document them as an advanced option
   with the WHOIS/CT warning.

7. **Use a neutral, non-descriptive PDS hostname and handle suffix**, ideally shared with
   unrelated communities the operator hosts (e.g. `*.people.<neutral-domain>`), *not*
   `*.freeschool.example`. This blunts P9. Be explicit internally that it is obscurity, not a
   fix: the endpoint is still public and enumerable.

8. **Skill claims: default to school-visible, not public — and split the taxonomy.** Maintain a
   two-tier skill list. Tier A (bread baking, bike repair, Spanish conversation, screen
   printing): the "also publish publicly" checkbox is pre-checked. Tier B (anything
   legal-exposure adjacent — know-your-rights/ICE response, street medic, digital security,
   de-escalation at actions, legal observing): the checkbox is unchecked, disabled until the
   member passes an explicit confirm, and the UI states the risk. We decide which tier a skill is
   in; the member does not have to reason about it under time pressure. Audit the tiering
   quarterly with members.

9. **Evaluation attestations: app-side by default; public requires double opt-in from both the
   attester *and* the named subject.** Publishing an edge is a disclosure about a third party.
   Positive-only content does not help: the edge is the leak.

10. **Membership role claims: app-side; no public roster, period.** Publish
    `coop.lexicon.membership` publicly only for individually-consented, already-public-facing
    roles (a named teacher on a named public class). If/when the Arbiter or a real space is used,
    **"Membership is Public" stays OFF.**

11. **Invites: opaque bearer token that carries nothing.** 128-bit random token; server stores
    `(token_hash, inviter_did, created_at, uses_left, expires_at)`; default single-use, 14-day
    TTL, revocable, rate-limited. The inviter's DID/handle appears in no URL, QR code, page
    title, or OG tag. **Delete `inviter_did` 30 days after redemption** (keep an abuse counter),
    so a later subpoena cannot reconstruct the vouch tree. Do **not** publish
    `coop.lexicon.invite` / `.share` as public records in v1 — the invite graph is the
    organizing graph.

12. **Anonymous feedback: structurally unlinkable, not merely hidden.** The feedback row carries
    `event_id`, scores, free text, and a **date only** (no timestamp, no author column, no
    insertion-order correlation — insert in randomized batches at window close). Eligibility and
    one-submission-per-person are enforced by a separate single-purpose ballot table holding
    `(event_id, HMAC(per-event key, attendee_did))`, written in a separate transaction; the
    per-event key is **destroyed when the feedback window closes**. After that we cannot
    deanonymize, even if ordered to. Aggregates: **k = 5 for anything text-bearing**, k = 3 only
    for numeric scores; suppress cells below k; publish each aggregate **once, at window close**
    — never a live counter, and never two cohorts that differ by one person (block the
    differencing attack explicitly in the query layer, with a test).

13. **Moderation records: no public written reasons, ever.** If anything is public, it is a
    content-free state plus a code from a fixed enum (`paused`, `removed`, category `safety` /
    `conduct` / `spam`) — no free text, no reporter, no narrative. Reports, narratives, evidence,
    and reporter identity live app-side behind a 2-person access rule with an access audit log.
    **Never put safety-report text in a space**: every member and every app any member authorizes
    can read a space.

14. **Event location: tiered disclosure by default.** Event `sensitivity` presets:
    `open` (everything public, including address), `listed` (**default**: public title, time, and
    *neighborhood text only*; exact address revealed app-side to confirmed attendees N hours
    before), `unlisted` (no public record at all; link/invite only). **Never** put
    `community.lexicon.location.geo` lat/long or a `community.lexicon.location.fsq` venue ID in a
    public record for a `listed` or `unlisted` event — the fsq ID is a stable join key into
    commercial venue datasets.

15. **Profile fields:** display name optional and never prefilled; no real-name prompt; location
    limited to a coarse picklist ("Boulder", "Front Range"); **no website/links field in v1**
    (the top self-doxx vector); bio free text allowed with a persistent inline "this is public"
    marker.

16. **Avatars: strip all metadata server-side, unconditionally, by re-encoding.** Decode and
    re-encode the image (do not merely drop EXIF chunks) to remove EXIF/XMP/IPTC/GPS/ICC
    provenance; cap dimensions; randomize the stored filename. **Do not rely on the PDS**: the
    spec says servers "might" block sensitive metadata, and it is not required. Default avatar is
    a generated identicon, and the UI never nudges anyone to "add a photo."

17. **Show the permanence sentence at the moment of the first public write**, not in onboarding:
    one sentence, plain language, with the action buttons.

18. **Do not be a correlation engine ourselves.** No "people you may know," no public per-member
    activity feed, no "who else is going" list for non-attendees, no member search by DID for
    non-members, `noindex` + robots.txt on member profiles, and authenticated + rate-limited
    access to any endpoint that enumerates people.

19. **Lexicon hygiene:** avoid distinctive `freeschool.*` NSIDs for records that live in *member*
    repos — a custom NSID is a free beacon for a Jetstream collection filter. Prefer app-side or
    space storage; if a public member-side record is unavoidable, reuse a generic
    `community.lexicon.*` type. Name this internally as obscurity, not security: the strongRef
    to the school's event still identifies us.

20. **Retention, as code with tests (not prose):** request/IP logs — none by default; if needed
    for abuse, truncate to /24 (IPv4) or /48 (IPv6) and delete at **7 days**. Auth/session logs
    — **30 days**. Email — while the account is active; hard-delete on account deletion (no soft
    delete). Attendance rows — **90 days**, then collapse to per-member counts without event IDs
    and per-event counts without members. Feedback text — **180 days**, then aggregate only.
    Moderation case files — **2 years**, then outcome summary only. Invite `inviter_did` — **30
    days** post-redemption. Push subscriptions — delete on logout and after 60 days idle.
    **Cap PITR at 7 days and snapshot retention at 30 days**, and treat every database branch as
    a retention leak; document that Neon branches/snapshots count.

21. **Logging policy:** no request-body logging; no DIDs, handles, or emails in analytics, URLs,
    or error reports; no third-party scripts, tag managers, font CDNs, or pixels on
    authenticated pages; `Referrer-Policy: no-referrer`; strict CSP; scrub DIDs/emails from
    Sentry-class tooling or run none. **No open/click tracking in any email** sent to this
    community.

22. **School DID custody (we keep it in v1, with conditions):** generate rotation keys offline;
    **hold at least one of the (up to 5) priority-ordered rotation keys with a second,
    non-operator community steward** so the community can recover the DID from us; publish the
    rotation-key fingerprints and the custody arrangement; write a dated handover commitment and
    path; and never use the school's signing key to write records *about* members that members
    did not ask for (see #3, #9, #10, #13). Residual risk stays: we can be compelled to sign as
    the school. Note the one upside — a forced key handover appears as a public PLC operation,
    which functions as an involuntary canary.

23. **Subpoena posture, published:** (i) we require valid legal process; (ii) we notify affected
    members before disclosure unless legally prohibited, and we challenge gag orders; (iii) we
    produce the narrowest responsive data; (iv) we hold as little as possible, by design (#12,
    #20 — minimization as legal strategy); (v) semi-annual transparency report with counts.
    Decide **now** which jurisdiction hosts the database, and put counsel (CLDC / EFF / NLG
    Colorado) on file before launch, not after the first letter.

24. **Warrant canary, honestly framed:** a signed, dated statement at a stable URL, updated on a
    fixed published schedule by a named human, stating that as of that date we have received no
    national security letters, no gag orders, and no requests for member identity data. Mirror it
    in a public git repo with signed commits so the history is tamper-evident. State in the
    canary itself that its legal efficacy is contested, that a missed update may mean vacation
    rather than compulsion, and what members should do if it lapses.

25. **Account deletion that tells the truth, plus a real remedy.** Deletion hard-deletes app-side
    rows and deletes the member's public records from their repo, *and* the confirmation screen
    says plainly that copies already taken by others cannot be recalled. Ship a supported
    **"burn and start over"** flow (new DID, nothing carried across) because re-pseudonymization
    is the only actual remedy for a blown pseudonym.

26. **Do not adopt Spaces for life-safety data while the alpha stands** (no security review, no
    backups, destructive migrations). Keep v1 on Postgres behind the Spaces-shaped interface — and
    make the interface's own docs and UI state that the operator is a reader, so nobody builds a
    confidentiality assumption on top of it.

**What stays public, deliberately:** the school's own account and profile; event listings (title,
description, start/end, neighborhood) for `open` and `listed` events; published curricula and
offerings; bucketed aggregate counts; the school's governance and moderation policies. That set is
enough to make the platform work.

---

## Member note

*(plain language, ≤150 words — draft for review by members, not yet approved copy)*

> Free School runs on an open network. Some things here are posted in public, where anyone can
> read them, copy them, and keep them forever — even if you delete them later.
>
> **Public:** the events we list (name, time, and neighborhood), and anything you choose to mark
> public, like a skill you want to teach.
>
> **Not public:** who RSVPs, who comes to an event, your email, and your feedback about a class.
>
> **If you need to stay separate from your other accounts:** make a new Free School account
> instead of signing in with Bluesky. Pick a made-up name. Don't use a photo of yourself. Don't
> use your own web address as your username.
>
> Not sure about something? Ask an organizer before you post it. We can delete our copy of your
> information. We cannot delete copies other people already took.

*(140 words)*

---

## Sources

All read 2026-09-12.

**Protocol specifications**
- Repository spec — https://atproto.com/specs/repository ("self-certifying storage for public
  account content"; MST; delete "without leaving a trace or 'tombstone'")
- TID spec — https://atproto.com/specs/tid (53-bit µs timestamp + 10-bit random clock identifier;
  base32-sortable, 13 chars)
- Sync spec / firehose — https://atproto.com/specs/sync (`#commit` with CAR slice, `#identity`,
  `#account`, `#sync`; `getRepo`, `listReposByCollection`)
- Handle spec — https://atproto.com/specs/handle (DNS `_atproto` TXT; `/.well-known/atproto-did`;
  bidirectional verification; `handle.invalid`)
- Blob spec — https://atproto.com/specs/blob (`getBlob`; "EXIF metadata in JPEG image files may
  contain GPS coordinates"; servers "might" block — not required)
- OAuth spec — https://atproto.com/specs/oauth (client metadata at `client_id` URL; DPoP
  mandatory; DID returned in `sub`; `transition:email` reveals the account email)

**Identity / PLC**
- did:plc method — https://github.com/did-method-plc/did-method-plc
- did:plc spec v0.1 —
  https://raw.githubusercontent.com/did-method-plc/did-method-plc/main/website/spec/v0.1/did-plc.md
  and https://web.plc.directory/spec/v0.1/did-plc (endpoints `/:did`, `/:did/data`,
  `/:did/log/audit`, `/export`, `WSS /export/stream`; rotationKeys ≤5; alsoKnownAs; services;
  tombstone; **"personally identifiable information (PII) encoded in `alsoKnownAs` URIs will be
  publicly visible even after DID deactivation, and can not be redacted or purged"**)
- did:plc Directory — https://web.plc.directory/
- Kuba Suder, "ATProto in Practice #1: Identity", 2026-07-20 —
  https://mackuba.eu/2026/07/20/atproto-in-practice-identity (**"you can see the past history of
  all handles that were assigned to this DID, and this information can't be erased"**; did:web
  tradeoffs)

**Permissioned data / Spaces**
- "The Atproto Spaces Alpha is Live", 2026-08-20 — https://atproto.com/blog/atproto-spaces-alpha
  (**"spaces give you access control not confidentiality ... it's not encrypted"**; "Records live
  in per-space permissioned repos on the author's PDS"; "no concept of a relay for data stored in
  a space"; alpha warnings: no security review, no backups, destructive migrations)
- Proposal 0016, permissioned data —
  https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data (space = (authority
  DID, type NSID, skey); space credentials + DPoP + client attestation; LtHash commits;
  **"A user does not sign the digest directly since a signature over the content digest would be a
  rebroadcastable proof"**; **"provides access control, not confidentiality. It is not end-to-end
  encrypted"**; "Services (both PDSes and authorized applications) can read the data they handle")
- Daniel Holmgren, "Permissioned Data Diary 6: Boring Auth" —
  https://dholms.leaflet.pub/3mnkrxp7rt22i (**"If your DID is on the list, you can read and sync
  everything in the space"**; **"AtmoBoards doesn't just get Alice's slice. It gets the whole
  forum"**)
- Daniel Holmgren, "Modeling communities on permissioned data", 2026-06-05 —
  https://dholms.leaflet.pub/3mndhk7ihsc2g (per-modality spaces under one community DID; consent
  screens; access-boundary granularity)
- Zicklag, "The Arbiter — Group Management for Permissioned Spaces and Beyond" —
  https://zicklag.leaflet.pub/3mjrvb5pul224 (host needs "a list of members so that it knows who to
  grant space credentials to"; optional "Membership is Public")

**Relay, firehose, indexers**
- Jetstream docs — https://bsky.network/docs/jetstream/ (**"No authentication is required for the
  live tail; these instances serve the full network"**; filters `collections` (NSID + wildcards),
  `dids`, `kinds`; **"A single subscription accepts up to 100 collections and 10,000 DIDs"**;
  inclusive cursor, at-least-once)
- Jetstream repo — https://github.com/bluesky-social/jetstream (**"Full-network archive, replay,
  and streaming service for atproto"**)
- PDSls — https://pdsls.dev/ , https://deepwiki.com/notjuliet/pdsls (browse any PDS: collections,
  records as JSON and raw CBOR, blobs, CAR export; no auth)
- atproto-browser — https://github.com/haroldadmin/atproto-browser
- ClearSky — https://clearsky.app/ , https://blueskydirectory.com/utilities/clearsky (who blocks /
  blocked / unfollowed you, retroactively, because the evidence is public and permanent)
- ATProto Record Viewer (multi-PDS) — https://corkiejp.github.io/ATProtoViewer/

**Lexicons (read directly from source)**
- `community.lexicon.calendar.event` —
  https://raw.githubusercontent.com/lexicon-community/lexicon/main/community/lexicon/calendar/event.json
  (fields verified: `name`, `description`, `createdAt`, `startsAt`, `endsAt`, `mode`, `status`,
  `rsvpExpected`, `uris`, `locations[]` = union of `event#uri`, `location.address`, `location.fsq`,
  `location.geo`, `location.hthree`; key type `tid`)
- `community.lexicon.calendar.rsvp` —
  https://raw.githubusercontent.com/lexicon-community/lexicon/main/community/lexicon/calendar/rsvp.json
  (verified: required `subject` = `com.atproto.repo.strongRef`, required `status` ∈
  {`interested`, `going`, `notgoing`}; key type `tid`)

**Related**
- EXIF handling issue — https://github.com/bluesky-social/atproto/issues/522
- Auth scopes proposal 0011 —
  https://github.com/bluesky-social/proposals/blob/main/0011-auth-scopes/README.md

---

## Confidence / not verified

**High confidence (read from primary specs or source JSON today)**
- TID structure and the creation-time/clock-id leak.
- PLC audit-log endpoints, unauthenticated bulk `/export`, permanence, and the unredactable-PII
  statement.
- Repo publicness, signed commits, tombstone-free deletes, blob fetchability, non-mandatory EXIF
  handling.
- Jetstream being unauthenticated, full-network, collection/DID-filterable, and self-described as
  an archive with replay.
- `community.lexicon.calendar.event` and `.rsvp` field sets (read the raw lexicon JSON).
- Spaces: access control not confidentiality, not E2EE, records on the author's PDS, no relay,
  space authority holds the member list, whole-space app access, MAC-based deniable commits,
  alpha warnings.

**Medium confidence**
- **Jetstream's actual replay depth.** The docs describe an inclusive cursor and the repo says
  "archive," but I did not find a stated retention window in hours/days. I assume effectively
  permanent for threat-model purposes; verify before telling anyone a number.
- **Relay backfill windows.** The sync spec does not state them. Different relay operators will
  differ.
- **Whether the reference PDS currently blocks or strips EXIF on `uploadBlob`, and under what
  flag.** Issue #522 and the spec both read as "optional / not finished." Our recommendation (strip
  server-side in our app before upload) does not depend on resolving this, and should not be
  changed even if the PDS does strip.
- **Space credential logging granularity** — how much access-pattern metadata the space authority
  actually retains is an implementation choice in 0016/the Arbiter, not a spec guarantee. I have
  assumed the worst (we see who syncs what, when, from which client).
- **Arbiter details** read from a single blog post, not from its source or an XRPC spec.

**Low confidence / explicitly not verified**
- **P21 (TID clock-id correlation).** Plausible from the 10-bit random clock identifier plus write
  timing, but I found no demonstrated attack and the field is re-randomized per generator, not per
  device. Rated Low deliberately; do not cite it as a known vector.
- **Blob CID cross-platform linkage.** Identical bytes give identical CIDs *within* atproto; my
  cross-platform claim rests on perceptual hashing, which is an OSINT practice, not a protocol
  property.
- **Legal claims are not legal advice.** Subpoena/NSL/gag mechanics, warrant-canary efficacy,
  notification duties, and retention-vs-preservation-order interaction (a preservation order can
  freeze the very deletion schedules in #20) all need a lawyer. Several recommendations here —
  especially #12 (destroying the per-event HMAC key), #20 (short PITR), and #24 (the canary) — have
  legal consequences I am not qualified to assess, including potential spoliation exposure once
  litigation is reasonably anticipated. **Get counsel before shipping #12, #20, #23, #24.**
- **The member note is unvalidated copy.** It has not been read by a member, tested for reading
  level with a tool, or translated into Spanish, which this community will need.
- **Threat-model completeness.** I did not cover: physical-security practices at events, phone
  seizure and device forensics, Signal/chat adjacency, the moderation labeler surface, the
  photo-at-the-event problem (members photographing each other), or payment rails if the school
  ever handles money. Each deserves its own pass.
