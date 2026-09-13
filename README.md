# Free School

A free, open-source, ATProto-native skill-sharing and events platform for community free schools. Everybody's a teacher, everybody's a student. No money in the app.

Built by Benjamin Life ([@omniharmonic](https://github.com/omniharmonic)) with Free School Boulder. Proposed license: AGPL-3.0-or-later for the app; lexicon schemas and the skill seed are CC0.

## What it is
- A public calendar of classes on `community.lexicon.calendar.event` (interoperable with atmo.rsvp, Dandelion, Beacon) with Free School sidecars (`freeschool.draft.*`) attached by strongRef — never by adding fields to somebody else's record.
- Profiles with skill claims; a needs board ("I want to learn X" → "I can teach that"); host-attested attendance; badges and roles derived from attestations, never scores.
- Federation without a firehose: each AppView follows a registry of peer PDS hosts directly.
- An installable PWA (Calendar · Skills · Requests · Me) with a printable monthly zine.

## Layout
```
apps/web            PWA (Vite + React, iOS idiom) + the Playwright e2e suite
apps/appview        Hono + @atproto/xrpc-server + @atproto/sync + pg-boss + contrail index
packages/lexicons   freeschool.draft.* lexicon JSON (CC0) + the 525-node skill seed
packages/spaces-shim  Spaces-shaped interface (v1: Postgres; later: the Spaces alpha SDK)
packages/school-actor SchoolActorPort — every write as the school goes through it
packages/shared     role ladder, k-anonymity aggregator, shared types
packages/pds-follow R4 direct-PDS follower (basis for the AppView's PdsChangeSource)
infra/              docker compose (reference PDS + Postgres), skill seed, R1 Spaces lab
docs/               stack proposal, PRD, architecture, implementation plan, research
```

## Run the MVP locally

Node 22, pnpm 10, Docker. Everything below assumes the repo root.

### 1. Install, and start the stack

```bash
pnpm install
./infra/setup-env.sh          # writes infra/pds.env (the admin password is inside; never commit it)
docker compose -f infra/compose.yml -f apps/appview/compose.override.yml up -d
```

**The second `-f` matters.** `infra/pds.env` ships `PDS_SERVICE_HANDLE_DOMAINS=.localhost`, and `.localhost` is a *reserved* TLD that `@atproto/syntax` rejects before the PDS ever looks at its own service domains — every `createAccount` fails with `InvalidHandle`. The overlay adds `.test` (RFC 6761, and not on atproto's disallowed list). `pnpm infra:up` starts the same stack without the overlay, which is fine for reading but cannot mint an account.

Note: this dev PDS publishes to the **production** PLC directory, so every local account mints a real, permanent `did:plc`. Fine for a handful of throwaway accounts; for heavy local work use the in-memory PLC in `infra/spaces-alpha-lab/`.

### 2. Put the AppView's env in your shell

`apps/appview/src/config.ts` is the only thing that reads `process.env`, and nothing loads `.env` for you — export it yourself, in the shell you will run everything else from:

```bash
cp .env.example .env
# then add to .env:
#   PDS_HANDLE_DOMAIN=test
#   PDS_ADMIN_PASSWORD=<the value in infra/pds.env>
#   SESSION_SECRET=<32+ random chars>
#   CUSTODY_KEYS=v1:<base64 of 32 random bytes>    # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
#   CUSTODY_KEY_VERSION=v1
#   FEEDBACK_BALLOT_PEPPER=<random>
#   ALLOWED_PRIVATE_PDS_HOSTS=localhost,127.0.0.1
#   WEB_PUBLIC_URL=http://localhost:5173
set -a; . ./.env; set +a
```

### 3. Create the school, and migrate

```bash
pnpm --filter @freeschool/appview create-school    # prints SCHOOL_DID / SCHOOL_HANDLE / SCHOOL_APP_PASSWORD
# paste those three into .env, then: set -a; . ./.env; set +a
pnpm --filter @freeschool/appview db:migrate       # fs_* via drizzle, then contrail.init()
```

The school account and its `freeschool.draft.school` + `freeschool.draft.policy` records are the **only** writes in the codebase that use the school's own session directly instead of `SchoolActorPort`: the port authorizes against the policy record, which does not exist yet.

### 4. Seed the skill taxonomy (optional, but the Skills tab is empty without it)

```bash
# infra/seed/.authority.env holds the authority account this repo seeded under (gitignored).
set -a; . ./infra/seed/.authority.env; set +a
pnpm --filter @freeschool/lexicons seed:skills     # 525 freeschool.draft.skill records
```

### 5. Run it

```bash
FREESCHOOL_NO_JOBS=1 pnpm --filter @freeschool/appview dev   # API on :4000 (drop the flag to run pg-boss too)
pnpm --filter @freeschool/web dev                            # PWA on :5173, proxying /api to :4000
```

Open <http://localhost:5173>, sign in with any email, and read the magic link out of **`apps/appview/.dev-mail.log`** — with `SMTP_URL` unset the AppView appends every mail there as one JSON line (`{to, subject, body, at}`) rather than printing it, because a log line with somebody's address or magic link in it is exactly what R9 forbids. `tail -1 apps/appview/.dev-mail.log` is the whole flow.

To act as a steward (the `/admin` screens), appoint yourself once — steward is the one role that cannot be derived from records:

```bash
STEWARD_DID=did:plc:... pnpm --filter @freeschool/appview appoint-steward
```

Running a second stack beside a first (the e2e suite does this): `APPVIEW_PORT=4100 APPVIEW_PUBLIC_URL=http://localhost:4100 … pnpm --filter @freeschool/appview dev` and `APPVIEW_PROXY_TARGET=http://localhost:4100 pnpm --filter @freeschool/web dev`.

**Signing in with an existing ATProto account cannot work on `http://localhost`** — a confidential OAuth client needs an `https:` `client_id` with a real hostname — so those routes answer `503 OAuthNotConfigured` locally, by design. See `apps/appview/README.md` §5. The primary door (a new Free School identity) is unaffected, and is the door the project wants people to use.

### 6. Check it

```bash
pnpm -r test            # unit/integration (live Postgres; 280 tests)
pnpm -r typecheck
pnpm lexicons:validate

pnpm --filter @freeschool/appview smoke           # 11 steps against the live stack, ends in SMOKE PASSED
pnpm --filter @freeschool/appview privacy-audit   # every public record on the PDS; exits 1 on a violation
pnpm e2e                                          # the browser loop (see below)
```

The privacy audit reads every repo on the PDS as a stranger would and fails on any public record that names a DID its holder did not write. On a box that has run the moderation or hand-off flows it currently reports real violations: `freeschool.draft.moderationAction` records carry `subjectDid`, the account acted on. That is a decision waiting on Benjamin, not a bug in the audit — see `docs/implementation-plan.md` §0b.

`pnpm e2e` drives a real browser through the whole MVP — sign up, ask for a class, post one, RSVP from three other members, check off attendance, three anonymous ballots, the k=3 summary, a materialized weekly series, the zine, and a steward policy change that re-derives a role. It needs the stack from steps 1–5 **already running**, Chromium (`pnpm --filter @freeschool/web exec playwright install chromium`), and the same exported env (two steps shell out to the AppView package). It takes a few minutes: the materializer ends in a full peer backfill.

## What is in v1

- One custodied school DID; email-first sign-in that mints a Free School identity on the school's own PDS; take-ownership of that account whenever you want it.
- Classes (one-off and recurring), location tiers (neighbourhood public, address to people who RSVP), capacity and waitlist, materials, invite links, `.ics`.
- Skill taxonomy with Tier A/B visibility rules, skill claims, the needs board with interest thresholds and "I can teach this".
- App-side RSVPs, attendance attestation, anonymous host feedback with a k-anonymous summary, derived roles and badges (counts and presence, never averages).
- Steward surface: policy editor, moderation queue with approvals and an audit trail, peer registry, monthly newsletter, steward hand-off.
- PWA: installable, offline calendar for 30 days, declarative push reminders, printable monthly zine, a plain-language "how it works" page.
- Federation: a peer registry of PDS hosts followed directly (`subscribeRepos` live, a 15-minute backfill beneath it), tag-routed listings so another school's calendar can carry our classes.

## What is *not* in v1

- Real Spaces (the interface is there — `packages/spaces-shim` — the Postgres implementation stands in), elections or any voting, labelers, a wiki adapter, one-click self-hosting.
- Money of any kind. No payments, no donations, no sponsorships.
- Private records on the protocol: v1 public records are genuinely public, and everything that should not be public is app-side instead.
- Skill attestations ("vouches") are read but never written yet — the double opt-in they need does not exist, so the privacy audit treats any attestation naming another DID as a violation on purpose.
- The secondary door (OAuth with an existing account) is implemented but cannot be exercised on `http://localhost`, and an OAuth session may not publish public skill claims in v1.
- Multi-school hosting from one AppView, a migration path off the custodial PDS for the *school* DID, and moderation federation.

## Decisions awaiting Benjamin

1. **License: AGPL-3.0-or-later (proposed) vs MIT.** `LICENSE` is AGPL-3.0 and every `package.json` says `AGPL-3.0-or-later`; lexicons and the skill seed are CC0 either way. Nothing is published yet, so this is still reversible.
2. **Send the two drafted emails** in `docs/email-drafts/` — Lucian Hymer (normalizing the `freeschool.draft.*` namespace) and Lex (policy defaults, install-nudge copy, the member note). Both are written and unsent; outward-facing contact waits on an explicit OK.
3. **Publishing the repo** to a public GitHub org, and with it the decision to exchange listings with the COhere calendar.
4. **A neutral PDS hostname** for the real deployment (R9: the hostname must not itself disclose what the school is), plus the VPS and backup plan around it.
5. **A second rotation-key holder** for the school DID, so custody is not one laptop. v1 custodies the school DID in the hosted service; the rotation key needs a second human before Boulder goes live.

## Status

MVP complete against the local stack (September 2026); v1 target is before COhere, October 2026. `docs/implementation-plan.md` §0 has the per-task state and what was deliberately deferred.
