---
title: "Runbook: the relay switch (PDS_CRAWLERS)"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-14
status: draft
---

# Runbook: the relay switch (`PDS_CRAWLERS`)

Companion: `docs/interop-audit.md` gap 1 (decided) and §8 ("Relay switch"). The PDS hostname
migration runbook is separate and owned by Task 7 — `docs/runbooks/pds-hostname-migration.md`
— and **must be done first**; see "Ordering" below. This runbook covers only the relay
switch itself: what it does, when to do it, how to do it, how to check it worked, and how
(and how not) to undo it.

## What `PDS_CRAWLERS` does

`PDS_CRAWLERS` is a comma-separated list of relay base URLs, read by the `pds` container
only (`infra/production/compose.yml`, `PDS_CRAWLERS: ${PDS_CRAWLERS:-}`). On startup, and
again after every account creation, the reference PDS calls
`com.atproto.sync.requestCrawl` on each host in the list, passing its own hostname. That
XRPC call is the entire mechanism: it is an announcement, "come crawl me", not a push of
data. A relay that accepts the request then calls back into our PDS's own
`com.atproto.sync.subscribeRepos` firehose and starts indexing every public repo we host —
which is everything already in the tier matrix as "eligible, not announced" in
`docs/interop-audit.md` §2. Nothing about which records are public changes; what changes is
whether anyone besides a peer who already knows our PDS host can find them.

Empty (today's production value) means no relay is ever asked, so nothing we publish
reaches Jetstream or a relay-backed AppView (Bluesky's own, and — per the federation-phase
design — COhere's) without that AppView adding our PDS as an explicit peer out of band.

## Permanence: this is a one-way door

Setting `PDS_CRAWLERS=https://bsky.network` and restarting the `pds` container is easy to
do and **impossible to fully undo**. Two separate things make it permanent:

1. **The relay keeps what it already crawled.** Once `bsky.network` (or any relay) has
   pulled our repos over `subscribeRepos`, it has copies of every record in them as of that
   moment. Jetstream consumers, and anyone who archived the firehose, have copies too.
   Unsetting `PDS_CRAWLERS` stops **future** crawling; it does not reach into a relay's
   database, Jetstream's replay buffer, or anyone's local archive and delete what is
   already there.
2. **A relay can re-broadcast forever.** Once a repo is in a relay's index, that relay can
   serve it to new subscribers, replay it to a Jetstream client asking for history, or
   answer `com.atproto.sync.getRepo`/`getLatestCommit` about it indefinitely — none of that
   depends on our `PDS_CRAWLERS` setting any more. The switch controls whether NEW records
   get announced for crawling; it does not control whether already-crawled records stay
   available.

This is why the hostname has to be right **before** the switch flips, not after — see
"Ordering".

## Ordering: neutral hostname first, always

`docs/superpowers/specs/2026-09-14-federation-phase-design.md` §2 rules explicitly:
production sets `PDS_CRAWLERS=https://bsky.network` **at the end of** the federation phase,
**after** the neutral hostname (`pds.freeskool.directory`, per Task 7's
`docs/runbooks/pds-hostname-migration.md`) is live. The reason is permanence, applied to the
thing R9's neutral-hostname rule protects: the relay's crawl history, and everything
downstream of it (Jetstream history, any archive, any AppView that indexed from the relay),
will forever associate whatever hostname is live **the first time a relay crawls us** with
every DID on this PDS. If the relay switch goes first, `pds.freeskool.xyz` — which already
says "free skool" in the school's own name, the thing R9 asked to keep out of a DID
document — is the hostname that gets permanently crawled and rebroadcast, and the later
hostname migration cannot retract that first impression from the network. Flip the
hostname, confirm it (Task 7's runbook + its own verification), and only then do the steps
below.

Do not run both changes in the same maintenance window without verifying the hostname
migration succeeded in between. If in doubt, check: `curl -s
https://plc.directory/$SCHOOL_DID | jq .service` should show the neutral endpoint before
you touch `PDS_CRAWLERS`.

## The exact env change and container restart

On the production server (`ssh -i ~/.ssh/frontrange-twin root@167.233.100.123`, checkout at
`/opt/freeskool`, per `docs/deployment.md`):

1. Edit `/opt/freeskool/infra/production/.env`:

   ```diff
   -PDS_CRAWLERS=
   +PDS_CRAWLERS=https://bsky.network
   ```

2. Recreate only the `pds` service — it is the only container that reads this variable
   (`appview` and `web` do not):

   ```bash
   cd /opt/freeskool
   C="docker compose --env-file infra/production/.env -f infra/production/compose.yml"
   $C up -d pds
   ```

   No `--build` is needed: the image is unchanged, only its environment. `docker compose`
   recreates the container with the new env and the existing `pds` volume untouched.

3. Confirm the container actually picked up the new value before moving on:

   ```bash
   $C exec pds printenv PDS_CRAWLERS
   ```

## What to watch

- **The PDS's own log**, for the crawl request it sends on startup (and again on the next
  account creation — useful for confirming the setting is live without waiting for a
  restart to be the only signal):

  ```bash
  $C logs --since 5m pds | grep -i crawl
  ```

  `LOG_ENABLED=true` is already set in `infra/production/compose.yml`. The exact log line
  text is version-dependent (this deployment runs `ghcr.io/bluesky-social/pds:0.4`); look
  for a line naming the crawler host (`bsky.network`) around the container's startup
  timestamp, or immediately after the next account creation if you do not want to wait for
  a restart.

- **Jetstream**, for the other end of the same request — this is what
  `apps/appview/scripts/verify-relay.ts` automates (next section).

- **The relay's own existence check**, independent of both logs and Jetstream:

  ```bash
  curl -s "https://bsky.network/xrpc/com.atproto.sync.getLatestCommit?did=$SCHOOL_DID"
  ```

  A `200` with a `rev` means the relay already has a copy of the repo. A `404`/`RepoNotFound`
  means it has not crawled it yet — expected for a few minutes after the switch, or if the
  crawl request itself failed (check the PDS log above).

## Verification with `verify-relay.ts`

```bash
pnpm --filter @freeschool/appview verify-relay -- --seconds=120 --expect
```

This (`apps/appview/scripts/verify-relay.ts`):

1. Calls `com.atproto.sync.getLatestCommit` against `https://bsky.network` (override with
   `--relay=`) for `SCHOOL_DID` and `AUTHORITY_DID` (override with `--school-did=` /
   `--authority-did=`) and reports whether the relay already knows each repo.
2. Opens a Jetstream connection (default
   `wss://jetstream2.us-east.bsky.network/subscribe`, override with `--jetstream=`) filtered
   to those two DIDs via `wantedDids`, listens for `--seconds` (default 60), and prints
   event counts by collection plus the latest cursor (`time_us`) seen.
3. Exits non-zero if `--expect` was given and nothing arrived in the window — use this
   exit code in the deploy script or a one-off check; omit `--expect` to just look without
   failing a job.

If nothing arrives within a couple of minutes of the switch, add `--request-crawl` to send
a manual `com.atproto.sync.requestCrawl` directly (useful if the PDS's own startup
announcement was missed, raced the relay being briefly unavailable, or you want to kick it
again without restarting the container):

```bash
pnpm --filter @freeschool/appview verify-relay -- --request-crawl --seconds=120 --expect
```

All identifiers this script prints (DIDs, in particular) are truncated to 12 characters,
per R9 — it is a diagnostic tool, not a place identifiers belong in full.

## How to stop crawling — and what that does not undo

```diff
-PDS_CRAWLERS=https://bsky.network
+PDS_CRAWLERS=
```

then `$C up -d pds` again. This stops the PDS from sending any further
`com.atproto.sync.requestCrawl` announcements. It does **not**:

- remove anything the relay has already crawled — see "Permanence" above;
- retract any record from Jetstream history, any archive, or any AppView that already
  indexed from the relay;
- prevent the relay from continuing to serve what it has, or from re-crawling us on its own
  initiative if it independently discovers our PDS (e.g. through a peer AppView).

There is no `com.atproto.sync.*` call, admin endpoint, or PLC operation that un-publishes a
record that has already reached a relay. The only lever this runbook's switch controls is
whether *new* activity keeps getting announced. Decide the hostname and the switch together,
once, in the right order — not as something to try and revert.
