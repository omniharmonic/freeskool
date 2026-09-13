# Refinement Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the onboarding, people, attestation and skill-picking gaps Benjamin found on the live site, broaden the taxonomy, and make the whole product evaluable on localhost with realistic mock members and Playwright persona journeys.

**Architecture:** App-side tables (`fs_skill_claim_index`, `fs_attestation`, `fs_skill_proposal`, new `fs_member_prefs` columns) feed members-only endpoints under `/api/members` and `/api/attestations`; the authority account writes proposed `freeschool.draft.skill` records from the AppView; the web app gains a People tab, a member profile, a shared type-ahead `SkillPicker`, and a `/welcome` onboarding screen. Nothing new becomes a public record (R9).

**Tech Stack:** pnpm workspace, Hono + drizzle (Postgres 16) + contrail indexer + `@atproto/api` in `apps/appview`; Vite + React + TanStack Router/Query + Tailwind in `apps/web`; Vitest; Playwright.

**Spec:** `docs/superpowers/specs/2026-09-13-refinement-phase-design.md`

## Global Constraints

- R9: no public record may name a DID its holder did not write; the roster is never public. Every members-only endpoint uses `requireViewer` and sets `X-Robots-Tag: noindex, nofollow`.
- Server logs never contain DIDs, emails or handles (`lib/logging.ts` conventions; truncate DIDs to 12 chars if a log line must mention one).
- Every write as the school goes through `SchoolActorPort`. Skill records are written by the taxonomy authority, never by the school actor.
- Do not add fields to borrowed lexicons. `freeschool.draft.skill` status values are `canonical | proposed | deprecated` (use `deprecated` for "retire").
- Never commit `.env`, `infra/pds.env`, `infra/seed/.authority.env`, `apps/appview/.dev-mail.log`, `apps/appview/.demo-users.json`.
- Implementers stage only their own files by path; never `git add -A`. Never touch `apps/web/dist`.
- Tests: `pnpm --filter @freeschool/appview test`, `pnpm --filter @freeschool/web test`, `pnpm -r typecheck`, `pnpm lexicons:validate` must stay green after every task.
- Dev stack: PDS `http://localhost:3000` (handles `.test`), Postgres `localhost:5434`, AppView `:4000`, web `:5173` (proxies `/api`). Env is exported from the repo-root `.env` (`set -a; . ./.env; set +a`).
- Copy is plain, warm, second person, no exclamation marks; matches the existing screens' tone.

---

### Task 1: Taxonomy visibility and authority scoping

**Files:**
- Modify: `apps/appview/src/config.ts` (add `AUTHORITY_DID`, `AUTHORITY_HANDLE`, `AUTHORITY_PASSWORD`, all optional strings, default `''`)
- Modify: `apps/appview/src/http/routes/skills.ts`
- Modify: `apps/web/src/routes/SkillsScreen.tsx`, `apps/web/src/routes/SkillScreen.tsx` (a small "proposed" tag)
- Test: `apps/appview/src/http/routes/skills.test.ts` (extend or create)
- Modify: `.env.example` (document the three AUTHORITY_* variables)

**Interfaces:**
- Produces: `config().AUTHORITY_DID` etc.; `GET /api/skills` now includes `status: 'proposed'` nodes by default and accepts `?includeProposed=0` to hide them; both skill routes ignore records whose `did !== config().AUTHORITY_DID` when that is set.

- [ ] Step 1: Write failing tests: (a) tree includes a proposed node by default; (b) `includeProposed=0` hides it; (c) with `AUTHORITY_DID` set, a record from another DID is excluded from tree and detail.
- [ ] Step 2: Implement. Keep `deprecated` nodes out of the tree unless `?includeDeprecated=1`; keep detail lookups working for deprecated (existing claims must still resolve).
- [ ] Step 3: Web: in `SkillsScreen` and `SkillScreen`, render a small muted "proposed" chip next to nodes whose `status === 'proposed'`; nothing else changes.
- [ ] Step 4: Run tests + typecheck. Commit `feat(skills): show proposed skills; scope the taxonomy to the configured authority`.

### Task 2: App-side tables and skill-claim index

**Files:**
- Modify: `apps/appview/src/db/schema.ts`
- Create: migration via `pnpm --filter @freeschool/appview db:generate` (commit the generated `drizzle/00xx_*.sql` + `meta`)
- Modify: `apps/appview/src/http/routes/me.ts` (`PUT /skill-claims` also replaces `fs_skill_claim_index` rows in one transaction; `GET /` returns `directoryListing`, `onboarded`)
- Create: `apps/appview/scripts/backfill-skill-claims.ts` + package script `backfill-skill-claims`
- Test: `apps/appview/src/http/routes/me.skill-claims.test.ts` (extend existing claims tests)

**Schema (exact):**
```ts
export const skillClaimIndex = pgTable('fs_skill_claim_index', {
  did: text('did').notNull(),
  skillUri: text('skill_uri').notNull(),
  level: text('level').notNull(),            // learning|practicing|proficient|teaching
  visibility: text('visibility').notNull(),  // public|school
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.did, t.skillUri] }), index('fs_skill_claim_index_skill_idx').on(t.skillUri)])

export const attestation = pgTable('fs_attestation', {
  id: text('id').primaryKey(),               // newId() from lib/ids.ts
  attesterDid: text('attester_did').notNull(),
  subjectDid: text('subject_did').notNull(),
  skillUri: text('skill_uri').notNull(),
  contextEventUri: text('context_event_uri'),
  createdAt: ts('created_at').notNull().defaultNow(),
}, (t) => [uniqueIndex('fs_attestation_unique').on(t.attesterDid, t.subjectDid, t.skillUri), index('fs_attestation_subject_idx').on(t.subjectDid)])

export const skillProposal = pgTable('fs_skill_proposal', {
  id: text('id').primaryKey(),
  skillUri: text('skill_uri').notNull(),
  proposerDid: text('proposer_did').notNull(),
  status: text('status').notNull().default('published'), // published|deprecated
  createdAt: ts('created_at').notNull().defaultNow(),
})
// fs_member_prefs gains:
directoryListing: boolean('directory_listing').notNull().default(true),
onboardedAt: ts('onboarded_at'),
```

- [ ] Step 1: Failing test: after `PUT /api/me/skill-claims` with two claims, `fs_skill_claim_index` has exactly those two rows with the right visibility; a second PUT with one claim leaves one row.
- [ ] Step 2: Schema + migration + PUT change (transaction: delete rows for did, insert new). `GET /api/me` adds `directoryListing` (default true when no prefs row) and `onboarded: boolean`.
- [ ] Step 3: Backfill script reads every `fs_app_meta` key `skill-claims:%`, upserts rows; idempotent; prints counts only.
- [ ] Step 4: Tests, typecheck, run migration locally. Commit `feat(db): skill-claim index, attestations, skill proposals, directory prefs`.

### Task 3: Attestations API and evidence

**Files:**
- Create: `apps/appview/src/lib/attestations.ts`, `apps/appview/src/http/routes/attestations.ts`
- Modify: `apps/appview/src/http/app.ts` (mount `app.route('/api', attestations)`), `apps/appview/src/lib/roles.ts` (`inviteOrVouch ||= receivedCount > 0`), `apps/appview/src/http/routes/me.ts` (`vouchesReceived` adds app-side counts; `GET /api/me/attestations`)
- Test: `apps/appview/src/lib/attestations.test.ts`, `apps/appview/src/http/routes/attestations.test.ts`

**Interfaces (exact):**
```ts
// lib/attestations.ts
export class AttestationError extends Error { constructor(message: string, public status: 400|403|404|409, public code: string) }
export async function subjectHoldsSkill(subjectDid: string, skillUri: string): Promise<boolean> // claim index row OR hosted an event whose skillLevel sidecar names skillUri
export async function createAttestation(input: { attesterDid: string; subjectDid: string; skillUri: string; contextEventUri?: string }): Promise<{ id: string }>
export async function removeAttestation(id: string, attesterDid: string): Promise<boolean>
export async function vouchCountsFor(subjectDid: string): Promise<Map<string /*skillUri*/, number>>
export async function vouchCountsForMany(subjectDids: string[]): Promise<Map<string, number>> // total per subject
export async function viewerVouches(attesterDid: string, subjectDid: string): Promise<Set<string /*skillUri*/>>
export async function receivedWithAttesters(subjectDid: string): Promise<Array<{ skillUri: string; attesterDid: string; id: string; createdAt: string }>>
```
Routes: `POST /api/attestations` body `{ subjectDid, skillUri, contextEventUri? }` → 201 `{ id }`; 400 `SelfAttestation` when attester = subject; 404 `SubjectNotHolding` when `subjectHoldsSkill` false; 409 `AlreadyVouched`. `DELETE /api/attestations/:id` → 204 (only attester). `GET /api/me/attestations` → `{ given: [{ id, subjectDid, skillUri, createdAt }], received: [{ id, attesterDid, attesterHandle, attesterDisplayName, skillUri, skillLabel, createdAt }] }`.

- [ ] Step 1: Failing tests for the four error cases, the happy path, delete-by-non-attester 403, evidence flip.
- [ ] Step 2: Implement; `vouchesReceived` merges app-side counts with the existing protocol counts by skill label.
- [ ] Step 3: Tests, typecheck. Commit `feat(attestations): app-side skill vouches with counts and evidence`.

### Task 4: Members directory and member profile API; skill-page people

**Files:**
- Create: `apps/appview/src/lib/members.ts`, `apps/appview/src/http/routes/members.ts`
- Modify: `apps/appview/src/http/app.ts`, `apps/appview/src/http/routes/skills.ts` (`people` for signed-in viewers, via `withViewer`), `apps/appview/src/http/routes/me.ts` (`PUT /api/me` accepts `directoryListing`)
- Test: `apps/appview/src/http/routes/members.test.ts`

**Interfaces (exact):**
```ts
// lib/members.ts
export interface MemberSummary { did: string; handle?: string; displayName?: string; avatarUrl?: string; bio?: string; role: number; roleLabel: string; claimCount: number; vouchCount: number; lastSeenAt: string }
export async function listMembers(opts: { q?: string; skill?: string; cursor?: string; limit?: number }): Promise<{ members: MemberSummary[]; cursor?: string }>
export async function memberVisible(did: string, viewerDid: string): Promise<boolean> // directoryListing || did === viewerDid
export async function memberProfile(did: string, viewerDid: string): Promise<MemberProfile | null>
export interface MemberProfile extends MemberSummary { claims: Array<{ skillUri: string; skillLabel: string; level: string; visibility: 'public'|'school'; vouchCount: number; viewerVouched: boolean }>; badges: unknown /* same shape as GET /api/me/badges */; hosting: Array<{ uri: string; name: string; startsAt: string }>; resources: Array<{ id: string; title: string }> }
```
Handle source: `fs_custodial_account.handle` for custodial members; for others, the contrail `identities` table (`did → handle`) or `@atproto/identity` resolution cached in `fs_app_meta` key `handle:<did>` (24h). Avatar served at `GET /api/members/:did/avatar` from the app-side profile.
Routes (all `requireViewer`, `noindex`): `GET /api/members`, `GET /api/members/:did` (404 when not visible), `GET /api/members/:did/avatar`. `GET /api/skills/:id` adds `people?: { count: number; members: Array<{ did, handle, displayName, avatarUrl, level, vouchCount }> }` only when a viewer exists (max 50, excludes hidden members).

- [ ] Step 1: Failing tests: unauthenticated 401; hidden member absent from list and 404 on profile; `q` matches displayName; `skill` filter; skill detail has `people` only with a session.
- [ ] Step 2: Implement (paginate by `lastSeenAt desc, did`, opaque cursor = base64 of `lastSeenAt|did`).
- [ ] Step 3: Tests, typecheck. Commit `feat(members): members-only directory, member profiles, people on skill pages`.

### Task 5: Continue-with-email sign-in and orphaned PDS account self-heal

**Files:**
- Modify: `apps/appview/src/http/routes/auth.ts` (add `POST /signin` sharing the signup handler), `apps/appview/src/lib/custody.ts`, `apps/appview/src/lib/pds.ts` (admin `searchAccounts` by email + `updateAccountPassword` helpers if missing)
- Modify: `apps/web/src/routes/SignInScreen.tsx` (button copy "Continue with email"; helper text "New here or coming back, this is the door."), `apps/web/src/lib/api.ts` (`auth.signin`)
- Test: `apps/appview/src/lib/custody.test.ts`, `apps/web/src/routes/SignInScreen.test.tsx`

Behaviour: `signup()` when `createAccount` fails with a PDS error whose message matches `/email.*(taken|already)/i` and no `fs_custodial_account` row exists for the email → look the account up through the PDS admin API, set a fresh random password with `com.atproto.admin.updateAccountPassword`, insert the custodial row (`isCustodial: true`) and continue to send the link. Log one line `custodial account adopted` with no identifiers.

- [ ] Step 1: Failing tests with a fake PDS client: existing row → resend; orphan → adopt; unknown PDS error → 502.
- [ ] Step 2: Implement; keep `POST /signup` as alias. Update `apps/web/e2e/mvp.spec.ts` selector to the new button name.
- [ ] Step 3: Tests, typecheck. Commit `feat(auth): continue with email for new and returning members; adopt orphaned PDS accounts`.

### Task 6: Handle choice and onboarding flag

**Files:**
- Modify: `apps/appview/src/lib/handles.ts` (`isValidChosenHandle(prefix)`, `HANDLE_PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$/`, reserved list `['admin','www','pds','skills','boulder','school','help','mail','api']`)
- Modify: `apps/appview/src/http/routes/me.ts`: `GET /api/me/handle/check?handle=<prefix>` → `{ available: boolean; reason?: 'invalid'|'reserved'|'taken' }`; `PUT /api/me/handle { handle }` (custodial only, else 403 `NotCustodial`) → calls `agent.com.atproto.identity.updateHandle({ handle: `${prefix}.${config().handleDomain}` })` through `actorAgent(viewer)`, updates `fs_custodial_account.handle`, returns `{ handle }`; 409 `HandleTaken` when the PDS rejects; `POST /api/me/onboarded` sets `onboardedAt`.
- Modify: `apps/appview/src/http/routes/auth.ts` `GET /me` adds `onboarded`.
- Test: `apps/appview/src/lib/handles.test.ts`, `apps/appview/src/http/routes/me.handle.test.ts`

- [ ] Step 1: Failing tests: validation matrix (too short, uppercase, leading dash, reserved, ok), check endpoint, PUT for oauth viewer 403, PUT happy path with a fake agent, onboarded flag.
- [ ] Step 2: Implement.
- [ ] Step 3: Tests, typecheck. Commit `feat(me): choose a handle; onboarding flag`.

### Task 7: Bluesky profile import and explicit public-linkage confirmation

**Files:**
- Create: `apps/appview/src/lib/bsky-profile.ts`, fixture `apps/appview/src/lib/__fixtures__/bsky-profile.json`
- Modify: `apps/appview/src/http/routes/oauth.ts` (call import after `createSession`, fire-and-forget with `.catch`), `apps/appview/src/http/routes/me.ts` (`POST /api/me/import-bsky-profile`, `checkPublicClaims` 4th arg, `PUT /api/me` `confirmPublicLinkage`)
- Test: `apps/appview/src/lib/bsky-profile.test.ts`, extend `me.public-claims.test.ts`

**Interfaces (exact):**
```ts
export interface BskyProfile { handle: string; displayName?: string; description?: string; avatar?: string /*url*/ }
export async function fetchBskyProfile(did: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<BskyProfile | null>
export async function importBlueskyProfile(did: string, opts: { overwrite: boolean; fetchImpl?: typeof fetch }): Promise<{ imported: boolean; fields: string[] }>
export function checkPublicClaims(sessionKind: SessionKind, claimTiers: SkillTierValue[], confirmTierB: boolean, confirmPublicLinkage = false)
// oauth + !confirmPublicLinkage → { ok:false, status:400, error:'PublicLinkageConfirmRequired', message:'publishing from an existing account links it to this school permanently; resend with confirmPublicLinkage: true' }
```
Avatar: download (max 5 MB, `image/*`), base64, `normalizeImage({ data, alt: '' }, true)`. `overwrite: false` skips when a profile with any field exists. Cache the handle in `fs_app_meta` `handle:<did>`.

- [ ] Step 1: Failing tests: fixture import stores three fields; no-overwrite respects an existing profile; network failure returns `{ imported: false }`; `checkPublicClaims` matrix (oauth without flag → 400 linkage; with flag Tier A ok; with flag Tier B still needs confirmTierB; custodial unchanged).
- [ ] Step 2: Implement; `PUT /api/me` `publicListing: true` for oauth requires `confirmPublicLinkage: true` (same error code) instead of the current 403.
- [ ] Step 3: Tests, typecheck. Commit `feat(oauth): import the Bluesky profile on sign-in; explicit public-linkage confirmation`.

### Task 8: Propose a skill (authority writer) and admin skills

**Files:**
- Create: `apps/appview/src/lib/authority.ts` (login with `AUTHORITY_HANDLE/PASSWORD` against `PDS_URL`, cached session, `putSkillRecord(record)`, `deprecateSkill(uri, replacedBy?)`, `moveSkill(uri, parentUri)`), `apps/appview/src/lib/slug.ts` (`slugify(label)`: NFKD, strip diacritics, lowercase, `[^a-z0-9]+ → -`, trim dashes, max 60)
- Modify: `apps/appview/src/http/routes/skills.ts` (`POST /api/skills`), `apps/appview/src/http/routes/admin.ts` (`GET /api/admin/skills/proposals`, `POST /api/admin/skills/:id/deprecate`, `POST /api/admin/skills/:id/move { parentUri }`), `apps/appview/src/lib/skill-tiers.ts` (export `isSensitiveLabel(label)` and `setTier(id, tier)`)
- Test: `apps/appview/src/lib/slug.test.ts`, `apps/appview/src/http/routes/skills.propose.test.ts` (fake authority)

Behaviour for `POST /api/skills { label (2–80 chars), description? (≤300), parentUri }`: parent must exist and not be `deprecated`; slug collision or a label equal (case/diacritic-insensitive) to a sibling → 409 `{ error: 'SkillExists', existing: SkillNode }`; otherwise write `{ $type:'freeschool.draft.skill', id, label, description, broader:[parentUri], externalIds:{}, status:'proposed', createdAt }` with `rkey = id`, `validate: false` (as the seed does), insert `fs_skill_proposal`, set Tier B when `isSensitiveLabel`, `indexer.notify(uri)`, return 201 `{ uri, id, label, status:'proposed', tier }`. When authority env is unset → 503 `AuthorityUnavailable`. Rate limit: 20 proposals per member per day (count rows) → 429.

- [ ] Step 1: Failing tests (fake authority client injected): happy path, collision, deprecated parent, unset env, rate limit, sensitive label → tier B.
- [ ] Step 2: Implement; admin routes reuse `requireRole(Role.Steward)` on the admin router.
- [ ] Step 3: Tests, typecheck. Commit `feat(skills): members propose skills, published as proposed under the authority; stewards deprecate or move`.

### Task 9: Web SkillPicker, propose sheet, and replacing the dropdowns

**Files:**
- Create: `apps/web/src/lib/skills.ts` (`flattenSkills`, `searchSkills(flat, query, limit)`, `FlatSkill { uri; label; path; area; domain; tier; status }`), `apps/web/src/components/SkillPicker.tsx` (`SkillPicker`, `SkillMultiPicker`), `apps/web/src/components/ProposeSkillSheet.tsx`, tests `SkillPicker.test.tsx`, `skills.test.ts`
- Modify: `apps/web/src/routes/RequestsScreen.tsx`, `MeScreen.tsx`, `EventEditScreen.tsx` (remove local `flattenSkills`, use pickers), `apps/web/src/lib/api.ts` (`skills.propose`), `apps/web/src/lib/queries.ts` (`useProposeSkillMutation`, invalidates `['skills']`), `apps/web/src/lib/types.ts`

Picker contract: WAI-ARIA combobox (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`; listbox options with `role="option"`); typing filters with `searchSkills` (rank: label prefix > label substring > path/description substring; diacritic-insensitive); max 12 rows, each showing label and "Domain › Area" secondary; keyboard ↑↓ Enter Esc; a last row "Can't find it? Propose a skill" (when `allowPropose`) opens `ProposeSkillSheet` (label, optional description, parent picker limited to domains/areas, defaulting to the area of the best current match); on success `onChange(newUri)`. Selected value renders as a chip with a clear button. `SkillMultiPicker` keeps a chip list. Minimum tap height 44px.

- [ ] Step 1: Failing tests: search ranking; picker opens on typing, arrow+Enter selects, Escape closes, propose row visible only with `allowPropose`; RequestsScreen posts the chosen `skill` uri.
- [ ] Step 2: Implement and replace the three dropdowns; delete the duplicate `flattenSkills` copies.
- [ ] Step 3: Tests, typecheck, `pnpm --filter @freeschool/web build`. Commit `feat(web): type-ahead skill picker with propose-a-skill; replaces the dropdowns`.

### Task 10: Web People tab, member profile, skill-page people, Me additions

**Files:**
- Create: `apps/web/src/routes/PeopleScreen.tsx`, `apps/web/src/routes/MemberProfileScreen.tsx`, tests for both
- Modify: `apps/web/src/router.tsx` (`/people` → PeopleScreen; `/people/$did` → a wrapper that renders `MemberProfileScreen` when `useMe()` succeeds and the existing `PublicProfileScreen` otherwise), `apps/web/src/components/TabBar.tsx` (add People between Requests and Me; Me no longer claims `/people`), `apps/web/src/routes/SkillScreen.tsx` (section "People with this skill" for members; signed-out keeps `PractitionerShelf` + "Sign in to see members"), `apps/web/src/routes/MeScreen.tsx` (directory toggle "Hide me from the school directory"; "Vouches you've received" list; "Refresh from Bluesky" for `kind === 'oauth'`; public-linkage confirm sheet on first public toggle/claim), `apps/web/src/lib/api.ts`, `queries.ts`, `types.ts`

Member profile: avatar, display name (fallback handle), handle, role label, bio, badges; claims grouped by level with level label, vouch count, and a **Vouch** / **Vouched ✓** toggle button (hidden on own profile; disabled with tooltip when the viewer cannot vouch); "Upcoming classes they host"; "Notes". Subject-only "Who vouched" expander per skill (from `GET /api/me/attestations`). Empty and error states via `PageState`.

- [ ] Step 1: Failing tests: People renders members and filters by search; profile shows claims and toggles vouch (mutation called with subjectDid/skillUri); skill page shows people section only with a session; Me toggle sends `directoryListing`.
- [ ] Step 2: Implement.
- [ ] Step 3: Tests, typecheck, build. Commit `feat(web): People tab, member profiles with vouching, people on skill pages`.

### Task 11: Web onboarding (`/welcome`) and handle editing

**Files:**
- Create: `apps/web/src/routes/WelcomeScreen.tsx` + test
- Modify: `apps/web/src/router.tsx` (`/welcome`), `apps/web/src/routes/VerifyScreen.tsx` (after verify: `GET /api/auth/me`; if `!onboarded && kind === 'custodial'` go to `/welcome`, else `consumeSignInReturn()`), `apps/web/src/routes/MeScreen.tsx` ("Your handle" row with "Change" → inline editor reusing the same component), `apps/web/src/lib/api.ts` (`me.checkHandle`, `me.setHandle`, `me.onboarded`), `queries.ts`

Screen: `FlowFrame` with three stacked cards and a "Step 1 of 3" strip. Card 1 shows the current handle in large type, "Choose my own" reveals an input with live availability (debounced 300 ms, `GET /api/me/handle/check`), states: checking / available / taken / invalid (message names the rule: "3 to 20 characters, lowercase letters, numbers and dashes"). Card 2: display name, bio, avatar (reuse `ImagePicker`). Card 3: `SkillMultiPicker`. Buttons: "Skip" per card, "Finish" at the end (calls `POST /api/me/onboarded` then navigates to `consumeSignInReturn()`). Copy line under card 1: "Your handle is public and lives in the AT Protocol directory permanently. Everything else here is only visible to members of this school."

- [ ] Step 1: Failing tests: VerifyScreen routes to `/welcome` for a new custodial member and to the requests board for an onboarded one; handle availability states; Finish calls onboarded and navigates.
- [ ] Step 2: Implement.
- [ ] Step 3: Tests, typecheck, build. Commit `feat(web): welcome onboarding with handle choice, profile and skills`.

### Task 12: Web admin skills screen

**Files:**
- Create: `apps/web/src/routes/admin/SkillsAdminScreen.tsx` + test
- Modify: `apps/web/src/router.tsx` (`/admin/skills`), `apps/web/src/routes/admin/AdminOverviewScreen.tsx` (card linking to it with pending count), `api.ts`, `queries.ts`

Lists proposals newest first: label, path, proposer handle, created; actions **Deprecate** (confirm sheet) and **Move** (parent picker). Empty state: "No proposed skills yet. Members can propose one from any skill picker."

- [ ] Step 1: Failing test: renders rows and calls deprecate mutation.
- [ ] Step 2: Implement. Commit `feat(web): steward view of proposed skills`.

### Task 13: Taxonomy expansion (~200 skills)

**Files:**
- Modify: `infra/seed/skills/skills-seed.jsonl`, `infra/seed/skills/stats.json`, `infra/seed/skills/README.md`
- Test: `pnpm lexicons:validate`; a Vitest in `packages/lexicons/scripts/seed.test.ts` (create) that parses the jsonl and asserts unique ids, every `broader` resolves, every record has `label`, `status`, `createdAt`, `description` ≤ 300 chars.

Add roughly 200 skills across: food and fermentation; fibre and textile crafts; garden, soil and land; body, movement and rest; music and voice; languages and literacy; digital basics and creative software; repair (bikes, electronics, small appliances, clothing); home, shelter and energy; care (childcare, elder care, disability support, grief); community organizing and facilitation; money, mutual aid and cooperatives; nature, outdoors and wayfinding; arts, drawing, printmaking, ceramics; writing and zines. Each: one-sentence description, `status: "proposed"` (unless ESCO-anchored), `_provenance.descriptionSource: "authored"`, `broader` = an existing area uri-style id as the file already uses. Add a new area only when ≥6 new skills share none. Keep the file sorted as it is (domain, area, skills). Update `stats.json` totals honestly (script or careful count).

- [ ] Step 1: Write the seed test and run it (passes on the current file).
- [ ] Step 2: Add the records; run `pnpm lexicons:validate` and the seed test.
- [ ] Step 3: Reseed the local PDS: `set -a; . ./infra/seed/.authority.env; set +a; PDS_URL=http://localhost:3000 pnpm --filter @freeschool/lexicons seed:skills`. Commit `feat(taxonomy): ~200 more community skills`.

### Task 14: Demo seed and persona helper

**Files:**
- Create: `apps/appview/scripts/demo-personas.ts`, `apps/appview/scripts/seed-demo.ts`, package script `"seed:demo": "tsx scripts/seed-demo.ts"`, `apps/web/e2e/personas.ts`
- Modify: `.gitignore` (`apps/appview/.demo-users.json`), README (a "Demo data" subsection)

Personas (slug, display name, bio, intent, skills): `amir` host (bike repair, welding basics; teaching), `maya` host (kimchi, sourdough; teaching, proficient), `jonah` host (guitar, songwriting), `priya` host (Spanish conversation, facilitation), `rosa` learner (wants fermentation, gardening), `theo` learner, `lina` learner, `sam` learner, `noor` learner, `eli` facilitator-to-be (has hosted 2 past classes with attendance), `ines` facilitator-to-be, `steward` (display name "Ada", steward). Emails `demo+<slug>@freeskool.test`.

Script order: guard (refuse in production or non-private PDS) → members (call `signup()`, then `verifyEmailToken` using the token in the returned `verifyUrl`; set profile via the same code `PUT /api/me` uses, factor `saveProfile(did, profile)` out of `me.ts` into `lib/profile.ts` if needed; avatar = deterministic identicon SVG → PNG via `sharp` (already a dependency of `lib/images.ts`; check) → `normalizeImage`; chosen handle via the same lib as Task 6) → claims (write through the same lib as `PUT /skill-claims`; factor `setSkillClaims(viewer, body)` into `lib/skill-claims.ts`) → events via `createEventAsHost` (3 series, 2 venue-needed, 2 past with attendance via `lib` used by `POST /events/:id/attendance`, 1 unlisted, 1 neighborhood-only) → RSVPs via `lib/rsvp.ts` → 6 requests + interest via `lib/request-rsvp.ts` → 10 attestations via `createAttestation` → 5 notes via the knowledge lib → `appointSteward(stewardDid)` → write `.demo-users.json` → print counts. Idempotent: existing emails resend nothing and reuse DIDs; events are tagged `demo` in `tags` and skipped when already present (query by name + host).

`apps/web/e2e/personas.ts`: `loadDemoUsers()`, `signInAs(page, slug)` (POST `/api/auth/signin` via `page.request`, read the magic link from the dev mail log exactly as `mvp.spec.ts` does — move `magicLinkUrl` into this helper and import it from `mvp.spec.ts`), `signUpFresh(page, address)`.

- [ ] Step 1: Refactors with tests kept green (profile + claims libs).
- [ ] Step 2: Script; run it locally; verify `GET /api/members` returns 12 rows and the calendar shows the events.
- [ ] Step 3: Commit `feat(dev): seed:demo with twelve personas, classes, requests, vouches`.

### Task 15: Persona journeys and screenshot audit

**Files:**
- Create: `apps/web/e2e/personas.spec.ts`, `apps/web/e2e/audit.spec.ts`
- Modify: `apps/web/playwright.config.ts` (add a `desktop` project 1280×800 used only by `audit.spec.ts`), `.gitignore` (`apps/web/test-results/`) if missing

Journeys exactly as spec §4.6 items 1–5, each in its own `test.describe.serial`. Assertions are user-visible (headings, buttons, counts), never DB reads. `audit.spec.ts` signs in as `steward` and as a fresh newcomer, visits every route in `router.tsx` (with real ids from the seed for parameterised routes) at both viewports, `page.screenshot({ fullPage: true })` into `test-results/audit/<persona>/<viewport>/<route>.png`, and fails only on console errors or an HTTP 5xx.

- [ ] Step 1: Write the specs; run `pnpm e2e -- personas.spec.ts` against the seeded dev stack until green.
- [ ] Step 2: Run `audit.spec.ts`. Commit `test(e2e): persona journeys and screenshot audit`.

### Task 16: UX audit findings and P1 fixes

- Controller reviews the screenshots and writes `docs/plans/refinement-ux-audit.md` (route, persona, what a real user hits, severity P1/P2, fix). One implementer dispatch fixes every P1 (dead ends, unreachable or overlapping buttons, missing empty/loading/error states, truncation, wrong tab highlight, copy that misleads). Re-run `personas.spec.ts` and `audit.spec.ts`. Commit `fix(web): UX audit P1s`.

### Task 17: Multi-school design document

- Create `docs/superpowers/specs/2026-09-13-multi-school-design.md` following spec §4.7 exactly, including the enumerated list of every `config().SCHOOL_DID` read site (`grep -rn "SCHOOL_DID" apps packages --include=*.ts`). No code.

### Task 18: Wrap-up

- `pnpm -r test`, `pnpm -r typecheck`, `pnpm lexicons:validate`, `pnpm --filter @freeschool/appview smoke`, `pnpm --filter @freeschool/appview privacy-audit` (zero violations), README updates (People tab, onboarding, propose a skill, demo seed, AUTHORITY_* env), `docs/deployment.md` (add AUTHORITY_* to the production env, reseed taxonomy on release, run `backfill-skill-claims` once), `.env.example`. Push branch `refinement`, open PR to `main`. Production release waits for Benjamin.
