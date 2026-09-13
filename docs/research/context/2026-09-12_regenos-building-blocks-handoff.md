---
source: "buzz"
author: "planbot"
buzz_channel: "general"
buzz_channel_id: "9a69d6db-e0fd-572f-8044-96a21d5cdc06"
buzz_thread_root: "4e112267c3e65965b9aac90c6eb9834f12d33310ed4d6b6399ff919bff970791"
buzz_event_id: "11c4bf5ec52322d749583a9b1615715065714e1a0176067655a51341409fd360"
regenos_commit: "c3e34d4"
date: "2026-09-12"
status: "draft"
parachute_path: "vault/projects/local-alternatives/reports/2026-09-12_regenos-free-school-building-blocks-handoff"
parachute_id: "2026-09-12-17-38-57-792226"
tags: ["atproto", "free-school", "handoff", "local-alternatives", "regenos", "report"]
---

# RegenOS building blocks for the Free School app (planbot handoff)

> **Where this came from.** planbot wrote this handoff on Buzz on 2026-09-12. It was verified against the RegenOS repo at `main` c3e34d4 (2026-09-11). It covers only the "narrow cut" Lucian scoped in the 09-11 session: public contracts and lexicon shapes, with no build-status or decision-log material. The text below is copied verbatim from the Buzz message.
>
> **Questions go to the Buzz thread.** Future agents with questions about this handoff, RegenOS lexicons, or access should post in that thread instead of starting a new one:
> - Channel: `general` (`9a69d6db-e0fd-572f-8044-96a21d5cdc06`)
> - Thread root event: `4e112267c3e65965b9aac90c6eb9834f12d33310ed4d6b6399ff919bff970791`
> - This message's event: `11c4bf5ec52322d749583a9b1615715065714e1a0176067655a51341409fd360`
> - Fetch the thread with: `buzz messages thread --channel 9a69d6db-e0fd-572f-8044-96a21d5cdc06 --event 4e112267c3e65965b9aac90c6eb9834f12d33310ed4d6b6399ff919bff970791`
> - Who's involved: planbot (owns the regenos Buzz channel and has repo read access), lucian (the human authority on repo access and lexicon design), and omniharmonic (Benjamin).
>
> **Related notes:** [[vault/projects/local-alternatives/meetings/2026-09-11_lucian-aaron-pds-roadmap-lexicon-governance-and-the-techne-coop-question]] · [[vault/agent/reports/2026-09-11_regen-hub-atproto-session]] · [[vault/projects/local-alternatives/reports/2026-09-10_lex-free-school-boulder-report]] · [[vault/organizations/Free School Boulder]] · [[vault/tasks/active/build-free-school-boulder-app-v1-before-cohere]]

---

Narrow-cut handoff for Free School, verified against regenos main at c3e34d4 (2026-09-11). Public contracts and lexicon shapes only, matching what Lucian scoped in the 09-11 session. No build-status or decision-log material.

## 1. Event lexicons and the sidecar pattern

`community.lexicon.calendar.event` is the base record. It's adopted, not owned: name, description, startsAt/endsAt, mode (inperson/virtual/hybrid), status, an array of `locations` (union of address/geo/fsq/hthree/uri), `rsvpExpected`. `community.lexicon.calendar.rsvp` is a strongRef to the event plus status (interested/going/notgoing).

RegenOS never edits the borrowed event. It composes with three `coop.lexicon.*` sidecars. Each is a strongRef back to the event, never a field inside it.

- `event.config`: attendance mode (`open` | `approval`), maxAttendees, waitlist, timezone.
- `event.detail`: the gated sidecar. Exact location (address/geo/fsq/hthree union), an exact pin (geo), free-form attendee-only text. Lives ONLY in the event's detail space (see below), never in the base event.
- `event.listing`: how a scene (or a person lighting a beacon) curates a borrowed event onto its own calendar. Just a strongRef plus createdAt.

Rule for Free School: a class is the base calendar event. Anything that should stay visible to SmokeSignal, Dandelion, and Beacon goes on the base record or an openly-placed sidecar (tags included; see the open question below). Anything gated, like a home address before approval, goes in an `event.detail`-shaped sidecar placed in its own space.

## 2. Spaces, the permission model

A space is addressed `at://{authority}/{spaceType}/{skey}`. The authority is the DID that owns the policy; the skey names the instance. A space-type declaration names its kind and which collections may live there. A separate `{spaceType}.policy` record holds a declarative read/write/manage predicate over data claims. There are no per-person grant records.

Worked example, `coop.lexicon.space.event.invite` (skey = the event):
```
collections: invite, rsvp, approval, presence, evaluation, event, event.listing, event.config, share
read/write: any[ invited(this, includeMembers), sharedWith(this), memberRole(authority, atLeast:10, includeMemberScenes) ]
manage:     memberRole(authority, atLeast:20)
```
Two placeholders only. `authority` is the space owner, a cohort shared across all its spaces. `this` is the space instance itself, a cohort per-instance. Predicates compose from an open set: `memberRole`, `connectionOf`, `confirmedFor`, `invited`, `sharedWith`, `authorityOnly`, `any`, `all`. Positive-only, no `not`.

How an edge verifies the author had permission when writing: admission is checked at write time against the space's write policy. Today the AppView's write path is the gate; membership and role checks read `coop.lexicon.membership` claims, which are themselves data records, not derived tables. A record keeps living in its own author's repo regardless. The space only governs who else can read or admit it.

For Free School's "anonymous host/skill feedback in spaces": that's `coop.lexicon.evaluation` (a judgment of someone or something else, like a vouch or event feedback). Records with `direction: negative` are structurally unable to route public. Place them in a permissioned space you'd declare, such as a per-scene or per-host space, rather than the firehose.

## 3. The door in: identity and the MCP surface

Two credential lanes, both resolving to `Principal::User(did)`:
- Lane A, a delegated `rsat_` token: act as an existing member. Mint via `social.scenius.createAgentToken {label, scopes, ttlDays?}` (cookie-authed); the scope grammar is `*`, `<ns>.*`, an exact NSID, `read`, or `write`. This is what the MCP door mints for you automatically on OAuth consent.
- Lane B, a BYOD service-auth JWT: your own DID and PDS, no custody. `getServiceAuth` on your own PDS, good for 300 seconds or less, one method per JWT.

The published MCP door (`apps/mcp-bridge`) is the easy path. Run `claude mcp add --transport http regenos https://mcp.scenius.social/mcp` then `claude mcp login regenos`, approve the OAuth consent once, and you're acting as yourself over the full XRPC surface. Five generic tools, no per-method code: `call(nsid, input)`, `list_methods`, `describe_method`, `whoami`, `get_app_guide`. A new method ships via its lexicon alone and shows up automatically. `createUser(handle)` (harness-lane) composes signup, `chooseHandle`, and `createAgentToken` if you need to mint an account rather than log into an existing one.

Higher-level query methods like "events within N relations of me" aren't a separate primitive. They're `getVisibleEvents`/`searchEvents` composed with the graph-distance feed recipe below, not a bespoke relation-count endpoint.

## 4. Declared algorithms: the recipe shape

`coop.lexicon.feed.recipe` is a public content record. Fields: `name`, `promise` (a plain-language one-liner), `signals[]` (each `{id, weight}`, weight as a decimal string, kebab-case signal ids like `scene-history` or `connection-pull`; an unknown id just under-ranks, never a rejection), `combinator` (currently only `weighted-sum`), optional `kinds[]` (NSIDs to rank over; absent means everything), optional `seeds[]` (`{scene, distance}`, a scene DID and a starting graph distance as a decimal string; this is how a newcomer's graph gets seeded without a subscription record), `version`, and an optional `forkedFrom` (a strongRef carrying fork provenance). Each viewer runs the algorithm over their own visible claims. The manifest is the whole shareable and forkable unit; evaluation happens per-viewer at read time.

## 5. Existing types to reuse before drafting new ones

- `coop.lexicon.profile`: displayName, bio, avatar blob, links. A sidecar to `app.bsky.actor.profile`.
- `coop.lexicon.interest`: a private free-text interest box, personal-space only, used only for the owner's own recommendations.
- `coop.lexicon.evaluation`: vouch, event feedback, or intro outcome, typed by subject strongRef, `direction: positive|negative`. Negative never goes public.
- `coop.lexicon.membership`: `{subject, role: int, addedBy?}`, an open i16 role registry (10/20/30/40 = Member/Builder/Facilitator/Steward). This is what "graduated moderation," new hosts needing approval until they've hosted enough classes, would hang off as a role claim rather than a bespoke counter.
- `coop.lexicon.invite` and `coop.lexicon.share`: a named invite versus a bearer join-link. Both are the primitive behind "invite links or vouching to create a profile."
- No existing skill or attendance-badge type. Those are net-new for Free School; see the open question below on extend versus sidecar.

## 6. Playground PDS

I don't have this. It's Lucian's to stand up per the 09-11 agreement: networked with the Techne PDS, your own `.draft` lexicons, a SQLite export of public data if it's ever shut down. Worth pinging him directly for the image or run instructions, or a publish target, once you're ready to point a client at it.

## Open design question, flagged for Lucian per Benjamin's note

When does a new Free School concept, a skill tag, an attendance badge, a needs-board post, extend an existing record versus become its own sidecar record? The sidecar pattern above (composition, strongRef back, placement follows the audience) is the existing precedent. The call on any specific new type is Lucian's before building deep.
