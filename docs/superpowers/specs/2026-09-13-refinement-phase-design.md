# Refinement phase: onboarding, people, skills, end-to-end personas

Date: 2026-09-13. Author of record: Benjamin Life (@omniharmonic). Status: approved for autonomous execution under the rulings below; Benjamin may override any ruling on a later pass.

## 1. Why

The MVP is live at https://freeskool.xyz. Benjamin's first real-user pass found the product thin exactly where a skill-sharing network lives: onboarding, people, and the links between a skill and the people who hold it. This phase closes those gaps, broadens the taxonomy, makes the whole thing testable with realistic mock members, and writes (but does not build) the multi-school design.

Benjamin's observations, verbatim in spirit:

1. Bluesky sign-in imported nothing from the Bluesky profile.
2. Email sign-in offered no handle choice and no profile setup.
3. The taxonomy needs more initial skills, and adding a missing skill into the right branch must be easy.
4. Why can't skill claims be public in v1?
5. How do attestations of other people's skills work? (They do not exist yet.)
6. There is no place to see other members' profiles.
7. A skill page does not link to the members who claim it.
8. Asking for a class uses a dropdown; it must be type-ahead.
9. Make the omniharmonic Bluesky account a steward (done on production 2026-09-13).
10. Comprehensive end-to-end testing with mock users and interactions, front end and back end, including button placement.
11. Multi-school for multiple cities: full spec now, development deferred to a later phase on a separate branch.

## 2. What exists (from the code map)

- Bluesky door: `GET /oauth/callback` creates a session and a `fs_member` row only. No `app.bsky.actor.*` call anywhere.
- App-side profile: `fs_app_meta` key `profile:<did>` with `displayName`, `bio`, `avatar` (re-encoded WebP), `publicListing`. Read by `GET /api/me`, written by `PUT /api/me`.
- Custodial door: `lib/custody.ts` mints a PDS account with a generated handle `<adjective><noun><3 digits>.<domain>`. `VerifyScreen` lands on the requests board. No handle change endpoint. A second `POST /api/auth/signup` with the same email fails at the PDS (returning members cannot get a new link).
- Skill claims: `PUT /api/me/skill-claims`. `visibility` is `public` or `school`. Public Tier A claims are written as `freeschool.draft.skillClaim` in the member's repo. `school` claims live only in `fs_app_meta` key `skill-claims:<did>`. `checkPublicClaims` forces `school` for every Bluesky-door session (rule F2) and requires `confirmTierB` for Tier B.
- Skill page: ancestors, children, classes that teach it. People appear only through `GET /api/practitioners?skill=`, which requires a public record and `publicListing`.
- Attestations: lexicon `freeschool.draft.skillAttestation` exists; `vouchesReceived` reads public records; nothing writes one; the privacy audit fails any attestation naming another DID because no double opt-in table exists.
- People: `/people/$did` shows opted-in public profiles only. No members list.
- Requests: `<select>` over `flattenSkills(useSkillTree())`. Same pattern in `MeScreen` and `EventEditScreen`.
- Taxonomy: 525 `freeschool.draft.skill` records under the authority DID, seeded from `infra/seed/skills/skills-seed.jsonl` by `packages/lexicons/scripts/seed-skills.mjs` using `AUTHORITY_HANDLE`/`AUTHORITY_PASSWORD` (idempotent `putRecord`, `rkey = id`).
- Steward: operator script `appoint-steward.ts`; admin UI at `/admin/*`; `requireRole(Role.Steward)`.
- Single school: `SCHOOL_DID`, `SCHOOL_HANDLE`, `SCHOOL_APP_PASSWORD` in `config.ts`; `lib/school-actor.ts`; `lib/policy.ts`; `fs_steward.school_did`.
- Tests: Vitest per package (appview 384, web 205), Playwright `apps/web/e2e/*.spec.ts` reading magic links from `apps/appview/.dev-mail.log`, `scripts/smoke.ts`, `scripts/privacy-audit.ts`. No demo seed.

## 3. Privacy rulings that bound this design

The R9 rule stands: **no public record may name a DID its holder did not write; the membership roster is never public.** "Public" means readable without a school session or readable from the AT Protocol network. Everything below that shows one member to another is **members-only**: it requires a session cookie, is served with `X-Robots-Tag: noindex, nofollow`, and never becomes a record.

- R-1 **Directory is members-only, listed by default, opt-out.** Every member with a session appears in the directory to other members. A member can set `directoryListing: false` in Me ("Hide me from the school directory"), which also removes them from skill-page people lists. Unauthenticated requests get 401.
- R-2 **Attestations are app-side in v1.** Table `fs_attestation`, positive only, attester-removable. Counts are shown to everyone in the school; who vouched is visible only to the subject. No `skillAttestation` record is written (double opt-in stays deferred; the privacy audit keeps failing closed on any such record).
- R-3 **Public claims for Bluesky-door members become possible with an explicit confirmation.** F2's default stays forced-off. A Bluesky-door member who ticks "Publish this to my Bluesky repo" sees a one-time confirm sheet stating the permanent linkage, and the request carries `confirmPublicLinkage: true`. Tier B still needs `confirmTierB`. Rationale: PRD principle 7 ("defaults open; gates opt-in"), and the member already accepted the linkage warning at sign-in. Benjamin may revert this to hard-off by deleting one branch in `checkPublicClaims`.
- R-4 **Bluesky profile import re-encodes the avatar** through the existing `normalizeImage` (strips metadata) and stores the result app-side like any other avatar. Imported text goes into the same app-side `profile`, never into a record.
- R-5 **Handles are chosen, never derived.** The custodial onboarding lets a member pick a handle; the server never suggests one from the email. The generated handle remains the fallback.
- R-6 **Proposed skills publish immediately** as `status: "proposed"` records under the authority DID, with a steward "retire" action. Gate-free by default (principle 7). A proposal carries the proposer's DID only app-side (`fs_skill_proposal`), never in the record.

## 4. Sub-projects, in build order

Each sub-project ships working, tested software on its own. Branch `refinement` from `main`; one PR at the end; production release only on Benjamin's OK.

### 4.1 Demo data and persona harness (first, because everything after is evaluated with it)

`pnpm --filter @freeschool/appview seed:demo` (script `apps/appview/scripts/seed-demo.ts`). Refuses when `NODE_ENV=production` or when `PDS_URL` is not in `ALLOWED_PRIVATE_PDS_HOSTS`. Idempotent by deterministic emails (`demo+<slug>@freeskool.test`).

Creates, through the same code paths real users hit (not raw SQL where an API/lib exists):

- 12 custodial members via `signup()` + direct verification, each with display name, bio, a generated avatar (deterministic SVG identicon rasterized to PNG, passed through `normalizeImage`), and a chosen handle (e.g. `maya-kintsugi.test`). Personas are written in `apps/appview/scripts/demo-personas.ts` with a role intent: 4 hosts, 5 learners, 2 facilitators-to-be, 1 steward (`demo+steward`).
- Skill claims per persona (3–7 each, mixed levels and visibilities; at least one Tier B kept `school`).
- 14 events over the next 6 weeks through `lib/events.ts` create path: 3 recurring series, 2 "venue needed", 2 past events with attendance records (so badges and counts derive), 1 unlisted, 1 listed with neighborhood-only place.
- RSVPs (going/interested) spread over the events; 6 requests on the needs board with interest counts near and past threshold; 1 claimed request.
- 10 attestations among members (uses the new attestation lib from 4.3; the seed task depends on it and is ordered after it in the plan, but the script file is created here).
- 5 knowledge notes through `lib` paths used by `routes/knowledge.ts`.
- Appoints `demo+steward` via `appointSteward()`.

Output: `apps/appview/.demo-users.json` (git-ignored) listing `{slug, email, did, handle}` so Playwright signs in as any persona through the normal magic-link flow (`POST /api/auth/signin` from 4.2, link read from `.dev-mail.log`). Prints a summary with truncated DIDs only (R9 logging rule).

Playwright helper `apps/web/e2e/personas.ts`: `signInAs(page, slug)` (requests a link, reads the dev mail log, visits `/verify?token=`), `asSteward`, `asNewcomer(email)`.

### 4.2 Onboarding

**Returning members.** `POST /api/auth/signin { email }`: if a custodial account exists for the email, send a fresh magic link (same 24h token table); otherwise behave exactly like signup. `POST /api/auth/signup` stays as an alias. Response never reveals whether the email existed (`{ ok: true }` both ways). `SignInScreen` copy becomes "Continue with email"; the 502 path disappears.

**Custodial onboarding screen** `/welcome` (new `WelcomeScreen.tsx`), reached from `VerifyScreen` when `GET /api/auth/me` reports `onboarded: false` (new `fs_member_prefs` flag `onboardedAt`). Three steps in one screen with a progress strip, each skippable:

1. *Your handle.* Shows the generated handle, offers "Choose my own". Input validates `^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$` (3–20 chars), live availability via `GET /api/me/handle/check?handle=`, saves via `PUT /api/me/handle { handle }` which calls `com.atproto.identity.updateHandle` with the custodial account's session (refreshed by `actor-agent.ts`) and re-resolves the member's handle. Custodial only (Bluesky-door → 403). Copy states the handle is public and permanent in the PLC log.
2. *How you show up.* Display name, bio, avatar (existing `ImagePicker`), saved via `PUT /api/me`. Copy says all three are optional and that the directory is members-only.
3. *What you can share or want to learn.* The new `SkillPicker` (4.4), saving via the existing skill-claims mutation.

"Finish" sets `onboardedAt` (`POST /api/me/onboarded`) and lands on the requests board as today. Me gets an "Edit handle" row for custodial members.

**Bluesky profile import.** On `GET /oauth/callback`, after `createSession`, call `importBlueskyProfile(did)` (`lib/bsky-profile.ts`): `GET https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=<did>` with a 5s timeout; on success and **only when the member has no app-side profile yet**, store `displayName`, `description → bio`, and the avatar fetched from the returned CDN URL, re-encoded with `normalizeImage(…, true)`. Failures are logged as a single line with no DID and never block sign-in. `POST /api/me/import-bsky-profile` re-runs it on demand (Bluesky-door only) and overwrites; Me shows "Refresh from Bluesky" for those members. The import is unit-tested with a recorded fixture; the network call is behind an injectable fetch.

**Public claims for Bluesky-door members (R-3).** `checkPublicClaims(sessionKind, tiers, confirmTierB, confirmPublicLinkage)` returns `PublicLinkageConfirmRequired` (400) instead of `PublicTogglesLocked` when the session is `oauth` and `confirmPublicLinkage` is false; with it true, Tier A proceeds and Tier B still needs `confirmTierB`. `PUT /api/me` `publicListing` gets the same treatment with the same flag. Me explains the rule in one sentence next to the toggle and shows the confirm sheet the first time.

### 4.3 People: attestations, directory, member profiles, skill-page people

**Data.**

- `fs_skill_claim_index(did, skill_uri, level, visibility, updated_at)`, PK `(did, skill_uri)`. `PUT /api/me/skill-claims` replaces the member's rows in the same transaction it writes the JSON blob; a one-off backfill (`scripts/backfill-skill-claims.ts`) reads every `skill-claims:*` key. This is the query index for "who claims X" and directory skill chips. Public practitioners (`/api/practitioners`) keep reading the protocol index; members-only views read this table.
- `fs_attestation(id, attester_did, subject_did, skill_uri, context_event_uri null, created_at)`, unique `(attester_did, subject_did, skill_uri)`. Constraints: attester ≠ subject; subject must currently claim the skill (any visibility) or have hosted a class teaching it.
- `fs_member_prefs.directory_listing boolean default true`, `onboarded_at timestamptz null`.

**API (all `requireViewer`, all `noindex`).**

- `GET /api/members?q=&skill=&cursor=` — directory. Returns `{ members: [{ did, handle, displayName, avatarUrl, bio (first 160 chars), role, claimCount, vouchCount }], cursor }`, ordered by `lastSeenAt` desc, excluding `directoryListing=false`. `q` matches handle and displayName (ILIKE), `skill` filters through the claim index.
- `GET /api/members/:did` — member profile for members: identity fields, `role`, `badges`, `claims` (all visibilities, each with `vouchCount` and `viewerVouched`), `hosting` (upcoming events they host, respecting visibility rules already in `lib/events.ts`), `resources`. 404 if hidden from directory and viewer ≠ subject.
- `GET /api/members/:did/avatar`.
- `POST /api/attestations { subjectDid, skillUri, contextEventUri? }`, `DELETE /api/attestations/:id`, `GET /api/me/attestations` (given and received; received includes attester identity — subject-only).
- `GET /api/skills/:id` gains `people: { count, members: [...] }` when a session exists (members-only, from the claim index, excluding hidden members), alongside the existing public practitioners list.
- `GET /api/me` gains `directoryListing`, `onboarded`.
- Evidence: `inviteOrVouch` becomes true when the member has ≥1 app-side attestation received; `vouchesReceived` adds app-side counts to the protocol counts.

**Web.**

- New tab **People** in the tab bar (Calendar · Skills · Requests · People · Me); `/people` `PeopleScreen.tsx`: search box, skill filter chip (SkillPicker), avatar grid with name/handle and role label; empty state explains members-only.
- `/people/$did` becomes the member profile for signed-in viewers (`MemberProfileScreen.tsx`); signed-out viewers still get the existing public-profile rendering. Shows claims grouped by level with a **Vouch** button per skill (disabled on own profile; toggles to "Vouched ✓"), vouch counts, badges, upcoming classes hosted, notes. Subject sees "Who vouched" expanders.
- Skill page: section **People with this skill** (members-only) listing members with their level and a vouch count, linking to their profiles; signed-out shows the public practitioners shelf as today, plus "Sign in to see members".
- Me: "Hide me from the school directory" toggle; "Vouches you've received" with per-skill counts and names.

### 4.4 Skills: type-ahead picker, propose a skill, taxonomy expansion

**`SkillPicker`** (`apps/web/src/components/SkillPicker.tsx`): accessible combobox (WAI-ARIA 1.2 pattern: `role=combobox`, `aria-expanded`, `aria-activedescendant`, listbox with options; arrow keys, Enter, Escape; touch-friendly rows). Filters `flattenSkills` by label, path and description tokens (diacritic-insensitive, prefix-and-substring ranked), shows "Domain › Area" as secondary text, up to 12 results, a "Show all in <area>" escape to the full tree sheet, and a final row **"Can't find it? Propose a skill"**. Props: `value`, `onChange(uri)`, `exclude?`, `allowPropose?`. Replaces the `<select>` in `RequestsScreen`, `MeScreen`, `EventEditScreen` (multi-select variant `SkillMultiPicker` for the latter two, chips for selected). `flattenSkills` moves to `apps/web/src/lib/skills.ts` (one copy).

**Propose a skill.** `POST /api/skills { label, description?, parentUri }` (members). Server: slugify label (`rkey`), reject collisions with an existing id or a near-duplicate label in the same area (case/diacritic-insensitive; returns the existing skill instead with 409 and `existing`), write `freeschool.draft.skill` `{ id, label, description, broader: [parentUri], status: "proposed", createdAt }` with the authority credentials (`AUTHORITY_HANDLE`, `AUTHORITY_PASSWORD`, new optional config; 503 `AuthorityUnavailable` when unset), record `fs_skill_proposal(id, skill_uri, proposer_did, created_at, status)`, `indexer.notify`, return the new `SkillNode`. Tier defaults to A unless the label matches `SENSITIVE_LABEL_RE`, in which case `fs_skill_tier` gets B. Web: `ProposeSkillSheet` from the picker with label, description, and a parent picker restricted to domains and areas (default: the area the member was browsing); success selects the new skill in the calling picker. Admin: `/admin/skills` lists proposals (newest first) with **Retire** (`POST /api/admin/skills/:id/retire` → record `status: "retired"`) and **Move** (change `broader`). Retired skills are hidden from pickers but keep resolving for existing claims.

**Taxonomy expansion.** Grow `skills-seed.jsonl` by roughly 200 skills, targeting thin areas for a community free school: food and fermentation, fibre and textile crafts, garden and land, body and movement, music and voice, languages and literacy, digital basics and creative software, repair (bikes, electronics, small appliances), home and shelter, childcare and elder care, community organizing and facilitation, money and mutual aid, nature and outdoors. Each new record: `status: "proposed"` unless ESCO-anchored, `_provenance.descriptionSource: "authored"`, a one-sentence description, placed under an existing area (add an area only where ≥6 new skills share none). Update `stats.json` and the README counts; `pnpm lexicons:validate` passes; reseed locally; production reseed happens with the release.

### 4.5 Steward experience

No new features beyond `/admin/skills`. The persona suite exercises every admin screen as `demo+steward`. Findings that block a steward from understanding a screen are fixed in 4.6.

### 4.6 End-to-end personas and UX audit

`apps/web/e2e/personas.spec.ts` (serial, against the dev stack seeded by 4.1):

1. **Newcomer**: continue with email → verify → `/welcome` → choose handle (availability error on a taken one, success on a free one) → set name and bio → pick two skills with the type-ahead → land on requests → appears in People and on both skill pages.
2. **Learner**: sign in as `demo+rosa` → post a request by typing "ferment" and choosing the match → RSVP to a class → open the host's profile from the class → vouch for the host's skill → vouch count increments on the skill page.
3. **Host**: sign in as `demo+amir` → create a class with two skills via the picker → see RSVP count → check attendance on the past class → read feedback summary → "Who vouched" shows Rosa.
4. **Steward**: sign in as `demo+steward` → admin overview → retire a proposed skill → moderation queue → policy → newsletter compose → handoff screen renders.
5. **Returning member**: request a second link for `demo+rosa`, sign in, confirm profile persisted.
6. **Bluesky-door**: unit level only (importer fixture, `checkPublicClaims` matrix); documented as a production acceptance step for Benjamin.

**UX audit**: `apps/web/e2e/audit.spec.ts` screenshots every route at 390×844 and 1280×800 for the newcomer and steward into `apps/web/test-results/audit/` (git-ignored). I review the images and write `docs/plans/refinement-ux-audit.md` with a finding per issue (route, what a real user hits, fix). P1 findings (dead ends, unreachable buttons, broken flows, truncated labels, missing empty/loading/error states) are fixed in this phase; P2 are listed.

Also: `pnpm -r test`, `pnpm -r typecheck`, `pnpm lexicons:validate`, `smoke.ts`, and `privacy-audit.ts` stay green; the privacy audit runs against the seeded dev PDS and must report zero violations, which proves the new features wrote no forbidden records.

### 4.7 Multi-school design (document only)

`docs/superpowers/specs/2026-09-13-multi-school-design.md`, written after 4.1–4.6 land so it reflects the final shapes. Required sections: goals and non-goals; tenancy model (one AppView, many schools, each a `freeschool.draft.school` record + DID; a member may belong to several); URL scheme (`<city>.freeskool.xyz` and custom domains vs path prefix; recommendation with DNS/Caddy implications and the R9 neutral-PDS-hostname constraint); data model changes (every app-side table gains `school_did`; session carries `current school`; `fs_member` becomes `fs_membership(did, school_did)`; policy/steward/proposal/attestation scoping; what stays global: members' profiles, claims, the skills authority); school actor: one `SchoolActorPort` per school with credentials in a `fs_school_credential` table encrypted under `CUSTODY_KEYS` instead of env; taxonomy: shared global authority plus per-school proposed skills; calendar exchange between schools and with COhere; onboarding a new city (a "start a school" flow: create school DID on the shared PDS or bring your own, appoint founder steward, choose handle domain); migration plan for Boulder (backfill `school_did` everywhere, zero downtime); security review against R9 per table; rollout in phases with a test plan. Also: an explicit list of every file found in the code map that reads `config().SCHOOL_DID`.

## 5. Non-goals this phase

Real Spaces, public attestation records, elections, labelers, multi-school code, handle domains other than the school's, a mobile native app, internationalization.

## 6. Acceptance

Benjamin can, on localhost with the demo seed: sign in as any persona, see a People tab with 12+ members, open a member, vouch for a skill, see that vouch counted on the skill page and in the subject's Me; sign up fresh and pick a handle and skills; ask for a class by typing; propose a skill and find it in the tree; and, as steward, retire it. On production after release: his Bluesky profile appears after "Refresh from Bluesky", his public claims can be published after the confirm sheet, and `privacy-audit` reports zero violations.
