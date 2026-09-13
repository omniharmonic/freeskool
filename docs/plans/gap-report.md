# Free School — PRD vs. Code Gap Report
Generated from a read-only audit of the repo at 2026-09-12 (Explore agent, saved by the technical lead). All paths relative to repo root.

## A. PRD §4.1 items 1–14

| # | Item | Backend | Frontend | Gap summary |
|---|---|---|---|---|
|1|Sign-in (two doors)|**Partial.** Primary door done: `POST /api/auth/signup` (`http/routes/auth.ts:31`), magic link + custodial PDS account (`lib/custody.ts:45-102`), cookie session (`http/session.ts:27-38`). Secondary door implemented but **structurally disabled on http origins**: `GET /api/auth/oauth/start` (`auth.ts:67`) 503s via `config().oauthUsable` (`config.ts:96-143`) unless `APPVIEW_PUBLIC_URL` is https.|**Stub only.** `SignInScreen.tsx` calls `lib/api.ts:25-34` which POST to relative `/api/auth/*` but nothing renders real state/errors; no verify-link landing, no OAuth hard-confirm UI copy (F2) implemented client-side.|Needs: OAuth confirm screen in web, verify-email landing route, wiring SignInScreen to real responses instead of fire-and-forget `.catch(()=>undefined)`.|
|2|Profile + skill claims|**Partial.** `GET/PUT /api/me/skill-claims` (`http/routes/me.ts:65,117`) writes `freeschool.draft.skillClaim` to own repo when `visibility:'public'`, else app-side only (`me.ts:6-9`). 525-skill taxonomy seeded. **Tier A/B flag**: no column anywhere holds Tier A/B; default-public-for-ordinary-skills rule is not enforced (no tier check in `me.ts`).|**Mock only.** `MeScreen.tsx` renders `lib/mock.ts` profile/skillClaims; no write path, no level/visibility picker UI.|Missing: Tier A/B data model + enforcement; profile edit UI; skill-claim composer UI.|
|3|Class creation|**Strong.** `POST /api/events` (`http/routes/events.ts:73`) validates full shape incl. recurrence (`series`, `events.ts:58-70`), tiered `visibility`/`neighborhood` (`events.ts:46-47`), materializer honors floor/ceiling/exdates (`jobs/materialize-series.ts:64-96`). "Venue needed" (no `locations`) is representable (`events.ts:42`) but not surfaced as a labeled state.|**Missing entirely.** No create/edit screen, no route in `router.tsx:31-40`.|Missing: class-creation/edit UI, recurrence editor UI, "venue needed" explicit state/badge.|
|4|RSVP|**Done.** `POST/DELETE/GET /api/rsvp` (`http/routes/rsvp.ts:37,82,94`), app-side by default, `alsoPublicRecord` opt-in column (`db/schema.ts:143`) — opt-in write path to repo not located in `lib/rsvp.ts`; smoke only exercises app-side path. Waitlist not found: no waitlist table/column; `capacity` only validated at creation (`events.ts:45`), not enforced.|**Stub.** `EventScreen.tsx:39` calls `rsvp()` fire-and-forget against mock; no going/interested distinction, no permanence-warning copy.|Missing: waitlist logic/ordering; public-RSVP opt-in write-through (unverified); RSVP opt-in UI + warning.|
|5|Host-attested attendance|**Done.** `POST/GET /api/events/:id/attendance` (`events.ts:163,203`), app-side only, tally bump (`lib/roles.ts` `bumpTally`), 90-day collapse (`jobs/retention.ts:67-102`).|**Missing.** No check-off screen.|Missing: host attendance check-off UI.|
|6|Needs board|**Done.** `GET/POST /api/requests`, `POST /api/requests/:id/claim` (`http/routes/requests.ts:36,67,100`), indexed with `claims` relation (`contrail.config.ts:134-147`).|**Mock only.** `RequestsScreen.tsx`; `lib/api.ts:44-54` stubs use wrong path (`/api/requests/claim`).|Gap: path mismatch; no real fetch.|
|7|Derived badges/roles|**Done, tested.** `deriveRole`, evidence (`lib/roles.ts:27-`), thresholds (`lib/policy.ts`). Badge sentences only exist as mock strings (`mock.ts:374`).|**Mock only.**|Missing: backend badge/sentence derivation; wire `/api/me` into UI.|
|8|Invite links|**Missing.** `fs_invite` (`db/schema.ts:115-126`) is only gating evidence populated during signup (`lib/custody.ts:87-92`). No endpoint mints a shareable opaque bearer invite link.|**Dangling.** `inviteHref()` (`lib/api.ts:62-65`) builds `/api/events/:id/invite`, which does not exist.|Missing end-to-end: invite mint/redeem API + UI.|
|9|Anonymous host feedback|**Done, strong.** `POST /api/feedback`, `GET /api/events/:id/feedback-summary` (`http/routes/feedback.ts:45,100`); ballots/window/key destruction in `lib/feedback.ts`; k=3/5; `feedback-ballot.test.ts` asserts no author column.|**Missing.** No form or summary view.|Missing: feedback form + host summary UI.|
|10|Admin dashboard v0|**Strong backend.** policy GET/PUT, moderation queue+approve+execute, peers GET/PUT, newsletter compose (`http/routes/admin.ts`, `requireRole(Role.Steward)` at `admin.ts:36`). "How this skool works" page not found.|**Missing entirely.** No `/admin` route.|Missing: admin UI; how-it-works page (both sides); hand-off flow.|
|11|Tag-routed exchange (COhere)|**Partial.** `coop.lexicon.event.listing` written by the school on publish (`lib/events.ts`, `materialize-series.ts:210-230`). No `skillshare`/`free-school` tag filter; no inbound consumption of COhere listings.|N/A|Missing: explicit tag-routing rule; inbound listing display.|
|12|PWA|**Partial.** Push: `notifications/dispatch.ts`, `lib/push.ts`, `POST/DELETE /api/push/subscribe`, `GET /api/push/vapid-public-key` (`http/routes/notifications.ts:25,27,34`); reminders job solid.|**Strong shell, disconnected.** Workbox NetworkFirst on `/api/calendar*` (`vite.config.ts:18-45`); `InstallNudge.tsx` + `ios-install.ts` tested. No call to `/api/push/subscribe`; no notification-settings screen (prefs endpoints exist, `notifications.ts:66,71`).|Gap: push subscribe wiring; settings screen.|
|13|Monthly print zine|**Partial.** `.ics` real (`lib/ics.ts`). No zine data endpoint; newsletter composes text digest.|**Done as static mock view** (`ZineScreen.tsx`, print CSS per R8).|Missing: real monthly data into zine.|
|14|Continuity|**Missing.** No policy-to-printable renderer; no hand-off flow.|**Missing.**|Fully unbuilt.|

## B. F1–F15

| ID | Backend | Frontend | Gap |
|---|---|---|---|
|F1|Met (`lib/custody.ts:45-102`; `lib/handles.ts`).|Not wired.|Frontend wiring.|
|F2|Met server-side: `428 ConfirmationRequired` without `?confirm=1` (`auth.ts:67-76`). Forced-off public toggles for OAuth users not found (`session.ts` stores `kind`; nothing reads it).|Confirm screen absent.|Backend: enforce forced-off for OAuth sessions. Frontend: confirm screen.|
|F3|Met (`events.ts:73-94`; `lib/events.ts`; `contrail.notify()`).|No create UI.|Frontend.|
|F4|Met (`http/visibility.ts`, `calendar-visibility.test.ts`).|Mock; EventScreen does not branch on `viewerRelation`.|Frontend.|
|F5|Met for app-side; `alsoPublicRecord` opt-in write path not located.|No opt-in UI.|Verify/implement opt-in write; UI + warning.|
|F6|Met (`events.ts:159-162`; `bumpTally`).|No UI.|Frontend.|
|F7|`requests.ts:100` claim transitions status; whether claiming creates the class is not verified.|No UI.|Verify claim→class; UI.|
|F8|Met, tested.|Mock.|Frontend.|
|F9|Met, tested (`FEEDBACK_WINDOW_DAYS=14`, `feedback.ts:31`).|No UI.|Frontend.|
|F10|Met (`admin.ts:36,183-261`; `schema.ts:281`; `lib/school-actor.ts:36-56`).|No UI.|Frontend.|
|F11|Met, tested (`jobs/materialize-series.ts`; `jobs/index.ts:76`).|N/A|None.|
|F12|Partial — no tag filter.|N/A|Tag rule + interop test.|
|F13|Partial. Uses `web-push` classic payloads; Declarative Web Push JSON not confirmed (`architecture.md:115`).|No gated "Remind me" in `EventScreen.tsx`; no subscribe call.|Verify declarative payload; gated UI + subscribe.|
|F14|`.ics` tested; no monthly zine data endpoint.|Static `ZineScreen.tsx`.|Wire real data.|
|F15|Met (`admin.ts:69`; `lib/policy.ts`, `fs_policy_cache`).|No UI.|Frontend.|

## C. Stubs / TODOs

| Item | Location | Note |
|---|---|---|
|`PdsChangeSource`|`apps/appview/src/sync/pds-change-source.stub.ts:53,63` throws `NotImplementedError`|Periodic `backfillFromPeers` every 15 min (`jobs/index.ts:84`) stands in. Cursor-map codec exists.|
|`takeOwnership`|`apps/appview/src/lib/custody.ts:186-188` → 501|Step 2 (PDS password reset) unresolved (`custody.ts:168-185`).|
|Newsletter sending|`apps/appview/src/jobs/newsletter.ts:5-16`|Compose works (`composeMonthlyDigest`, line 33); no consent table, MJML, unsubscribe, approval.|
|`coop.lexicon.*` shapes|`apps/appview/src/lexicons/coop.ts`|Documented assumptions.|
|Runtime lexicon validation|`contrail.config.ts` (no `validate:true`); PDS writes `validate:false`.||
|Membership claim writes|none|Roles derived, never published as `coop.lexicon.membership`.|
|Invite mint/redeem|absent|web references dead route.|
|Tag routing|absent||
|Admin/create/attendance/feedback/zine-data/notification-settings UI|absent|8 screens exist in `apps/web/src/routes`.|
|How-it-works page + hand-off|absent everywhere||

## D. Integration seams

1. **No API base URL in web.** `apps/web/src/lib/api.ts:15-22` uses relative `fetch(path, {credentials:'same-origin'})`. `VITE_APPVIEW_URL` is never read. No Vite proxy in `apps/web/vite.config.ts`. Fix: a dev proxy (`/api`, `/oauth` → `http://localhost:4000`) so cookies stay same-origin.
2. **Cookie session.** `http/session.ts:27-38`: `SameSite=Lax`, `Secure` only in prod (`config.ts:130`). Same-origin via proxy avoids cross-site issues.
3. **OAuth secondary door cannot run on http://localhost** (`config.ts:96-112`; README 109-127). Treat as untestable locally.
4. **Peer registry** = `PEER_PDS_HOSTS` / contrail `relays` (`contrail.config.ts:38`, `config.ts:46`).
5. **Three schemas in one Postgres** (`fs_*` drizzle, contrail, pgboss); keep `tablesFilter:['fs_*']`.
6. **`FREESCHOOL_NO_JOBS=1`** runs HTTP only.
7. `apps/web/dist` is checked in; builds will diff it.

## E. Suggested boundaries
1 web API client + proxy + query hooks + router entries · 2 backend gap batch (invites, tiers, OAuth forced-off, venue-needed, tag rule, badges, zine data) · 3 sign-in UI · 4 calendar/event/RSVP/invite/push/zine wiring · 5 class create/edit + recurrence + attendance UI · 6 requests/skills/me UI · 7 feedback UI · 8 admin UI · 9 newsletter sending + membership claims + continuity backend · 10 continuity UI · 11 PdsChangeSource · 12 takeOwnership · 13 e2e + privacy audit + docs. Router edits live in Task 1 only.
