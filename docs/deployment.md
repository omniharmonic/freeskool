# Deploying Free School

One small VPS runs the whole stack under Docker Compose: Caddy (TLS, the built PWA, reverse proxy),
the AppView (indexer + API + jobs), Postgres, and the school's own reference PDS. Files:

- `Dockerfile` — `appview` and `web` targets from one pnpm workspace layer
- `infra/production/compose.yml` — the four services; only Caddy publishes ports
- `infra/production/Caddyfile` — an `(app)` snippet and four names: web+API on the apex, the PDS
  hostname, the `*.` wildcard (handles **and** schools), and the container-local TLS `ask`
- `infra/production/.env.example` — every variable, with how to generate each secret
- `infra/production/backup.sh` — nightly Postgres dump + PDS volume tarball, 14-day retention

## The current deployment (2026-09-13)

| | |
|---|---|
| Host | Hetzner Cloud `freeskool-1`, CX33 (4 vCPU, 8 GB, 80 GB), Falkenstein (`fsn1`), Ubuntu 24.04 |
| Firewall | Hetzner `freeskool-fw`: 22/tcp, 80/tcp, 443/tcp, 443/udp, ICMP |
| SSH | `root@167.233.100.123`, key `frontrange-twin deploy` (the Bioregional Twin key) |
| Checkout | `/opt/freeskool` (branch `main`), env at `/opt/freeskool/infra/production/.env` |
| Web + API | `https://freeskool.xyz` (`www.` redirects) |
| PDS | `https://pds.freeskool.xyz`; handles `<name>.freeskool.xyz` |
| Email | Resend over SMTP (`smtps://resend:<key>@smtp.resend.com:2465`) |
| Registrar / DNS | Namecheap, `freeskool.xyz` |
| School | `boulder.freeskool.xyz` = `did:plc:wv2kwwxv2keocw52uaugwbis` (policy `3mvg3wgw2ps2x`) |
| Skills authority | `skills.freeskool.xyz` = `did:plc:yekh7akcatgn7o7foedjpgj4`, 525 skills seeded |
| First steward | Benjamin (`calmalder301.freeskool.xyz`), appointed 2026-09-13 |
| Secrets | `/opt/freeskool/infra/production/.env` + `.authority.env` on the server; copies in `~/.config/freeskool/` on Benjamin's Mac |

Why Falkenstein and not a US location: Hetzner's CX line (CX33 €9.99/month, 20 TB traffic) is EU-only;
the US locations only offer CPX at roughly four to seven times the price. Boulder sees ~130 ms to
Falkenstein, which the PWA's offline-first calendar absorbs. Move later with the runbook below.

**Decided (R9), 2026-09-14:** the PDS hostname `pds.freeskool.xyz` is not neutral — the hostname
itself says what the school is, in a DID document that is world-readable forever. Benjamin
registered **`freeskool.directory`**, and the PDS moves to `pds.freeskool.directory` with every
handle to `<name>.freeskool.directory` (federation design §2, ruling 3). That is a PLC operation
per existing account, plus a Caddy/env window in which both domains are served at once, so it has
its own runbook: **`docs/runbooks/pds-hostname-migration.md`** — do it before the relay switch
(`docs/runbooks/relay-switch.md`). `infra/production/{Caddyfile,compose.yml,.env.example}` already
carry the `PDS_LEGACY_HOST` / `PDS_LEGACY_HANDLE_DOMAIN` overlap variables the runbook uses; they
are empty except during that window.

## DNS

All `A` records point at the server. The wildcard is what lets every generated handle resolve and
lets Caddy mint a certificate per handle on demand.

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `@` | `167.233.100.123` | 300 |
| A | `www` | `167.233.100.123` | 300 |
| A | `pds` | `167.233.100.123` | 300 |
| A | `*` | `167.233.100.123` | 300 |

Resend adds its own records once the domain is created there (a `resend._domainkey` TXT for DKIM,
an MX plus SPF TXT on the `send` subdomain, and optionally `_dmarc`). `freeskool.xyz` is a verified
Resend domain (since 2026-09-13; `cosense.us` was removed to make room) and mail goes out as
`Free School <hello@freeskool.xyz>`. Namecheap only keeps MX records once Mail Settings is set to
**Custom MX** in its UI; the API silently drops them otherwise.

## Caddy: handle hosts, school hosts, and the on-demand gate

Since the federation branch the wildcard is **inverted** (multi-school design §3). It used to send
everything on `*.freeskool.xyz` to the PDS, which made `boulder.freeskool.xyz` — the school
account's handle — unusable as the school's web address. Now:

| Name | What serves it |
|---|---|
| `freeskool.xyz` | the PWA, plus `/api/*` and the three `/oauth/*` documents on the AppView |
| `www.freeskool.xyz` | 301 to the apex (from inside the wildcard block; see below) |
| `pds.freeskool.xyz` | the PDS, whole and unchanged |
| `*.freeskool.xyz` | `/.well-known/atproto-did` and `/xrpc/*` → the PDS; **every other path → the app** |

So `boulder.freeskool.xyz` is both the Boulder school's web address and the Boulder school
account's handle, and `calmalder301.freeskool.xyz/.well-known/atproto-did` keeps resolving exactly
as before. The apex body lives in one Caddyfile snippet, `(app)`, imported by both the apex block
and the wildcard block, so "the same app on another name" cannot drift into two apps.

The consequence is that **school labels and member handles share one namespace**. One list,
`RESERVED_LABELS` in `apps/appview/src/lib/handles.ts` (mirrored in the PWA's `HandleChooser.tsx`,
which cannot import server code), is refused by the handle generator, by the handle chooser and by
school creation: `admin www pds skills school help mail api app static assets internal denver
boulder`, plus every label in `SCHOOL_LABELS`. A member who held a school's label would hold a
school's origin — the session cookie is scoped to the registered domain — so this is a
security rule, not a tidiness rule.

**The on-demand `ask` now asks the AppView, not the PDS.** Caddy cannot get a wildcard certificate
here (no DNS challenge), so every handle and school host is issued one name at a time and Caddy
asks first. `http://127.0.0.1:9000` inside the Caddy container proxies to
`appview:4000/internal/tls-check?domain=…`, which answers 200 for `www.$WEB_HOST`, 200 for a known
school label under `SCHOOL_DOMAIN_SUFFIX`, and otherwise asks the PDS's own `/tls-check` (3-second
timeout). **A PDS that does not answer is a 403**, never a yes: an unanswered check must not spend
one of Let's Encrypt's 50 certificates per registered domain per week. The endpoint is never routed
from a public host — the site blocks send only `/api/*` and the OAuth documents to the AppView — and
it never logs the domain (R9: the ask carries a member's handle host).

Two AppView variables belong in `infra/production/.env` (both have defaults that already match this
deployment): `SCHOOL_DOMAIN_SUFFIX=freeskool.xyz` and `SCHOOL_LABELS=boulder`. The label of
`SCHOOL_HANDLE` is added automatically when that handle sits directly under the suffix. Federation
Task 2 replaces the `SCHOOL_LABELS` half with the `fs_school_domain` table.

**Caddy gotchas that constrain all of the above.** Caddy never issues a certificate for a specific
name it believes a configured wildcard covers, which is why `www` is served from inside the wildcard
block (it would otherwise never get a certificate at all) and why `pds.freeskool.xyz` keeps
`tls { on_demand }` even in its own block.

### Validating the Caddyfile

The Caddyfile uses `{$ENV}` placeholders, so validation needs them set — an unset placeholder
becomes an empty hostname and the adapter's answer is meaningless:

```sh
docker run --rm \
  -e WEB_HOST=freeskool.xyz -e PDS_HOST=pds.freeskool.xyz -e PDS_HANDLE_DOMAIN=freeskool.xyz \
  -v "$PWD/infra/production/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

It ends in `Valid configuration`. Swap `validate` for `adapt` to read the JSON it becomes — the
quickest way to check that the PDS paths still sit ahead of the app on the wildcard host, and that
the on-demand policy still covers both `pds.` and `*.`.

## Email (Resend)

1. Resend → Domains → add `freeskool.xyz` (region `us-east-1`). Put the DNS records it prints into
   Namecheap. Verify.
2. Resend → API keys → new key, **sending access**, restricted to that domain.
3. In `.env`: `SMTP_URL=smtps://resend:<key>@smtp.resend.com:2465`,
   `MAIL_FROM=Free School <hello@freeskool.xyz>`, `PDS_EMAIL_FROM=hello@freeskool.xyz`.
4. `docker compose … up -d appview pds` to pick the new values up.

Port 2465, not 465: Hetzner Cloud blocks outbound 25 and 465 on new accounts (587 and Resend's
alternates 2465/2587 are open). The server's resolver is pinned to 1.1.1.1/9.9.9.9 in
`/etc/systemd/resolved.conf.d/freeskool.conf` because Hetzner's resolvers negatively cached the zone
for an hour during the first deploy.

The AppView refuses to boot in production without `SMTP_URL` (the magic-link door cannot work, and
the dev file sink would write magic links to disk). The PDS uses the same transport for its own mail.

## First deploy, step by step

```sh
# On the server, as root
git clone https://github.com/omniharmonic/freeskool.git /opt/freeskool
cd /opt/freeskool && git checkout main
cp infra/production/.env.example infra/production/.env && chmod 600 infra/production/.env
$EDITOR infra/production/.env            # every blank; generators are in the comments

C="docker compose --env-file infra/production/.env -f infra/production/compose.yml"
$C config --quiet && $C build            # ~5 minutes on a CX33 the first time
$C up -d postgres pds web                # Caddy starts fetching certificates once DNS resolves

# Mint the school account + its school/policy records (permanent public identity — run once)
$C run --rm appview pnpm --filter @freeschool/appview create-school
# Paste SCHOOL_DID / SCHOOL_HANDLE / SCHOOL_APP_PASSWORD into infra/production/.env, then
$C up -d
curl -s https://freeskool.xyz/api/health   # {"status":"ok","checks":{"postgres":"ok","pds":"ok"},"school":true}
```

The AppView migrates `fs_*` and initialises contrail at every boot, and seeds the skill-tier
classifications. The public skill taxonomy (525 `freeschool.draft.skill` records) is published
under an **authority account** on this PDS:

```sh
# Create the authority account once (an admin invite code, then createAccount), then:
$C run --rm -e AUTHORITY_HANDLE=skills.freeskool.xyz -e AUTHORITY_PASSWORD=… \
   -e PDS_URL=https://pds.freeskool.xyz appview pnpm --filter @freeschool/lexicons seed:skills
```

Appoint the first steward after that person has signed in once (steward is the one role that is not
derived): `$C run --rm -e STEWARD_DID=did:plc:… appview pnpm --filter @freeschool/appview appoint-steward`.

Backups: `crontab -e` → `17 3 * * * /opt/freeskool/infra/production/backup.sh >> /var/log/freeskool-backup.log 2>&1`.
Copies that leave the server must be encrypted first; they contain member email addresses and
custodial credentials (wrapped, but still).

## Releasing a change

```sh
ssh -i ~/.ssh/frontrange-twin root@167.233.100.123 /opt/freeskool/infra/production/release.sh
```

`release.sh` refuses tracked local changes, pulls with `--ff-only`, runs `backup.sh`, retains the
running application images as `freeschool-{appview,web}:rollback-<previous revision>`, rebuilds
`appview` + `web`, and recreates only those two services with `--no-deps`. Postgres and the PDS keep
running. It exits unsuccessfully if the final HTTPS health response is not healthy. Rollback
images are deliberately retained, never pruned by the release script. The deployed branch is now
`main`; the original `deploy/hetzner` history has been merged.

Roll back with `git checkout <previous commit> && $C build && $C up -d`. A release that changes the
schema also needs the pre-release dump to roll back to; never delete a volume.

## Releasing this refinement branch

Beyond the usual `release.sh` above, this branch adds the taxonomy authority, the skill index, and a
one-off record repair, none of which `release.sh` or the AppView's own boot-time migration runs for you.
In order, against the production server (`ssh -i ~/.ssh/frontrange-twin root@167.233.100.123`, checkout
at `/opt/freeskool`, `C="docker compose --env-file infra/production/.env -f infra/production/compose.yml"`):

**Pre-flight, before step 1:** this branch's migration 0008 adds a UNIQUE index on
`fs_custodial_account.email` (`fs_custodial_account_email_idx`). `runMigrations()` runs at AppView
boot, not in a separate script, so a duplicate email already in production makes the index creation
fail and takes the AppView down rather than merely failing a migration script. Check for duplicates
before running step 1:
```sh
$C exec postgres psql -U freeschool -d freeschool -c \
   "select lower(email), count(*) from fs_custodial_account group by 1 having count(*) > 1;"
```
If this returns any rows, resolve them before proceeding — merge or re-point the duplicate accounts
(e.g. via `take-ownership`/steward intervention) so every email is unique, then re-run the check. Do
not start step 1 while it returns rows: the AppView will not boot until the duplicates are resolved.

1. **Merge `refinement` to `main`**, then `/opt/freeskool/infra/production/release.sh` as usual (see
   "Releasing a change" above) — this pulls, backs up, rebuilds and recreates `appview` + `web`.
2. **Add `AUTHORITY_DID`, `AUTHORITY_HANDLE`, `AUTHORITY_PASSWORD` to `infra/production/.env` and
   recreate the appview container.** Production holds these today in
   `/opt/freeskool/infra/production/.authority.env`, a file the appview container never reads — only
   `.env` (passed as `env_file`) does. Copy the three values across, then
   `$C up -d --no-deps --force-recreate appview` to pick them up. Skipping this step leaves
   `POST /api/skills` (propose-a-skill) answering `503 AuthorityUnavailable` and the skill tree unscoped
   to the authority.
3. **Reseed the taxonomy against production** (745 records, up from the 525 seeded 2026-09-13):
   ```sh
   $C run --rm -e AUTHORITY_HANDLE=skills.freeskool.xyz -e AUTHORITY_PASSWORD=… \
      -e PDS_URL=https://pds.freeskool.xyz appview pnpm --filter @freeschool/lexicons seed:skills
   ```
4. **`reindex-skills`** — `$C run --rm -e AUTHORITY_DID=did:plc:… appview pnpm --filter @freeschool/appview reindex-skills`.
   Contrail backfills a repo once and then only follows its live stream from "head"; the reseed in step 3
   wrote records the running indexer will otherwise never see. Without this, the skill tree and
   propose-a-skill both look empty or stale even though the records exist on the PDS.
5. **`backfill-skill-claims`, once** — `$C run --rm appview pnpm --filter @freeschool/appview backfill-skill-claims`.
   Fills `fs_skill_claim_index` for every member who saved a school-visibility skill claim before the
   index existed. Idempotent, but there is no reason to run it more than once per deployment.
6. **`migrate-event-notes`, dry run then real** — the one-off repair that moves attendee notes and meeting
   links off the public event record (task 19c):
   ```sh
   $C run --rm appview pnpm --filter @freeschool/appview migrate-event-notes -- --dry-run
   $C run --rm appview pnpm --filter @freeschool/appview migrate-event-notes
   ```
   Read the dry-run counts before running for real; the script is idempotent (a second run finds nothing
   to do) and prints counts only, never a DID, a handle, or the text of anybody's notes.
7. **Verify:**
   - `curl -s https://freeskool.xyz/api/health` → `{"status":"ok",...,"school":true}`.
   - `curl -s https://freeskool.xyz/api/calendar.ics` returns a `text/calendar` feed.
   - A skill page loads (`https://freeskool.xyz/skills/<any-seeded-slug>`) and shows people who claim it.
   - `/people` loads as a signed-in member (it is members-only; a signed-out or unauthenticated request
     should 401/redirect, not show the directory).
   - `pnpm --filter @freeschool/appview privacy-audit` against `PDS_URL=https://pds.freeskool.xyz` ends in
     `PRIVACY AUDIT OK` — zero violations.

**The test-database change (`freeschool_test`, pinned by Vitest) does not apply here.** That isolation
exists only for `pnpm -r test`; production always runs against `DATABASE_URL` in `infra/production/.env`,
unchanged by this branch.

**`boulder.freeskool.xyz` is the school's own handle**, not yet a distinct subdomain the web app serves —
today it resolves through the PDS's wildcard handle domain like any member's handle. The multi-school
design doc (`docs/superpowers/specs/2026-09-13-multi-school-design.md` §3) flags the exact collision this
causes: a `<city>.freeskool.xyz`-per-school URL scheme, which that doc proposes, would collide head-on
with the member-handle namespace `PDS_HANDLE_DOMAIN=freeskool.xyz` already owns. Nothing to do for this
release — it is a known, written-down constraint for whenever multi-school ships, not a bug in what
shipped here. **Resolved on branch `federation`** by the wildcard inversion — see "Caddy: handle
hosts, school hosts, and the on-demand gate" above.

## Moving the stack

Everything that moves: the two volumes (`postgres`, `pds`) and `infra/production/.env`. Stop the
stack, `backup.sh`, copy the dump, the PDS tarball and `.env` to the new host, `up -d postgres`,
restore the dump, untar into the `pds` volume, `up -d`, then flip the four A records. The PDS's
rotation key is in `.env`; losing it means losing the ability to recover the school's DID.

## Acceptance checks after a deploy

1. `/api/health` is `ok` with `school: true`.
2. Sign up with a real address on `https://freeskool.xyz`; the magic link arrives from Resend and the
   session survives a reload.
3. Post a class, RSVP from a second account, confirm the address is hidden from a signed-out viewer.
4. `https://<handle>.freeskool.xyz/.well-known/atproto-did` returns the DID for a minted handle.
5. `pnpm --filter @freeschool/appview privacy-audit` against `PDS_URL=https://pds.freeskool.xyz` ends
   in `PRIVACY AUDIT OK`.


## Live frontend acceptance, September 13, 2026

The polish and original Hetzner deployment were merged into `main` and released through the
backup script. Live testing discovered and fixed an index query limit: Contrail clamps queries
to 200 records, which hid taxonomy branches and could truncate busy calendars. Collection reads
now follow cursors. Production has 525 indexed skills: 219 canonical skills appear in the public
library and 306 proposed skills remain excluded by the existing publication policy.

The empty Requests board now offers a direct sign-in action. The operational resend helper now
passes TypeScript checks and reports failures without printing transport error details. No
resend was performed during acceptance testing.

Repeat the public live suite (read-only; no API interception, no emails or published records):

```sh
pnpm --filter @freeschool/web exec playwright install chromium webkit
E2E_BASE_URL=https://freeskool.xyz pnpm --filter @freeschool/web exec playwright test --config playwright.live.config.ts
```

This covers direct loading and navigation for the calendar, skills, knowledge, requests,
agreements, sign-in and OAuth explanation; month/week/day/list navigation and reloads; the
complete canonical taxonomy and skill ancestry; personal, author and steward access gates;
missing records and incomplete verification links; live Letter/A4 zine rendering; and installed
service-worker calendar caching through offline navigation in Chromium. It checks viewport overflow,
uncaught JavaScript errors, failed server responses and CSP/module-loading failures. Chromium
runs at desktop, phone and tablet sizes; WebKit runs with an iPhone viewport. Chromium also
produces PDFs and verifies page counts. Browser emulation is not a physical-device push test.

Separate rendering checks run against the deployed JavaScript with synthetic browser-only data:

```sh
E2E_BASE_URL=https://freeskool.xyz pnpm --filter @freeschool/web exec playwright test design.spec.ts knowledge.spec.ts presentation.spec.ts
```

Those checks cover 80-class zine pagination, author note editing/removal, linked skills/licenses,
public profile navigation, portrait/landscape/square/240-pixel artwork, broken/missing-image
fallbacks, full-image zoom and public class decision details. Fixtures are not published to the
production school and do not demonstrate authenticated production writes.

Production had no listed classes at verification time. Completing the authenticated live
signup/email → class creation → private RSVP → attendance/feedback journey requires a dedicated
production test account. No member account was impersonated, no test account was minted and no
email was sent during this pass. Local full-stack coverage remains separate evidence.

A historical untracked resend helper from deployment is preserved outside the checkout at
`/opt/freeskool-operator-notes/resend-verify.ts`. Use the committed helper under
`apps/appview/scripts/` for future maintenance. Backups are owner-readable only; do not commit or
copy their contents into test artifacts.

### Verified results and remaining acceptance

- 389 backend tests and 205 frontend tests passed; workspace TypeScript checks and production
  web build passed. Test database isolation was maintained.
- 27 live public browser scenarios passed (21 Chromium across three viewport sizes; six iPhone
  WebKit online scenarios). One WebKit offline-navigation check is explicitly marked incomplete.
  A minimal standalone service worker, unrelated to this application, reproduces the same
  `WebKit encountered an internal error` under Playwright 1.63 / WebKit 2359. This isolates a
  test-runtime limitation but does **not** prove physical iPhone offline behavior. Run with
  `E2E_FORCE_WEBKIT_OFFLINE=1` to attempt that case again after a browser update.
- Seven additional rendering scenarios passed against the deployed frontend with synthetic data.
- HTTPS health, `www` redirect, school-handle DID resolution and OAuth client metadata passed.
- Signed-in production writes, actual email delivery, external OAuth completion and physical
  mobile push remain unverified in this pass. A dedicated production test account was requested.
