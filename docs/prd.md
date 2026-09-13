---
title: "Free School — Product Requirements (v1)"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-12
status: draft
version: "0.1"
---

# Free School — Product Requirements Document (v1, before COhere)

*Benjamin Life (@omniharmonic) · 2026-09-12 · The organizer's 2026-09-10 interview is the product spec; this document turns it into requirements, informed by research briefs R1–R9. Companion: `architecture.md`, `implementation-plan.md`.*

## 1. Purpose

Free School is a free, open-source app for a community free school: a calendar of classes anyone can teach, a board of things people want to learn, and profiles of what people can share. It exists so a broke, part-time organizer can run a skill-sharing network without becoming an organization, and so the network's memory outlives any website or founder. It runs on the AT Protocol so people own their records and a school in another city can be started by copying, not by asking permission.

The app is the directory and the reminder. The school is the people in the room.

## 2. Who it is for

| Person | Need | What they do in v1 |
|---|---|---|
| **Lex, the steward** | run the school without touching code; promote without money; stay out of "organizing an org" | sets policy in plain switches, approves nothing by default, prints the monthly zine, sends the newsletter, handles rare moderation with a written reason and a second steward |
| **A host** ("I know plumbing") | post a class in two minutes, pick a time and a place, list materials, know who is coming, check people off afterwards | creates a class, sees RSVP count, attests attendance, reads an anonymous summary once enough people respond |
| **A learner** ("I want to learn auto mechanics") | find classes, say what they want to learn, get reminded, not be exposed | browses the calendar, posts a request, RSVPs privately, installs the app for reminders, prints the zine |
| **A newcomer** | join without a gate, without a real name, without linking to their other life | creates a fresh Free School identity in under a minute with a made-up name |
| **A peer school** (COhere calendar; later another city) | see our tagged classes, have theirs seen | exchanges tag-routed listings; later subscribes to our peer registry |
| **A future self-hoster** | run a copy | Phase 3; v1 keeps everything forkable |

## 3. Principles (binding on every feature)

1. **Everybody's a teacher, everybody's a student.** No experts, no credentials, no approval to teach by default.
2. **No money in the app.** No payments, tickets, fees, or donate button. At most a free-text supplies note per class (pending Lex).
3. **Attestations, not scores.** Counts and presence; never averages, rankings, stars, or public per-person feedback.
4. **Public calendar, private people.** Classes are public. Who RSVPs, who attended, who is a member, and who said what in feedback are not public, ever.
5. **No public record may name a person who did not write it.**
6. **The calendar is the school.** The printable zine is a first-class output, not an export.
7. **Defaults open; gates opt-in.** Ship with Lex's "if you say you're Free School, you're Free School."
8. **Forkable and continuous.** Records in people's own repos; open license; no single-owner objects; a hand-off path.
9. **Failure is normal.** Empty calendars, cancelled classes, and nobody showing up are recorded plainly, never penalized.
10. **Reuse before extend.** Borrow `community.lexicon.calendar.*` and `coop.lexicon.*`; attach sidecars; never fork the commons.

## 4. Scope

### 4.1 In v1 (priority order)
1. **Sign-in**: create a new Free School identity with an email (primary); sign in with an existing AT Protocol account (secondary, with a plain permanent-linkage warning). Pseudonymous generated handle; no real-name prompt.
2. **Profile + skill claims**: display name optional, generated identicon, bio; skills I can share / want to learn, each with a level (learning, practicing, proficient, teaching) and a visibility choice (school-only by default, public pre-ticked only for ordinary skills). The taxonomy is the 525-node seed from R5 (8 domains, 52 areas, 465 skills; ESCO and Wikidata anchored, community extensions marked proposed) in two tiers: Tier A ordinary skills, Tier B legal-exposure-adjacent skills that are never public by default.
3. **Class creation**: title, description, skill + depth (1–3), date/time (timezone-aware), place with tiered disclosure (open / listed: neighborhood only until RSVP / unlisted), capacity and waitlist, materials list, optional supplies note, recurrence (weekly, biweekly, monthly; edit this one / this and following; cancel one). A class may reference zero skills (reading groups, socials, open shop hours are a third of real free-skool offerings per R5) and may be posted as "venue needed", which is a valid, findable state rather than an error (R7).
4. **RSVP**: going / interested; private by default; per-class opt-in to publish the RSVP with a permanence warning; waitlist in TID order.
5. **Host-attested attendance**: the host checks off who came; stored app-side; feeds counts and badges.
6. **Needs board**: "I want to learn X" with a threshold; people add themselves; at threshold a host can claim it and it becomes a class.
7. **Derived badges and roles**: counts (hosted, attended, vouched); role ladder member → host → facilitator → steward computed from evidence and the school's policy; all thresholds editable; defaults open.
8. **Invite links**: opaque bearer links that reveal nothing about the inviter; optional vouch gate in policy.
9. **Anonymous host feedback**: three 3-point aspects and an optional note after a class; host sees a summary once 3 (numeric) or 5 (text) people have answered; published once per window; stewards can see more only for safety handling.
10. **Admin dashboard v0**: policy editor (plain-language switches and numbers), moderation queue (written reason mandatory, second steward for removals), newsletter composer (monthly "upcoming classes"), peer schools list.
11. **Tag-routed calendar exchange with COhere**: classes tagged `skillshare` / `free-school` appear on the COhere calendar and vice versa via `coop.lexicon.event.listing`.
12. **PWA**: installable; offline next 30 days; install nudge after first RSVP; reminders (24 h, 1 h, day-of) by push after install and by email always; badge count.
13. **Monthly print zine**: one click, black-and-white, photocopy-legible, folds.
14. **Continuity**: a printable "how this skool works" page rendered from the policy record, and a steward hand-off flow so a stranger can restart the school after a year of silence (R7).

### 4.2 Out of v1
Real Spaces in production; steward elections; labelers; wiki adapter; one-click self-host; venue records (Phase 2); Telegram/Bluesky DM notifications; payments of any kind (never).

## 5. Functional requirements

| ID | Requirement | Acceptance |
|---|---|---|
| F1 | New-identity signup completes in ≤ 60 s with only an email | account exists on our PDS; handle is generated, not derived from the email; cookie session set |
| F2 | OAuth door shows the hard confirm before redirect | confirm copy per R9 #4; all public toggles forced off for OAuth-door users |
| F3 | A host with role ≥ policy threshold can publish a class | event + config + skillLevel records written; class visible on calendar within 5 s on our PDS, ≤ 60 s from a peer |
| F4 | Listed events hide the exact address from non-RSVP'd viewers | public API returns neighborhood only; exact address served app-side N hours before to RSVP'd members |
| F5 | RSVP never writes a repo record unless opted in per event | default path creates only an app row; opt-in shows the permanence sentence |
| F6 | Attendance is host-attested, app-side, never a public record naming a DID | no `attendance` record in any public repo; counts update |
| F7 | Needs board threshold → claim → class | request status transitions open → claimed → scheduled; the class links back |
| F8 | Roles are a pure function of evidence + policy | changing a threshold re-derives roles without migration; `deriveRole` tests |
| F9 | Feedback is structurally anonymous | no author column on feedback rows; ballot table separate; event key destroyed at window close; aggregate suppressed below k |
| F10 | Destructive moderation needs two stewards and a written reason | `actAs` denies with `ErrThresholdNotMet` otherwise; audit row written either way; public projection is state + enum |
| F11 | Recurring classes materialize server-side | occurrences exist 90 days ahead, ≥ 4 always; cancelled occurrences never reappear |
| F12 | Tag-routed listings reach COhere | a tagged class yields a `coop.lexicon.event.listing` by the school; COhere's AppView indexes it (joint test with Aaron Gabriel) |
| F13 | Installed app gets reminders; uninstalled app is told why not | "Remind me" is gated; declarative push shows 24 h / 1 h / day-of |
| F14 | Zine prints from one click | A4/Letter explicit sizes, margins, no page breaks inside a class block, paper color on wrapper |
| F15 | Admin can change every policy default without a deploy | policy record written through the actor port; thresholds take effect immediately |

## 6. Non-functional requirements
- **Privacy** (R9): the defaults in architecture §3.3 and §5; retention as code with tests; counsel review of ballots-key destruction, PITR, subpoena posture, canary before launch.
- **Performance**: calendar first paint < 1.5 s on a mid-range iPhone over LTE; API p95 < 300 ms for reads.
- **Availability**: one-box deploy; a peer PDS outage must not affect our own calendar; 24 h cursor gaps repaired automatically.
- **Accessibility**: WCAG 2.2 AA for the PWA and the zine (high-contrast print); `prefers-reduced-motion`; in-app reduce-blur toggle.
- **Interoperability**: every class is a plain `community.lexicon.calendar.event`; Smoke Signal's former users and atmo/Dandelion/Beacon readers see correct events.
- **Portability**: a member can export their repo (CAR) and take ownership of a custodial account; a school can export app-side tables.
- **Licensing**: app AGPL-3.0-or-later (proposed); lexicons and zine templates CC0; all reused code MIT/Apache with attribution.

## 7. Success for v1 (COhere, October 2026)
- Free School Boulder's classes run from the app for the skill-share track; the zine is on the wall.
- ≥ 20 classes posted by ≥ 8 distinct hosts in the first month; ≥ 5 requests converted to classes.
- Zero public records naming a person who did not write them (audited by a scripted check against our PDS and Jetstream).
- Lex never opens a terminal.
- At least one tagged class flows to the COhere calendar and one back.

## 8. Open questions (owners)
- Lex: feedback compromise, day-one hosting, profile defaults, freeschool.com and handles, supplies note (drafted).
- Lucian: extend-vs-sidecar rule, skillAttestation vs evaluation, sandbox PDS, custody shape, series sidecar (drafted).
- Counsel: retention, ballots, canary, subpoena posture.
- zicklag / flo-bit: licenses for the Arbiter and atproto-notify.
- Aaron Gabriel: joint listing test date and the COhere AppView's indexing path.

## Sources
Organizer interview report 2026-09-10; research briefs R1–R9; research brief v0.2.
