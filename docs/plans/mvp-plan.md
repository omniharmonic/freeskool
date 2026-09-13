# Free School MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the existing scaffold (`apps/appview` backend with most endpoints, `apps/web` PWA shell on mock data) to a working MVP of every PRD §4.1 item and F1–F15, runnable end to end against the local compose stack.

**Architecture:** The backend already implements the privacy-sensitive core (roles, feedback anonymity, attendance, recurrence, moderation, policy). This plan (a) wires the PWA to the real API through a same-origin dev proxy and TanStack Query hooks, (b) fills the backend gaps the gap report found (invite links, skill tiers, OAuth forced-off, venue-needed state, tag routing, badges, zine data, newsletter sending, membership claims, continuity, `PdsChangeSource`, `takeOwnership`), (c) builds the missing screens, and (d) closes with an end-to-end test, a privacy audit script, and docs.

**Tech Stack:** TypeScript, pnpm workspace, Node 22. Backend: Hono, Drizzle + `pg`, pg-boss, `@atmo-dev/contrail` 0.23, `@atproto/*` 0.20-era packages, `packages/pds-follow`, `packages/school-actor`, `packages/shared`. Frontend: Vite 7, React 19, TanStack Router + Query, Tailwind 4, `vite-plugin-pwa`, Vitest, Playwright.

**Spec:** `docs/prd.md` (binding), with `docs/architecture.md`, `docs/research-brief-v0.2.md`, and `docs/plans/gap-report.md` (file:line inventory of what exists) as supporting context. Working notes: `CLAUDE.md`.

## Global Constraints

- Repo root: `/Users/benjaminlife/iCloud Drive (Archive)/Documents/cursor projects/freeskool` (path contains spaces; always quote). Branch `mvp`. Commit after each task with the attribution trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_017a13nYTBJNDEiXKapgTkjR`. Never push.
- Settled decisions (never reopen): sidecar composition, never add fields to borrowed records; all `freeschool.draft.*` lexicons live in `packages/lexicons/lexicons/freeschool/draft/` and must keep validating via `pnpm lexicons:validate`; **every write as the school goes through `SchoolActorPort`** (`packages/school-actor`), nothing else touches the school session; reputation derived, never scored; v1 on public records with RSVP, attendance, roster, feedback, moderation and invites app-side.
- Privacy (PRD §3.4–3.5, R9): **no public record may name a DID its holder did not write**; membership roster and moderation reasons are never public; feedback rows carry no author; no DIDs or emails in logs; public endpoints never enumerate members; profiles are `noindex`.
- Counts and presence only: the UI never shows averages, stars, rankings, or "popular".
- Local dev stack: PDS `http://localhost:3000` (handles `*.test`, admin password in `infra/pds.env`), Postgres `postgres://freeschool:freeschool@localhost:5434/freeschool`, AppView `http://localhost:4000`, web dev server `http://localhost:5173` proxying `/api` and `/oauth` to the AppView. `FREESCHOOL_NO_JOBS=1` runs HTTP only. OAuth secondary door cannot run on http origins (returns 503) — UI must handle that state; it is not testable locally.
- Tests: Vitest per package with a package-local `vitest.config.ts` (a stray `vite.config.ts` in the home directory breaks discovery otherwise). DB tests use the live local Postgres and skip with a clear message if unreachable. Test output must be pristine. `pnpm -r test` and `pnpm -r typecheck` must pass at the end of every task.
- Frontend copy: sign-in hard-confirm text verbatim from PRD/R9: "Before you continue: anyone on the internet will be able to see that this account is part of Free School, and that link can't be undone later — not by us, and not by you. If you'd rather keep Free School separate, go back and create a new identity instead." Install-nudge copy stays as shipped from R8. Do not name a specific iOS button position.
- Design system: keep the existing risograph/iOS-idiom styles in `apps/web/src/styles.css` and components; new screens reuse existing components (sheets, cards, chips, tab bar). No new CSS frameworks.
- Model-facing note: the gap report's file:line references are from 2026-09-12; verify before editing.

---

### Task 1: Web API client, dev proxy, query hooks, and route skeleton

**Files:**
- Modify: `apps/web/vite.config.ts` (add `server.proxy` for `/api` and `/oauth` → `http://localhost:4000`, `changeOrigin: false`)
- Modify: `apps/web/src/lib/api.ts` (rewrite: typed client, `credentials: 'include'`, error type, every endpoint the screens will need)
- Create: `apps/web/src/lib/queries.ts` (TanStack Query hooks + mutation helpers)
- Create: `apps/web/src/lib/types.ts` (response types mirroring the AppView's JSON shapes; replace usages of mock types where they leak)
- Modify: `apps/web/src/router.tsx` (register ALL routes this plan adds, pointing at placeholder components that Tasks 3–10 replace: `/signin`, `/verify`, `/oauth/confirm`, `/events/new`, `/events/:id/edit`, `/events/:id/attendance`, `/events/:id/feedback`, `/events/:id/feedback-summary`, `/invite/:token`, `/me/settings`, `/admin`, `/admin/policy`, `/admin/moderation`, `/admin/peers`, `/admin/newsletter`, `/admin/handoff`, `/how-it-works`)
- Create: `apps/web/src/routes/Placeholder.tsx` (renders the route name and "coming in a later task")
- Modify: `apps/web/src/lib/mock.ts` — keep the file, but export a `USE_MOCK` flag defaulting to `import.meta.env.VITE_USE_MOCK === '1'` so existing screens keep working until each is wired
- Test: `apps/web/src/lib/api.test.ts`, `apps/web/src/lib/queries.test.ts`

**Interfaces:**
- Produces: `api` object in `apps/web/src/lib/api.ts` with methods, all returning parsed JSON and throwing `ApiError { status: number; code?: string; message: string }` on non-2xx:
  - `auth.signup({ email })`, `auth.verify(token)`, `auth.me()`, `auth.logout()`, `auth.oauthStartUrl(confirm: boolean): string`
  - `calendar.list({ from, to, school? })`, `events.get(id)`, `events.create(body)`, `events.update(id, body)`, `events.icsHref(id)`
  - `rsvp.set(eventId, { status: 'going'|'interested', alsoPublicRecord?: boolean })`, `rsvp.clear(eventId)`, `rsvp.mine()`
  - `attendance.list(eventId)`, `attendance.set(eventId, rows)`
  - `requests.list()`, `requests.create(body)`, `requests.rsvp(id)`, `requests.claim(id, body)`
  - `skills.tree()`, `skills.get(id)`
  - `me.skillClaims()`, `me.setSkillClaims(claims)`, `me.profile()`, `me.updateProfile(body)`
  - `feedback.submit(body)`, `feedback.summary(eventId)`
  - `invites.mint(body)`, `invites.redeem(token)`
  - `push.vapidKey()`, `push.subscribe(sub)`, `push.unsubscribe(endpoint)`, `notifications.list()`, `notifications.prefs()`, `notifications.setPrefs(p)`
  - `admin.policy()`, `admin.setPolicy(p)`, `admin.moderation.list()`, `admin.moderation.propose(b)`, `admin.moderation.approve(id)`, `admin.moderation.execute(id)`, `admin.peers()`, `admin.setPeers(p)`, `admin.newsletter.compose()`, `admin.newsletter.send(id)`, `admin.handoff.start(b)`, `admin.handoff.accept(token)`
  - `school.howItWorks()`
  - `zine.month(yyyyMm)`
  Endpoint paths: read `apps/appview/src/http/routes/*.ts` for the ones that exist and use them exactly; for endpoints Tasks 2 and 9 add, use these paths: `POST /api/invites`, `POST /api/invites/:token/redeem`, `GET /api/zine/:yyyyMm`, `GET /api/me/badges`, `GET /api/school/how-it-works`, `POST /api/admin/handoff`, `POST /api/admin/handoff/:token/accept`, `POST /api/admin/newsletter/:id/send`, `GET/PUT /api/notifications/prefs`.
- Produces: hooks in `queries.ts` named `useCalendar(range)`, `useEvent(id)`, `useMe()`, `useRequests()`, `useSkillTree()`, `useSkill(id)`, `useMyClaims()`, `useFeedbackSummary(id)`, `useAdminPolicy()`, `useModerationQueue()`, `usePeers()`, `useNotifications()`, plus `useRsvpMutation()`, `useCreateEventMutation()`, etc., all invalidating the right query keys. Query keys are arrays starting with the resource name (`['event', id]`).

- [ ] **Step 1: Write failing tests** — `api.test.ts`: mock `globalThis.fetch`; assert `credentials: 'include'` is passed, JSON body and content-type on POST, `ApiError` thrown with `status` and server `error` code on 4xx, `events.icsHref('x')` returns `/api/events/x.ics`, `auth.oauthStartUrl(true)` includes `confirm=1`. `queries.test.ts`: with a `QueryClientProvider` and mocked `api`, `useRsvpMutation` invalidates `['event', id]` and `['calendar']`.
- [ ] **Step 2: Run** `pnpm --filter @freeschool/web test` — expect the new tests to fail (missing exports).
- [ ] **Step 3: Implement** `api.ts`, `types.ts`, `queries.ts`; add the proxy; register routes with `Placeholder`; add `USE_MOCK` gate without breaking the existing screens (they still render mock data when `USE_MOCK` is true; default false means screens must not crash on real empty data — wrap existing mock consumers with `USE_MOCK ? mock : []` where needed).
- [ ] **Step 4: Run** `pnpm --filter @freeschool/web test && pnpm --filter @freeschool/web typecheck && pnpm --filter @freeschool/web build` — all pass. Start the AppView (`FREESCHOOL_NO_JOBS=1 pnpm --filter @freeschool/appview dev`) and `pnpm --filter @freeschool/web dev`; `curl -s http://localhost:5173/api/health` returns the AppView health JSON through the proxy.
- [ ] **Step 5: Commit** `feat(web): real API client, dev proxy, query hooks, route skeleton`.

---

### Task 2: Backend gap batch — invites, skill tiers, OAuth forced-off, venue-needed, tag routing, badges, zine data

**Files:**
- Modify: `apps/appview/src/db/schema.ts` (add `fs_invite_link` table: `id`, `token_hash` unique, `inviter_did`, `school_did`, `event_uri` nullable, `uses_left` int default 1, `expires_at`, `created_at`, `redeemed_at` nullable; add `fs_skill_tier` table: `skill_id` pk, `tier` enum `'A'|'B'`, `reason` text, `updated_at`) and generate a migration with `pnpm --filter @freeschool/appview db:generate`
- Create: `apps/appview/src/http/routes/invites.ts` (`POST /api/invites` auth required, body `{ eventUri?: string, uses?: number (1–20), ttlDays?: number (1–30) }` → `{ url, token, expiresAt }` where `token` is 128-bit base64url random, only its SHA-256 is stored, and the URL is `${APPVIEW_PUBLIC_URL or web origin}/invite/${token}`; `POST /api/invites/:token/redeem` (auth required) → marks use, records `fs_invite` evidence for `invite-or-vouch` gating, returns `{ ok, eventUri }`; 410 when expired/exhausted). The inviter's DID must never appear in the URL, QR, or response to the redeemer.
- Create: `apps/appview/src/lib/skill-tiers.ts` (`tierOf(skillId): Promise<'A'|'B'>` default `'A'`; seed function that marks Tier B from a list in `apps/appview/src/lib/skill-tiers.seed.json` — include at least: `know-your-rights`, `street-medicine`, `ice-raid-response`, `digital-security`, `legal-observing`, `de-escalation`, `jail-support`, `squatting`, `harm-reduction`, plus any slug in `infra/seed/skills/skills-seed.jsonl` whose domain is `organizing` and whose `_provenance.level === 'skill'` and whose label matches /police|ICE|legal|medic|security|encrypt|doxx|squat|prison|jail|raid/i)
- Modify: `apps/appview/src/http/routes/me.ts` (`PUT /api/me/skill-claims`: reject `visibility: 'public'` for Tier B unless body has `confirmTierB: true`; reject `visibility: 'public'` entirely when the session `kind === 'oauth'` and the account has not set `publicTogglesUnlocked` — add `GET /api/me/visibility-defaults` returning `{ oauthDoor: boolean, tierBConfirmRequired: true }`); add `GET /api/me/badges` → `{ counts: { hosted, attended, vouched }, role: number, badges: string[] }` where badges are plain-language sentences derived only from counts and role (e.g. "Hosted 3 classes", "Came to 7 classes", "Vouched for bike repair by 2 people") — never averages
- Modify: `apps/appview/src/http/visibility.ts` and the event projection (`projectEvent`): add `venueNeeded: boolean` (true when the event has no `locations` and no `neighborhood`) and `tags: string[]` to the projected event
- Modify: `apps/appview/src/http/routes/events.ts` + `apps/appview/src/lib/events.ts`: accept `tags: string[]` (lowercase kebab, ≤ 10) on create/update; write the school's `coop.lexicon.event.listing` **only** when the event carries at least one tag in the school's routing tags (from the `freeschool.draft.school` record's `tags`, default `['skillshare','free-school']`); events without a routed tag still appear on our own calendar (they are ours) but get no listing
- Modify: `apps/appview/src/http/routes/calendar.ts` (or wherever `GET /api/calendar` lives): include `tags`, `venueNeeded`, and an `origin: 'ours' | 'listed'` field for events that reached us through another school's listing
- Create: `apps/appview/src/http/routes/zine.ts` (`GET /api/zine/:yyyyMm` public → `{ month, school: { name, region }, days: [{ date, events: [projected listed events with neighborhood-only location] }], howToPost: string }`; same redaction rules as the calendar)
- Modify: `apps/appview/src/http/routes/requests.ts`: add `POST /api/requests/:id/rsvp` (auth; toggles the viewer's interest in an app-side `fs_request_rsvp` table (`request_uri`, `did`, `created_at`, unique pair); response `{ interested: boolean, count: number }`; the request list/detail include `rsvpCount` and `viewerInterested`; the threshold check for claiming uses this count). Add `PUT /api/events/:id` (host-only update of the same body shape as create; writes through the host's session; for the school-authored listing, re-run the tag-routing rule) if it does not already exist. Add `PUT /api/me` (update `displayName`, `bio` — app-side profile fields; never a real-name prompt) if it does not already exist.
- Modify: `apps/appview/src/http/app.ts` to mount the new routers
- Test: `apps/appview/test/invites.test.ts`, `apps/appview/test/skill-tiers.test.ts`, `apps/appview/test/tag-routing.test.ts`, `apps/appview/test/zine.test.ts`, extend `apps/appview/test/calendar-visibility.test.ts` for `venueNeeded`

**Interfaces:**
- Produces the endpoint contracts listed above, consumed by Tasks 4, 6, 8 via `api.ts`.

- [ ] **Step 1: Tests first** — invites: mint returns a URL without the inviter DID; redeem twice with `uses: 1` → second is 410; expired → 410; redemption writes gating evidence. Tiers: `tierOf('bicycle-repair') === 'A'`, `tierOf('street-medicine') === 'B'`; PUT public claim on Tier B without confirm → 400 `TierBConfirmRequired`; OAuth-kind session PUT public → 403 `PublicTogglesLocked`. Tag routing: creating an event with `tags: ['skillshare']` results in exactly one `putRecordAsSchool` call for `coop.lexicon.event.listing` (use a fake `SchoolActorPort`); `tags: ['knitting']` → zero calls. Zine: month payload groups by day, redacts addresses, includes `venueNeeded` events with a "venue needed" marker. Badges: sentences contain no decimals or percent signs. Request interest: toggling twice returns `interested:false` and the count drops; claim is refused (409 `ThresholdNotMet`) below the threshold.
- [ ] **Step 2: Run** `pnpm --filter @freeschool/appview test` — new tests fail.
- [ ] **Step 3: Implement**; run `db:generate` and `db:migrate` against the local Postgres.
- [ ] **Step 4: Run** `pnpm --filter @freeschool/appview test && pnpm --filter @freeschool/appview typecheck`; run `pnpm --filter @freeschool/appview smoke` to confirm nothing regressed (it must still print `SMOKE PASSED`).
- [ ] **Step 5: Commit** `feat(appview): invite links, skill tiers, OAuth forced-off, venue-needed, tag routing, badges, zine data`.

---

### Task 3: Sign-in screens wired to the real API

**Files:**
- Modify: `apps/web/src/routes/SignInScreen.tsx` (real states: idle → sending → "check your email" → error; primary button "Create a new Free School identity (recommended)"; secondary link "Use an existing AT Protocol account" → `/oauth/confirm`)
- Create: `apps/web/src/routes/VerifyScreen.tsx` (reads `?token=`, calls `api.auth.verify`, shows success → navigates to `/requests` (needs board is the onboarding landing, PRD §13 constraint 2), or a clear error)
- Create: `apps/web/src/routes/OAuthConfirmScreen.tsx` (the verbatim hard-confirm copy from Global Constraints, a text input for the existing account's handle (label "Your handle, like name.bsky.social"; the server's `GET /oauth/start` returns 400 without one), button "Continue anyway" disabled until a handle is entered → `window.location = api.auth.oauthStartUrl(true, handle)`, button "Go back and create a new identity" → `/signin`; if the start endpoint returns 503 `OAuthUnavailable`, show "Signing in with an existing account isn't available on this server yet." — do not show a broken redirect)
- Create: `apps/web/src/components/SessionGate.tsx` (uses `useMe()`; renders children when signed in, otherwise a sign-in prompt; used by Tasks 4–8 for authenticated actions)
- Modify: `apps/web/src/router.tsx` only to swap placeholders for these three components (no new routes)
- Test: `apps/web/src/routes/SignInScreen.test.tsx`, `apps/web/src/routes/OAuthConfirmScreen.test.tsx` (React Testing Library; mock `api`)

- [ ] **Step 1: Tests** — signup form posts the email and shows the check-your-email state; error state shows the server message; confirm screen renders the exact copy string and the two buttons; 503 path shows the unavailable message.
- [ ] **Step 2: Run** web tests → fail. **Step 3: Implement.** **Step 4:** tests + typecheck + build pass; manual check: with the AppView running (`SMTP_URL` unset), the verify link is printed to the AppView console; opening it in the browser through the proxy creates a session and `GET /api/auth/me` returns the DID.
- [ ] **Step 5: Commit** `feat(web): sign-in, verify, and OAuth confirm screens on the real API`.

---

### Task 4: Calendar, event detail, RSVP, invite, push, and zine on real data

**Files:**
- Modify: `apps/web/src/routes/CalendarScreen.tsx` (use `useCalendar`; month strip; day grouping; empty state "Nothing on the calendar yet. Post what you'd like to learn." linking to `/requests`)
- Modify: `apps/web/src/routes/EventScreen.tsx` (use `useEvent`; RSVP going/interested with `SessionGate`; per-event "also publish my RSVP publicly" toggle defaulting off, showing the permanence sentence "Anyone will be able to see, permanently, that you planned to be at this place at this time." before enabling; invite button → `api.invites.mint({ eventUri })` → share sheet via `navigator.share` or copy; "Remind me" gated by install state (existing `ios-install.ts`) → when installed, request permission inside the tap handler, subscribe with the VAPID key from `api.push.vapidKey()`, `api.push.subscribe`; `.ics` link `target="_self"`; exact address shown only when `viewerRelation` says RSVP'd; `venueNeeded` badge; tags chips; host card with counts only)
- Create: `apps/web/src/routes/InviteScreen.tsx` (`/invite/:token`: if signed in → redeem → navigate to the event or requests; else show sign-in with `?next=`)
- Modify: `apps/web/src/routes/ZineScreen.tsx` (use `api.zine.month`; month picker; keep the print CSS)
- Modify: `apps/web/src/components/InstallNudge.tsx` (trigger after a successful real RSVP mutation)
- Test: `apps/web/src/routes/EventScreen.test.tsx` (RSVP toggle calls the mutation with `alsoPublicRecord` only after the warning is accepted; address hidden when not RSVP'd; Remind-me gated when not installed), `apps/web/src/routes/ZineScreen.test.tsx` (renders days from the API payload)

- [ ] **Step 1: Tests** (fail) → **Step 2: Implement** → **Step 3:** tests, typecheck, build pass; manual: sign in as a member (Task 3 flow), RSVP to the smoke-created event, see the street address appear, print preview of `/zine` shows the month.
- [ ] **Step 4: Commit** `feat(web): calendar, event, RSVP, invite, push, zine on real data`.

---

### Task 5: Class creation and editing, recurrence editor, attendance check-off

**Files:**
- Create: `apps/web/src/routes/EventEditScreen.tsx` (create at `/events/new`, edit at `/events/:id/edit`; fields: title, description, skill picker (from `useSkillTree`, searchable; "no specific skill" allowed), depth 1–3, start/end with timezone from the browser, location mode: `open` (full address public) / `listed` (neighborhood public, address to RSVP'd) / `unlisted`; "venue needed" checkbox that clears location; capacity + waitlist; materials list; optional supplies note; tags (suggest `skillshare`, `free-school`); recurrence editor: none / weekly / every 2 weeks / monthly, day(s) of week, end by count or date, with a live preview of the next 4 occurrences computed client-side with `rrule`; on edit of a recurring occurrence: "this one only" / "this and following" radio mapping to the API's edit semantics)
- Create: `apps/web/src/routes/AttendanceScreen.tsx` (`/events/:id/attendance`, host only via `useMe` role/authorship; list RSVPs with check boxes; save calls `api.attendance.set`; after save show "Thanks — counts updated. Feedback opens for attendees now.")
- Create: `apps/web/src/lib/recurrence.ts` (build the RRULE string + denormalized fields from the editor state; `previewOccurrences(state, n=4)`)
- Modify: `apps/web/package.json` (add `rrule` dependency, same major as the AppView uses)
- Test: `apps/web/src/lib/recurrence.test.ts` (weekly Thursdays count 8 → `FREQ=WEEKLY;BYDAY=TH;COUNT=8`; preview returns 4 dates on Thursdays; `until` XOR `count` enforced), `apps/web/src/routes/EventEditScreen.test.tsx` (venue-needed clears locations; submit body shape matches `api.events.create`)

- [ ] **Steps:** tests fail → implement → tests/typecheck/build pass → manual: create a weekly class as the smoke host; the AppView materializer (run `pnpm --filter @freeschool/appview dev` without `FREESCHOOL_NO_JOBS`, or trigger the job) yields occurrences on the calendar; check attendees off.
- [ ] **Commit** `feat(web): class create/edit with recurrence editor and attendance check-off`.

---

### Task 6: Requests, Skills, Me, and notification settings on real data

**Files:**
- Modify: `apps/web/src/routes/RequestsScreen.tsx` (use `useRequests`; composer posts via `api.requests.create`; "I want this too" → `api.requests.rsvp`; threshold progress; "I can teach this" → `api.requests.claim` then navigate to `/events/new?request=<id>` prefilled; empty state copy "Post what you'd like to learn. Someone nearby probably knows it.")
- Modify: `apps/web/src/routes/SkillsScreen.tsx` and `SkillScreen.tsx` (use `useSkillTree`/`useSkill`; Tier B skills show a small "sensitive" marker and the public-visibility explanation)
- Modify: `apps/web/src/routes/MeScreen.tsx` (profile from `api.me.profile` with display name + bio edit; skill claims editor: add/remove, level picker, per-claim visibility with the Tier rule: Tier A defaults `public`, Tier B defaults `school` and requires an explicit confirm dialog before `public`; OAuth-door users see public toggles disabled with the reason from `api.me.visibilityDefaults`; badges and counts from `api.me.badges`; theme/reduce-blur as today; link to `/me/settings`)
- Create: `apps/web/src/routes/NotificationSettingsScreen.tsx` (`/me/settings`: per-category route `off` / `inbox` / `push` / `email`, install state, "Turn on reminders" button that subscribes)
- Modify: `apps/web/src/routes/EventEditScreen.tsx` only to read `?request=` and prefill title/skill (small, isolated change)
- Test: `apps/web/src/routes/MeScreen.test.tsx` (Tier B claim cannot be set public without confirm; OAuth-door disables toggles), `apps/web/src/routes/RequestsScreen.test.tsx` (claim navigates with the request id)

- [ ] **Steps:** tests fail → implement → pass → manual: post a request as one member, "I want this too" as another, claim as the host; set a Tier B claim and confirm the dialog appears.
- [ ] **Commit** `feat(web): requests, skills, me, and notification settings on real data`.

---

### Task 7: Anonymous feedback form and host summary

**Files:**
- Create: `apps/web/src/routes/FeedbackScreen.tsx` (`/events/:id/feedback`: only for attendees whose attendance was checked off (server enforces; UI shows the server's 403 message otherwise); three 3-point dials labeled "Knew the material", "Taught it well", "The experience" using `<input type="radio">` groups, optional note; explain anonymity in one sentence: "Your answers are anonymous. The host only sees a summary once enough people respond."; submit via `api.feedback.submit`; show the 409 AlreadyVoted state)
- Create: `apps/web/src/routes/FeedbackSummaryScreen.tsx` (`/events/:id/feedback-summary`, host only: shows `count`, and when `released`, positive/negative counts and per-aspect `mean` rendered as **three filled dots out of three** (rounded), never as a decimal; text withheld notice when `textK` not met; never shows individual rows)
- Modify: `apps/web/src/routes/EventScreen.tsx` (add "Leave feedback" for past events the viewer attended and "See feedback summary" for the host)
- Test: `apps/web/src/routes/FeedbackSummaryScreen.test.tsx` (no decimal digits rendered for means; unreleased state shows only the count)

- [ ] **Steps:** tests fail → implement → pass → manual: as the three smoke learners, submit feedback; as the host, see the summary release at 3.
- [ ] **Commit** `feat(web): anonymous feedback form and host summary`.

---

### Task 8: Admin dashboard v0

**Files:**
- Create: `apps/web/src/routes/admin/AdminLayout.tsx` (steward-only via `useMe().role >= 40`; sub-nav Policy · Moderation · Peers · Newsletter · Hand-off)
- Create: `apps/web/src/routes/admin/PolicyScreen.tsx` (plain-language switches and numbers for every threshold in `freeschool.draft.policy#thresholds`: who can join (none / invite or vouch / attended one), classes attended before hosting, classes hosted before facilitating, first-event approval, feedback k, stewards needed for removals; policy text editor; save via `api.admin.setPolicy`; show "Saved — takes effect immediately")
- Create: `apps/web/src/routes/admin/ModerationScreen.tsx` (queue list; propose action with mandatory reason (disabled submit until ≥ 10 chars); approve as second steward; execute; show audit outcome; public projection preview shows state + category only)
- Create: `apps/web/src/routes/admin/PeersScreen.tsx` (peer schools / PDS hosts list; add by handle or DID or host URL; remove; show last sync)
- Create: `apps/web/src/routes/admin/NewsletterScreen.tsx` (compose preview from `api.admin.newsletter.compose`, edit intro text, "Send to subscribers" → `api.admin.newsletter.send(id)` with a confirm; shows recipient count only)
- Modify: `apps/web/src/router.tsx` only to swap the admin placeholders (and the `/admin/handoff` placeholder stays for Task 10)
- Test: `apps/web/src/routes/admin/ModerationScreen.test.tsx` (submit disabled without a reason; approve requires a different steward per the API response), `apps/web/src/routes/admin/PolicyScreen.test.tsx` (form round-trips the thresholds object)

- [ ] **Steps:** tests fail → implement → pass → manual as a steward (promote the smoke host to steward via the policy/role path or `scripts/create-school.ts` output): change the hosting threshold and watch the role re-derive on `/me`.
- [ ] **Commit** `feat(web): admin dashboard v0 — policy, moderation, peers, newsletter`.

---

### Task 9: Backend — newsletter sending, membership claims, continuity (how-it-works + hand-off)

**Files:**
- Modify: `apps/appview/src/db/schema.ts` (add `fs_newsletter_subscription` (`did`, `email_ref`→ existing account email, `subscribed_at`, `unsubscribed_at`, `token_hash`), `fs_newsletter_issue` (`id`, `month`, `html`, `text`, `status` draft|sent, `sent_at`, `recipient_count`), `fs_handoff` (`id`, `from_did`, `to_did` nullable, `token_hash`, `created_at`, `accepted_at`, `expires_at`)) + migration
- Modify: `apps/appview/src/jobs/newsletter.ts` and `apps/appview/src/http/routes/admin.ts`: `POST /api/admin/newsletter/:id/send` (steward) → renders the composed digest to MJML-free simple HTML + text, sends via the existing mail transport (`SMTP_URL`; console fallback) to subscribed members with a one-click unsubscribe link `GET /api/newsletter/unsubscribe/:token` (no tracking pixels, no click tracking); caps at 500 recipients per run; marks the issue sent with `recipient_count`. Members subscribe/unsubscribe via `PUT /api/me/newsletter { subscribed: boolean }` (default: subscribed at signup only if the signup form's checkbox was ticked — add `newsletter?: boolean` to signup body; default false)
- Create: `apps/appview/src/lib/membership-claims.ts`: `publishRoleClaim(schoolDid, subjectDid, role)` writes `coop.lexicon.membership {subject, role, addedBy}` **only** when (a) the school policy has `publishRoles: true` (new optional boolean in the policy record's thresholds; default false) and (b) the subject has opted in (`fs_member_prefs.public_role = true`; add that table/column) and (c) role ≥ 20 (a public-facing host/steward). Everything else stays app-side. Called from the role re-derivation path.
- Create: `apps/appview/src/lib/how-it-works.ts` + route `GET /api/school/how-it-works` (public): renders the school record + current policy into a plain-language page payload `{ title, school, sections: [{ heading, body }], lastUpdated, printable: true }` covering: what the school is, how to post a class, how to post a request, who can host (from thresholds), how feedback works, how moderation works (two stewards, written reasons), how to start this school again if it goes quiet (points at the hand-off flow and the open-source repo)
- Create: `apps/appview/src/http/routes/handoff.ts`: `POST /api/admin/handoff { toHandleOrDid? }` (steward) → creates a hand-off token (7-day TTL) and returns a URL `/admin/handoff/accept/:token`; `POST /api/admin/handoff/:token/accept` (any signed-in member) → through `SchoolActorPort` with action `set-role` grants the acceptor role 40 and records the hand-off; requires the proposing steward's approval to already exist (the proposer's own approval record is written at creation); if the school has fewer than 2 stewards after acceptance, the response includes `warning: 'single-steward'`
- Test: `apps/appview/test/newsletter.test.ts` (send marks issue sent, recipient count excludes unsubscribed, unsubscribe token works once, HTML contains no `<img` tracking), `apps/appview/test/membership-claims.test.ts` (no publish without both flags; publish calls `putRecordAsSchool` with `coop.lexicon.membership`), `apps/appview/test/how-it-works.test.ts` (sections reflect thresholds), `apps/appview/test/handoff.test.ts` (token single-use; acceptor becomes steward through the actor port; audit row exists)

- [ ] **Steps:** tests fail → implement → `pnpm --filter @freeschool/appview test && typecheck && smoke` pass.
- [ ] **Commit** `feat(appview): newsletter sending, opt-in membership claims, how-it-works page, steward hand-off`.

---

### Task 10: Web — how-it-works page and hand-off flow

**Files:**
- Create: `apps/web/src/routes/HowItWorksScreen.tsx` (`/how-it-works`: renders the payload with the print stylesheet from `ZineScreen` (extract shared print CSS into `apps/web/src/styles.print.css` if not already shared); "Print" button)
- Create: `apps/web/src/routes/admin/HandoffScreen.tsx` (`/admin/handoff`: explains continuity in two sentences, "Create hand-off link" → shows the URL and a QR; lists pending hand-offs) and `apps/web/src/routes/admin/HandoffAcceptScreen.tsx` (`/admin/handoff/accept/:token`: signed-in member accepts; shows the single-steward warning when returned)
- Modify: `apps/web/src/routes/MeScreen.tsx` to add a "How this skool works" link; `apps/web/src/router.tsx` to swap the two placeholders and add `/admin/handoff/accept/:token`
- Modify (wiring for Task 12's additions): `apps/web/src/routes/AttendanceScreen.tsx` — replace "add attendee by DID" with the host's RSVP roster from `GET /api/events/:id/rsvps` (checkboxes pre-populated; keep a small "add someone who came without RSVPing" handle field); `apps/web/src/routes/EventEditScreen.tsx` — real `materials` list and `suppliesNote` fields and `waitlist` toggle bound to the new backend fields; `apps/web/src/routes/EventScreen.tsx` — show materials, the supplies note, and the viewer's `waitlistPosition`; update `api.ts`/`types.ts` accordingly. `apps/web/src/routes/SkillsScreen.tsx`/`SkillScreen.tsx`/`MeScreen.tsx` — use the server's `tier` field: show the "sensitive" marker on Tier B skills and default a new Tier B claim's visibility to school-only (Tier A to public). `apps/web/src/lib/recurrence.ts` — REMOVE the `effectiveByDay` UTC weekday shift now that Task 12 expands BYDAY in the series timezone (send the host's chosen weekday verbatim); update `recurrence.test.ts`. `EventEditScreen.tsx` — prefill `visibility` from the host view's raw enum on edit (Task 12 returns it) and keep the touched-only submit rule.
- Test: `apps/web/src/routes/HowItWorksScreen.test.tsx` (renders sections; print button calls `window.print`)

- [ ] **Steps:** tests fail → implement → pass → **Commit** `feat(web): how-it-works page and steward hand-off flow`.

---

### Task 11: Backend — `PdsChangeSource` (live indexing from peer PDS hosts)

**Files:**
- Create: `apps/appview/src/sync/pds-change-source.ts` (replace the stub; delete `pds-change-source.stub.ts`) implementing contrail's `ChangeSource` interface (read its exact shape from `node_modules/@atmo-dev/contrail` — the gap report notes `ChangeSource` exports from the package root, with `{ id, semantics, mark, read }`) by wrapping `packages/pds-follow` (`src/follow-pds.ts`, `src/cursors.ts`, `src/identity.ts`, `src/backfill.ts`): one `subscribeRepos` WebSocket per `peer_host` row, per-host cursor persisted in `fs_peer_host.cursor` (debounced 1 s, monotonic), per-DID in-order processing, decode `#commit` CAR slices to records for the configured collections, map `#account` statuses (`deactivated|suspended|takendown|deleted|desynchronized|throttled`) to `fs_peer_repo.status`, re-resolve on `#identity` and mark `movedOffThisPeer`, handle `#info OutdatedCursor` by enqueuing a `listRecords` repair for every repo on that host, send a `User-Agent: freeschool-appview/<version> (+<APPVIEW_PUBLIC_URL>)` header, reconnect with backoff capped at 16 s and log reconnects with the host name (no DIDs in logs)
- Modify: `apps/appview/src/index/*` to register the source when `PEER_LIVE_SYNC=1` (default on in dev), keeping the 15-minute `backfillFromPeers` as the safety net
- Modify: `apps/appview/src/sync/README.md` to describe the real implementation
- Test: `apps/appview/test/pds-change-source.test.ts` — run a **local** test double: spin up a `ws` server in the test that speaks the `subscribeRepos` framing (reuse any frame fixtures from `packages/pds-follow/probes/` or craft minimal CBOR frames with `@atproto/repo`/`cborg`) and assert: a `#commit` containing a `community.lexicon.calendar.event` op yields one indexed record; cursor persists and resumes from the stored value on reconnect; `#info OutdatedCursor` triggers the repair enqueue; `#account deleted` flips the repo status. Plus an integration test against the live local PDS (skip if unreachable): write an event record as the smoke host and observe it arrive through the live source within 10 s.

- [ ] **Steps:** tests fail → implement → `pnpm --filter @freeschool/appview test && typecheck` pass; manual: start the AppView with jobs, post a class from the web UI, observe the `[sync]` log line and the calendar update without waiting for the 15-minute backfill.
- [ ] **Commit** `feat(appview): PdsChangeSource — live subscribeRepos indexing from the peer registry`.

---

### Task 12: Backend — `takeOwnership` for custodial accounts

**Files:**
- Modify: `apps/appview/src/lib/custody.ts` (implement `takeOwnership(did)`: (1) verify the session belongs to the custodial account; (2) use the PDS admin API `com.atproto.admin.updateAccountPassword` with a freshly generated 24-char password; (3) email the member a one-time "set your own password" link that reveals the new password once (`GET /api/auth/take-ownership/:token`, token single-use, 24 h TTL) and instructs them to change it in their PDS settings and to export their repo (`com.atproto.sync.getRepo`) any time; (4) set `isCustodial = false`, delete our stored encrypted credential, keep the DID; (5) the school continues to work because hosts' own writes happen through their OAuth session — for custodial accounts that become non-custodial, subsequent writes require the user to sign in via the OAuth door (which is the secondary door; the UI explains this). Ruling: this is the simplest correct step 2 — we never learn or keep the final password.)
- Modify: `apps/appview/src/http/routes/auth.ts` (`POST /api/auth/take-ownership` and the reveal route)
- Modify: `apps/web/src/routes/MeScreen.tsx` (a "Take full ownership of my account" section with the explanation and consequences; only shown when `me.isCustodial`)
- Modify (spec gaps found by Task 5): `apps/appview/src/http/routes/events.ts` + `src/lib/events.ts` — accept and persist `materials: string[]` (≤ 20 items, ≤ 120 chars each) and `suppliesNote` (≤ 300 chars, free text, no links rendered as payment) on create/update, stored on the event's `coop.lexicon.event.config` sidecar if it has room per its schema or otherwise on a `freeschool.draft.skillLevel`-adjacent app-side table `fs_event_extra(event_uri pk, materials jsonb, supplies_note text)` — choose the app-side table unless the config lexicon already has fields for them (read `apps/appview/src/lexicons/coop.ts`); return them in `GET /api/events/:id`. Implement `waitlist`: when `capacity` is set and reached, new RSVPs get `status: 'waitlisted'` ordered by creation TID; a cleared RSVP promotes the earliest waitlisted one; expose `waitlistPosition` to the viewer. Add `GET /api/events/:id/rsvps` (host of that event or steward only; never public): `[{ did, handle, displayName?, status, createdAt }]` so the host can see who is coming and check attendance off a real list (PRD persona: the host needs to "know who is coming"); this endpoint must never be reachable by other members.
- Modify (from Task 5 review): `apps/appview/src/http/routes/events.ts` / `http/visibility.ts` — `GET /api/events/:id` returns the raw `visibility` enum (`listed|unlisted|private`) to the host and stewards only (never to other viewers). `apps/appview/src/jobs/materialize-series.ts` — expand `BYDAY` in the series' own IANA `timezone` (wall-clock expansion then localize, per R6: do not pass a UTC `dtstart` to rrule and match weekdays in UTC); add a test where a Denver 18:00 Thursday weekly series yields Thursday occurrences, not Friday. The web client currently compensates with a client-side weekday shift (`apps/web/src/lib/recurrence.ts` `effectiveByDay`); Task 10 removes that shift once this lands — do NOT change the web client in this task.
- Modify (from Task 6): `apps/appview/src/http/routes/skills.ts` — expose `tier: 'A'|'B'` on every skill in `GET /api/skills` and `GET /api/skills/:id` (from `fs_skill_tier`, default `'A'`), so the web can show the sensitive marker and default Tier B claims to school-only.
- Test: `apps/appview/test/event-extras.test.ts` (materials/suppliesNote round-trip; waitlist ordering and promotion; roster forbidden for a non-host member and visible to the host), `apps/appview/test/take-ownership.test.ts` (flips `isCustodial`, removes the stored credential, reveal token is single-use, second reveal is 410; against the live PDS when reachable — the smoke host can afterwards `createSession` with the revealed password)

- [ ] **Steps:** tests fail → implement → pass → **Commit** `feat: take ownership of a custodial account`.

---

### Task 13: End-to-end, privacy audit, and docs

**Files:**
- Create: `apps/appview/scripts/privacy-audit.ts` (`pnpm --filter @freeschool/appview privacy-audit`: lists records in every repo on the local PDS (and optionally `PEER_PDS_HOSTS`) for the collections `community.lexicon.calendar.rsvp`, `freeschool.draft.attendance`, `freeschool.draft.hostFeedback`, `coop.lexicon.membership`, `freeschool.draft.moderationAction`, `freeschool.draft.skillAttestation`; FAILS (exit 1) if any record names a DID other than its author without the consent flags the plan defines (membership: `publishRoles` + member opt-in; attestation: double opt-in recorded app-side); prints a table)
- Create: `apps/web/e2e/mvp.spec.ts` (Playwright, `@playwright/test` dev dependency; runs against `http://localhost:5173` with the AppView and compose stack up): sign up with email → read the verify link from the AppView's console/log file (the dev transport writes it to `apps/appview/.dev-mail.log`; add that file sink if absent, gitignored) → verify → land on Requests → post a request → create a class (venue needed) → RSVP → check off attendance (as host, via the smoke host's session cookie fixture) → leave feedback from three fixture members → host sees the summary → print-preview `/zine` renders the class → `/how-it-works` renders → admin policy change re-derives the role. Use `FREESCHOOL_NO_JOBS=1` plus a direct call to the materializer for the recurrence step.
- Modify: `apps/appview/scripts/smoke.ts` to cover invites (mint → redeem), tag routing (tagged event gets a listing; untagged does not), zine payload, badges, and the privacy audit at the end
- Modify: `README.md` (repo root): "Run the MVP locally" section (compose up → appview dev → web dev → create school → seed skills → open `http://localhost:5173`), what is and is not in v1, the decisions awaiting Benjamin; `docs/implementation-plan.md` §0 updated with the MVP state
- Add a root `package.json` script `e2e` that runs the Playwright spec
- Test: the e2e spec itself and the extended smoke

- [ ] **Steps:** write the e2e spec and audit (they fail without the sinks/scripts) → implement sinks and scripts → `pnpm e2e` passes locally and `pnpm --filter @freeschool/appview smoke` prints `SMOKE PASSED` with the privacy audit `OK`; `pnpm -r test` and `pnpm -r typecheck` pass.
- [ ] **Commit** `test: end-to-end MVP flow, privacy audit, and run docs`.
