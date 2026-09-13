---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r2"
type: "research"
title: "R2 \u2014 Lexicon inventory and sidecar drafts"
projects: ["local-alternatives"]
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r2_lexicon-inventory"
parachute_id: "2026-09-12-19-20-19-137239"
tags: ["atproto", "free-school", "local-alternatives", "research"]
---

# R2 — Lexicon inventory and sidecar drafts

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R2*

## TL;DR

1. **`lexicon-community/lexicon` on GitHub is archived.** The canonical home of the `community.lexicon.*` schemas moved to Tangled: `https://tangled.org/lexicon.community/lexicons`. I cloned both and **diffed them byte-for-byte: `community/` is identical**, so nothing we had is stale — but future pulls must target Tangled.
2. **The base event is thinner than assumed.** `community.lexicon.calendar.event` requires only `name` + `createdAt`. `startsAt` / `endsAt` are **optional**, there is no capacity, no timezone, no recurrence, no host/organizer, and no ticketing. `community.lexicon.calendar.rsvp` has **no `createdAt` at all** — ordering RSVPs for waitlist fairness cannot come from the record body and must come from the rkey (TID) or the firehose. This is the single most consequential finding for waitlists.
3. **`coop.lexicon.*` was fully accessible** — `technefoundation/regenOS` (private, my account has read). The three `coop.lexicon.event.*` shapes match the 2026-09-12 handoff note with one naming correction: the field is **`attendance`**, not `attendanceMode`. I did not have to fall back to the handoff shapes.
4. **Smoke Signal is being sunset** (target 2026-07-14, already executed to read-only; `plan_sunset.md` on the live Tangled repo). Its end state explicitly "links out to other services that speak the same `community.lexicon.calendar.*` lexicons for any create/RSVP action." That is a direct opening for Free School, and it means Smoke Signal's patterns are a *historical* inventory, not a live competitor to interop with.
5. **Smoke Signal keys its config sidecar differently and it's worth knowing about:** `events.smokesignal.calendar.eventConfiguration` uses **`key: "any"`** — the sidecar's rkey *is* the event's rkey, so the join is positional rather than a `strongRef`. Cheaper lookup (1 `getRecord`, no index), but it only works for self-authored events and silently breaks the moment you configure a *borrowed* event. `coop.lexicon.*` correctly chose `strongRef` + `key: "tid"`. **Our drafts follow coop.**
6. Two draft lexicons delivered and validated, **plus a third I had to add**: choosing the occurrence back-pointer as a record rather than a field on `series` (justified below) means `freeschool.draft.occurrence` needs a schema to be usable, so I drafted it too.
7. **All three drafts validate against `@atproto/lexicon@0.7.14`**, including 12 positive/negative record cases that prove the constraints actually bite.

---

## Sources pulled (commit hashes)

| Source | Location | Commit / CID | Date | Notes |
|---|---|---|---|---|
| `community.lexicon.*` — **canonical** | `https://tangled.org/lexicon.community/lexicons` (redirects to knot `knot.lexicon.garden/did:plc:g5niz7yav7io2erxaoyef5dn`) | `c8552ebbf7f2d1cc13e14870f6908cdc29796008` | 2026-07-27 | Cloned to `r2_lexicons/tangled-lexicons/` |
| `community.lexicon.*` — archived mirror | `github.com/lexicon-community/lexicon` | `b4a2b19613105ede6b43e1330d3831842278b073` | 2026-07-27 | Repo **archived**; last commit is "Update README to reflect repository archiving" |
| — diff of the two | — | `diff -r` exit **0** | — | `community/` trees identical; archived copy is not stale |
| Smoke Signal source — **live** | `https://tangled.org/smokesignal.events/smokesignal` (knot `knot1.tangled.sh/did:plc:ga34q35mgpfvqvkj2dn6w6qk`) | `7bdfaf654858465eebb09529f476dd242e72e911` | 2026-09-09 | "chore: local dev env cleanup"; contains `plan_sunset.md` |
| Smoke Signal source — GitHub | `github.com/SmokeSignal-Events/smokesignal` | `a5d7f2d4b00195e483dc15d439b4132c5340dfb3` | 2024-08-05 | **Stub only** — single "Initial commit". Do not use. |
| `coop.lexicon.*` | `github.com/technefoundation/regenOS` (private, accessible) | `c3e34d4fe87f9cacc1dd9641c26319969343b143` | 2026-09-11 | `crates/regenos-lexicons/{lexicons,space-lexicons,method-lexicons}/` |

**Smoke Signal's lexicons are not in its git repo.** They are published as `com.atproto.lexicon.schema` records. I resolved them from primary source:

- `dig +short TXT _lexicon.smokesignal.events` → `"did=did:plc:tgudj2fjm77pzkuawquqhsxm"`
- PLC doc → PDS `https://pds.cauda.cloud` (note: *not* `bsky.social`, which returns `Could not find repo`)
- `com.atproto.repo.listRecords` on `com.atproto.lexicon.schema` → 7 records

| Record (rkey) | CID |
|---|---|
| `events.smokesignal.calendar.eventConfiguration` | `bafyreiao6gsspips3763jqfdrl76fydgz3ciaihznynewkb5bktza2wmsi` |
| `events.smokesignal.calendar.acceptance` | `bafyreifoud6qgtgafjkbmi2m5zqtkftoud4niguzsjc7fr5piml3kmt5xa` |
| `events.smokesignal.event.configure` | `bafyreig4utg6wfi5eu5fm6yw673pi6cx3fpfwhtga7whf6qlndiane2fuy` |
| `events.smokesignal.lfg` | `bafyreidzx6j7iwetliikuthdpd73g2pv26fcpk3cxvufu6flisftbwlnqu` |

Other published rkeys (fetched, not central to this brief): `events.smokesignal.profile`, `events.smokesignal.authFull`, `tools.smokesignal.blahg.content.post`. Saved under `r2_lexicons/smokesignal-published/`.

**Bug found in a published Smoke Signal schema:** `events.smokesignal.lfg` declares its `location` union as `["community.lexicon.location#geo", "community.lexicon.location#hthree"]`. There is no `community.lexicon.location` lexicon document — the real NSIDs are `community.lexicon.location.geo` and `community.lexicon.location.hthree`, each its own doc with an object at `defs.main`. Those refs are **unresolvable**. Worth avoiding the same mistake, and worth knowing that published `com.atproto.lexicon.schema` records are not validated on write.

---

## Side-by-side field table

### Base records

| Record | Field | Type | Req | Notes |
|---|---|---|---|---|
| `community.lexicon.calendar.event` (record, `key: tid`) | `name` | string | **yes** | — |
| | `createdAt` | string `datetime` | **yes** | Client-declared |
| | `description` | string | no | No length cap declared |
| | `startsAt` | string `datetime` | no | **Optional** — a valid event may have no start time |
| | `endsAt` | string `datetime` | no | Optional; no duration field |
| | `mode` | ref `#mode` | no | string, default `#inperson`, knownValues `#hybrid` / `#inperson` / `#virtual` |
| | `status` | ref `#status` | no | string, default `#scheduled`, knownValues `#cancelled` / `#planned` / `#postponed` / `#rescheduled` / `#scheduled` |
| | `locations` | array of union | no | Refs: `#uri`, `location.address`, `location.fsq`, `location.geo`, `location.hthree` |
| | `uris` | array of ref `#uri` | no | `#uri` = object `{uri (uri, req), name}` |
| | `rsvpExpected` | boolean | no | "Whether a response is requested" |
| | *absent* | — | — | **No** capacity, timezone, recurrence, host/organizer, cost, ticketing, category/skill |
| `community.lexicon.calendar.rsvp` (record, `key: tid`) | `subject` | ref `com.atproto.repo.strongRef` | **yes** | The event |
| | `status` | string | **yes** | default `#going`, knownValues `#interested` / `#going` / `#notgoing` |
| | *absent* | — | — | **No `createdAt`** — ordering must come from rkey/TID or firehose seq |

### Location defs (all `type: object` at `defs.main`, not records — they ride inside other records)

| Def | Field | Type | Req | Notes |
|---|---|---|---|---|
| `community.lexicon.location.address` | `country` | string | **yes** | ISO 3166, `minLength 2`, `maxLength 10` |
| | `postalCode`, `region`, `locality`, `street`, `name` | string | no | No coordinates |
| `community.lexicon.location.geo` | `latitude` | string | **yes** | **String, not float** — ATProto data model excludes floats |
| | `longitude` | string | **yes** | Decimal degrees; negative for S/W; WGS84 |
| | `altitude` | string | no | Meters above MSL |
| | `name` | string | no | — |
| `community.lexicon.location.fsq` | `fsq_place_id` | string | **yes** | Foursquare OS Places. README says "may (should?) be deprecated" |
| | `latitude`, `longitude`, `name` | string | no | — |
| `community.lexicon.location.hthree` | `value` | string | **yes** | H3 cell index; precision chosen by resolution |
| | `name` | string | no | — |

### Smoke Signal config / acceptance

| Record | Field | Type | Req | Notes |
|---|---|---|---|---|
| `events.smokesignal.calendar.eventConfiguration` (record, **`key: "any"`**) | — | — | — | **No required fields at all.** rkey = the event's rkey; positional join, no strongRef. Breaks for borrowed events. |
| | `rsvpRedirectUrl` | string `uri`, max 2048 | no | External ticketing (ti.to, Eventbrite) |
| | `disableDirectRsvp` | boolean | no | RSVP button redirects instead of writing an rsvp record |
| | `requireConfirmedEmail` | boolean | no | Email gate — AppView state, not in-protocol |
| `events.smokesignal.calendar.acceptance` (record, `key: tid`) | `cid` | string `cid` | **yes** | "Cryptographic proof record." Holds **only the RSVP's CID** — no `uri`, no event ref. The host authors it in their own repo; it is the *ticket*. Pairs with `events.smokesignal.rsvp.linkAttestation` (an XRPC write path, never a published schema) which stamps the attestation back onto the RSVP. |
| `events.smokesignal.event.configure` (**procedure**, not a record) | `event` | string `at-uri` | **yes** | Input |
| | `rsvpRedirectUrl` / `disableDirectRsvp` / `requireConfirmedEmail` | as above | no | Input; writes to a *local DB row*, not to a repo record |
| | errors | — | — | `EventNotFound`, `NotAuthorized`, `InvalidRedirectUrl` |

### `coop.lexicon.event.*` (verified from regenOS, not from the handoff note)

| Record | Field | Type | Req | Notes |
|---|---|---|---|---|
| `coop.lexicon.event.config` (record, `key: tid`) | `event` | ref `strongRef` | **yes** | — |
| | `attendance` | string | **yes** | knownValues `open` / `approval`. **Field is `attendance`, not `attendanceMode`** (handoff note wording) |
| | `maxAttendees` | integer, `minimum 1` | no | Absent = uncapped |
| | `waitlist` | boolean | no | Whether over-capacity RSVPs waitlist |
| | `timezone` | string | no | IANA name |
| | `createdAt` | string `datetime` | **yes** | — |
| `coop.lexicon.event.detail` (record, `key: tid`) | `event` | ref `strongRef` | **yes** | — |
| | `exactLocation` | union | no | `address` / `geo` / `fsq` / `hthree` |
| | `exactPin` | ref `location.geo` | no | Rides **alongside** `exactLocation`: address for humans, pin for proximity search |
| | `attendeeDetails` | string, max 10000 / 1000 graphemes | no | Door codes, instructions |
| | `createdAt` | string `datetime` | **yes** | — |
| `coop.lexicon.event.listing` (record, `key: tid`) | `event` | ref `strongRef` | **yes** | Curator is the **author**; no space DID in body |
| | `createdAt` | string `datetime` | **yes** | — |

**Placement is not a body field in coop — it is the record's location.** `coop.lexicon.event.detail` is *placed* at `at://{scene}/coop.lexicon.space.event.detail/{event-rkey}`, and `coop.lexicon.space.event.detail.policy` declares `read: any(confirmedFor(this), authorityOnly, memberRole(authority) atLeast 20)`, `write`/`manage`: `authorityOnly`. Roles are integers in `coop.lexicon.membership#role` (open registry; 10/20/30/40), evaluated as `atLeast: n`. This is the mechanism our sidecars must slot into — the reason our drafts carry **no** visibility or space field.

---

## Draft lexicons

Saved to `r2_lexicons/` (and copied into the repo at `packages/lexicons/lexicons/freeschool/draft/`). NSIDs are under `freeschool.draft` so the final namespace is a find-and-replace (`freeschool.draft.` → whatever Lucian decides); nothing else in the documents encodes the namespace.

> **Coordinator's note (2026-09-12):** in the repo copy, `skillLevel.skill` was changed from a strongRef to a plain `at-uri` so that every skill reference (skillLevel, skillClaim, skillAttestation, request, resource) uses the same shape. Taxonomy nodes are edited in place, so a version-pinned strongRef would go stale on every relabel. Flagged for Lucian in the review packet.

### `freeschool.draft.skillLevel.json`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.skillLevel",
  "description": "Sidecar to a community.lexicon.calendar.event: declares WHICH skill a class teaches and at WHAT depth. Composition over extension — the borrowed community.lexicon.calendar.event is never modified and never gains a field. One class may carry several skillLevel sidecars (a class that teaches two skills, or one skill at a spanning level). Placement: PUBLIC alongside the event by default (a class's subject and depth are the discovery surface — this is what a learner browses and searches); it rides into a scene's space only when the event itself is permissioned, in which case it is placed in the event's invite space so that the class's existence is not leaked by its subject tag.",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["event", "skill", "level", "createdAt"],
        "properties": {
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the community.lexicon.calendar.event this describes."
          },
          "skill": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the freeschool.draft.skill record naming the subject taught. A strongRef (not a free-text tag) so that two scenes teaching the same skill resolve to the SAME record, which is what makes cross-scene skill discovery possible."
          },
          "level": {
            "type": "integer",
            "minimum": 1,
            "maximum": 3,
            "description": "Depth index, ORDERED so that policies and queries can ask `atLeast`/`atMost`: 1=introductory (no prior exposure assumed), 2=intermediate (assumes working familiarity), 3=advanced (assumes practice). An integer rather than an enum because the only question anyone asks of it is a comparison ('classes at or below my depth'), and because widening the maximum is a backward-compatible lexicon change whereas re-ordering an enum's knownValues is not. Mirrors the open-registry integer used by coop.lexicon.membership#role."
          },
          "prerequisites": {
            "type": "string",
            "maxLength": 2560,
            "maxGraphemes": 256,
            "description": "Optional free-form note on what a learner should already have (tools, prior classes, physical requirements). Deliberately prose, not a ref list: most real prerequisites ('bring closed-toe shoes', 'can you already cast on?') are not other classes."
          },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

**Why `level` is an integer, not an enum.** Every real query is ordinal — "show me beginner and intermediate classes", "is this above my depth?". `coop.lexicon.membership#role` already set this precedent in this codebase (integer, open registry, `atLeast: n`). Widening `maximum` later is backward-compatible; re-ordering an enum's `knownValues` is not. I kept `maximum: 3` per the brief; if a 4th depth ever appears, raising the max is a one-line non-breaking change.

### `freeschool.draft.series.json`

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.series",
  "description": "Recurrence sidecar to a community.lexicon.calendar.event. The community calendar lexicon has NO recurrence field and will not gain one; a series is therefore a separate record that points at its first occurrence and states the rule by which further occurrences are generated. Occurrences are materialized as ORDINARY community.lexicon.calendar.event records, each carrying a freeschool.draft.occurrence sidecar pointing back here — so every occurrence is independently viewable, RSVP-able, cancellable and borrowable by any consumer that has never heard of this lexicon. Placement: PUBLIC alongside the first event when the series is public; in the event's invite space when the series is permissioned (a recurrence rule otherwise discloses the cadence of a private gathering).",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["firstEvent", "rrule", "freq", "timezone", "createdAt"],
        "properties": {
          "firstEvent": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the first occurrence, which doubles as the series template: its name, description, locations, mode and duration are copied to each materialized occurrence. Anchoring on a real first event rather than on a dedicated template record means no phantom, dateless pseudo-event reaches the firehose, and a consumer that ignores this lexicon still sees a correct single event."
          },
          "rrule": {
            "type": "string",
            "maxLength": 1024,
            "description": "The NORMATIVE recurrence rule as an RFC 5545 RRULE value, without the 'RRULE:' prefix — e.g. 'FREQ=WEEKLY;INTERVAL=1;BYDAY=TU;COUNT=8'. This is the field of record: where the structured fields below disagree with it, rrule wins. Kept as a string so the series round-trips through iCalendar and through every existing RRULE library unchanged."
          },
          "freq": {
            "type": "string",
            "knownValues": ["daily", "weekly", "monthly", "yearly"],
            "description": "Denormalized FREQ, required so that any calendar UI can render 'weekly' without shipping an RRULE parser. Must agree with rrule."
          },
          "interval": {
            "type": "integer",
            "minimum": 1,
            "default": 1,
            "description": "Denormalized INTERVAL: every Nth freq period. Must agree with rrule."
          },
          "byDay": {
            "type": "array",
            "maxLength": 7,
            "description": "Denormalized BYDAY, as RFC 5545 two-letter weekday codes. Must agree with rrule.",
            "items": {
              "type": "string",
              "knownValues": ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]
            }
          },
          "until": {
            "type": "string",
            "format": "datetime",
            "description": "Denormalized UNTIL: the series generates no occurrence starting after this instant. Mutually exclusive with `count` — RFC 5545 forbids both in one rule, an invariant the lexicon cannot express and the write path must enforce."
          },
          "count": {
            "type": "integer",
            "minimum": 1,
            "description": "Denormalized COUNT: total number of occurrences the series ever generates. Mutually exclusive with `until`."
          },
          "exdates": {
            "type": "array",
            "maxLength": 200,
            "description": "EXDATE list: start instants the rule would produce but which must NEVER be materialized (holiday skips). Distinct from cancelling an occurrence — a cancelled occurrence already exists as an event and uses the base lexicon's own community.lexicon.calendar.event#cancelled status, which is why this sidecar needs no cancellation field.",
            "items": { "type": "string", "format": "datetime" }
          },
          "timezone": {
            "type": "string",
            "maxLength": 128,
            "description": "IANA timezone name, e.g. America/Denver. Required, and load-bearing rather than cosmetic: 'every Tuesday at 6pm' must survive a DST transition, which is only expressible by expanding the rule in a named zone. Matches the timezone field on coop.lexicon.event.config."
          },
          "materializeAhead": {
            "type": "integer",
            "minimum": 1,
            "maximum": 730,
            "default": 90,
            "description": "How many days ahead of now the materializer should keep occurrence events created. Bounded rather than infinite so an open-ended weekly series does not write unbounded records; the materializer re-runs and extends the window."
          },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

**`rrule` is normative; the structured fields are a denormalized index.** Two reasons to carry both. `rrule` makes a series round-trip through iCalendar and through every existing RRULE library untouched — we are not inventing a recurrence grammar. The structured fields let an AppView filter and render ("weekly, Tuesdays, 8 sessions") without shipping an RRULE parser into every consumer. The cost is a consistency obligation, which I resolved explicitly in the schema: **`rrule` wins on conflict**, and the write path must derive the structured fields from it rather than accepting both from the client.

Two invariants the lexicon **cannot** express and the write path must enforce: `until` XOR `count` (RFC 5545 forbids both), and structured-field agreement with `rrule`.

**Why `firstEvent` and not `template`.** A template record would be a new record type whose only job is to not be an event — and on a public firehose it would surface as a dateless phantom event to every consumer that doesn't know our lexicon. Anchoring on the first real occurrence means a naive consumer sees exactly one correct event and simply doesn't know about the rest; a knowing consumer follows the sidecar. It also means the series' "template" fields are automatically the fields of a record that already validates against the adopted lexicon.

### How occurrences are materialized

Each occurrence is an **ordinary `community.lexicon.calendar.event`** — not a special type, not a reference into a series. The materializer expands `rrule` in `timezone`, drops any start in `exdates`, copies `name` / `description` / `locations` / `mode` and the first event's duration, sets `startsAt` / `endsAt` for that slot, and writes the event. It then writes a `freeschool.draft.occurrence` sidecar binding that event to the series. It keeps doing this for slots falling within `materializeAhead` days of now, and re-runs to extend the window.

Consequences worth stating, because they are the payoff:

- Every occurrence is independently **RSVP-able** (`community.lexicon.calendar.rsvp` takes a strongRef to *an event*, so it needs no series awareness), independently **configurable** (`coop.lexicon.event.config` per occurrence — week 3 can have a different cap), independently **cancellable** via the base lexicon's own `#cancelled` status, and independently **borrowable** by another scene via `coop.lexicon.event.listing`.
- A consumer that has never heard of `freeschool.draft.series` sees a correct calendar. That is the whole point of materializing rather than storing a rule and expecting readers to expand it.
- `originalStartsAt` on the occurrence sidecar is the idempotency key: a re-running materializer recognises an already-materialized slot instead of duplicating it.

**Decision: a separate `freeschool.draft.occurrence` record, not an `occurrences[]` field on `series`.** Three reasons, in order of weight:

1. **Write amplification and conflict.** An array field means rewriting the `series` record on every single materialization. An open-ended weekly series would rewrite that record forever, growing it without bound and making it a write-conflict hotspot between the materializer and any human editing the rule.
2. **Authorship.** A field on `series` forces the series author to also author every occurrence. A separate record lets a scene's materializer (or a Builder, per `memberRole atLeast 20`) write occurrences the series author did not — which is how this actually has to work operationally.
3. **Per-occurrence state has nowhere else to live.** RFC 5545 `RECURRENCE-ID` semantics need `originalStartsAt` *per occurrence* to express "this week moved from Tuesday to Wednesday". An array of strongRefs cannot carry it; an array of objects is a sidecar record with extra steps and none of the benefits.

It also keeps the settled rule intact without an exception: every sidecar is a strongRef back to the event.

### `freeschool.draft.occurrence.json` (required by the decision above)

```json
{
  "lexicon": 1,
  "id": "freeschool.draft.occurrence",
  "description": "Back-pointer sidecar binding one materialized community.lexicon.calendar.event to the freeschool.draft.series that generated it. Chosen over an occurrences[] array on the series record because (a) appending to an array rewrites the series record on every materialization, turning the series into a write-conflict hotspot that grows without bound, (b) an array forces the series author to also be the author of every occurrence, where a separate record lets a scene's materializer write occurrences the series author did not, and (c) RFC 5545 RECURRENCE-ID semantics need per-occurrence state (originalStartsAt) that has nowhere to live on the series. Placement: follows its event.",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["event", "series", "originalStartsAt", "createdAt"],
        "properties": {
          "event": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the materialized occurrence event."
          },
          "series": {
            "type": "ref",
            "ref": "com.atproto.repo.strongRef",
            "description": "Strong reference to the freeschool.draft.series that generated it."
          },
          "originalStartsAt": {
            "type": "string",
            "format": "datetime",
            "description": "The start instant the recurrence rule PRODUCED for this occurrence — the RFC 5545 RECURRENCE-ID. Stays fixed when the event's own startsAt is edited, which is what lets a materializer recognise an already-materialized slot instead of creating a duplicate, and lets a reader say 'moved from Tuesday to Wednesday this week'."
          },
          "sequence": {
            "type": "integer",
            "minimum": 1,
            "description": "Optional 1-based index of this occurrence within the series ('week 3 of 8'), for display only; never used to locate an occurrence."
          },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

---

## Validation output

Real install, real run — `@atproto/lexicon@0.7.14`.

```
mkdir -p scratchpad/research/r2_validate && cd scratchpad/research/r2_validate
npm init -y && npm install @atproto/lexicon     # -> @atproto/lexicon@0.7.14
node validate.mjs ../r2_lexicons
```

The script (`r2_validate/validate.mjs`) does four things: loads `com.atproto.repo.strongRef` and the real `community.lexicon.*` docs so every `ref` resolves; `lex.add()`s each draft (this is what runs ATProto's own lexicon-document schema validator, and it rejects a malformed document); asserts `defs.main.type === "record"` and `key === "tid"`; then runs 12 positive/negative record cases through `lex.validate()` to prove the constraints are actually enforced rather than merely declared.

```
== dependency lexicons ==
  PASS  com.atproto.repo.strongRef
  PASS  community.lexicon.calendar.event
  PASS  community.lexicon.calendar.rsvp
  PASS  community.lexicon.location.address
  PASS  community.lexicon.location.geo
  PASS  community.lexicon.location.fsq
  PASS  community.lexicon.location.hthree

== freeschool.draft.* documents (schema version 1 shape) ==
  PASS  freeschool.draft.skillLevel  (lexicon:1, defs.main=record, key=tid)
  PASS  freeschool.draft.series  (lexicon:1, defs.main=record, key=tid)
  PASS  freeschool.draft.occurrence  (lexicon:1, defs.main=record, key=tid)

== record validation (positive and negative cases) ==
  PASS  skillLevel minimal valid
  PASS  skillLevel full valid
  PASS  skillLevel level=4 rejected (max 3) -> rejected: Record/level can not be greater than 3
  PASS  skillLevel missing skill rejected -> rejected: Record must have the property "skill"
  PASS  skillLevel bad strongRef (uri not at-uri) rejected -> rejected: Record/event/uri must be a valid at-uri
  PASS  series weekly COUNT valid
  PASS  series monthly UNTIL valid
  PASS  series missing timezone rejected -> rejected: Record must have the property "timezone"
  PASS  series interval=0 rejected (min 1) -> rejected: Record/interval can not be less than 1
  PASS  series bad createdAt rejected -> rejected: Record/createdAt must be an valid atproto datetime (both RFC-3339 and ISO-8601)
  PASS  occurrence valid
  PASS  occurrence missing originalStartsAt rejected -> rejected: Record must have the property "originalStartsAt"

== borrowed-record integrity ==
  PASS  community.lexicon.calendar.event carries no freeschool/recurrence field (composition preserved)

ALL CHECKS PASSED
EXIT=0
```

I also ran the three `coop.lexicon.event.*` documents through the same loader as a cross-check on my harness (if coop's real schemas failed, my harness would be wrong):

```
PASS coop.lexicon.event.config   key=tid  required=[event,attendance,createdAt]
PASS coop.lexicon.event.detail   key=tid  required=[event,createdAt]
PASS coop.lexicon.event.listing  key=tid  required=[event,createdAt]
```

---

## Extend-vs-sidecar notes

### `freeschool.draft.skillLevel`

**Why a sidecar.** Three independent reasons, any one sufficient. (1) The settled rule: `community.lexicon.calendar.event` is adopted, not owned — we have no authority over the `community.lexicon.*` namespace and a field we added would be invalid under the published schema. (2) Even if we could, we shouldn't: the whole value of the base event is that Smoke Signal, atmo-events, OpenMeet and anyone else can read it. A Free-School-specific field would be dead weight to all of them and would fracture the commons. (3) Cardinality actually requires it — a class can teach two skills, and a single record with one `skill` field could not express that, whereas N sidecars can. This third reason is the one that would make a sidecar correct *even in a world where we owned the lexicon*.

**Where it is placed.** **Public, alongside the event**, by default. Skill and depth *are* the discovery surface — this is precisely what a learner browses, searches and filters on, and hiding it would defeat the platform. It rides into a space only when the event itself is permissioned, and then it goes to **the event's invite space**, not the detail space: the invite space is the audience that is allowed to know the class exists, and a skill tag in public would leak the existence (and subject) of a private gathering even with the event hidden. Following the coop convention, the record carries **no** visibility field — placement is its location, never a body field.

### `freeschool.draft.series`

**Why a sidecar.** The base lexicon has no recurrence field, by deliberate design, and the adopted-not-owned rule settles that we cannot add one. But the stronger argument is that a sidecar is *better* here regardless: recurrence is a statement *about a set of events*, not a property *of one event*. Putting an `rrule` inside an event record is the iCalendar design, and it is exactly what forces every reader to implement RRULE expansion before it can render a calendar. Materializing occurrences as ordinary events and keeping the rule in a separate record inverts that cost: naive readers get correct concrete events for free, and only the materializer needs to understand recurrence. This is the same conclusion atmo-events and OpenMeet reached independently.

**Where it is placed.** **Public, alongside the first event**, when the series is public. In **the event's invite space** when the series is permissioned — a recurrence rule is more disclosing than a single event, because it reveals the *cadence and duration* of a private gathering ("this group meets every Tuesday for the next eight weeks") even if individual occurrences are hidden. Note that `timezone` is duplicated with `coop.lexicon.event.config.timezone`; that is intentional, not an oversight — a series must state its own expansion zone because it can exist before any per-occurrence config does, and config is per-occurrence whereas the series zone governs the whole expansion.

### `freeschool.draft.occurrence`

**Why a sidecar.** It is the join record between two records neither of which may be modified: a borrowed base event and our own series. There is no field on either that could hold it. See the three-part justification under "How occurrences are materialized" for why it is a record rather than an array on `series`.

**Where it is placed.** **Follows its event** — public for public occurrences, in the event's invite space for permissioned ones. A back-pointer must be at least as visible as the event it points at, or a reader who can see the occurrence cannot discover it belongs to a series; and no more visible, or it leaks the private event's existence.

---

## Sources

- `https://tangled.org/lexicon.community/lexicons` @ `c8552ebbf7f2d1cc13e14870f6908cdc29796008` — canonical `community.lexicon.*` schemas
- `https://github.com/lexicon-community/lexicon` @ `b4a2b19613105ede6b43e1330d3831842278b073` — archived mirror; README documents the move to Tangled
- `https://blog.lexicon.community/a/3mrnjw6qzzq23-publishing-and-resolution` — publishing/resolution guide referenced by the archive notice (cited, not fetched)
- `https://tangled.org/smokesignal.events/smokesignal` @ `7bdfaf654858465eebb09529f476dd242e72e911` — live Smoke Signal source, incl. `plan_sunset.md`
- `https://github.com/SmokeSignal-Events/smokesignal` @ `a5d7f2d4b00195e483dc15d439b4132c5340dfb3` — stub, single initial commit
- `dig TXT _lexicon.smokesignal.events` → `did:plc:tgudj2fjm77pzkuawquqhsxm`; `https://plc.directory/did:plc:tgudj2fjm77pzkuawquqhsxm` → PDS `https://pds.cauda.cloud`
- `com.atproto.repo.listRecords` / `getRecord` on `com.atproto.lexicon.schema` at `pds.cauda.cloud` — Smoke Signal's published lexicons (CIDs in the Sources-pulled table)
- `https://github.com/technefoundation/regenOS` @ `c3e34d4fe87f9cacc1dd9641c26319969343b143` (private) — `coop.lexicon.*` under `crates/regenos-lexicons/`
- `@atproto/lexicon@0.7.14` from npm — validation
- RFC 5545 (iCalendar) — `RRULE`, `EXDATE`, `RECURRENCE-ID` semantics (applied from knowledge, spec not re-fetched)

## Confidence / not verified

**High confidence.** Everything in the field table for `community.lexicon.*`, `coop.lexicon.event.*`, and Smoke Signal's published schemas is read directly from primary sources I cloned or fetched this session. The two GitHub/Tangled `community.lexicon` trees were diffed programmatically (`diff -r`, exit 0), so "the archived copy is current" is verified, not assumed. The validation output is a real run, pasted verbatim.

**Things I could not access or did not verify:**

- **Nothing was inaccessible.** `technefoundation/regenOS` is private but my account has read access, so the `coop.lexicon.*` shapes are from the **real source**, not the handoff note. Worth flagging the one discrepancy that fell out of that: the handoff note's `attendanceMode` is actually **`attendance`**.
- **Smoke Signal's `rsvp.linkAttestation` shape is unverified.** It appears only as an XRPC route name in `plan_sunset.md` (`POST /xrpc/events.smokesignal.rsvp.linkAttestation`) and its handler was deleted in the sunset. It was never published as a `com.atproto.lexicon.schema` record, so its input shape is not recoverable from primary sources. My description of the acceptance/attestation ticket pattern is inferred from the `acceptance` record (which holds only an RSVP `cid`) plus the route names — treat the *mechanism* as inference, the *`acceptance` record shape* as verified.
- **Smoke Signal's sunset status** is taken from `plan_sunset.md` on the live repo, which states phases 1–5 executed and a target of 2026-07-14 (now past). I did **not** check `smokesignal.events` in a browser to confirm the site is in fact read-only today. Worth a 30-second check before anyone repeats the claim publicly.
- **`freeschool.draft.skill`** is referenced by `skillLevel` as a strongRef target but is not drafted here — it's outside this brief. Because the link is a strongRef (not a lexicon `ref`), `skillLevel` validates without it; but the pair is incomplete until someone drafts the skill record, and the "two scenes resolve to the same skill record" claim depends on how that record handles identity/deduplication, which is an open design question.
- **`materializeAhead: 90` and `maximum: 730`** are my judgement calls, not derived from any source. Likewise `exdates` `maxLength: 200` and the `prerequisites` length caps (which I matched to coop's grapheme-cap convention). All are cheap to change.
- **atmo-events / OpenMeet materialization** is cited from the brief's context, not independently verified this session — I did not pull either codebase.
