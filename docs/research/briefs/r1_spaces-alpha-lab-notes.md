---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r1"
type: "research"
title: "R1 \u2014 Spaces alpha lab notes"
projects: ["local-alternatives"]
image_revision: "3827ed0acee59e36f3e26ed47647b0e7aae82452"
alpha_tag: "0.0.0-spaces-alpha-20260910230440"
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r1_spaces-alpha-lab-notes"
parachute_id: "2026-09-12-19-30-01-126241"
tags: ["atproto", "free-school", "local-alternatives", "research", "spaces"]
---

# R1 — Spaces alpha lab notes

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R1*

Ran the atproto **Spaces alpha** end to end on a local `pds-spaces-alpha` PDS.
No BPS invite was used or needed. Everything below marked "ran" was executed
against a real PDS on 2026-09-12; everything marked "read" is from primary source
in `bluesky-social/atproto@permissioned-data` or `bluesky-social/bulletin`.

Lab directory: `scratchpad/research/r1_lab/` (`README.md`, `docker-compose.yml`, `plc-server.mjs`, `spaces-lab.mjs`, `lab-output.txt`); copied into the freeskool repo at `infra/spaces-alpha-lab/`.

## TL;DR

- **It runs locally, today, without an invite.** `ghcr.io/bluesky-social/atproto:pds-spaces-alpha`
  + a 12-line in-memory `did:plc` server is a complete spaces testbed. Two env vars are
  load-bearing and undocumented in `example.env`: `PDS_DEV_MODE=1` (or the PDS refuses to
  boot over HTTP) and `PDS_DISABLE_SSRF_PROTECTION=1`. The image is **amd64-only** — a bare
  `docker pull` fails on Apple Silicon.
- **Read access is per-space, all-or-nothing. Per-collection read is not merely unimplemented,
  it is inexpressible.** One space credential reads *every collection in every member repo* of
  that space; the `collection` argument on `listRecords` is a client-side filter, not a
  permission; the member row is `{space, did, read, write}` with no collection column; and the
  OAuth scope type system forbids pairing a `collection` with a read action at all. The
  isolation boundary is the space itself — so `freeschool.members` and `freeschool.feedback`
  must be **two separate spaces**, which the lab confirms (a members credential against the
  feedback space → `InvalidCredential: Credential is not scoped to this space`).
- **The host cannot be kept out of a space it is the authority for.** The authority is
  unconditionally authorized for its own space (`if (userDid === spaceDid) return true`), so
  the school DID can always mint itself a credential and read every member's rows — verified.
  Spaces are access control, not confidentiality; this is consistent with the settled v1
  decision to ship anonymous feedback app-side.
- **`writePolicy` does not gate the write — it gates the *tracking* of the write.** A
  non-member's `putRecord` into a space **succeeded** (HTTP 200, real CID) and persists in her
  own repo; the authority merely refused the `notifyWrite`
  (`ForbiddenError: notifyWrite writer is not authorized`, swallowed as a warning) so she never
  entered `listRepos`' writer set and is invisible to every syncer. Unauthorized writes are
  *unsynced*, not *rejected*.
- **Revocation has a ~2-hour tail.** `removeMember` immediately blocks new credentials
  (`UserNotAuthorized`) but an already-issued credential keeps working until its `exp`
  (7200s from issuance) — verified by reading after removal. Plan for an eventual-consistency
  window, not instant cut-off.

## Setup (exact commands)

Host: macOS 15 (Darwin 25.6.0) arm64, Docker 29.5.2, node v22.22.3, pnpm 10.18.2.

### 0. Image

```sh
docker buildx imagetools inspect ghcr.io/bluesky-social/atproto:pds-spaces-alpha
#  Digest: sha256:481a87733c639966139e34dc6425eddf30d6218327fb489649e76edf2c3c9252
#  Platform: linux/amd64          <-- the only platform
docker pull ghcr.io/bluesky-social/atproto:pds-spaces-alpha
#  Error response from daemon: no matching manifest for linux/arm64/v8 ...
docker pull --platform linux/amd64 ghcr.io/bluesky-social/atproto:pds-spaces-alpha   # works
```

Image labels (primary source for "which commit is this?"):

| label | value |
| --- | --- |
| `org.opencontainers.image.revision` | `3827ed0acee59e36f3e26ed47647b0e7aae82452` |
| `org.opencontainers.image.created` | `2026-09-10T23:04:35.061Z` |
| `org.opencontainers.image.version` | `pds-spaces-alpha` |

Reported `_health` version: **0.5.32**. Entrypoint `dumb-init -- node … index.ts` in
`/app/services/pds` — the image ships **TypeScript sources**, so stack traces name real files
(`/app/packages/pds/src/api/com/atproto/space/util.ts:239`), which is very useful.

### 1. Dependencies

```sh
cd r1_lab && pnpm install
```

`package.json` pins every `@atproto` package to **`0.0.0-spaces-alpha-20260910230440`** (the
`alpha` dist-tag as of 2026-09-12, same timestamp as the image build). The `pnpm.overrides`
block is **mandatory** — see "Alpha packaging bug" below.

### 2. did:plc directory (in-memory)

Account creation needs a PLC. Writing to production `plc.directory` would be antisocial, so
the lab runs its own, mirroring `packages/dev-env/src/plc.ts`:

```js
// plc-server.mjs
import * as plc from '@did-plc/server'
const db = plc.Database.mock()                 // in-memory; no Postgres
const server = plc.PlcServer.create({ db, port: 2582 })
await server.start()
```

```sh
node plc-server.mjs &
curl -s http://localhost:2582/_health          # {"version":"0.0.0"}
```

### 3. PDS

```sh
docker compose up -d
curl -s http://localhost:2583/xrpc/_health     # {"version":"0.5.32"}
```

`docker-compose.yml` environment (the full set that matters):

```yaml
PDS_DEV_MODE: "1"                 # REQUIRED over plain HTTP
PDS_HOSTNAME: "localhost"         # => publicUrl http://localhost:2583
PDS_PORT: "2583"                  # publish 2583:2583 so container & host URLs agree
PDS_DATA_DIRECTORY: "/data"
PDS_BLOBSTORE_DISK_LOCATION: "/data/blobs"
PDS_DID_PLC_URL: "http://host.docker.internal:2582"
PDS_SERVICE_HANDLE_DOMAINS: ".test"
PDS_INVITE_REQUIRED: "0"
PDS_DISABLE_SSRF_PROTECTION: "1"  # REQUIRED: the PLC is on a private IP
PDS_REPO_SIGNING_KEY_K256_PRIVATE_KEY_HEX: "<64 hex>"
PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX: "<64 hex>"
PDS_DPOP_SECRET: "<64 hex>"
PDS_JWT_SECRET: "<any>"
PDS_ADMIN_PASSWORD: "<any>"
```

Without `PDS_DEV_MODE` the container dies immediately:

```
PDS failed to start: Error: Resource URL must use the https scheme
    at Module.createRouter (/app/packages/pds/src/auth-routes.ts:28:11)
```

— the guard is `if (!cfg.service.devMode && !resource.startsWith('https://')) throw`
(`packages/pds/src/auth-routes.ts:23-28`).

**There is no spaces feature flag.** `grep -i space packages/pds/src/config/env.ts
packages/pds/src/config/config.ts` returns nothing; `simplespace` and `space` routes are
unconditionally registered in this build.

### 4. Run

```sh
node spaces-lab.mjs | tee lab-output.txt
```

### Auth shortcut (and why it is legitimate)

The lab uses a **full legacy password session** (`com.atproto.server.createSession` with the
account password → `AuthScope.Access`) rather than the OAuth authorization-code flow, because
the alpha explicitly exempts non-OAuth credentials from the space-scope check:

```ts
// packages/pds/src/api/com/atproto/space/util.ts:76-88
/**
 * Legacy access tokens (including app passwords) predate granular permissions and
 * carry no space grants at all, so there is nothing to evaluate — they are bounded
 * instead by the handlers, which require the caller to be the repo they name.
 */
export function assertSpaceScope(auth, spaceUri, op): void {
  if (auth.credentials.type !== 'oauth') return
  ...
}
```

So the **space policy** layer (member list, managing app, credential exchange, DPoP) is
exercised in full; the **OAuth `space:` scope** layer is bypassed and is documented here from
source only.

Be precise about the distinction, because it bit me: a *full password session* is
`AuthScope.Access` and works everywhere, but a true **app password** (`AuthScope.AppPass`)
would be **refused at `getDelegationToken`**, which declares `scopes: ACCESS_FULL` —
`ACCESS_FULL = [AuthScope.Access]` only (`packages/pds/src/auth-scope.ts:11`). So an app
password can `createRecord` into a space but can never obtain a credential to read one.
The consequence still worth flagging: any non-OAuth token is a *wildcard* over the space
write API for its own repo, since `assertSpaceScope` returns early for it.

## SDK surface

### Packages

| package | lab (pinned) | bulletin (`alpha` at its lockfile) |
| --- | --- | --- |
| `@atproto/space` | `0.0.0-spaces-alpha-20260910230440` | `0.0.0-spaces-alpha-20260818163953` |
| `@atproto/syntax` `@atproto/crypto` `@atproto/car` `@atproto/lex-data` `@atproto/lex-cbor` | same `…20260910230440` | `…20260818163953` (`lex-data` pinned `^0.1.7`) |
| `@atproto/lex-client` `@atproto/lex-schema` `@atproto/oauth-client-node` `@atproto/xrpc-server` `@atproto/identity` `@atproto/common-web` | n/a (raw XRPC) | `…20260818163953` |
| `@atproto/oauth-scopes` | n/a | `0.0.0-spaces-alpha-20260818163953` (pinned literal) |
| `@atproto/jwk-jose` | `0.2.4` | `0.2.4` |

The `alpha` dist-tag moves **weekly** and is shared across all packages, so "alpha" is a
moving target: bulletin's checked-in lockfile is three weeks behind the current tag. Pin the
literal timestamp.

**Alpha packaging bug (found, worth reporting upstream):** `@atproto/space`'s dependency
range `^0.0.0-spaces-alpha-20260910230440` also matches the plain `0.0.0` placeholder
publishes of `@atproto/lex-data` / `@atproto/lex-cbor`, whose manifests still contain
`"@atproto/syntax": "workspace:*"`. Installing without overrides aborts:

```
ERR_PNPM_WORKSPACE_PKG_NOT_FOUND  "@atproto/syntax@workspace:*" is in the dependencies
but no package named "@atproto/syntax" is present in the workspace
This error happened while installing the dependencies of
@atproto/space@0.0.0-spaces-alpha-20260910230440 at @atproto/lex-data@0.0.0
```

Fix: `pnpm.overrides` pinning `@atproto/lex-data`, `@atproto/lex-cbor`, `@atproto/syntax`,
`@atproto/crypto`, `@atproto/car` to the exact alpha build. (bulletin sidesteps it by pinning
`@atproto/lex-data: ^0.1.7` plus its own override block.)

### Addressing

```
space ref : at://{spaceDid}/space/{spaceType}/{skey}
record    : at://{spaceDid}/space/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}
```

`SPACE_MARKER` is the literal `space` (`SpaceRef.toString()` / `parsePath`, `@atproto/syntax`
`dist/aturi.js`). `spaceType` must be a **valid NSID (>= 3 segments)** — `freeschool.members`
is rejected (`Invalid NSID (got "freeschool.members") at $.type`); `skey` is a record key,
auto-generated as a TID when omitted.

### Calls

Auth column: **acct** = an account token (OAuth, or a legacy/app-password session);
**owner** = acct, and the handler asserts caller == space DID; **deleg** =
`Authorization: Bearer <delegation token>` + `DPoP:` proof; **cred** =
`Authorization: DPoP <space credential>` + bound `DPoP:` proof.

Two rules hold across the whole table: **no write ever accepts a space credential** (every
write handler uses `authVerifier.authorization(...)` and requires `repo == caller`), and
`getDelegationToken` is the one method that demands `ACCESS_FULL`, so a true app password
reaches the write API but never the read API.

| call | type | auth | key args | returns | ran? |
| --- | --- | --- | --- | --- | --- |
| `com.atproto.simplespace.createSpace` | proc | acct | `type` (nsid), `skey?`, `readPolicy`, `writePolicy`, `appAccess` | `{uri}` | ✅ |
| `com.atproto.simplespace.getSpace` | query | acct or cred | `space` | `{uri, readPolicy, writePolicy, appAccess}` | ✅ |
| `com.atproto.simplespace.updateSpace` | proc | owner | `space`, any of `readPolicy`/`writePolicy`/`appAccess` (replaced wholesale) | — | ✗ read only |
| `com.atproto.simplespace.deleteSpace` | proc | owner | `space` | — | ✗ read only |
| `com.atproto.simplespace.putMember` | proc | owner | `space`, `did`, `read` (bool), `write` (bool) | — (200, empty) | ✅ |
| `com.atproto.simplespace.removeMember` | proc | owner | `space`, `did` | — | ✅ |
| `com.atproto.simplespace.listMembers` | query | **acct only** | `space`, `limit`, `cursor` | `{members:[{did,read,write}], cursor}` | ✅ |
| `com.atproto.simplespace.checkUserAccess` | query | service auth **from** the authority | `space`, `user`, `access` (`read`\|`write`), `clientId?` | `{authorized}` | ✗ served by the app, not the PDS |
| `com.atproto.space.createRecord` | proc | acct | `space`, `repo` (must == caller), `collection`, `rkey?`, `record`, `validate?` | `{uri, cid, validationStatus}` | ✅ |
| `com.atproto.space.putRecord` | proc | acct | as above, `rkey` required | `{uri, cid, validationStatus}` | ✅ |
| `com.atproto.space.deleteRecord` | proc | acct | `space`, `repo`, `collection`, `rkey` | `{}` (idempotent) | ✗ |
| `com.atproto.space.applyWrites` | proc | acct | batch | — | ✗ |
| `com.atproto.space.getDelegationToken` | query | acct (`ACCESS_FULL`) | `space` | `{token}` — 60s JWT | ✅ |
| `com.atproto.space.getSpaceCredential` | proc | **deleg** | `space`, `clientAttestation?` | `{credential}` — 7200s JWT | ✅ |
| `com.atproto.space.listRecords` | query | acct (own repo) **or** cred (any repo) | `space`, `repo`, `collection?`, `limit`, `cursor`, `reverse?`, `excludeValues?` | `{records:[{collection,rkey,cid,value}], cursor}` | ✅ both |
| `com.atproto.space.listRepos` | query | **cred only** | `space`, `limit`, `cursor` | `{repos:[{did,rev,hash}]}` — the **writer set** | ✅ |
| `com.atproto.space.listRepoOps` | query | cred | `space`, `repo`, `since?` (tid), `cursor?`, `limit`, `excludeValues?` | `{ops:[{rev,collection,rkey,cid,prev,value?}], commit?, cursor?}` | ✅ |
| `com.atproto.space.getRepo` | query | cred | `space`, `repo` | **CAR stream** (not JSON) | ✅ |
| `com.atproto.space.getRecord` / `listBlobs` / `getLatestCommit` | query | cred | — | — | ✗ |
| `com.atproto.space.getBlob` | query | cred | `space`, `repo`, `cid` | raw bytes | ✗ |
| `com.atproto.space.registerNotify` | proc | cred | `space`, `service` (DID + optional `#fragment`) | `{expiresAt}` — TTL **1 day** | ✅ |
| `com.atproto.space.unregisterNotify` | proc | cred | `space`, `service` | — | ✗ |
| `com.atproto.space.notifyWrite` | proc | service auth from the authority | `space`, `repo`, `rev`, `hash` | — | ⚠ observed server-side only |
| `com.atproto.space.notifySpaceDeleted` | proc | service auth | `space` | — | ✗ |

### Policy union values (verbatim `$type` strings)

```js
// readPolicy / writePolicy — pick one
{ $type: 'com.atproto.simplespace.defs#publicPolicy' }                 // anyone
{ $type: 'com.atproto.simplespace.defs#memberListPolicy' }             // host-internal member list
{ $type: 'com.atproto.simplespace.defs#managingAppPolicy',
  managingApp: 'did:web:example.com#forum' }                           // ask the app via checkUserAccess

// appAccess — pick one
{ $type: 'com.atproto.simplespace.defs#open' }                         // no client attestation
{ $type: 'com.atproto.simplespace.defs#allowList', allowed: ['<oauth client_id>', …] }
```

`readPolicy` and `writePolicy` are **independent** and each is one of the three. Policy
dispatch (`packages/pds/src/simplespace/manager.ts:145-169`): `public` → true;
`member-list` → that member row's `read`/`write` boolean; `managing-app` → `checkUserAccess`;
anything else → false (`manager.ts:146-169`). An unreachable managing app **denies** (fail closed).

### Two client-construction patterns (from bulletin)

```ts
// 1. as the user — the OAuth session IS the transport
const client = new Client(session)                       // @atproto/lex-client
await client.call(com.atproto.simplespace.createSpace, { type, skey, readPolicy, … })

// 2. as a space-credential holder — inject a DPoP-signing fetch
class SpaceCredential {
  fetch = async (input, init) => {
    const request = new Request(input, { ...init, redirect: 'error' })
    request.headers.set('authorization', `DPoP ${this.token}`)
    request.headers.set('dpop', await createDpopProof(this.key, {
      htm: request.method, htu: request.url, credential: this.token,
    }))
    return fetch(request)
  }
  client(service) { return new Client({ service, fetch: this.fetch }) }
}
```

`client.call()` takes the **codegen'd schema object**, not an NSID string, and inputs must be
branded (`asStringFormat(space, 'space-ref')`, `asStringFormat(did, 'did')`). Bulletin escapes
to raw `fetch` for exactly two calls: `getSpaceCredential` (bespoke header dance) and
`getRepo` (CAR stream). `redirect: 'error'` matters — it stops a repo host bouncing a
credential somewhere else.

## Walkthrough with real output

Actors: `freeskool.test` = `did:plc:6rmyvzigxgoatefk5332w6wr` (authority),
`alice.test` = `did:plc:uqxgs4dsymmkyvzxdnink7l7` (member),
`carol.test` = `did:plc:c5mmke5wvm4lx22v55aysbbq` (non-member).
(`school.test` is refused: `HandleNotAvailable: Reserved handle`.)

### 1. Create two spaces

```
input.body: {
  "type": "org.freeschool.members", "skey": "v1",
  "readPolicy":  { "$type": "com.atproto.simplespace.defs#memberListPolicy" },
  "writePolicy": { "$type": "com.atproto.simplespace.defs#memberListPolicy" },
  "appAccess":   { "$type": "com.atproto.simplespace.defs#open" }
}
output.uri: at://did:plc:6rmyvzigxgoatefk5332w6wr/space/org.freeschool.members/v1
output.uri: at://did:plc:6rmyvzigxgoatefk5332w6wr/space/org.freeschool.feedback/v1
```

### 2. Add a member / list members

```
input.body: { "space": "at://…/space/org.freeschool.members/v1",
              "did": "did:plc:uqxgs4dsymmkyvzxdnink7l7", "read": true, "write": true }
putMember returned 200 with an empty body

members: { "cursor": "did:plc:uqxgs4dsymmkyvzxdnink7l7",
           "members": [ { "did": "did:plc:uqxgs4dsymmkyvzxdnink7l7", "read": true, "write": true } ] }
```

`read` and `write` are the *only* two dimensions. There is no collection field — the stored
row is literally that wide (`packages/pds/src/actor-store/db/schema/simplespace-member.ts`):

```ts
// Host-internal access list for simplespace's member-list policies.
export interface SimplespaceMember {
  space: string
  did: string
  read: 0 | 1
  write: 0 | 1
}
const tableName = 'simplespace_member'
```

and the sibling `simplespace_config` holds exactly
`{uri, readPolicy, readManagingApp, writePolicy, writeManagingApp, appAccessType, appAllowed}`
(`db/migrations/003-space-access.ts`, which split the original single `policy` column into
separate read/write policies).

### 3. Write into the space (as the member, into her own repo)

```
output: {
  "uri": "at://did:plc:6rmyvzigxgoatefk5332w6wr/space/org.freeschool.members/v1/did:plc:uqxgs4dsymmkyvzxdnink7l7/freeschool.draft.skill/r1lab",
  "cid": "bafyreibmxticltjkrjabsujih7jc5rcapkhzy3rt6ssydhrx5tb6l4k6am",
  "validationStatus": "unknown"
}
```

`freeschool.draft.*` collections accept writes with `validationStatus: "unknown"` — no
published lexicon required, which is exactly what the approved drafting record types need.

### 4. Member read via the credential exchange

```
DPoP key thumbprint (jkt): 2R0KmCBi9fZ6N4Hfdk9cmcN3-6Zr8ah44QWUr3c1vVg

listRepos -> { "repos": [ { "did": "did:plc:uqxgs4dsymmkyvzxdnink7l7",
                            "rev": "3mveg52d2p22q",
                            "hash": { "$bytes": "9aUyfA/iffxjKNcUJKvWgM34wWRn9XpNM6G957Huwz8" } } ] }

listRecords (no collection filter) -> BOTH collections returned:
  freeschool.draft.skill/r1lab      "Sourdough starter basics"
  freeschool.draft.feedback/r1lab   "loved the bread class"
```

**This is the per-collection answer.** One credential, both collections. Adding
`collection: freeschool.draft.feedback` narrows the result — but that is the caller choosing,
not the authority constraining.

### 5. Non-member

```
[REFUSED] carol exchanges her delegation token for a credential
  HTTP 400  error="UserNotAuthorized"  message="User not authorized for this space"

[REFUSED] carol listRecords on alice's repo (account token)
  HTTP 400  error="RepoNotFound"  message="Could not find repo for DID: did:plc:uqxgs4…"

[ALLOWED] carol putRecord into the space ->
  { "uri": "at://…/space/org.freeschool.members/v1/did:plc:c5mmke5wvm4lx22v55aysbbq/freeschool.draft.feedback/r1lab-carol",
    "cid": "bafyreie2jkourejmkcqru3rkhhcmnfpsthaiaagpaxpwjj6gvpyaovqgim", "validationStatus": "unknown" }

repos after carol attempt -> still only alice
```

Two findings in that block:

1. `RepoNotFound` is **deliberate** cover, not a bug: *"Deliberately the same error an absent
   repo gets: whether a given account holds a repo in a space the caller cannot read is not the
   caller's business."* (`space/util.ts:115-124`). Non-membership and non-existence are
   indistinguishable to the caller — which is also how bulletin probes whether a space exists
   at all (`UserNotAuthorized` ⇒ exists-but-hidden; `SpaceNotFound`/`SpaceDeleted` ⇒ absent).
2. The non-member's **write succeeded**. The refusal happens later and server-side:

```
level 40 (warn)  ForbiddenError: notifyWrite writer is not authorized
  at processNotifyWrite (/app/packages/pds/src/api/com/atproto/space/util.ts:239:11)
  at async fireNotifyWrite (/app/packages/pds/src/api/com/atproto/space/util.ts:303:7)
  at async handler (/app/packages/pds/src/api/com/atproto/space/putRecord.ts:71:7)
```

`fireNotifyWrite` catches everything (*"notifications are best-effort"*), so the write returns
200 and the row sits in carol's own repo forever, never entering the writer set.

### 6. Can the authority read a member's rows? Yes.

```
[ALLOWED] school mints itself a space credential
school reads alice's rows -> both records, full values
```

Even though the school is **not on its own member list**, because:

```ts
// packages/pds/src/simplespace/manager.ts:142-144, inside authorizeUser()
// The authority is the only party who can reconfigure the space, so it must not be
// able to lock itself out.
if (userDid === spaceDid) return true
```

Note also that `authorizeCredential` (`manager.ts:102-131`) evaluates the user perimeter with
`access: 'read'` **always** — a space credential is a *read* credential. Write authorization is
a separate decision taken later, at `notifyWrite`. And the app perimeter is checked *first*,
deliberately: *"a refused app is never disclosed to a third-party managing app."*

### 7. Syncer path

```
listRepoOps -> ops: [ {rev, collection, rkey, cid, prev, value?}, … ]
               commit: { ver: 1,
                         hash: {$bytes:"VgKuxObungbJRT3vS1hAsPFdHqtJoEMQcJGyRqw98Ik"},
                         ikm:  {$bytes:"6fH6b8sTd6whFBXbuJTjbRqCDxhsB8pLg4ZpLjZDAeg"},
                         mac:  {$bytes:"+Sl45tOII+0/OS3t1S0TRJdzEjAoCyFPX2XlZepGXzc"},
                         sig:  {$bytes:"0Kks0lYxUVv7zmIwd4n3oulQwjLMDsaOb3zxSWaF90J…"},
                         rev: "3mveg6zvjac2q" }

getRepo -> CAR bytes (roots / version 1 / signed commit), not JSON

[ALLOWED] registerNotify service=did:plc:uqxgs4dsymmkyvzxdnink7l7 -> { "expiresAt": "2026-09-14T01:14:28.541Z" }
[REFUSED] registerNotify with an unresolvable service
  HTTP 400  error="ServiceNotResolvable"  message="Could not resolve a service endpoint for did:web:syncer.invalid#atproto_space_syncer"
```

### 8. Cross-space, revocation, replay

```
[REFUSED] alice's org.freeschool.members credential used against org.freeschool.feedback
  HTTP 400  error="InvalidCredential"  message="Credential is not scoped to this space"

removeMember returned 200 ; members now: { "members": [] }
[REFUSED] alice re-exchanges after removal
  HTTP 400  error="UserNotAuthorized"  message="User not authorized for this space"
[ALLOWED] alice reuses the old credential -> both records still returned
  >>> revocation lag: valid for 7200s from issuance (until 2026-09-13T03:13:21.000Z)

[ALLOWED] listRepos with a fresh proof
[REFUSED] listRepos replaying that proof
  HTTP 401  error="BadDpopProof"  message="DPoP proof replayed"
```

## Delegation token + policy anatomy

Three token classes share one wire shape and differ only in signer, audience and lifetime
(`packages/space/src/credential.ts:18-55`):

| | `delegation` | `credential` | `clientAttestation` |
| --- | --- | --- | --- |
| `typ` | `atproto-space-delegation+jwt` | `atproto-space-credential+jwt` | `atproto-client-attestation+jwt` |
| signed by | the **member's** PDS (`#atproto`) | the **authority** (`#atproto`, or `#atproto_space` if published) | the **app** (JWKS key) |
| `kid` | `#atproto` | `#atproto` | — |
| lifetime | **60s** | **7200s** | 60s |
| `aud` required | yes | **no** (multi-use across repo hosts) | yes |
| `cnf.jkt` required | no | **yes** | no |
| single-use | yes (`jti` consumed) | no | yes |

### Real delegation token (decoded)

```json
header  { "alg": "ES256K", "typ": "atproto-space-delegation+jwt", "kid": "#atproto" }
payload {
  "iss": "did:plc:uqxgs4dsymmkyvzxdnink7l7",
  "sub": "at://did:plc:6rmyvzigxgoatefk5332w6wr/space/org.freeschool.members/v1",
  "aud": "did:plc:6rmyvzigxgoatefk5332w6wr#atproto_space_host",
  "iat": 1789262001, "exp": 1789262061,
  "jti": "543f78c23c27660c8fc2268d62514d58"
}
```

`sub` is the space ref; `aud` is `${spaceDid}#atproto_space_host` — derived from `sub`, so a
token minted for one authority cannot be presented to another. ES256K because the PDS account
signing key is secp256k1. Signature 64 bytes, raw (not DER).

### Real space credential (decoded)

```json
header  { "alg": "ES256K", "typ": "atproto-space-credential+jwt", "kid": "#atproto" }
payload {
  "iss": "did:plc:6rmyvzigxgoatefk5332w6wr",        // the authority
  "sub": "at://did:plc:6rmyvzigxgoatefk5332w6wr/space/org.freeschool.members/v1",
  "cnf": { "jkt": "2R0KmCBi9fZ6N4Hfdk9cmcN3-6Zr8ah44QWUr3c1vVg" },
  "iat": 1789262001, "exp": 1789269201,
  "jti": "8bae11256c49bb9d68007256e1c482aa"
}
```

**Note what is *not* in it**: no collections, no repos, no read/write distinction, no `aud`.
The entire authorization content is "bearer of key `jkt` may read space `sub` until `exp`".
That is the whole per-collection story, in nine lines of JSON.

Verification on a repo host (`auth-verifier.ts:369-404`): `iss` must equal the space's own DID
(*"any DID could sign a credential naming someone else's space"*), `cnf.jkt` must be present,
and the DPoP proof must be signed by that key. The host then trusts the credential — it
re-checks nothing, because *"a repo host has no member list of its own to consult"*
(`space/util.ts:93-97`).

### The DPoP proofs

```json
// leg 1 — obtaining a credential: Authorization: Bearer <delegation>, no `ath`
header  { "alg":"ES256", "typ":"dpop+jwt",
          "jwk": { "kty":"EC","crv":"P-256","x":"amKUkvNjsPTm…","y":"XF1lScBFQAvF…" } }
payload { "jti":"837b0ed5217c4dd9f2d4c874330d6c12", "htm":"POST",
          "htu":"http://localhost:2583/xrpc/com.atproto.space.getSpaceCredential",
          "iat":1789262001 }
```

- Always **ES256** (`SIGNING_ALG` in `packages/space/src/dpop.ts:18`) even though the atproto
  keys are ES256K. The DPoP key is app-generated (`JoseKey.generate(['ES256'])`), per-credential,
  memory-only.
- `htu` is normalised to `origin + pathname` (query/fragment stripped), so one proof covers any
  query on a path — but `jti` is still single-use.
- No `exp`; bounded by `iat` + `MAX_PROOF_AGE_SEC = 60`, `CLOCK_SKEW_SEC = 5`.
- On the *read* leg the proof adds `ath = base64url(sha256(credential))` and the scheme becomes
  `Authorization: DPoP <credential>`. Omitting `ath` on a read, or including it on the
  exchange, is an error either way.

### Space-type declaration

Two separate things, and I initially conflated them:

- **On the PDS, nothing declares a space type.** `createSpace` takes `type` as a bare NSID,
  validates only its *syntax*, and stores nothing about it beyond the string. The authority's
  actor store gains exactly three rows — `space (uri, authority, type, createdAt, deletedAt)`,
  `space_repo (space, setHash, rev)`, and `simplespace_config (uri, readPolicy,
  readManagingApp, writePolicy, writeManagingApp, appAccessType, appAllowed)`. No member rows,
  and no check that `type` corresponds to any published lexicon. `skey` defaults to
  `TID.nextStr()`.
- **In the lexicon/OAuth layer, a space type IS declared**, via `l.space(nsid, key,
  collections, options)` in `@atproto/lex-schema` (`packages/lex/lex-schema/src/schema/space.ts`).
  Its `collections` list is what the OAuth provider uses at token-issuance time to expand a
  bare `space:<type>` scope — whose `collection` list defaults to **empty**, meaning "no write
  targets", *not* "all collections" — into the concrete collections
  (`packages/oauth/oauth-provider/src/lexicon/lexicon-manager.ts:75-96`,
  `SpacePermission.withDefaultCollections`).

So the space-type declaration is a *client-permission* artifact, not a host-enforced schema: it
shapes what an app can be granted, and the PDS never consults it. For Free School that means
our space-type NSIDs need published lexicon declarations only when we want consent screens and
scope expansion to work — the spaces themselves will function without them.

### OAuth scope layer (read, not run)

The granular wire syntax, from bulletin's tests:

```
space:my.bulletin.board?authority=*&skey=self&action=read
space:my.bulletin.board?authority=*&skey=self&collection=my.bulletin.post&action=create&manage=create
```

Repeated keys are multi-valued params, not comma lists. A permission-set lexicon bundles them:

```json
{ "type": "permission", "resource": "space",
  "spaceType": "my.bulletin.board", "authority": "*", "skey": "self",
  "collection": ["my.bulletin.post","my.bulletin.removal","my.bulletin.position"],
  "action": ["read","create","update","delete"],
  "manage": ["create","update","delete"] }
```

and the app requests it by NSID: `atproto blob?accept=image/jpeg&… include:my.bulletin.permissions`.

The three scope strings that matter, with the handler that demands each:

| to do this | scope | asserted at |
| --- | --- | --- |
| create a space | `atproto space:<type>?manage=create` | `createSpace.ts:22` |
| `putMember` / `removeMember` / `updateSpace` | `…?manage=update` | `putMember.ts:17`, `removeMember.ts:17`, `updateSpace.ts:16` |
| delete a space | `…?manage=delete` | `deleteSpace.ts:17` |
| write records | `atproto space:<type>?authority=<did>&collection=<nsid>&action=create&action=update&action=delete` | `createRecord.ts:40` etc. |
| read the whole space (i.e. get a delegation token) | `atproto space:<type>?authority=<did>&action=read` | `getDelegationToken.ts:22` |

`authority` defaults to `self` (rewritten to the granting user's DID at issuance), `skey`
to `*`, `action` to `['read','create','update','delete']`, and `manage` to **`[]`** — so a
default grant carries no management rights at all. `action=read_self` buys only your own repo
and is explicitly insufficient for a delegation token.

**The scope layer has collection granularity for WRITES ONLY — and its type system forbids
pairing a collection with a read at all** (`packages/oauth/oauth-scopes/src/scopes/space-permission.ts:65-78`):

```ts
export type SpacePermissionMatch = { type: string; authority: string; skey: string } & (
  | { action: 'read';      collection?: never; manage?: never }
  | { action: 'read_self'; collection?: never; manage?: never }
  | { action: 'create' | 'update' | 'delete'; collection: string; manage?: never }
  | { action?: never; collection?: never; manage: SpaceManageOp }
)
```

with the matcher commenting *"Reads are collection-independent, and `read` implies
`read_self`"* (`:106-113`) — `collectionAllows()` is only ever reached for
`create|update|delete`. So `createRecord` asserts `{action:'create', collection}` while
`getDelegationToken` asserts a bare whole-space `{action:'read'}` (*"A whole-space `read`
grant is what an app exchanges for such a credential … it is not itself one"*).

This closes the question from both sides: **there is no per-collection read anywhere in the
stack** — not in the space policy, not in the member row, not in the credential, and not even
expressible in the scope grammar. Collection granularity constrains only **what an app may
write on the user's behalf**, and a scope is in any case a promise the user's own PDS enforces
against its own app, never a wall between members.

Also note: **writes never accept a space credential.** Every write handler uses
`ctx.authVerifier.authorization(...)` (account/OAuth only), and asserts `repo === caller`. A
credential reads; it cannot write, and it cannot be used to write on someone else's behalf.

## Implications for Free School

These follow from the lab; they don't touch the settled items (sidecar composition,
`freeschool.draft.*`, hosted-service custody of the school DID, v1 on public records with
app-side anonymous feedback behind a Spaces-shaped interface, reputation from attestations).

1. **A school DID owning spaces works exactly as hoped, and is cheap.** The school account
   calls `createSpace` twice and owns both; the space ref embeds the school DID, so
   `at://{schoolDid}/space/org.freeschool.members/v1` is self-describing and needs no registry.
   Because the hosted service custodies the school DID for v1, it holds the only key that can
   `putMember`/`removeMember`/`updateSpace` — ownership is not delegable in this alpha
   (`assertSpaceOwner` is a bare DID equality check). Any "admin" notion above one key has to
   be built app-side, or by making the school a `managingAppPolicy` space and letting the
   Free School app answer `checkUserAccess`.

2. **`freeschool.members` and `freeschool.feedback` must be two spaces, not two collections.**
   This is the single most consequential finding. A credential is scoped to one space and reads
   everything in it; there is no per-collection or per-repo read policy anywhere in the
   credential, the member row (`{did, read, write}`), or the read handlers. If feedback and
   membership live in one space, every member who can read the roster can read every piece of
   feedback. Two spaces cost one extra `createSpace` and one extra credential per syncer, and
   the boundary is enforced (`InvalidCredential`). Note also that space *type* NSIDs need 3+
   segments, so the on-the-wire names will be something like `org.freeschool.members` /
   `org.freeschool.feedback` even if we keep talking about them unqualified.

3. **A host cannot be shut out of a space it is the authority for — by design.** The authority
   short-circuits its own policy check, so the school (and therefore whoever custodies the
   school DID) can always read every member's rows in every school space. Separately, the PDS
   that *hosts* a member's repo stores those rows in plaintext in its actor store. Spaces are
   access control, not confidentiality, and the alpha says so. This is precisely why v1's
   anonymous feedback is an app-side construction behind a Spaces-shaped interface: Spaces
   cannot deliver contributor anonymity against the host, now or on this roadmap. Worth stating
   plainly in any trust/privacy copy: "the school can see who said what" is the protocol's
   default, and any stronger claim is our app's doing, not atproto's.

4. **The syncer/AppView story is clean and well-shaped for us.** One credential, then:
   `getSpace` (confirm the policy is still ours) → `registerNotify` (1-day TTL, renew early) →
   `listRepos` (the writer set, paginated) → per-repo `listRepoOps?since=<rev>` for deltas,
   falling back to `getRepo` (CAR) when the LtHash doesn't reconcile. Crucially, reads go to
   **each member's own PDS**, not the authority — the authority only holds the writer set and
   the fan-out registrations. The pieces we'd need to build: an in-memory credential cache with
   a single silent re-mint on failure, per-repo job serialisation, and a DID-doc service entry
   (`#atproto_space_syncer`-style fragment) so `notifyWrite` can reach us with service auth. A
   syncer must borrow *some* authorized user's OAuth session to mint a credential — there is no
   service-to-service path to a credential, which is the awkward bit bulletin solves by trying
   the authority's own session first.

5. **Two operational hazards to design around.** (a) **Revocation lag**: `removeMember` is
   instant for new credentials but an issued one lives 7200s. If removal needs to be prompt,
   the app must also revoke app-side, or we accept a two-hour window. (b) **Unauthorized writes
   are silently retained, not rejected**: a removed or never-added member can keep writing into
   her own repo under our space URI and get 200s; the rows simply never sync. That is
   fail-safe for the AppView but means "is this row real?" must always be answered by the
   writer set, never by the row's existence — and that a member's own client will happily show
   her writes that nobody else will ever see. (c) **Any credential holder can wiretap the write
   stream**: `registerNotify` is authenticated by a space credential alone, so any member can
   subscribe an arbitrary service DID of their choosing to a space's write notifications for a
   day at a time. The notifications carry only `{space, repo, rev, hash}` — no record content —
   but they do leak *who wrote when*, to a third party of a member's choosing, and the authority
   is not asked. If that matters for feedback spaces, the mitigation is `appAccess: allowList`
   with client attestation, which this lab did not exercise.

6. **Alpha stability caveats.** The `alpha` dist-tag moves weekly and covers ~8 interdependent
   packages at one shared timestamp; bulletin's own lockfile is three weeks behind the current
   tag. The published `@atproto/lex-data@0.0.0` / `lex-cbor@0.0.0` placeholders break a naive
   install outright. Three of the six lexicons bulletin needs aren't even in its vendored
   upstream set, and two endpoints have no generated client at all. Two call sites in the PDS
   carry `@NOTE`-grade comments about behaviour that may change. Conclusion: Spaces is the right
   shape to design toward and the wrong thing to ship on. Keep the v1 public-records
   implementation behind a Spaces-shaped seam — the seam that matters is
   "mint credential → read space", because that is the part whose *shape* the alpha has
   already settled even if the package names churn. Re-run this lab against a fresh weekly
   image before committing to any of the specifics above — `spaces-lab.mjs` is deliberately
   written against raw XRPC rather than the alpha clients, so it keeps working when the
   generated-client surface moves.

## Sources

All URLs and files read 2026-09-12.

**Code checked out and read**

- `bluesky-social/bulletin` — cloned at commit **`0acf237`** ("update match new spaces-alpha pds").
  <https://github.com/bluesky-social/bulletin>. Read: `package.json`, `pnpm-lock.yaml`,
  `README.md`, `DEPLOY.md`, `lib/atproto/{actions,space-credential,space-existence,board-access,follows,service-auth}.ts`,
  `lib/sync/{engine,service,client,forward,registration,service-auth,credential-candidates,errors}.ts`,
  `lib/auth/{client,metadata,bulletin-capabilities}.ts`, `lib/config.ts`,
  `scripts/codegen-lex.mjs`, `lexicons/my/bulletin.permissions.json`,
  `app/xrpc/com.atproto.simplespace.checkUserAccess/route.ts`, and the `*.test.ts` siblings.
- `bluesky-social/atproto` branch **`permissioned-data`** (= PR #5187), sparse checkout at
  local HEAD **`9d787eb`**. <https://github.com/bluesky-social/atproto/pull/5187>. Read:
  `lexicons/com/atproto/space/*.json` (20 files), `lexicons/com/atproto/simplespace/*.json` (9 files),
  `packages/space/src/{credential,dpop,types,index}.ts`,
  `packages/pds/src/api/com/atproto/space/{util,createRecord,getDelegationToken,getSpaceCredential,listRecords,listRepos,registerNotify}.ts`,
  `packages/pds/src/api/com/atproto/simplespace/{createSpace,putMember}.ts`,
  `packages/pds/src/simplespace/config.ts`, `packages/pds/src/auth-verifier.ts`,
  `packages/pds/src/auth-routes.ts`, `packages/pds/src/config/{env,config}.ts`,
  `packages/pds/example.env`, `packages/dev-env/src/{plc,bin-multi-pds}.ts`.
  Also `packages/pds/src/simplespace/manager.ts` (policy dispatch / `authorizeCredential`).
- `@atproto/syntax@0.0.0-spaces-alpha-20260910230440` `dist/aturi.js` (installed) — `SpaceRef`,
  `SPACE_MARKER`, `parsePath`.

  > The image is built from revision `3827ed0acee59e36f3e26ed47647b0e7aae82452`, which is **not**
  > the branch HEAD I read (`9d787eb`). Line numbers cited from my checkout matched the
  > stack traces the running container emitted, so the drift did not bite here — but it is
  > drift, and a future run should pin the checkout to the image's revision label.

**Container image**

- `ghcr.io/bluesky-social/atproto:pds-spaces-alpha`, index digest
  `sha256:481a87733c639966139e34dc6425eddf30d6218327fb489649e76edf2c3c9252`,
  amd64 manifest `sha256:5666dd1847dce6df4918005be58c26574023a9f73a3cf8db487b6434dd2e717a`,
  created `2026-09-10T23:04:35.061Z`, revision `3827ed0acee59e36f3e26ed47647b0e7aae82452`.
  Reported `/xrpc/_health` version `0.5.32`.

**npm (dist-tags read 2026-09-12)**

- `alpha` = `0.0.0-spaces-alpha-20260910230440` for `@atproto/space`, `@atproto/syntax`,
  `@atproto/crypto`, `@atproto/car`, `@atproto/lex-data`, `@atproto/lex-cbor`.
  `@atproto/space` `latest` = `0.0.0-spaces-alpha-20260818022935`.
- `@did-plc/server@0.0.1`, `@did-plc/lib@0.0.1`, `@atproto/jwk-jose@0.2.4`, `jose@5.10.0`.

**Lab artifacts produced**

- `r1_lab/README.md`, `r1_lab/docker-compose.yml`, `r1_lab/plc-server.mjs`,
  `r1_lab/spaces-lab.mjs`, `r1_lab/package.json`, `r1_lab/lab-output.txt` (533 lines of
  recorded output), `r1_lab/docker-pull.log`.

**Referenced, not fetched**

- Permissioned-data proposal 0016:
  <https://github.com/bluesky-social/proposals/tree/main/0016-permissioned-data> — cited by
  bulletin's README and the lexicon descriptions; I relied on the in-repo lexicons and source
  rather than the proposal text.
- <https://bulletin.my> — not visited.

## Confidence / not verified

### Ran and observed (high confidence)

- Pulling and booting `pds-spaces-alpha` under amd64 emulation; the arm64 pull failure;
  `PDS_DEV_MODE` and `PDS_DISABLE_SSRF_PROTECTION` being required; the full env set above.
- Standalone `@did-plc/server` with `Database.mock()`; account creation on `.test` handles;
  `school.test` being a reserved handle.
- `createSpace` (twice), `getSpace`, `putMember`, `listMembers`, `removeMember`,
  `putRecord` (member and non-member), `listRecords` (account token and credential, with and
  without a `collection` filter), `getDelegationToken`, `getSpaceCredential`, `listRepos`,
  `listRepoOps`, `getRepo`, `registerNotify` (success and `ServiceNotResolvable`).
- Error names/HTTP codes exactly as quoted: `UserNotAuthorized`, `RepoNotFound`,
  `InvalidCredential`, `BadDpopProof`, `ServiceNotResolvable`, `SpaceAlreadyExists`,
  `HandleNotAvailable`, `Invalid NSID`.
- The decoded delegation token and space credential above are real tokens from this run.
- One credential reading both collections; the same credential refused against a sibling space;
  the authority minting its own credential and reading a member's rows; DPoP single-use;
  the post-`removeMember` window.
- The non-member write succeeding **and** the server-side
  `ForbiddenError: notifyWrite writer is not authorized` (observed in container logs, with the
  stack trace through `fireNotifyWrite`), and carol's continued absence from `listRepos`.
- The `pnpm` install failure without overrides, and the exact resolved alpha version strings.

### Read only, not executed (medium-high confidence — source, untested)

- `updateSpace`, `deleteSpace`, `deleteRecord`, `applyWrites`, `getRecord`, `listBlobs`,
  `getLatestCommit`, `getBlob`, `unregisterNotify`, `notifySpaceDeleted`.
- `managingAppPolicy` / `checkUserAccess` end to end, and `allowList` app access with a
  client attestation. I never stood up a managing app, so the `AppNotAuthorized` path,
  `clientAttestation` verification, and the fail-closed-on-unreachable-app behaviour are
  source-read only. bulletin's spaces are all `appAccess: open`, so its code does not
  exercise them either.
- The **OAuth scope layer was never executed**: no authorization-code flow, no consent screen,
  no token carrying a `space:` scope, so `assertSpaceScope`'s OAuth branch, scope expansion from
  space-type declarations, and permission-set resolution are all source-read only. I read
  `space-permission.ts`'s `SpacePermissionMatch` and `matches()` directly; the scope *strings*
  in the table and the `lexicon-manager.ts` expansion I took from a second agent's read plus
  bulletin's tests, not from my own reading of those files. Version strings for
  `@atproto/oauth-scopes` and `@atproto/lex-client` are from bulletin's lockfile — not installed
  or run here.
- `manager.ts`'s internals beyond the quoted `authorizeCredential` / `authorizeUser` bodies
  (`:102-170`), which I read directly with line numbers. The member-list schema and the
  `003-space-access` migration I also read directly. What I did *not* read: `checkManagingApp`'s
  body, the reader/transactor SQL, and the `notifyWrite` fan-out persistence.
- `getRepo`'s CAR contents: I saw the bytes and the CBOR structure in the raw dump but did not
  run `verifyRepoCarFull` over them. Likewise I did not verify the `listRepoOps` signed commit
  with `verifyCommit`, so the LtHash/commit crypto is unverified by me.

### Inferred (flag before relying on it)

- **"Per-collection read is impossible"** now rests on four independently verified facts, not
  an inference about absence: (i) the credential JWT carries no collection claim — I decoded a
  real one; (ii) the member row is `{space, did, read, write}` in the migration and the
  interface; (iii) every read handler routes through `assertSpaceRead` →
  `assertCredentialSpace`, which is a single `credentials.space !== spaceUri` string compare;
  and (iv) the scope type system makes `{action:'read', collection}` unrepresentable. I also
  demonstrated it empirically (one credential, two collections). I consider this settled. What
  remains un-audited is the handful of read endpoints I neither called nor opened
  (`getRecord`, `listBlobs`, `getLatestCommit`, `getBlob`) — a second agent reported they use
  the same helper, which I did not personally confirm.
- **Cross-PDS behaviour was not exercised by me.** Both accounts lived on one PDS, so the
  authority and the repo host were the same process, and `fireNotifyWrite` took its in-process
  short-circuit rather than the service-auth path. The claims that a repo host trusts a
  credential without consulting a member list, that `notifyWrite` crosses hosts with service
  auth, and that a syncer reads each member's own PDS are read from source — but note they are
  also covered by upstream tests I read rather than ran
  (`packages/pds/tests/space/auth.test.ts:167-188`, "reads another member repo across PDSes"),
  which raises my confidence without making it first-hand. Running
  `pnpm --filter @atproto/dev-env start:multi-pds` (3 PDSes) is the obvious next step; I did not
  do it, and it is the single biggest gap in this lab.
- **"Ownership is not delegable"** is inferred from `assertSpaceOwner` being a DID equality
  check and from the absence of any co-owner field in the lexicons. I did not search for an
  out-of-band mechanism.
- The claim that the hosted service holding the school DID key therefore holds sole admin
  power follows from the above inference, not from anything I ran.
- Weekly-drop cadence, the hosted alpha PDS, and the BPS invite gate are from the brief, not
  independently confirmed.
