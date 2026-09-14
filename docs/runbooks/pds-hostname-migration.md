---
title: "Runbook: moving the PDS to a neutral hostname"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-14
status: draft
---

# Runbook: moving the PDS to a neutral hostname

`pds.freeskool.xyz` → **`pds.freeskool.directory`**, and every handle from
`<name>.freeskool.xyz` to `<name>.freeskool.directory`.

Authority: `docs/superpowers/specs/2026-09-14-federation-phase-design.md` §2 ruling 3 —
Benjamin registered `freeskool.directory` on 2026-09-14 — and
`docs/superpowers/specs/2026-09-13-multi-school-design.md` §3. The reason is R9: a DID
document is world-readable, permanent, and names the PDS that hosts the repo. A hostname
that says "free school" tells anyone who ever reads that document which community the
person belongs to. The neutral name is how that stops being true.

Three things move and one deliberately does not:

| | before | after |
|---|---|---|
| PDS hostname | `pds.freeskool.xyz` | `pds.freeskool.directory` |
| member handles | `calmalder301.freeskool.xyz` | `calmalder301.freeskool.directory` |
| school account handle | `boulder.freeskool.xyz` | `boulder.freeskool.directory` |
| taxonomy authority handle | `skills.freeskool.xyz` | `skills.freeskool.directory` |
| **the app** | `freeskool.xyz`, `boulder.freeskool.xyz` | **unchanged** |

Moving the school account's handle off `boulder.freeskool.xyz` is what *frees* that name to
be the Boulder city app host (ruling 2). `WEB_HOST` and `SCHOOL_DOMAIN_SUFFIX` stay
`freeskool.xyz` and must not be touched by this migration.

**Do this BEFORE the relay switch** (`docs/runbooks/relay-switch.md`). `PDS_CRAWLERS` is
set at the end of the federation phase precisely so the first records the network ever sees
carry the neutral endpoint.

---

## 1. The mechanism, and why it is this one

Changing `PDS_HOSTNAME` changes what the container *serves*. It changes **nothing** about
the DID documents already published to plc.directory. Every existing account keeps telling
the network its repo lives at the old endpoint until somebody signs a new PLC operation for
it. The reference PDS has no "republish everyone" command; it is not a migration tool.

Four candidate paths, checked against `@atproto/pds` 0.5.34 (the image the dev stack runs):

| path | auth | moves the endpoint? | verdict |
|---|---|---|---|
| `com.atproto.identity.updateHandle` | session | **no** | `accountManager.updateHandle` → `plcClient.updateHandle` → `updateHandleOp`, which is `createUpdateOp(lastOp, …, n => ({ ...n, alsoKnownAs }))`. `n` is the normalized *last op*, so `services` is copied forward verbatim. Handle only. |
| `requestPlcOperationSignature` + `signPlcOperation` | session **+ an email token** | yes | `signPlcOperation` throws `email confirmation token required` unless it can consume a `plc_operation` token, which the PDS mails to the account's own address. For a custodial member that is the member's inbox. Unusable for an operator-run migration. |
| `com.atproto.identity.submitPlcOperation` | session | yes | Takes an already-signed op, no email token — but needs a session per account and requires the PDS to *already* be on the new hostname (`op.services.atproto_pds.endpoint === ctx.cfg.service.publicUrl`). Kept as the documented fallback (§8). |
| **what we do** | **admin token + our own rotation key** | **yes** | below |

We hold `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` — the key the PDS signs its own PLC
operations with, and the only entry in `rotationKeys` for every account it created. So:

1. **The endpoint.** Build the update operation ourselves — normalize the last audit-log
   entry, change `services.atproto_pds.endpoint`, set `prev` to that entry's CID, sign the
   dag-cbor with secp256k1 (low-S, 64 raw bytes, base64url) — and `POST` it straight to
   `https://plc.directory/<did>`. No session, no password, no email.
2. **The handle.** `com.atproto.admin.updateAccountHandle`, authorized by the Basic
   `admin:<PDS_ADMIN_PASSWORD>` token the AppView already holds. On a PDS with no entryway
   it calls `accountManager.updateHandle(did, handle, { allowAnyValid: true })`, which signs
   the handle PLC op with the same rotation key, writes the PDS's own account row, and
   sequences an `#identity` event onto the firehose.

**Endpoint first, handle second**, per account: step 2 is the one that emits the identity
event, so the event a relay sees follows the final document rather than a half-migrated one.

Two consequences worth knowing before you start:

- The new handle domain **must** be in `PDS_SERVICE_HANDLE_DOMAINS` before step 2, or
  `normalizeAndValidateHandle` falls through to external DNS resolution and rejects it.
- An account whose `rotationKeys` no longer contain ours — a member who took ownership and
  rotated — **cannot** be moved by us, by design. The script reports them as
  `foreign-rotation-key` and never forces it. They keep working on the old endpoint for as
  long as it is served; reaching them is a conversation, not an operation.
- The script therefore **refuses to run at all** — dry run included — without
  `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX`. Without the key it cannot tell "this account
  rotated away from us" from "we do not have the key", and a plan that cannot tell those
  apart would quietly report the entire deployment as unmovable.

`com.atproto.admin.searchAccounts` rejects the Basic admin token (it wants moderator service
auth), so the account list comes from `com.atproto.sync.listRepos` (public) plus
`com.atproto.admin.getAccountInfos` (Basic admin) — the same pair `src/lib/pds.ts` uses.

### Proven, not assumed

Rehearsed against the dev PDS and the **real** plc.directory on 2026-09-14
(`.test` → `.test2` → back). See §9 for the transcript.

---

## 2. Before you touch anything

- [ ] A fresh backup: `infra/production/backup.sh` (Postgres **and** the `pds` volume — the
      PDS's SQLite account store holds the handles this migration rewrites).
- [ ] `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` and `PDS_ADMIN_PASSWORD` are in
      `/opt/freeskool/infra/production/.env` and readable. Without the first, nothing here
      works and nothing here is recoverable.
- [ ] A maintenance window. The flip and the migration are **one window**: see the TLS
      caveat in step 4.
- [ ] `docs/deployment.md` open beside this, for the release procedure.
- [ ] A place for the PLC snapshot. `--snapshot=<dir>` writes every planned account's full
      audit log, as plc.directory has it *before* the run, into a timestamped subdirectory —
      the exact `prev` chain you would need to reconstruct a rollback by hand. It contains
      DIDs and handles, so it belongs on the server beside the backups and not in a repo.

---

## 3. DNS — done

`freeskool.directory` is registered and both records already point at the server:

| Type | Host | Value | TTL |
|---|---|---|---|
| A | `pds` | `167.233.100.123` | 300 |
| AAAA | `pds` | `2a01:4f8:c010:8a1a::1` | 300 |
| A | `*` | `167.233.100.123` | 300 |
| AAAA | `*` | `2a01:4f8:c010:8a1a::1` | 300 |

Confirm before the window, because everything after this assumes it:

```bash
dig +short pds.freeskool.directory
dig +short anything.freeskool.directory
```

`freeskool.xyz`'s own records stay exactly as they are: the app lives there.

---

## 4. Caddy and the env: serve BOTH domains

Edit `/opt/freeskool/infra/production/.env`:

```diff
-PDS_HOST=pds.freeskool.xyz
-PDS_HANDLE_DOMAIN=freeskool.xyz
+PDS_HOST=pds.freeskool.directory
+PDS_HANDLE_DOMAIN=freeskool.directory
+
+# The overlap. Empty again at step 7.
+PDS_LEGACY_HOST=pds.freeskool.xyz
+PDS_LEGACY_HANDLE_DOMAIN=freeskool.xyz
```

`WEB_HOST`, `SCHOOL_DOMAIN_SUFFIX` and `SCHOOL_LABELS` do **not** change.

What those variables do:

- `infra/production/compose.yml` composes `PDS_SERVICE_HANDLE_DOMAINS` as
  `.freeskool.directory,.freeskool.xyz` — the PDS accepts and validates handles on both, so
  an account that has not moved yet is still a handle it recognizes as its own.
- `infra/production/Caddyfile` serves **all three** wildcards from ONE site block:

  ```
  *.{$PDS_HANDLE_DOMAIN}, *.{$SCHOOL_DOMAIN_SUFFIX}, *.{$PDS_LEGACY_HANDLE_DOMAIN:legacy.invalid}
  ```

  One block, not three, and that is the whole collision guarantee. Caddy **refuses a
  duplicate site address across two blocks** ("ambiguous site definition: *.freeskool.xyz")
  but **silently deduplicates identical addresses inside one block**. Before the migration
  `PDS_HANDLE_DOMAIN` and `SCHOOL_DOMAIN_SUFFIX` are the same name; during it
  `PDS_LEGACY_HANDLE_DOMAIN` is the same name as `SCHOOL_DOMAIN_SUFFIX`; after it they are
  all distinct. Every one of those arrangements adapts cleanly, so there is nothing for the
  operator to keep straight and no combination that can break the config.
- `*.{$SCHOOL_DOMAIN_SUFFIX}` is **permanent**, and it is why step 7 does not take
  `boulder.freeskool.xyz` and `www.freeskool.xyz` down with the overlap. `compose.yml`
  passes `SCHOOL_DOMAIN_SUFFIX` to the `web` container for exactly this.
- `{$PDS_LEGACY_HOST}` serves the whole old PDS hostname, because a client reading a
  not-yet-migrated DID document dials it for `/xrpc/*` *and* for OAuth. Unset, it and
  `PDS_LEGACY_HANDLE_DOMAIN` fall back to `.invalid` sentinel names that resolve nowhere.

Validate the adapted config before deploying — an unset variable becomes an empty site
address and the adapter's answer is meaningless (`docs/deployment.md`, "Validating the
Caddyfile"):

```bash
docker run --rm -v /opt/freeskool/infra/production/Caddyfile:/etc/caddy/Caddyfile:ro \
  -e WEB_HOST=freeskool.xyz \
  -e PDS_HOST=pds.freeskool.directory -e PDS_HANDLE_DOMAIN=freeskool.directory \
  -e SCHOOL_DOMAIN_SUFFIX=freeskool.xyz \
  -e PDS_LEGACY_HOST=pds.freeskool.xyz -e PDS_LEGACY_HANDLE_DOMAIN=freeskool.xyz \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# → Valid configuration
```

`validate` says the file parses. To see the names actually served, swap `validate` for
`adapt` and read the host matchers — this is the check that catches "the wildcard the app
lives on stopped being served", which a parse check cannot:

```bash
… caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
  | jq -r '[.apps.http.servers[].routes[].match[]?.host[]?] | unique | join(" ")'
# transition → *.freeskool.directory *.freeskool.xyz 127.0.0.1 freeskool.xyz
#              pds.freeskool.directory pds.freeskool.xyz
```

> ### ⚠ The one thing to plan around
>
> The on-demand TLS `ask` gate (`apps/appview/src/lib/tls-check.ts`) vouches for exactly
> **one** handle domain — whichever `PDS_HANDLE_DOMAIN` currently is. During the overlap,
> hosts on the *other* domain are served from certificates Caddy already holds; a name that
> has never been issued one cannot get one. Existing member handle hosts are fine (they have
> certificates, valid 90 days); a brand-new one on the old domain is not.
>
> That is why steps 4–6 are **one window**, not a week-long soak. It is also a known
> follow-up: teaching `allowCertificateFor` a second, legacy handle domain is a few lines,
> and belongs to whoever next owns `src/lib/tls-check.ts`.

---

## 5. Deploy and flip the PDS

```bash
cd /opt/freeskool
docker compose --env-file infra/production/.env -f infra/production/compose.yml up -d --build
```

This recreates `pds` with the new `PDS_HOSTNAME` and both service handle domains, and
reloads Caddy with the four site blocks.

Check the PDS answers on both names, and that it kept its data:

```bash
curl -s https://pds.freeskool.directory/xrpc/_health
curl -s https://pds.freeskool.xyz/xrpc/_health          # same container, old name
curl -s "https://pds.freeskool.xyz/xrpc/com.atproto.identity.resolveHandle?handle=boulder.freeskool.xyz"
```

The third one still answers: nothing has moved yet. That is the point of doing the flip
before the migration — step 6 needs the PDS to already be on the new hostname.

---

## 6. The migration script

`apps/appview/scripts/migrate-pds-hostname.ts`, run in the `appview` container (it needs
`DATABASE_URL`, `PDS_ADMIN_PASSWORD` and the rotation key). Output is **counts only** (R9):
no DID, handle or email ever reaches stdout.

```
--handle-domain=<domain>       REQUIRED. `freeskool.directory`
--service-endpoint=<url>       REQUIRED. `https://pds.freeskool.directory`
--accounts=custodial|all       custodial (default) = accounts we custody + every school
                               and the authority. `all` also includes members who took
                               ownership but still host here
--only=<did,did>               restrict to these DIDs (retries, staged runs)
--limit=N                      plan at most N accounts this run
--pds=<url>                    the PDS to talk to (default PDS_URL)
--pds-host=<host>              what --service-endpoint's host must equal (default PDS_HOST)
--plc=<url>                    default https://plc.directory
--snapshot=<dir>               write every planned account's PLC audit log here first
--skip-external-verify         do not fetch https://<handle>/.well-known/atproto-did
--allow-loopback-endpoint      dev only; BOTH the endpoint and the PDS must be loopback
--dry-run                      the default
--apply                        actually write
```

**`--service-endpoint` has no default, on purpose.** The obvious default would have been
`config().PDS_URL`, whose own default is `http://localhost:3000` — one unset variable
between an `--apply` and a permanent loopback endpoint in every DID document on the
deployment. So it is required, and it is checked before anything is signed: https, a real
hostname (not an IP literal, not loopback, not RFC1918, not a reserved TLD), no path or
query, and its host must equal the PDS we are talking to. A typo in any other flag is
refused outright rather than silently taking a default.

The script also **refuses to start without the rotation key**, dry run included — see §1.
### 6a. Dry run

```bash
C="docker compose --env-file infra/production/.env -f infra/production/compose.yml"
$C run --rm appview pnpm --filter @freeschool/appview migrate-pds-hostname -- \
  --handle-domain=freeskool.directory \
  --service-endpoint=https://pds.freeskool.directory
```

(`run --rm appview` gets `.env` as its `env_file`, so `DATABASE_URL`, `PDS_ADMIN_PASSWORD`
and `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX` are all already there. Both the `--accounts`
default and the dry-run default are the safe ones, so a mistyped command does nothing.)

Expect something like:

```
DRY RUN → freeskool.directory @ https://pds.freeskool.directory (accounts=custodial)
considered=41 planned=39
  by kind: school=1 authority=1 custodial=37
  skipped: already-migrated=0 not-selected=2
```

Read it before going further:

- `planned` should equal the members you expect plus one per school plus the authority.
- `foreign-rotation-key` above zero means somebody took ownership and rotated. Expected;
  those accounts are simply not ours to move.
- `not-selected` is members who took ownership (rotation key still ours) plus anything
  `--only` excluded. Run them afterwards with `--accounts=all` if you want them moved.
- **`COLLISIONS` above zero stops the migration.** Two accounts whose new handles would be
  the same name, or a member whose prefix is a reserved label (`boulder`, `denver`,
  `skills`, `www`, `admin`, …), are found here rather than halfway through the batch, where
  `admin.updateAccountHandle` would fail and leave the deployment half-moved. `--apply`
  refuses outright while any stand. Resolve them first: ask the member to choose another
  handle (`PUT /api/me/handle`), or rename the school's label.

Per-account problems go to **stderr**, one line each, with a truncated DID
(`did:plc:tgb5…`) and a reason — enough to find the account in your own notes, never a
whole identifier, and never a handle or an email. stdout stays counts only (R9).

### 6b. Apply

Start with one account to watch the whole path end to end, then the rest:

```bash
# one, by DID, taken from your own notes — the script never prints whole DIDs
$C run --rm -v /opt/freeskool/backups:/snap appview \
  pnpm --filter @freeschool/appview migrate-pds-hostname -- \
  --handle-domain=freeskool.directory \
  --service-endpoint=https://pds.freeskool.directory \
  --snapshot=/snap/plc --only=did:plc:… --apply

# the rest
$C run --rm -v /opt/freeskool/backups:/snap appview \
  pnpm --filter @freeschool/appview migrate-pds-hostname -- \
  --handle-domain=freeskool.directory \
  --service-endpoint=https://pds.freeskool.directory \
  --snapshot=/snap/plc --apply
```

```
APPLY → freeskool.directory @ https://pds.freeskool.directory (accounts=custodial)
considered=41 planned=39
  by kind: school=1 authority=1 custodial=37
  skipped: already-migrated=0 not-selected=2
  snapshot: /snap/plc/2026-09-14T18-02-11-904Z
endpoint-ops=39 handle-ops=39 db-repaired=0
verified=39 failed-verification=0 failed=0
```

The script is **idempotent, resumable and repairing**: every account is planned from its
current published state, so an endpoint that already matches skips step 1, a handle that
already matches skips step 2, and a second run after a crash, a rate limit or a `--limit`
batch does the remainder and nothing else. If a run reports failures, run the same command
again; it exits `2` when anything failed verification or collided, `0` when clean.

Per account it also rewrites `fs_custodial_account.handle` and the `handle:<did>` entry in
`fs_app_meta` (the best-effort cache `lib/bsky-profile.ts` writes and `routes/me.ts` reads as
its last resort), so the app does not serve stale handles. **`db-repaired`** counts the case
where a previous run died between the PLC write and the database write: the identity is
already right, only the app's own copy is stale, and a re-run fixes exactly that without
signing anything.

### 6c. Verify, independently of the script

The script verifies each account itself — four checks, all of which must pass or it counts
`failed-verification`: the PLC document names the new endpoint; it names the new handle; our
PDS resolves the new handle to that DID; `https://<new handle>/.well-known/atproto-did`
answers with that DID **over the public name**, which is the one check `resolveHandle`
cannot make (our own PDS will happily say yes while DNS, Caddy or the certificate says no);
and the OLD handle does not resolve to somebody *else*. `--skip-external-verify` drops only
the fourth, and exists for the dev rehearsal, where there is no public name to fetch.

Do it again by hand for a couple of accounts anyway:

```bash
curl -s https://plc.directory/did:plc:… | jq '{alsoKnownAs, service}'
curl -s "https://pds.freeskool.directory/xrpc/com.atproto.identity.resolveHandle?handle=boulder.freeskool.directory"
curl -s https://boulder.freeskool.directory/.well-known/atproto-did
```

Then the app itself, from `docs/deployment.md`'s acceptance checks: sign in, open the
calendar, publish one record and confirm it lands in the repo at the new endpoint.

Finally, `PEER_PDS_HOSTS` and `SCHOOL_HANDLE` / `AUTHORITY_HANDLE` in `.env` should now name
the new domain (`https://pds.freeskool.directory`, `boulder.freeskool.directory`,
`skills.freeskool.directory`). Update and recreate the `appview` container.

---

## 7. Close the overlap

Once every account reports `verified` and the app is healthy, empty the two overlap
variables and redeploy:

```diff
-PDS_LEGACY_HOST=pds.freeskool.xyz
-PDS_LEGACY_HANDLE_DOMAIN=freeskool.xyz
+PDS_LEGACY_HOST=
+PDS_LEGACY_HANDLE_DOMAIN=
```

`PDS_SERVICE_HANDLE_DOMAINS` collapses to `.freeskool.directory` and Caddy drops the legacy
PDS hostname. **`*.freeskool.xyz` keeps being served**, by the permanent
`*.{$SCHOOL_DOMAIN_SUFFIX}` address in the wildcard block, and goes back to being only the
app and the school hosts. Prove it before you walk away — this is the step that is easy to
get wrong, and getting it wrong takes `boulder.freeskool.xyz` and `www.freeskool.xyz` off
the internet:

```bash
docker run --rm -v /opt/freeskool/infra/production/Caddyfile:/etc/caddy/Caddyfile:ro \
  -e WEB_HOST=freeskool.xyz \
  -e PDS_HOST=pds.freeskool.directory -e PDS_HANDLE_DOMAIN=freeskool.directory \
  -e SCHOOL_DOMAIN_SUFFIX=freeskool.xyz \
  -e PDS_LEGACY_HOST=legacy-pds.invalid -e PDS_LEGACY_HANDLE_DOMAIN=legacy.invalid \
  caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile \
  | jq -r '[.apps.http.servers[].routes[].match[]?.host[]?] | unique | join(" ")'
# → *.freeskool.directory *.freeskool.xyz *.legacy.invalid 127.0.0.1 freeskool.xyz
#   legacy-pds.invalid pds.freeskool.directory
```

`*.freeskool.xyz` is in that list. The two `.invalid` names are the sentinels: valid site
addresses for names that resolve nowhere, which is how the file stays free of conditionals.

Then, from outside the server:

```bash
curl -sI https://boulder.freeskool.xyz | head -1
curl -sI https://www.freeskool.xyz | head -1      # 301 to the apex
```

Leave the overlap open for at least one full working day first if you can afford it: a
member with a stale cached DID document will dial the old endpoint until their client
re-resolves.

**Only now** do `docs/runbooks/relay-switch.md`.

---

## 8. Rollback

Nothing here is a one-way door, but the two halves roll back differently.

**Before step 6b (nothing has been signed).** Put the four hostname variables back to their
old values, clear the two overlap variables, redeploy. The stack is exactly as it was.

**After step 6b (PLC operations are published).** A PLC operation cannot be deleted, but it
can be superseded — which is all this script does. Re-run it pointed the other way:

```bash
$C run --rm appview pnpm --filter @freeschool/appview migrate-pds-hostname -- \
  --handle-domain=freeskool.xyz --service-endpoint=https://pds.freeskool.xyz \
  --accounts=all --apply
```

with `PDS_HANDLE_DOMAIN` / `PDS_HOST` back to the old values — the endpoint guard requires
`--service-endpoint`'s host to equal the PDS we are talking to, so a rollback that forgets
to move the PDS back is refused rather than half-applied. The target handle domain must be
in `PDS_SERVICE_HANDLE_DOMAINS`, which it is as long as the overlap variables are still set.
Every account gets two more operations and lands back where it started. The audit log at
`https://plc.directory/<did>/log/audit` shows the whole round trip, which is the honest
record and worth keeping — and `--snapshot`'s file for each account is the same log as it
stood before you began.

This is exactly the path the dev rehearsal took, so it is tested rather than theoretical.

**If the rotation key is lost**, none of this is possible and no account can be moved by us
again. That is the one irrecoverable failure, and it is why step 2's first checklist item is
the backup.

**Fallback if `admin.updateAccountHandle` is ever removed or gated**: build both operations
locally and submit through `com.atproto.identity.submitPlcOperation` with a session per
account (the custodial password via `lib/custody.ts#custodialPassword`, the school and
authority via their app passwords). Slower, needs the passwords, and the PDS must already be
on the new hostname — but no email token either.

---

## 9. The dev rehearsal, 2026-09-14

Run against the dev PDS (`http://localhost:3000`, handles `.test`) and the **real**
plc.directory. `.test2` was added to `apps/appview/compose.override.yml` and only the `pds`
container restarted:

```bash
docker compose -f infra/compose.yml -f apps/appview/compose.override.yml up -d pds
```

A throwaway account was minted through the ordinary signup path
(`--create-rehearsal-account`, which refuses any non-loopback PDS and, like everything else
here that writes, requires `--apply`), then moved and moved back. Dev needs two escapes the
production run must never use: `--allow-loopback-endpoint` (which only opens when BOTH the
endpoint and the PDS are loopback) and `--skip-external-verify` (there is no public
`https://<prefix>.test2` to fetch).

```bash
… migrate-pds-hostname --handle-domain=test2 \
    --service-endpoint=http://127.0.0.1:3000 --allow-loopback-endpoint \
    --skip-external-verify --accounts=all --only=did:plc:… --snapshot=/tmp/snap --apply
```

The audit log after the round trip:

```
bafyreiezqppzzv3…  plc_operation  ['at://t7rehearsal….test']   http://localhost:3000
bafyreibnde2syme…  plc_operation  ['at://t7rehearsal….test']   http://127.0.0.1:3000   ← ours, direct to plc.directory
bafyreiaamkv3nsf…  plc_operation  ['at://t7rehearsal….test2']  http://127.0.0.1:3000   ← the PDS's, via admin.updateAccountHandle
… (two more, back to .test / localhost:3000)
```

- `com.atproto.identity.resolveHandle` answered for `<prefix>.test2` and returned
  `HandleNotFound` for `<prefix>.test`, then the reverse after the rollback.
- A second `--apply` with the same arguments reported
  `planned=0 … skipped: already-migrated=1` and wrote nothing — idempotency, observed.
- `--snapshot` wrote the account's pre-run audit log to a timestamped directory.
- The guards were exercised against the live dev stack and each refused as intended: a
  missing `--service-endpoint`; a loopback endpoint without `--allow-loopback-endpoint`; a
  mistyped flag (`--handle-domian`); `--apply --dry-run` together.
- The rotation key derived locally from `infra/pds.env` produced exactly the `did:key` the
  dev accounts' DID documents already list. That equality is pinned by an **env-gated**
  test (`DEV_PDS_ROTATION_KEY_HEX` + `DEV_PDS_ROTATION_DID_KEY`) which skips when they are
  absent — no key material lives in a tracked file. The rest of the suite generates a fresh
  throwaway secp256k1 key per run.

Every other dev identity — including the school and the taxonomy authority — was left
untouched, via `--only`.
