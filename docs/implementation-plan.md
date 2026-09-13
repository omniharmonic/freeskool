---
title: "Free School — Implementation Plan (v1 before COhere)"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-12
status: draft
version: "0.1"
---

# Free School — Implementation Plan

*Benjamin Life (@omniharmonic) · 2026-09-12 · Target: v1 usable for the COhere skill-share track in October 2026. Companion: `prd.md`, `architecture.md`, `research-brief-v0.2.md`.*

## 0. Where we are (end of day 1, 2026-09-12)

Done this session: pnpm workspace; 17 validated `freeschool.draft.*` lexicons (CC0); `packages/shared` (role ladder, k-anonymity aggregator, 11 tests); `packages/spaces-shim` (Spaces-shaped store, in-memory impl, 4 tests); `packages/school-actor` (`SchoolActorPort` + `AppCustodyAdapter`, threshold + audit, 6 tests); `packages/pds-follow` (R4 follower, typechecks, ran against seven real hosts); `infra/` compose with the reference PDS (`:3000`, healthy) and Postgres 16 (`:5434`, healthy); stack proposal; Lucian packet and Lex questions drafted (not sent); brief v0.2; architecture; PRD. Also done: `apps/web` PWA shell (29 tests, builds) and `apps/appview` core (63 tests; contrail index + Hono API + pg-boss jobs + PostgresSpaceStore + server-side OAuth/custodial signup; `PdsChangeSource` stubbed with interface). End-to-end smoke test passes against the live local PDS + Postgres (school → custodial host → class in host repo + listing as the school → 3 app-side RSVPs → attendance → 3 feedbacks → k=3 summary with text withheld → redacted public calendar + `.ics`). 525-node skill taxonomy seeded under `taxonomy.test`. Workspace: 113 tests passing. Note for local dev: handles are `.test`; the reference PDS does not serve `listReposByCollection`, so contrail's discovery is seeded from `listRepos`.

## 1. Workstreams and owners

| # | Workstream | Owner | Depends on |
|---|---|---|---|
| A | Identity: custodial signup, server-side OAuth, sessions, take-ownership stub | appview | PDS running |
| B | Indexing: contrail projection, backfill, `PdsChangeSource`, peer registry | appview + `pds-follow` | A (school account exists) |
| C | Classes: create/edit, config, skillLevel, location tiers, series + occurrences | appview + web | A, B |
| D | RSVP / attendance / requests (app-side) | appview + web | A |
| E | Roles, badges, policy editor | `shared` + appview + web | D |
| F | Feedback (ballots, k-anon, window) | appview + web | D |
| G | Moderation: queue, approvals, audit, public projection | `school-actor` + appview + web | E |
| H | Notifications: outbox, reminders, declarative push, email, newsletter | appview + web | C, D |
| I | PWA: shell, install nudge, offline cache, zine | web | C |
| J | Interop: tag-routed listings with COhere | appview + Aaron Gabriel | B, C |
| K | Skills seed: R5 JSONL → `freeschool.draft.skill` records under Benjamin's authority; Tier A/B flags | scripts | A |
| L | Privacy hardening: retention jobs, logging policy, EXIF re-encode, headers, audit script | appview | all |
| M | Ops: deploy to a VPS, neutral PDS hostname, backups, runbook, counsel review | Benjamin | L |

## 2. Week plan (five weeks to COhere)

**Week 1 (Sep 15–19) — skeleton runs end to end locally.** Finish A and the first cut of B (backfill from our own PDS + one peer; live via `PdsChangeSource` spike). Smoke script: create school → create member → post class → RSVP → attest → feedback summary → calendar. K: seed skills on the local PDS. Ping #3 ("scaffold runs end to end") when the smoke script passes against the live compose stack. Benjamin decisions needed: license (AGPL proposed), repo publishing under `clawmniharmonic`, send the Lucian and Lex emails.

**Week 2 (Sep 22–26) — the loop a host feels.** C (classes incl. series), D, E with policy defaults open, I shell wired to real API (replace mocks). First deploy to a staging VPS with a neutral PDS hostname. Lucian's answers folded into lexicon names if they arrive; otherwise stay on `.draft`.

**Week 3 (Sep 29–Oct 3) — trust and notifications.** F, G, H (push + email), invite links, Tier A/B skill visibility. Joint listing test with Aaron Gabriel (J). Privacy audit script (zero public records naming others) runs in CI.

**Week 4 (Oct 6–10) — steward-ready.** Admin dashboard v0 complete; newsletter; zine polish; accessibility pass; install-nudge copy reviewed with Lex; member note (R9) reviewed by two members with exposure; counsel review of retention and posture items started.

**Week 5 (Oct 13–17) — launch hardening.** Load test the reminder and materialization jobs; chaos: take a peer down 25 h and confirm repair; backups + restore drill; runbook for Lex; production deploy; Boulder school account created with rotation keys split; COhere classes entered.

**Buffer: COhere week.** Fixes only.

## 3. Definition of done per workstream
- A: F1, F2 pass; session survives Add-to-Home-Screen on a real iPhone.
- B: a class posted on a peer PDS appears within 60 s; a 25 h outage repairs without manual action; `peer_repo` follows a migrated repo.
- C: F3, F4, F11 pass; a cancelled occurrence never reappears (test).
- D: F5, F6, F7 pass; no `rsvp`/`attendance` records in public repos unless opted in (audit script).
- E: F8, F15 pass; defaults open; gate opt-in.
- F: F9 passes; differencing test (n=4 then n=3 cohorts) blocked.
- G: F10 passes; public projection shows enum only.
- H: F13 passes on iOS 26.x; email `.ics` opens in Calendar.
- I: F14 passes; Lighthouse PWA installable; offline calendar for 30 days.
- J: F12 passes jointly.
- K: ≥ 300 skill records seeded; Tier B list reviewed.
- L: retention tests; headers; no DID/email in logs (grep test).
- M: deployed; runbook; canary published; counsel sign-off on #12/#20/#23/#24 of R9.

## 4. Risks and mitigations
| Risk | Mitigation |
|---|---|
| `PdsChangeSource` cursor semantics across hosts (R6 flags as highest-risk) | spike in week 1 using `pds-follow`; one contrail source per host if `SourcePosition` cannot encode multi-host |
| Spaces alpha churn | nothing user-facing depends on it in v1; shim keeps Postgres backend |
| Lucian's namespace decision arrives late | stay on `.draft`; rename is a find-and-replace |
| iOS install/push behavior changes in iOS 27 (ships 2026-09-14) | R8 baseline 26.2; test on a 27 device in week 3 |
| Legal exposure of retention choices | counsel review before launch; ship conservative defaults until then |
| Lex's capacity | everything automatable is automated; dashboard has no required daily task |
| Reused code licenses | Arbiter and atproto-notify not vendored; OpenMeet (Apache) with NOTICE; contrail/atmo MIT |

## 5. Decisions needed from Benjamin (blocking outward-facing steps)
1. License: AGPL-3.0-or-later for the app (proposed) or MIT.
2. Publish the repo under `clawmniharmonic` (public) — when.
3. Send the Lucian packet and the Lex questions (drafts in `docs/email-drafts/`).
4. Neutral PDS hostname (domain to buy or reuse).
5. Who holds the second rotation key for the school DID.

## Sources
Research briefs R1–R9; research brief v0.2; architecture v0.1; PRD v0.1.
