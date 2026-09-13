# Copied from the R1 research lab (2026-09-12). Run from this directory with its own pnpm install; it is NOT part of the workspace.

# R1 Spaces-alpha lab

Runnable harness for the atproto **Spaces alpha** (permissioned data, formerly
proposal 0016), exercising `com.atproto.simplespace.*` and `com.atproto.space.*`
against the tagged `pds-spaces-alpha` image.

Author of record: **Benjamin Life (@omniharmonic)**. Run date: **2026-09-12**.

No BPS invite code was used. Everything runs locally.

## What's here

| path | what |
| --- | --- |
| `docker-compose.yml` | the spaces-alpha PDS (port 2583), fully parameterised |
| `plc-server.mjs` | standalone in-memory `did:plc` directory (port 2582) |
| `spaces-lab.mjs` | the end-to-end flow; every call is a plain XRPC request so the wire shape is visible |
| `lab-output.txt` | recorded output of the run |
| `bulletin/` | clone of `bluesky-social/bulletin` @ `0acf237` |
| `atproto/` | sparse clone of `bluesky-social/atproto` branch `permissioned-data` |

## Prerequisites

- Docker (Docker Desktop on macOS). **The ghcr image publishes only a
  `linux/amd64` manifest**, so on Apple Silicon you must pass
  `--platform linux/amd64` (the compose file already does). A bare
  `docker pull ghcr.io/bluesky-social/atproto:pds-spaces-alpha` fails with
  `no matching manifest for linux/arm64/v8`.
- Node >= 22 and pnpm.

## 1. Install

```sh
pnpm install
```

`package.json` pins every `@atproto` package to the exact alpha build
`0.0.0-spaces-alpha-20260910230440`. The `pnpm.overrides` block is **required**:
resolving `@atproto/space`'s own `^0.0.0-spaces-alpha-…` range otherwise picks the
placeholder `@atproto/lex-data@0.0.0` / `@atproto/lex-cbor@0.0.0`, whose published
manifests still contain `"@atproto/syntax": "workspace:*"` and abort the install
(`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`). npm fails the same way, less legibly.

## 2. Start the did:plc directory

Account creation needs a PLC directory. Rather than write to the production
`plc.directory`, run a local one — `@did-plc/server` supports an in-memory
database (`plc.Database.mock()`), exactly as `packages/dev-env/src/plc.ts` does.

```sh
node plc-server.mjs &          # http://0.0.0.0:2582
curl -s http://localhost:2582/_health    # {"version":"0.0.0"}
```

## 3. Start the PDS

```sh
docker compose up -d
docker compose logs -f pds
curl -s http://localhost:2583/xrpc/_health     # {"version":"0.5.32"}
```

Equivalent single command:

```sh
docker run -d --name r1-spaces-pds \
  --platform linux/amd64 \
  -p 2583:2583 \
  --add-host host.docker.internal:host-gateway \
  -v "$PWD/pds-data:/data" \
  -e PDS_DEV_MODE=1 \
  -e PDS_HOSTNAME=localhost \
  -e PDS_PORT=2583 \
  -e PDS_DATA_DIRECTORY=/data \
  -e PDS_BLOBSTORE_DISK_LOCATION=/data/blobs \
  -e PDS_DID_PLC_URL=http://host.docker.internal:2582 \
  -e PDS_SERVICE_HANDLE_DOMAINS=.test \
  -e PDS_INVITE_REQUIRED=0 \
  -e PDS_DISABLE_SSRF_PROTECTION=1 \
  -e PDS_REPO_SIGNING_KEY_K256_PRIVATE_KEY_HEX=3ee6892a2d10a23ca48ce8b1a2b4e7a96a0ba0f1cf43b7f2a1c0cdd1dd3ca111 \
  -e PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=e049f5a1f17b1a8e9b1ab1d2cc93dd1ca2a2f2e5c1b0a9f8e7d6c5b4a3928171 \
  -e PDS_DPOP_SECRET=6b6579626f6172646361746b6579626f6172646361746b6579626f6172646361 \
  -e PDS_JWT_SECRET=r1-lab-jwt-secret \
  -e PDS_ADMIN_PASSWORD=r1-lab-admin \
  -e LOG_ENABLED=1 -e LOG_LEVEL=info \
  ghcr.io/bluesky-social/atproto:pds-spaces-alpha
```

### The two env vars that are easy to miss

- **`PDS_DEV_MODE=1`** — without it the PDS refuses to boot over plain HTTP:
  `PDS failed to start: Error: Resource URL must use the https scheme`
  (`packages/pds/src/auth-routes.ts:24-28`, guarded by `!cfg.service.devMode`).
- **`PDS_DISABLE_SSRF_PROTECTION=1`** — the PLC directory is on a private IP.
  (`PDS_DEV_MODE` also defaults this on; set it explicitly anyway.)

`PDS_HOSTNAME=localhost` makes the PDS advertise `http://localhost:2583` in DID
documents (`packages/pds/src/config/config.ts:19-22`), which is what makes the
space-credential exchange work without TLS: the `htu` in the DPoP proof is checked
against the PDS's own `publicUrl`, so container-internal and host-side URLs must
agree. Publishing the container port as **2583:2583** (not 3000) is what keeps them
agreeing.

There is **no feature flag for spaces** — `grep -i space packages/pds/src/config/*.ts`
is empty. The `simplespace` and `space` route trees are unconditionally registered
in this build.

## 4. Run the lab

```sh
node spaces-lab.mjs | tee lab-output.txt
```

It is idempotent: accounts and spaces are created on first run and reused after
(`HandleNotAvailable` → `createSession`, `SpaceAlreadyExists` → reuse the URI).

Handles are `freeskool.test` (the school / space authority), `alice.test` (member),
`carol.test` (non-member). Note `school.test` is rejected as a
**`HandleNotAvailable: Reserved handle`**.

Probes print `[ALLOWED]` or `[REFUSED] … error="…"`; the outcome *is* the finding,
so nothing aborts the run.

## 5. Reset

```sh
docker compose down
rm -rf pds-data
kill %1              # the PLC server (in-memory: state dies with it)
```

## Auth shortcut used here, and why it is sound

The lab authenticates with ordinary **app-password / legacy access tokens**
(`com.atproto.server.createSession`), not the OAuth authorization-code flow. That is
not a hack around the scope system — it is the documented behaviour:

```ts
// packages/pds/src/api/com/atproto/space/util.ts:76-88
/**
 * Space credentials carry their own space, checked by {@link assertCredentialSpace}.
 * Legacy access tokens (including app passwords) predate granular permissions and
 * carry no space grants at all, so there is nothing to evaluate — they are bounded
 * instead by the handlers, which require the caller to be the repo they name.
 */
export function assertSpaceScope(auth, spaceUri, op): void {
  if (auth.credentials.type !== 'oauth') return
  ...
}
```

So the **space policy** layer (member list / managing app) is exercised in full,
while the **OAuth `space:` scope** layer is bypassed. The scope layer is documented
statically in the lab notes from `bulletin`'s permission set and
`@atproto/oauth-scopes`; it was not executed.

## Gotchas worth knowing

- A space `type` must be a full **NSID (>= 3 segments)**. `freeschool.members` is
  rejected with `Invalid NSID (got "freeschool.members") at $.type`; the lab uses
  `org.freeschool.members`.
- A space ref serialises as `at://{spaceDid}/space/{spaceType}/{skey}`; a record in
  it is `at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}`
  (`SpaceRef.toString()` / `parsePath` in `@atproto/syntax`).
- `com.atproto.space.getRepo` returns a **CAR stream**, not JSON — the lab prints the
  raw bytes rather than pretending to parse them. Verify it with
  `verifyRepoCarFull` from `@atproto/space`.
- Every DPoP proof is **single-use**; replaying one yields
  `401 BadDpopProof: DPoP proof replayed`. Mint a fresh proof per request.
- A delegation token is also single-use (`jti` consumed) and lives **60s**; a space
  credential lives **7200s**.
