# Free School

A free, open-source, ATProto-native skill-sharing and events platform for community free schools. Everybody's a teacher, everybody's a student. No money in the app.

Built by Benjamin Life ([@omniharmonic](https://github.com/omniharmonic)) with Free School Boulder. Proposed license: AGPL-3.0-or-later for the app; lexicon schemas and the skill seed are CC0.

## What it is
- A public calendar of classes on `community.lexicon.calendar.event` (interoperable with Smoke Signal, atmo.rsvp, Dandelion, Beacon) with Free School sidecars (`freeschool.draft.*`).
- Profiles with skill claims; a needs board ("I want to learn X" → "I can teach that"); host-attested attendance; badges and roles derived from attestations, never scores.
- Federation without a firehose: each AppView follows a registry of peer PDS hosts directly.
- An installable PWA (Calendar · Skills · Requests · Me) with a printable monthly zine.

## Layout
```
apps/web            PWA (Vite + React)
apps/appview        Hono + @atproto/xrpc-server + @atproto/sync + pg-boss
packages/lexicons   freeschool.draft.* lexicon JSON (CC0) + generated TS
packages/spaces-shim  Spaces-shaped interface (v1: Postgres; later: the Spaces alpha SDK)
packages/shared     role ladder, k-anonymity aggregator, shared types
infra/              docker compose (reference PDS + Postgres), seed scripts
docs/               stack proposal, PRD, architecture, implementation plan, research
```

## Quick start
```
pnpm install
./infra/setup-env.sh
pnpm infra:up
pnpm lexicons:validate
pnpm dev
```

## Status
Pre-alpha scaffold (September 2026). v1 target: before COhere, October 2026. See `docs/`.
