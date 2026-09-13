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
| Checkout | `/opt/freeskool` (branch `deploy/hetzner`), env at `/opt/freeskool/infra/production/.env` |
| Web + API | `https://freeskool.xyz` (`www.` redirects) |
| PDS | `https://pds.freeskool.xyz`; handles `<name>.freeskool.xyz` |
| Email | Resend over SMTP (`smtps://resend:<key>@smtp.resend.com:2465`) |
| Registrar / DNS | Namecheap, `freeskool.xyz` |

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
an MX plus SPF TXT on the `send` subdomain, and optionally `_dmarc`). Until `freeskool.xyz` is a
verified Resend domain, mail goes out from the already-verified `omniharmonic.com`.

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
cd /opt/freeskool && git checkout deploy/hetzner
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
cd /opt/freeskool && git pull --ff-only
/opt/freeskool/infra/production/backup.sh
$C build && $C up -d          # Postgres and the PDS are untouched; appview + web restart
curl -s https://freeskool.xyz/api/health
```

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
