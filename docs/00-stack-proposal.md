# Free School — Stack proposal (one page)

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: proposed, pending Benjamin's OK on license and publishing*

## What we are building
A free, open-source, ATProto-native skill-sharing and events app for community free schools. v1 ships before COhere (October 2026) on **public records**; the hosted service custodies the school DID; anonymous feedback is app-side behind a Spaces-shaped interface; reputation is derived from attestations. Sidecar composition only.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere, Node 22, pnpm workspaces | One language across PDS glue, AppView, PWA; the reference ATProto SDKs are TS. |
| Protocol SDKs | `@atproto/api` 0.20, `@atproto/oauth-client-node` + `-browser` 0.5, `@atproto/sync` 0.4, `@atproto/repo`, `@atproto/identity`, `@atproto/lexicon` + `lex-cli` (codegen). `alpha` dist-tag (`0.0.0-spaces-alpha-20260910…`) **only** in the isolated `packages/spaces-shim` that touches Spaces. | Latest stable for everything user-facing; alpha quarantined so weekly drops cannot break v1. |
| Identity / PDS | Reference PDS (`ghcr.io/bluesky-social/pds`) via Docker Compose for hosted email signup; accounts minted server-side with `com.atproto.server.createAccount` using invite codes we issue. Existing ATProto users sign in via OAuth (DPoP, public client metadata). | Proven self-host path (1 vCPU / 1 GB), CAR export built in, accounts can migrate out later. |
| AppView | Hono (HTTP) + `@atproto/xrpc-server` for our own `freeschool.draft.*` query methods; `@atproto/sync` Firehose class pointed at each peer PDS (no relay) with `getRepo` backfill; peer registry is a config table; Postgres via Drizzle ORM; BullMQ-free: pg-boss for jobs (materialize series, send reminders, newsletter). | Direct-PDS federation is the settled model; Postgres + pg-boss keeps a one-box deploy. |
| Database | Postgres 16 (Docker locally; Neon or any managed Postgres in prod). One schema: indexed records (by `at://` URI + CID), derived views (badges, roles, skill pages), app-only tables (feedback, push subs, email, sessions, invites, moderation audit). | Derived data is rebuildable from repos; app-only tables are the explicit privacy boundary. |
| Front end | Vite + React 19 + TypeScript PWA (`vite-plugin-pwa`, Workbox), TanStack Router + Query, Tailwind 4 with a small iOS-idiom component set (frosted surfaces, large titles, bottom tabs Calendar · Skills · Requests · Me, sheet modals). Print stylesheet for the monthly zine. | PWA is the settled delivery; React keeps the contributor pool wide (Lex's "kid from CU" contributors). |
| Notifications | Web push (VAPID) after install nudge; email via Resend/SMTP with a monthly newsletter job. Adopt patterns from `atproto-notify` / OpenMeet `event-mail` per R6. | iOS push is Home-Screen-only; email is the reliable floor. |
| Recurrence | `freeschool.draft.series` sidecar + RRULE (`rrule` lib), occurrences materialized as ordinary events 60 days ahead (R6 decides the final window). | Calendar lexicon has no recurrence; interop tools only see plain events. |
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

## Out of scope for v1
Real Spaces in production, elections, labelers, wiki adapter, one-click self-host.
