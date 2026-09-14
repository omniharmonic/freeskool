# Federation Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One AppView serving many schools (MS §11 phases 1–6), the school's peers published in its record, the PDS ready to move to a neutral hostname and to be crawled by a relay, engineering-owned interop and UX leftovers closed, and all of it proven by a tenant-isolation suite, two-school persona journeys and a per-school privacy audit.

**Architecture:** `fs_school` / `fs_membership` / `fs_school_credential` make the school a row instead of an env var; `currentSchool(c)` resolves the school from the request host (or the session's current school) and every per-school read/write takes it; one `SchoolActorPort` per school from a credential table encrypted under `CUSTODY_KEYS`; Caddy sends handle hosts' `/.well-known/atproto-did` to the PDS and everything else to the app; `MULTI_SCHOOL` flag guards multi-tenant routing until the e2e suite is green.

**Tech Stack:** as before (Hono + drizzle + contrail; Vite + React + TanStack; Vitest; Playwright; Caddy + Docker Compose).

**Spec:** `docs/superpowers/specs/2026-09-14-federation-phase-design.md` (rulings) over `docs/superpowers/specs/2026-09-13-multi-school-design.md` (MS, the design authority; cite sections in every task).

## Global Constraints

- R9: no public record may name a DID its holder did not write; a school's roster, RSVPs, attendance, feedback, moderation reasons, attestations and directory prefs are per-school app-side data and NEVER served to a member of another school (MS §10). Every members-only route is `requireViewer` + school-scoped + `noindex`.
- Every write as a school goes through that school's `SchoolActorPort`; never touch a school session elsewhere; credentials only in `fs_school_credential` (encrypted) or, during the transition, the legacy env.
- `MULTI_SCHOOL=0` (default) must behave exactly like today for Boulder: the full existing suites stay green at every task.
- Never add fields to borrowed lexicons; `freeschool.draft.school` already has `peers` and `tags`.
- Server logs never contain DIDs/emails/handles. Never commit `.env`, `infra/production/.env`, `.authority.env`, `.demo-users.json`.
- Migrations are additive and idempotent; each task that adds one commits the generated SQL + meta; `runMigrations` on a fresh DB passes (the vitest global setup proves it).
- Git hygiene: `git add <own paths>`; `git commit -m … -- <own paths>`; never `git stash`; never stage `apps/web/dist`. One implementer per file at a time.
- Tests: `pnpm --filter @freeschool/appview test` (on `freeschool_test`), `pnpm --filter @freeschool/web test`, `pnpm -r typecheck`, `pnpm lexicons:validate` green after every task.

---

### Task 1: Caddy inversion, reserved labels, internal tls-check (MS §3, Phase 1)
**Files:** `infra/production/Caddyfile`, `apps/appview/src/http/routes/health.ts` (or new `routes/internal.ts`), `apps/appview/src/lib/handles.ts` (reserved labels become the single source: `RESERVED_LABELS`), `apps/web/src/components/HandleChooser.tsx` (import the list or mirror with a comment), `apps/appview/src/config.ts` (`WEB_HOST`, `PDS_HANDLE_DOMAIN` already; add `SCHOOL_DOMAIN_SUFFIX` default `freeskool.xyz`), tests, `docs/deployment.md`.
**Behaviour:** `*.{$PDS_HANDLE_DOMAIN}` block: `/.well-known/atproto-did` and `/xrpc/*` → PDS; everything else → the web app (same as apex). `{$PDS_HOST}` unchanged. `GET /internal/tls-check?domain=` on the AppView: 200 for `www`, for any `fs_school_domain` host (table lands in Task 2; until then, for `<label>.<suffix>` where label is a known school label from config), else proxies the PDS `tls-check`. Reserved labels: `admin www pds skills school help mail api app static assets internal denver boulder` + every existing school label; handle generator, handle chooser and school creation refuse them.
- [ ] Failing tests: reserved label refused by `isValidChosenHandle`; internal tls-check answers per rule (fake PDS); Caddyfile validated with `caddy validate` in a container (`docker run --rm -v … caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`).
- [ ] Implement; commit `feat(edge): handle hosts serve only the well-known; the app owns every other host; reserved labels`.

### Task 2: Multi-school schema and backfill (MS §4, §9 A–C, Phase 2)
**Files:** `apps/appview/src/db/schema.ts`, migrations, `apps/appview/src/lib/schools.ts` (new: `getSchool(did)`, `listSchools()`, `schoolByHost(host)`, `ensureLegacySchoolRow()`), `apps/appview/scripts/backfill-school.ts`, tests.
**Schema (exact):** `fs_school(did pk, label unique, name, city, handle, created_at, creation_state)`, `fs_school_domain(host pk, school_did fk, kind 'canonical'|'alias')`, `fs_membership(did, school_did, joined_at, left_at null, door, last_seen_at; pk(did, school_did))`, `fs_school_credential(school_did pk, app_password_wrapped, key_version, rotated_at)`; `school_did text not null default ''` added to: `fs_steward` (already has), `fs_rsvp`, `fs_attendance`, `fs_attendance_tally`, `fs_attendance_rollup`, `fs_feedback*`, `fs_moderation_queue`, `fs_invite`, `fs_invite_link`, `fs_request_rsvp`, `fs_attestation`, `fs_member_prefs` (directory_listing is per school → move to `fs_membership.directory_listing`), `fs_skill_proposal`, `fs_policy_cache`, `fs_peer`, `fs_newsletter_*`, `fs_notification_*` as MS §4 lists (follow the table there exactly; where it says "global" leave the table alone). Backfill: every existing row gets `SCHOOL_DID`; `fs_school` gets the legacy row from `SCHOOL_DID/SCHOOL_HANDLE`; `fs_school_domain` gets `WEB_HOST` canonical + `<label>.<suffix>`; `fs_school_credential` imports `SCHOOL_APP_PASSWORD` wrapped with `wrapSecret`. `ensureLegacySchoolRow()` runs at boot after migrations when `SCHOOL_DID` is set (idempotent).
- [ ] Failing tests: fresh DB migrates; backfill creates the school row, domain rows, credential row, and stamps `school_did` everywhere; running twice changes nothing.
- [ ] Implement; commit `feat(db): schools, memberships, school credentials; school_did on every per-school table`.

### Task 3: Tenant threading and the actor registry (MS §5, Appendix A, Phase 3)
**Files:** `apps/appview/src/http/school-context.ts` (new: `currentSchool(c)`, middleware `withSchool`), every file in MS Appendix A (17 `config().SCHOOL_DID` read sites + `lib/policy.ts`, `lib/roles.ts`, `lib/school-actor.ts` → `lib/school-actors.ts` registry `actorFor(schoolDid)`), `lib/members.ts`, `lib/attestations.ts`, `lib/custody.ts` (signup joins the current school), `routes/*` that list per-school data, tests.
**Behaviour:** with `MULTI_SCHOOL=0`, `currentSchool(c)` returns the legacy school for every request; with `1`, it resolves from the request host via `fs_school_domain`, else from `fs_session.current_school_did` (Task 4), else 404 `UnknownSchool`. Every per-school query filters by `school_did`; every per-school write stamps it. `actorFor(schoolDid)` builds a `SchoolActorPort` from `fs_school_credential` (legacy env fallback), cached with eviction on rotation. `evidenceFor(did, schoolDid)` and `roleOf(did, schoolDid)` are already parameterised — make every caller pass the current school.
- [ ] Failing tests: the tenant-isolation harness (Task 11's route table, first version) with two schools in the DB and `MULTI_SCHOOL=1` via host header; existing suites unchanged with the flag off.
- [ ] Implement in small commits per area (policy/roles → members/attestations → events/rsvp/attendance → requests/feedback/moderation → admin/newsletter/notifications); final commit `feat(tenancy): every per-school read and write takes the current school`.

### Task 4: Sessions, host routing, school picker (MS §3, Phase 4)
**Files:** `apps/appview/src/http/session.ts` (`current_school_did`; cookie `Domain` from `SESSION_COOKIE_DOMAIN`), `routes/auth.ts` (`GET /api/auth/me` adds `school` and `schools: [{did,label,name}]`; `POST /api/auth/switch-school`), `routes/oauth.ts` (apex only; after callback redirect to the requesting school host — carry it in the OAuth state), web: `apps/web/src/components/SchoolSwitcher.tsx` in the Me screen header (only when `schools.length > 1`), `apps/web/src/lib/api.ts`/`queries.ts`/`types.ts`, tests.
- [ ] Failing tests: a session created on `boulder.<suffix>` has that school; switching updates it; a member of one school cannot switch to another; OAuth state round-trips the host.
- [ ] Implement; commit `feat(session): current school on the session; host routing; school switcher`.

### Task 5: School lifecycle (MS §8, Phase 5; ruling 10)
**Files:** `routes/schools.ts` (new: `GET /api/schools` public list; `POST /api/schools` operator-only via `OPERATOR_TOKEN` header when `SCHOOL_CREATION=closed`; `POST /api/schools/:did/leave` for a member), `scripts/create-school.ts` (delegates to the same lib), `lib/schools.ts` (create: mint the school account on the shared PDS with invite, write `freeschool.draft.school` + policy through the new actor, insert rows, appoint founder steward), `lib/membership.ts` (join on first session per school; leave: `left_at`, hide from directory/people, retract the role claim record if published), web: `/schools` public page listing schools (name, city, link), Me "Leave this school" with confirm, tests.
- [ ] Failing tests: create → rows + records + founder steward; leave → hidden and claim retracted; classes stay.
- [ ] Implement; commit `feat(schools): create (operator), list, leave`.

### Task 6: Federation — published peers, peer school records, cross-school routing (MS §7; interop gaps 4a/4b; ruling 9)
**Files:** `routes/admin.ts` (`PUT /api/admin/peers` also republishes `peers`/`tags` in the school record via the school actor), `lib/peers.ts` (per-school registry; `peerSchools()` reads indexed `freeschool.draft.school` records from peer hosts), `contrail.config.ts` (index `school` from peers — already), `lib/events.ts`/`jobs/materialize-series.ts` (routing tags per school), web: "Nearby schools" section on `/schools` and the admin Peers screen shows the published state, tests, `docs/interop-audit.md` gap 4 status.
- [ ] Failing tests: peers edit writes the record (fake actor) with the exact `peers` array; a peer's school record appears in `peerSchools()`; routing uses the current school's tags.
- [ ] Implement; commit `feat(federation): peers and tags published in the school record; nearby schools; per-school routing`.

### Task 7: Neutral PDS hostname migration (MS §3; ruling 3) — runbook + script, dry-run against dev
**Files:** `apps/appview/scripts/migrate-pds-hostname.ts`, `docs/runbooks/pds-hostname-migration.md`, `infra/production/{Caddyfile,.env.example,compose.yml}` (parameterised for the new host/handle domain), tests with a fake PDS/PLC.
**Behaviour:** for every account on our PDS (school, authority, custodial members): request a PLC signature via the PDS (`com.atproto.identity.requestPlcOperationSignature` needs the account email token for custodial accounts — document the admin alternative: the PDS signs with its rotation key when the operator runs `pdsadmin`-style ops; pick the path that works against the dev PDS and prove it), build the operation with the new `service` endpoint and new handle, submit, verify via `resolveHandle`/PLC audit log; rewrite `fs_custodial_account.handle`, `identities`; OAuth-door members are untouched (their PDS is elsewhere). Dry-run prints counts only. DNS/Caddy/env steps in the runbook with rollback.
- [ ] Failing tests with fakes; then a REAL dry run and real run against the dev PDS on a second handle domain (`.test2` added to the dev overlay), verifying `calmalder`-style dev accounts resolve on the new domain.
- [ ] Commit `feat(ops): PDS hostname migration script and runbook`.

### Task 8: Firehose readiness
**Files:** `apps/appview/scripts/verify-relay.ts` (subscribe to Jetstream for the school DID + authority DID, print counts by collection for 60 s), `docs/deployment.md` (relay section: what `PDS_CRAWLERS=https://bsky.network` does, permanence, the order: hostname first), `docs/interop-audit.md` gap 1 status.
- [ ] Commit `docs+feat(ops): relay switch runbook and verifier`. (Production flip happens in the release, after Task 7's migration.)

### Task 9: Interop leftovers — validate borrowed records (gap 6)
**Files:** `packages/lexicons` (vendor the `community.lexicon.calendar.*` and `coop.lexicon.*` JSON we rely on, with source URLs and dates), `apps/appview/test/borrowed-records.test.ts` (validate every record shape we write — event, rsvp opt-in, listing, config, membership — with `@atproto/lexicon`), `apps/appview/src/lexicons/coop.ts` (note which are assumptions), `docs/interop-audit.md` gaps 6/7 status.
- [ ] Commit `test(interop): our borrowed records validate against the vendored lexicons`.

### Task 10: UX leftovers (audit journeys 7, 12, 13, 14, 15; final-review nits 6, 7, 9)
**Files:** web `MemberProfileScreen.tsx` (vouch explainer + "Ask <name> to teach this" → `POST /api/requests` with `askedOf: did` app-side + notification), `WelcomeScreen.tsx` (cards 2–3 behind Next), `routes/admin/*` (help text, newsletter preview always visible), appview `routes/requests.ts` (`askedOf` app-side column + notification), `me.ts` (`checkPublicClaims` used by `PUT /`; `labelsForSkills` batched), `auth.ts` (`onboarded` via `loadDirectoryPrefs`), tests.
- [ ] Commit `fix(ux): vouch explainer, ask to teach, welcome steps, admin help; review nits`.

### Task 11: Testing — isolation suite, two-school seed, e2e, per-school privacy audit (MS §11 test plan)
**Files:** `apps/appview/test/tenant-isolation.test.ts` (route table: every list endpoint × two schools × three members), `scripts/seed-demo.ts` (`--schools boulder,denver`: Maya in both, distinct vouches/RSVPs/roles; Denver steward), `apps/web/e2e/multi-school.spec.ts`, `scripts/privacy-audit.ts` (`--school=<did>` + MS §10 assertions), `apps/appview/test/migration-fixture.test.ts` (pre-migration fixture → migrate → suites), `apps/web/playwright.config.ts` (host header or `*.localhost` project for the second school), docs.
- [ ] All green with `MULTI_SCHOOL=1` locally; then the full regression with `0` and `1`. Commit `test(federation): tenant isolation, two-school personas, per-school privacy audit`.

### Task 12: Wrap-up
- Final whole-branch review (privacy first), fix round, `docs/deployment.md` runbook for: flag flip, hostname migration (when the domain exists), relay switch; README; PR to `main`. Production release: Benjamin's call, with the neutral domain in hand.
