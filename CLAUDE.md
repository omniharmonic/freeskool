# Free School — working notes for Claude Code

Free, open-source, ATProto-native skill-sharing + events platform for community free schools (Boulder first). Author of record: Benjamin Life (@omniharmonic). Never attribute to OpenCivics. v1 ships before COhere (October 2026).

## Settled decisions (do not reopen)
- Sidecar composition only: never add fields to `community.lexicon.calendar.event` or any borrowed record; attach strongRef sidecars; placement follows audience.
- Record types live under `freeschool.draft.*` (`packages/lexicons`) until Lucian Hymer normalizes the namespace; design so the rename is a find-and-replace.
- The hosted service custodies the school DID in v1. **Every write as the school goes through `SchoolActorPort`** (`packages/school-actor`); never touch the school session elsewhere. Destructive actions need the policy's steward threshold (default 2) with approvals as records.
- v1 on public records; anonymous feedback, RSVPs, attendance, roster and moderation are app-side behind the Spaces-shaped interface (`packages/spaces-shim`). Real Spaces, elections, labelers, wiki adapter, one-click self-host are out of v1 scope.
- Reputation is derived (`deriveRole`, `aggregateFeedback` in `packages/shared`), never minted or scored. Counts and presence, never averages in public.
- Privacy defaults from the R9 threat model (human-review-required): no public record may name a DID its holder did not write; fresh Free School identity is the primary sign-in door; membership roster and moderation reasons are never public; neutral PDS hostname; strip avatar metadata by re-encoding.

## Layout
`apps/web` PWA (Vite + React, iOS idiom, Calendar · Skills · Requests · Me, print zine) · `apps/appview` (contrail indexing core + Hono API + pg-boss jobs; server-side ATProto OAuth with cookie session) · `packages/lexicons` (17 validated lexicons, CC0) · `packages/shared` · `packages/spaces-shim` · `packages/school-actor` · `packages/pds-follow` (R4 direct-PDS follower; basis for the AppView `PdsChangeSource`) · `infra/` (compose: reference PDS on :3000, Postgres on :5434; `spaces-alpha-lab/` from R1) · `docs/` (stack proposal, review packets, research brief v0.2, PRD, architecture, plan).

## Commands
`pnpm install` · `./infra/setup-env.sh && pnpm infra:up` · `pnpm lexicons:validate` · `pnpm -r test` · `pnpm -r typecheck`. Vitest configs live per package (a stray `vite.config.ts` in the home directory breaks config discovery otherwise). Workspace packages export TypeScript source directly (`exports: {".": "./src/index.ts"}`).

## Research
Parachute vault `default`: `vault/projects/local-alternatives/free-school/research/r1..r9_*`, brief v0.1/v0.2 under `vault/projects/local-alternatives/reports/`. Key corrections to older notes: `coop.lexicon.event.config` field is `attendance` (not `attendanceMode`); `community.lexicon.*` canonical home is `tangled.org/lexicon.community/lexicons`; Smoke Signal is sunset; the Arbiter has no license and no membership API as of 2026-09-12.

## Outward-facing actions need Benjamin's explicit OK
Sending the Lucian/Lex emails (`docs/email-drafts/`), publishing the repo to a public GitHub org, exchanging listings with the COhere calendar, anything on-chain or social.
