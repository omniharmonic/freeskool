---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "ready"
type: "handoff"
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/2026-09-12_claude-code-handoff"
parachute_id: "2026-09-12-18-54-13-042233"
tags: ["atproto", "free-school", "handoff", "local-alternatives", "research"]
---

# Free School — Claude Code handoff: research swarm (2026-09-12)

*Written by Benjamin Life (@omniharmonic). Paste the "Kickoff prompt" section into a Claude Code session in the OmniHarmonic agent repo, or run the dispatch commands directly.*

## Context the swarm needs (read first)
- Synthesis + build plan: [[vault/projects/local-alternatives/reports/2026-09-12_free-school-research-brief-v0.1]]
- Product spec from the organizer: [[vault/projects/local-alternatives/reports/2026-09-10_lex-free-school-boulder-report]]
- Lucian's lexicon building blocks: [[vault/projects/local-alternatives/reports/2026-09-12_regenos-free-school-building-blocks-handoff]]
- 09-11 session (Syntropic, sandbox PDS, `.draft` rule): [[vault/agent/reports/2026-09-11_regen-hub-atproto-session]]
- Gitcoin Brain: `knowledge/atproto-vs-nostr-for-regenos`, `knowledge/project-weave-kaliya-young-atproto-groups`

## Decisions already made (do not re-litigate)
1. **Sidecar composition is the rule.** Never extend `community.lexicon.calendar.event` or any borrowed record; attach strongRef sidecars; placement follows audience (public vs space).
2. **The net-new record types in brief §6 are approved for drafting** under `freeschool.draft.*` (Lucian reviews before canonical).
3. **We (the hosted service) custody the school DID** for v1. Moderation actions are written as the school by the app, audit-logged, with a two-steward threshold for destructive actions.
4. v1 ships before COhere (October) on public records; anonymous feedback lives app-side behind a Spaces-shaped interface until the alpha stabilizes.
5. Attestations, not scores. Badges and trust levels are derived views, never stored tokens.

## Repos already identified (clone fresh; all public GitHub)
`bluesky-social/bulletin` (alpha Spaces reference app + SDK usage) · `muni-town/arbiter` (group DIDs/roles over spaces; has `lexicons/`, `docs/`, `policies/`, `SERVER_PLAN.md`) · `flo-bit/atmo-events` (Meetup alt on calendar lexicon; issue #78 = groups roadmap) · `flo-bit/atproto-notify` · `flo-bit/contrail` (PR #95 = spaces reader) · `lexicon-community/lexicon` (calendar + location lexicon JSON) · `OpenMeet-Team/openmeet-api` (event-series, event-mail) · `smokesignal.events/smokesignal` on tangled.org · `bluesky-social/atproto` PR #5187 (spaces branch) · `bluesky-social/proposals/0016-permissioned-data`.

## Swarm briefs
Dispatch each as its own agent. Every agent writes its deliverable to Parachute at `vault/projects/local-alternatives/free-school/research/<id>_<slug>` with tags `[free-school, local-alternatives, research]`, metadata `{author: "Benjamin Life (@omniharmonic)", date, status: draft, brief: <id>}`, and ends with a **Sources** section and a **Confidence / not verified** section. No agent proposes new decisions on items 1–5 above.

```
python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R1 Spaces alpha lab: clone bluesky-social/bulletin; document the exact @atproto alpha SDK calls to create a space, add/remove a member, write a record into it, read as member vs non-member, and what the delegation token + space policy look like. If a BPS invite is available in env, run it against the hosted alpha PDS; otherwise run against ghcr.io/bluesky-social/atproto:pds-spaces-alpha locally. Deliver lab notes + a runnable script. Path: vault/projects/local-alternatives/free-school/research/r1_spaces-alpha-lab-notes"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R2 Lexicon inventory: pull current JSON for community.lexicon.calendar.* and community.lexicon.location.* from lexicon-community/lexicon, Smoke Signal's eventConfiguration/acceptance, and coop.lexicon.event.* from the regenos repo if accessible (else from the 09-12 handoff note). Produce a side-by-side field table, then draft valid lexicon JSON for freeschool.draft.skillLevel (event sidecar) and freeschool.draft.series (recurrence sidecar). Path: .../r2_lexicon-inventory"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R3 The Arbiter: read muni-town/arbiter (lexicons/, docs/, policies/, SERVER_PLAN.md) and zicklag's two leaflet posts. Document its XRPC surface, role model, how a calendar app gets scoped write-as-group, and what running an arbiter-manager costs. Recommend adopt / wrap / wait for v1 vs Phase 2, given that we custody the school DID ourselves for v1. Path: .../r3_arbiter-review"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R4 Direct-PDS federation: document com.atproto.sync.subscribeRepos on a PDS, getRepo/listRecords backfill, and Tap configuration for a fixed repo/collection set. Deliver a working Node script that follows two PDS hosts and prints new community.lexicon.calendar.event records, with notes on cursors, reconnects, and identity resolution. Path: .../r4_direct-pds-federation"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R5 Skill taxonomy seed: query the ESCO API for skills under practical/trade/food/land/repair/care/arts/organizing; map ~400 nodes to Wikidata QIDs; emit freeschool.draft.skill records as JSONL with label, description, broader[], externalIds{esco,wikidata}. List what free schools teach that ESCO lacks (hide tanning, foraging, alley cats, zine making, etc.) and propose community-extension nodes. Path: .../r5_skills-seed (attach skills-seed.jsonl)"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R6 Prior-art code review: read flo-bit/atmo-events, flo-bit/contrail PR #95, OpenMeet's event-series and event-mail modules, flo-bit/atproto-notify. For each: license, what to fork vs reimplement, and the recurrence + notification approach to adopt for Free School. Path: .../r6_prior-art-review"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R7 Free-skool history and design values: Ferrer's Escuela Moderna, US Modern School movement, 1960s-70s free school movement (Goodman, Illich), Toronto Anarchist Free Skool 1999 (Shantz, Spaces of Learning), Free Skool Santa Cruz, Neighborhood Anarchists' Grow Your Own Free Skool zine, Asheville Free School. Two pages ending in ten design constraints for the app. Path: .../r7_free-skool-values"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R8 PWA on iOS 2026: current Safari support for install, web push, badging, background sync, file handling, storage limits. Checklist of what our PWA can and cannot do on iPhone, with the install-nudge pattern. Path: .../r8_pwa-ios-checklist"

python3 scripts/dispatch_task.py --project local-alternatives --notify-dm --goal "R9 Privacy threat model for an activist-adjacent community on ATProto: what a public repo reveals, DID correlation across apps, what the PLC directory exposes, what a space leaks to its host and to the app operator that custodies the school DID. Deliver default-settings recommendations and a one-paragraph plain-language note for members. Mark as human-review-required. Path: .../r9_privacy-threat-model"
```

## After the swarm
Synthesize R1–R9 into brief v0.2 at `vault/projects/local-alternatives/reports/2026-09-1x_free-school-research-brief-v0.2`, then draft the Lucian review packet (§6 types + `series` sidecar + questions) and the Lex questions list.

## Kickoff prompt (paste into Claude Code)
> Read `vault/projects/local-alternatives/free-school/2026-09-12_claude-code-handoff` in Parachute and the v0.1 brief it links. Dispatch R1–R9 as separate swarm agents with the exact commands in the handoff (default budget; raise R1 and R4 to 800k). Write each deliverable to the Parachute path in its brief. When all nine land, synthesize v0.2 and ping me on Telegram with the three things that changed the plan.
