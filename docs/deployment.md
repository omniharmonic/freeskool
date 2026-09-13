# Deploy Free School

This application needs a persistent Node service, Postgres and a production AT Protocol PDS. The frontend alone is not a working deployment. The supplied Compose stack runs the frontend, HTTPS proxy, API, indexing, background jobs and database; it connects to a separately provisioned PDS.

## Required deployment inputs

- A Linux server with Docker Compose and a public web hostname pointed to it. Ports 80/443 must be available to the supplied Caddy proxy. If the server already runs Caddy, merge the route configuration into that proxy rather than bind the ports twice.
- A production PDS on a neutral hostname, with working DNS and TLS, including generated-handle resolution. Follow the [official PDS deployment guide](https://github.com/bluesky-social/pds). Do not deploy the development PDS configuration: its dev mode and localhost endpoint are intentionally local-only. Never copy local `.test` identities into production.
- An SMTP transport and verified sender domain. Magic-link signup requires email. A production boot without SMTP fails deliberately.
- Fresh session, custody, feedback and stable OAuth keys; the school account's credentials; and named maintainers for backups and the school's rotation keys.

## Build and configure

From the repository root:

```sh
cp infra/production/.env.example infra/production/.env
chmod 600 infra/production/.env
# Fill the production values. Use URL-safe hex for POSTGRES_PASSWORD.
docker compose --env-file infra/production/.env -f infra/production/compose.yml config --quiet
docker compose --env-file infra/production/.env -f infra/production/compose.yml build
```

The API runs as the unprivileged `node` user. Only Caddy exposes public ports; Postgres and the API remain on the internal Compose network. API and frontend share an origin so session cookies and OAuth callbacks round-trip correctly. The Docker context excludes environment files, local data and mail logs. Fonts are self-hosted. Photos and avatars are stored in Postgres with other app-side data, resized and stripped of metadata; no extra storage account is required for this MVP.

Set `SCHOOL_HANDLE`, `SCHOOL_NAME`, `SCHOOL_REGION` and `SCHOOL_EMAIL` for the actual city before bootstrap (the development defaults are Boulder). Create a fresh production school once, using `create-school` with the production environment (see the root README). It creates permanent public identity records: do not use it as a health check. Save `SCHOOL_DID`, `SCHOOL_HANDLE` and `SCHOOL_APP_PASSWORD` in the production environment. The primary PDS hostname and its identity DNS must already work. Bootstrap can run via:

```sh
docker compose --env-file infra/production/.env -f infra/production/compose.yml up -d postgres
docker compose --env-file infra/production/.env -f infra/production/compose.yml run --rm appview pnpm --filter @freeschool/appview create-school
# Save the printed school configuration privately in infra/production/.env.
docker compose --env-file infra/production/.env -f infra/production/compose.yml up -d
```

AppView runs migrations at startup. It seeds skill visibility classifications, but the public taxonomy still needs to be published under a production authority account and indexed; use the seed command documented in the root README. Appoint the first steward with `STEWARD_DID` and the `appoint-steward` command; use the in-app handoff flow to add the second key holder/steward. Keep `FREESCHOOL_NO_JOBS` unset in production so reminders, retention, recurrence, newsletters and peer repair run.

## Acceptance after launch

1. `/api/health` reports Postgres and PDS healthy, with the school configured.
2. Sign up with a real address; receive and consume the email link on the public origin. Confirm the session survives reload.
3. Post a class with a photo and neighborhood. Visit signed out: image/title/coarse neighborhood visible, private address absent. RSVP privately from another account; verify address access and roster restrictions.
4. Set and remove a profile image. Keep the profile private and verify another account cannot retrieve it. Explicitly opt into a public profile, verify its public skill/resource links, then revoke and verify profile/avatar access ends.
5. Complete attendance and feedback on a test class, and verify the summary suppression/release thresholds.
6. Publish, edit and remove a knowledge note linked to a skill/class. Verify the school moderation approval threshold and restore path. Print busy Letter and A4 calendars across multiple pages. Install the PWA and confirm public calendar access offline. Enable push with real VAPID keys if offered; verify email reminder delivery.
7. Test the secondary OAuth door on HTTPS and the COhere listing exchange with its operator. The local test stack cannot prove either external integration.

## Backup and rollback

Back up the production Postgres database, PDS data/blob volumes, PDS signing/rotation keys, and environment secrets together. Encrypt copies before sending them off-server. Do not log mail links, email addresses or credential values. Set backup retention consistently with the project's privacy retention policy; restoring a database also restores the data present at that time.

Before each release, take a database backup and record the current image IDs. Deploy the new images, check health, then walk signup and a class RSVP. If those fail, return to the recorded images. A schema-changing release requires a compatible database restore strategy as well; never automatically delete volumes. Perform a restore drill on a separate private machine before inviting the school.

## Current release status

The production configuration is prepared for a specific server and domain to be supplied. Building containers or passing local tests is not evidence of production email, OAuth, federation, backups or mobile push working. Record their actual verification results here after deployment.


### Local release verification, September 13, 2026

The web build, workspace typechecks, 384 backend tests (one skipped), 205 frontend tests, and live MVP journey pass. A temporary production frontend preview also passed five calendar/print/contribution-management browser checks. Compose configuration validation passed with placeholder values and `--no-env-resolution`; actual production secrets remain unconfigured.

The production Docker build was attempted, but Docker Hub timed out while resolving `node:22-bookworm-slim` and `caddy:2-alpine`. Neither base image is cached locally. Retry the image build once registry connectivity is available; the production image has not been verified or deployed. Supply the production domain/server, PDS, SMTP and operator-owned secrets before launch acceptance.
