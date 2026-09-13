# Free School — Stack proposal (one page)

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: proposed, pending Benjamin's OK on license and publishing · revised after R1–R3, R6, R8, R9*

## What we are building
A free, open-source, ATProto-native skill-sharing and events app for community free schools. v1 ships before COhere (October 2026) on **public records**; the hosted service custodies the school DID; anonymous feedback is app-side behind a Spaces-shaped interface; reputation is derived from attestations. Sidecar composition only.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, Node 22, pnpm workspaces | One language across PDS glue, AppView, PWA; the reference ATProto SDKs are TS. |
| Protocol SDKs | `@atproto/api` 0.20, `@atproto/oauth-client-node` + `-browser` 0.5, `@atproto/sync` 0.4, `@atproto/repo`, `@atproto/identity`, `@atproto/lexicon` + `lex-cli` (codegen). `alpha` dist-tag (`0.0.0-spaces-alpha-20260910…`) **only** in the isolated `packages/spaces-shim` that touches Spaces. | Latest stable for everything user-facing; alpha quarantined so weekly drops cannot break v1. |
| Identity / PDS | Reference PDS (`ghcr.io/bluesky-social/pds`) via Docker Compose for hosted signup; accounts minted server-side (`createAccount` + invite code, random 32-byte password encrypted at rest, OpenMeet's custodial pattern, Apache-2.0) with a take-ownership path. **ATProto OAuth runs server-side** (`@atproto/oauth-client-node`, confidential client, cookie session) — R8: iOS copies only cookies at Add-to-Home-Screen, and the browser client keeps non-extractable DPoP keys in IndexedDB, so a browser-side flow logs the user out on install. **Default door = new Free School identity on our PDS; existing-account OAuth is the secondary path with a hard confirm** (R9). | Proven self-host path; survives install; keeps Free School records off the user's public Bluesky DID by default. |
| AppView | **`@atmo-dev/contrail` 0.23 (MIT) as the indexing core** — per R6: backfill is already relay-free (its `relays` list is just hosts serving `listReposByCollection`, which a PDS serves), sidecars are first-class via `references`, Postgres adapter, transactional outbox. We write the one missing piece, a **`PdsChangeSource`** over `com.atproto.sync.subscribeRepos` (reusing the R4 script), and offer it upstream. Hono for our own `freeschool.*` HTTP/XRPC endpoints; pg-boss for jobs (materialize series, reminders, newsletter). | Importing a maintained AppView framework beats re-deriving cursors, backfill and outbox; the per-host cursor semantics of `PdsChangeSource` is the highest-risk build item and gets a spike first. |
| Database | Postgres 16 (Docker locally; any managed Postgres in prod with **PITR ≤ 7 days, snapshots ≤ 30 days** per R9). Indexed records (contrail), derived views (badges, roles, skill pages), app-only tables (RSVPs, attendance, feedback ballots with per-event HMAC keys destroyed at window close, push subs, email, sessions, invites, moderation audit). Retention as code with tests. | Derived data is rebuildable from repos; app-only tables are the explicit privacy boundary and the subpoena target, so they hold as little as possible. |
| Front end | Vite + React 19 + TypeScript PWA (`vite-plugin-pwa`, Workbox), TanStack Router + Query, Tailwind 4 with a small iOS-idiom component set (frosted surfaces, large titles, bottom tabs Calendar · Skills · Requests · Me, sheet modals). Print stylesheet for the monthly zine. | PWA is the settled delivery; React keeps the contributor pool wide (Lex's "kid from CU" contributors). |
| Notifications | Built in-app (R6: atproto-notify has no license; take its protocol shape only). Two triggers: contrail outbox (`initial: 'future'`) for record changes, minutely cron for reminders (24h, 1h, day-of digest). **Declarative Web Push** (iOS 18.4+, `mutable: true`) via `web-push` after the install nudge; email via SMTP/comail with MJML templates (OpenMeet, Apache-2.0) and `.ics` attachment. Dedup ledger + Postgres outbox. Preferences are app state, never public records. | iOS push is Home-Screen-only and revokes on silent push; email is the reliable floor. |
| Recurrence | `freeschool.draft.series` + `.occurrence` sidecars (R2, validated); RRULE string normative; `rrule` ^2.8.1, wall-clock expansion then localize; server-side daily materialization, 90-day window, ≥4 occurrences floor, 18-month ceiling, deterministic occurrence rkeys, `exdates` fed into every expansion, split-series for "this and following" (R6). | Calendar lexicon has no recurrence; interop tools only see plain events; nobody upstream has solved it. |
| Admin | Same PWA, `/admin` routes gated by steward role; policy editor, thresholds, moderation queue (mandatory written reason), newsletter composer, peer registry, export. | "All the tools inside the tool." |
| Deploy | `docker compose up` = pds + appview + postgres + web. Fly.io or a $10 VPS for Boulder; Vercel optional for the static PWA only. | Self-hostable by a community later; one-box now. |
| Testing | Vitest; Playwright for the PWA; a `compose.test.yml` that boots a throwaway PDS for integration tests. | Integration against a real PDS is the only honest test of record writes. |

## License: **AGPL-3.0-or-later** (proposed)
- The community is explicitly anti-capitalist and anti-enclosure; AGPL guarantees any hosted fork (a city running its own instance) publishes its changes back. MIT would let a platform wrap the app and close it.
- Lexicon JSON files and the skills seed are licensed **CC0** separately so Lucian's co-op and other apps can adopt the schemas without friction (schemas must be maximally shareable; the app need not be).
- Compatibility: everything we intend to reuse (atmo-events, atproto-notify, OpenMeet, @atproto/*) is MIT/Apache/AGPL-compatible for inbound code; R6 confirms per-repo. If Benjamin prefers MIT for contributor simplicity, the only cost is the enclosure guarantee.

## Repo shape
```
freeskool/
  apps/web        PWA (Vite + React)
  apps/appview    Hono + xrpc-server + sync + jobs
  packages/lexicons   freeschool.draft.* JSON (CC0) + generated TS
  packages/spaces-shim  Spaces-shaped interface; v1 = Postgres impl, later = alpha SDK impl
  packages/shared     types, policy engine (role ladder, k-anonymity aggregator)
  infra/              compose files, PDS env, seed scripts (skills)
  docs/               this proposal, PRD, architecture, plan, research
```

## Research-driven changes (2026-09-12)
- **Two spaces, not one** for members and feedback when Spaces arrive: per-collection read is inexpressible in the alpha (R1). Space-type NSIDs need 3+ segments (`org.freeschool.members`).
- **Every school-authored write goes through `SchoolActorPort`** (built: `packages/school-actor`) so the Arbiter can be swapped in for Phase 2 without call-site changes (R3). The Arbiter currently has no license and no membership API; wrap, don't adopt.
- **Privacy defaults (R9, human-review-required):** RSVP and attendance app-side by default; no public record naming a DID that the DID holder did not write; membership roster never public; moderation reasons never public (enum + code only); neutral PDS hostname; EXIF re-encode; skill taxonomy tiered A/B for public default.
- **Smoke Signal is sunset** (R2); its users are the first interop audience for our calendar.

## Out of scope for v1
Real Spaces in production, elections, labelers, wiki adapter, one-click self-host.
