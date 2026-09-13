# Deploying Free School

One small VPS runs the whole stack under Docker Compose: Caddy (TLS, the built PWA, reverse proxy),
the AppView (indexer + API + jobs), Postgres, and the school's own reference PDS. Files:

- `Dockerfile` — `appview` and `web` targets from one pnpm workspace layer
- `infra/production/compose.yml` — the four services; only Caddy publishes ports
- `infra/production/Caddyfile` — three site blocks: web+API, `www` redirect, PDS + handles
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

**Still open (R9):** the PDS hostname is `pds.freeskool.xyz`, which is not neutral — the hostname
itself says what the school is. Changing it later means a new `PDS_HOSTNAME`, DNS, and a PLC
operation per existing account to re-point the service endpoint, so decide before inviting members.

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
