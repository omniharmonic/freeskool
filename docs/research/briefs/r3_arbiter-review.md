---
author: "Benjamin Life (@omniharmonic)"
date: "2026-09-12"
status: "draft"
brief: "r3"
type: "research"
title: "R3 \u2014 The Arbiter review"
recommendation: "wrap for v1, pilot Phase 2"
source_commit: "muni-town/arbiter@16583192de93b8718594ba59841d3b994548aabe"
visibility: "public"
parachute_path: "vault/projects/local-alternatives/free-school/research/r3_arbiter-review"
parachute_id: "2026-09-12-19-17-57-127238"
tags: ["atproto", "free-school", "local-alternatives", "research"]
---

# R3 — The Arbiter review

*Benjamin Life (@omniharmonic) · 2026-09-12 · status: draft · brief R3*

**Verified against:** `github.com/muni-town/arbiter` @ `16583192de93b8718594ba59841d3b994548aabe`, authored 2026-09-12 11:04:55 −0500 ("Refactor the way records are cached to reduce pressure on PDS"), cloned to `scratchpad/research/r3_arbiter/`. Repo created 2026-04-09; GitHub description: *"Experimental arbiter for community account management in the Atmosphere."*

---

## TL;DR

1. **The Arbiter in the blog post is not the Arbiter in the repo.** The spaces/roles/8-access-level/delegation model from zicklag's first post (2026-07) was deleted by an explicit "total rewrite" (`SERVER_PLAN.md` §1, §9). `listSpaces`, `getSpaceMembers`, `setSpaceMemberAccess`, `createSpace`, `resolveSpaceMembers`, `getArbiterConfig` — all gone. The surviving lexicon surface is **three procedures, one recovery procedure, and five records**. There is **no membership API and no role model in the Arbiter today**.
2. **What it actually is now:** a single-tenant-per-account **Rego-policy-gated XRPC proxy that holds a PDS credential for a "stewarded account" and executes requests as that account.** That is *precisely and only* the "write-as-the-school" mechanism — the one thing we already decided to own in v1.
3. **Our roles are ours either way.** `coop.lexicon.membership` has no counterpart in the Arbiter. The reference policy reads a flat DID list (`town.muni.arbiter.simple.admins`) and nothing else. Adopting the Arbiter does not save us from writing the membership/role/threshold logic; it only relocates *where the school's signing credential lives*.
4. **Blocking defects for a Free School dependency:** **no LICENSE file at all** (none in the tree, no `license` field in any manifest, GitHub API reports `license: null`); single-instance-only by design (no HA); steward PDS passwords stored **in plaintext**; the hosted instance's `did:web` document **404s right now**; and the manager UI **cannot write the `simple.admins` record its own reference policy depends on** (open TODO).
5. **Recommendation: WRAP for v1, PILOT in Phase 2 (Q4 2026), behind one port.** Build a `SchoolActorPort` with a required `scope` argument and an arbiter-shaped response envelope on day one. The v1 adapter uses the app-held school credential; the Phase 2 adapter swaps in the `<scope>.arbiter.proxy` flow with **no call-site changes**. Full interface in [Recommendation](#recommendation).
6. **Holmgren's endorsement is directional, not a standards commitment.** He endorses the *principle* ("put the genericness in the governance layer and keep the spaces themselves particular") and explicitly leaves *who hosts arbiters* open — PDS? app? every community-focused app? — and flags migration between arbiter implementations as the priority. That is an argument for a seam, not for adoption.

---

## What it is

An **arbiter is named after the single account it stewards** — there is no separate "arbiter DID" vs "community DID" (`SERVER_PLAN.md` §1). One `arbiter-server` process stewards many accounts. For each, it holds a PDS credential (an app password for an imported account, or a server-generated random password for an account it created) in a local Turso/libSQL file, and will execute XRPC requests **as that account** when policy allows.

Discovery is **by PDS record, not DID document** — the `#arbiter` service endpoint was deliberately removed from stewarded DID docs:

```
steward repo: town.muni.arbiter.service/self  { did: "did:web:arbiter.example.com" }
                → resolve that DID doc → #arbiter service endpoint → server URL
```

Accepted caveat in the plan: discovery couples to PDS availability.

Authorization is **two layers of Rego**, evaluated per request:

- **Layer 1 — scope gate.** The request arrives at `<scope>.arbiter.proxy`. Strip `.arbiter.proxy` → the scope NSID must be *exactly* one entry in the steward's `town.muni.arbiter.config/self.trustedScopes`. Then resolve the scope's **permission-set lexicon** and evaluate the Rego embedded at `defs.main["x-town-muni-arbiter"].policy` as a pure predicate (`data.arbiter.allow` → boolean) over the request core `{method, nsid, parameters, body, encoding}` only — **no host functions, no caller/arbiter DIDs visible**. Anything other than `true` denies.
- **Layer 2 — community pipeline.** The ordered `at://` `policyLayers` from the config record, each a `town.muni.arbiter.policy/<rkey>` record of Rego source. Outcome vocabulary: `{"pass":true}` → next layer; `{"ok":true,"output":…}` → handle; `{"ok":false,"error":{status,error}}` → deny; `{"handleBuiltin":true}` → hand to the server's built-in handler. **Falling off the end denies (fail-closed).** Layers may call the `xrpc` host function, which executes **as the steward**.

Everything is hot-reloaded over an **unfiltered Jetstream subscription** (default `jetstream1.us-east.bsky.network`), rev-gated by a per-arbiter `rev_floor` captured from `getRepoStatus`. A broken or absent config record leaves the arbiter **offboarded** — it refuses all requests until repaired.

Three architectures in five months (May → Sept 2026): spaces + access levels → root/sub policy records → pipeline + scopes. Each transition was a documented "hard cut" with no migration path.

---

## XRPC surface (complete)

Every file in `lexicons/town/muni/arbiter/` at this commit. Auth for all four procedures is a **serviceAuth JWT** (`com.atproto.server.getServiceAuth`) with `aud` = the arbiter **server's** DID (bare or `<did>#arbiter`) and `lxm` = the called NSID; max token age 5 min, max clock skew 30 s (`auth.rs:38,42`).

### Procedures

| NSID | Purpose | Input | Output | Errors |
|---|---|---|---|---|
| `town.muni.arbiter.proxy` | Owner/manager path. Proxies an inner XRPC request through the steward's policy, executed as the steward. Documents the body shape shared by the whole `*.arbiter.proxy` family. | `{arbiterDid: did, target: "did#service", method: str, nsid: str, parameters?: unknown, body?: unknown, encoding?: str}` — `body` accepts `{"$bytes": <base64>}` for raw blobs | The inner XRPC response body (open object) | `ErrPermissionDenied` |
| `<scope>.arbiter.proxy` (wildcard family, e.g. `community.lexicon.authCalendar.arbiter.proxy`) | **The app path.** Same body shape. Routed by the `/xrpc/{nsid}` catch-all on the `.arbiter.proxy` suffix (`handlers.rs:75,361`). Gated by `trustedScopes` + the permission-set-embedded scope policy *before* the community pipeline. | identical to `proxy` | inner response body | 403 on untrusted scope, unresolvable/uncompilable permission set, scope denial, or scope-eval error (all fail-closed) |
| `town.muni.arbiter.createArbiter` | Provision a **brand-new** stewarded PDS account: `createAccount` against a configured default PDS with a configured invite code + random password; store creds; write `service/self` + `recovery/self`. Writes **no** policy — the arbiter stays offline until configured. | *(none — caller identity from serviceAuth)* | `{did: did}` | `ErrPermissionDenied`, `ErrProvisioningFailed` |
| `town.muni.arbiter.createAppPasswordArbiter` | **Import an existing account** as a steward. Caller supplies an app password proving control. Same record writes; no policy written; offline until configured. | `{arbiterDid: did, appPassword: str}` | `{ok: bool}` | `ErrPermissionDenied`, `ErrArbiterAlreadyExists`, `ErrProvisioningFailed` |
| `town.muni.arbiter.installPolicy` | **Append-only** config change: append ONE policy layer by `at://` reference at the END of the pipeline (lowest priority) and union trusted scopes. Never writes policy records; never removes or reorders. Approved either by recovery-admin bypass **or** by a pipeline layer returning `{"handleBuiltin":true}`. CAS-guarded `putRecord` (swapCommit) on `config/self`, then re-onboard. | `{arbiterDid: did, trustedScopes: str[] (required, may be empty), policy?: at-uri}` | `{ok: bool}` | `ErrPermissionDenied`, `ErrInvalidPolicy` |
| `town.muni.arbiter.resetConfig` | **Recovery hatch.** Replace `config/self` wholesale, verbatim, shape-validated only. **Never** evaluates the pipeline; works while offboarded. Recovery-admin only. This is also the *bootstrap* path for both setup flows. | `{arbiterDid: did, trustedScopes: str[], policyLayers: at-uri[]}` | `{ok: bool}` | `ErrPermissionDenied` |

No `deleteArbiter`: teardown is driven by the `service/self` record (absent → stop serving, keep credentials; repointed elsewhere → stop serving **and purge credentials**).

### Records

| NSID | rkey | Shape | Role |
|---|---|---|---|
| `town.muni.arbiter.service` | `self` | `{did: did}` | Discovery + lifecycle. Points at the arbiter server's DID. |
| `town.muni.arbiter.config` | `self` | `{trustedScopes: str[], policyLayers: at-uri[]}` | The whole authorization configuration. One record = atomic install, one Jetstream collection. |
| `town.muni.arbiter.policy` | any (= policy name) | `{policy: str}` (Rego source) | One pipeline layer. May live in **any** repo — shared app-owned policies are the same shape elsewhere, referenced by `at://`. |
| `town.muni.arbiter.recovery` | `self` | `{did: did}` | **Ultimate trust root.** Single DID. Re-read from the repo on every `installPolicy`/`resetConfig` call; rewriting it rotates the admin. |
| `town.muni.arbiter.simple.admins` | `self` | `{admins: did[]}` | **Day-to-day adminship, as read by the reference policy only.** Not server-enforced. Fetched via the `xrpc` host fn on every request. |

---

## Role model

**There isn't one in the server.** This is the single most important finding for us.

### What exists today

`policies/arbiter/default-policy.rego` (111 lines) is the entire shipped authorization model, and it is **binary**:

- caller DID ∈ `town.muni.arbiter.simple.admins.admins`, **or** caller DID == steward DID → admin;
- admin + NSID starts with `town.muni.arbiter.` → `{"handleBuiltin": true}`;
- admin + anything else → proxied to `<steward>#atproto_pds` as the steward;
- everyone else, and any failed admins-record fetch → **403 deny**.

No levels. No hierarchy. No delegation. No "can add members at or below your own rank." And this file is **only a reference template** — per `TODO.md`, *"Decision — no shipped default policy; bootstrap is operator-provided."* It is compiled by `crates/arbiter-core/tests/default_policy.rs` and nothing else. Worse, an open TODO notes the manager UI has **no surface to create or edit the `simple.admins` record the template depends on**.

### The 8-level ladder is legacy

`policies/arbiter/access-levels.rego` (430 lines) still contains the blog post's ladder:

```
ReadMemberList 0 · IsMember 1 · AddMembers 2 · RemoveMembers 3
ConfigureSpace 4 · CreateSpaces 5 · RemoveSpace 6 · Owner 7
```

…plus `min_access` attenuation, `$admin`-space inheritance, `space:<type>/<key>` recursive expansion capped at depth 9, and cross-arbiter delegation via `"<arbiterDid>|<spaceType>|<spaceKey>"` member entries resolved through `xrpc_remote`. **But every NSID it authorizes was deleted** (`town.muni.arbiter.getSpaceMembers`, `setSpaceMemberAccess`, …), and the only live references to the file are in `arbiter-simulator/src/lib/simulator.ts` and its test. It is a **dead demo artifact**. Treat the 8 levels as design vocabulary we may borrow, not as an API we can call.

### The two real trust tiers

1. **Recovery admin** — one DID in `recovery/self`. Server-enforced identity gate (not policy-evaluated) on `installPolicy` and `resetConfig`. Works while the arbiter is offline. This is the lockout escape hatch.
2. **Whatever the policy says** — entirely ours to author. The policy sees `{callerDid, arbiterDid, pdsEndpoint, xrpcEndpoint, method, nsid, parameters, body, encoding}` and can `xrpc()` out to read any record to make its decision.

**Implication for us:** a Rego layer reading our `coop.lexicon.membership` records is exactly as much work as the v1 TypeScript authorization we are writing anyway — and it is *additional* work, in a second language, with a 100 ms execution budget (`policy.rs:39`) and a 12-remote-call ceiling (`handlers.rs:213`).

---

## Write-as-group flow

How a calendar app actually gets a scoped "write-as-the-school" credential. This is the design's best idea and the reason to keep the seam.

**Prerequisites (one-time, per school):**

1. The school account is stewarded: its repo carries `service/self` → the arbiter server's DID, and the server holds its password.
2. **Publish a permission-set lexicon** for the scope, e.g. `school.freeskool.authCalendar`. Resolution follows the atproto lexicon-publication spec exactly (`permission_set.rs`): authority = all NSID segments except the last, reversed (`school.freeskool.authCalendar` → `freeskool.school`) → DNS TXT `_lexicon.freeskool.school` carrying `did=…` → resolve that DID's `#atproto_pds` → `com.atproto.repo.getRecord(collection: com.atproto.lexicon.schema, rkey: <full NSID>)`, and the record's `id` must equal the requested NSID.
3. Inside that lexicon, `defs.main["x-town-muni-arbiter"] = { policy: "<rego>" }` — a host-fn-free predicate on `{method, nsid, parameters, body, encoding}`, entrypoint `data.arbiter.allow`, that confines the scope to calendar writes (e.g. `nsid == "com.atproto.repo.putRecord"` and `parameters.collection == "community.lexicon.calendar.event"`).
4. Add `school.freeskool.authCalendar` to the school's `trustedScopes` (via `installPolicy` append, or `resetConfig` wholesale).

**Per-request flow:**

```
(1) App OAuths the *user* (a steward) against the *user's own PDS*, requesting
      include:school.freeskool.authCalendar
    or the raw scope
      rpc:school.freeskool.authCalendar.arbiter.proxy?aud=did:web:arbiter.example.com#arbiter
    The PDS consent screen renders title/detail from the permission-set lexicon.

(2) App → user's PDS:  POST /xrpc/school.freeskool.authCalendar.arbiter.proxy
    header  atproto-proxy: did:web:arbiter.example.com#arbiter
    body    { arbiterDid: "<school did>",
              target:     "<school did>#atproto_pds",
              method:     "POST",
              nsid:       "com.atproto.repo.putRecord",
              parameters: null,
              body:       { repo, collection: "community.lexicon.calendar.event",
                            rkey, record: {...}, swapRecord? } }

(3) PDS validates the token's rpc: scope (lxm + aud), mints a serviceAuth JWT
    (iss = user DID, aud = <server did>#arbiter, lxm = the scoped NSID, ~60s exp)
    and forwards to the arbiter.

(4) Arbiter verifies the JWT against the *caller's PDS signing key*, checks
    aud ∈ {server_did, server_did#arbiter} and lxm == path NSID.

(5) Layer 1: strip `.arbiter.proxy` → scope ∈ trustedScopes? → resolve the
    permission-set lexicon → evaluate embedded Rego → must be boolean true.

(6) Layer 2: community pipeline, with callerDid/arbiterDid/pdsEndpoint in input.

(7) On allow, the policy's own `xrpc(...)` call executes against the school's
    PDS **using the stored steward session** → the record is written BY the school DID.
```

**The answer to "what token does the app present?"** — *never a school credential.* The app presents the **user's** OAuth/DPoP access token to the **user's own PDS**. The PDS mints a short-lived serviceAuth JWT signed by **the user's PDS key**, naming the arbiter server as audience and the scoped NSID as `lxm`. The school's actual password never leaves the arbiter server's local Turso file. The scope is carried *in the NSID itself* — the design deliberately "stretches" atproto OAuth by encoding the capability into the method name so the existing `rpc:` scope machinery enforces it.

**Three consequences for us:**

- The app's OAuth client metadata must enumerate every scope it will ever use (see the manager's own `scope:` line in `.github/workflows/deploy-manager.yml` for the shape).
- The design is **sidecar-clean**: the calendar event stays a plain `community.lexicon.calendar.event` written by the school DID. Nothing is extended. Our curation/moderation records sit alongside it. ✔ consistent with our settled composition rule.
- Layer 1 depends on **two things that are not shipped**: atproto permission sets, and lexicon resolution over DNS TXT. And `x-town-muni-arbiter` is explicitly a *"documented arbiter-side convention,"* not a standard — the plan's own open items flag *"confirm lexicon schemas tolerate extra keys."*

---

## Running cost

Two deployables. Note that **`arbiter-manager` is the cheap one** and `arbiter-server` is the one with real cost.

### `arbiter-manager` — near zero

Static SvelteKit SPA + a WASM build of `arbiter-core`, deployed to **GitHub Pages** (`deploy-manager.yml`), configured by two public env vars (`PUBLIC_ARBITER_URL`, `PUBLIC_ARBITER_DID`). No backend, no database. Public instance points at `https://arbiter.muni.town` / `did:web:arbiter.muni.town`. **$0/mo**, CI-only ops. Same for `arbiter-simulator`.

### `arbiter-server` — one small always-on VM, plus real operational burden

| Dimension | Detail |
|---|---|
| Artifact | Single static Rust binary, `musl` → `alpine:3`, `EXPOSE 8203`. `cargo build -p arbiter-server --release`. |
| Runtime deps | axum 0.8 / tokio / moka cache / **regorus 0.11** (Rego VM) / **turso 0.8.0-pre.2** (note: pre-release) / `atproto-identity,-oauth,-record,-jetstream 0.14.5` / atrium-api. |
| External services | **Jetstream** (persistent outbound WebSocket, unfiltered, default `jetstream1.us-east.bsky.network`); **PLC directory** (`plc.directory`) for DID resolution; every steward's PDS; a **default PDS + invite code** *only* if you want `createArbiter`. |
| Storage | Local Turso/libSQL file (`./data/arbiter-server.db`) holding **steward PDS passwords and DID keys**. Needs a persistent volume + backups. |
| TLS | **None built in** — a reverse proxy is required (accepted round-1 review finding H4). |
| DID | You must serve a `did:web` document with an `#arbiter` service endpoint at your host's `/.well-known/did.json`. The server does not serve it. |
| **Scale ceiling** | **Single instance only**, by design (`SERVER_PLAN.md` §11): *"Two replicas loading the same arbiter diverge on policy and race on `createArbiter`."* No HA, no horizontal scale, no leader election. A restart cold-fetches every steward's records (the `cache.db` persistence fix is deferred). |
| Per-request cost | Resolve caller PDS signing key + steward PDS (both moka-cached). **Plus one extra PDS `getRecord` per request** if your policy reads an authz record the way the reference template does — caching explicitly deferred in `TODO.md`. |
| Hard limits | request body 2 MiB; response body 8 MiB; proxied response 8 MiB; ≤12 remote xrpc calls per policy run; 100 ms Rego execution; 32 concurrent proxies; `createArbiter` 1 per caller per 60 s; Jetstream cursor resume window 18 h. |
| Cash | ~1× 1 vCPU / 512 MB–1 GB VM + small volume + reverse proxy ≈ **$5–15/mo** at our scale. Idle Rego/moka footprint is small; `TODO.md` flags *"Regorus VM memory at scale — measure at 4k-arbiter scale"* as unmeasured. |

**Accepted risks carried by the operator** (all documented in-repo, not bugs): steward passwords stored **in plaintext** (encryption at rest "intentionally dropped from the production bar for now"); **permissive CORS**, deliberately; PDS signing-key cache finding M10 "NOT fixed" per `local-review-context.md`; TOCTOU between pipeline evaluation and the CAS'd config write; the Jetstream reverse-index window where a policy write landing mid-load is missed until the next event or restart; and the discovery coupling to steward-PDS availability.

**The operational failure mode that matters most for a community service:** the arbiter is **fail-closed on config**. A malformed `config/self`, an unresolvable `at://` policy layer, a policy that fails to compile, or a sustained PDS outage during load → the school is **offboarded and every write 403s** until the recovery admin calls `resetConfig`. For Free School that is a school that cannot publish its own class schedule, recoverable only by one designated DID.

---

## Maturity and license

**Maturity: working code, pre-production, actively churning.**

- Commit `1658319`, dated **today** (2026-09-12). Five commits in the last three days, all PDS-load/caching hardening. The scopes-and-pipeline rewrite landed **2026-09-08/09** — four days ago.
- `arbiter-core` is described as "essentially finished" and is tested. The server was rewritten from scratch and has integration tests (mock PDS + mock Jetstream, CAS and rev-gating covered).
- **Not yet deployed at scale.** `TODO.md` has a live **"Pre-deployment (Roomy cutover, 4k spaces)"** section: Roomy's existing Rego must be rewritten for the new engine (the `policy` host fn and root/sub model were removed); every space is **offline/fail-closed until it has a config record**; `trustedScopes` must be seeded or scoped endpoints 403. That cutover has not happened.
- **The reference policy is not operable from the UI.** Open TODO: *"Admins-record editor… policies that fetch it (the reference template does) have no UI surface to create/update it."*
- **Hosted instance partially up.** `https://arbiter.muni.town/xrpc/town.muni.arbiter.proxy` → **401** (live, auth required). But `https://arbiter.muni.town/.well-known/did.json` → **404**, so `did:web:arbiter.muni.town` does not currently resolve — the documented `aud` for every serviceAuth token. The manager SPA at `muni-town.github.io/arbiter/arbiter-manager/` → **200**.
- **Project signals:** 2 stars, 0 forks, **0 open issues** (work is tracked in `docs/scratchpad/ai/TODO.md`, not the issue tracker), 1 contributor (Zicklag), `main` only. Description self-labels **"Experimental."** Zicklag's own words on the scope design: *"on the wild and experimental side."*

**Known open issues, verbatim from `TODO.md`:** Roomy policy rewrite; per-space cutover path undecided; `trustedScopes` seeding; no shipped default policy; missing admins-record editor; PolicyTab duplicate-URI dedupe and stale-load guard; remote-reference UX; Jetstream reverse-index window; **structural namespace enforcement for non-trusted scopes deferred** (first pass whitelists only); `town.muni.arbiter.proxy` retention undecided; Regorus VM memory at 4k scale unmeasured; per-request policy-record read caching deferred; `cache.db` persistence deferred. Plus, from the design doc's own risks: the permission-set extension key is unconfirmed against the spec, and lexicon resolution (DNS TXT + well-known) is new infra `resolver.rs` does not yet do.

**License: NONE. This is a blocker.**

- No `LICENSE`, `LICENCE`, or `COPYING` file anywhere in the tree.
- No `license` or `license-file` field in the workspace `Cargo.toml`, `crates/*/Cargo.toml`, `package.json`, or `arbiter-manager/package.json`.
- GitHub API: `"license": null`.

A public repo with no license grants **no rights to use, copy, modify, or distribute**. For a project whose premise is "free, open-source," we cannot vendor, fork, self-host, or ship a derived Rego policy from this repo until Zicklag adds an explicit license. **Action: ask him directly; this is almost certainly an oversight** (Muni Town's other work is open), and it is a one-line fix that unblocks Phase 2.

**Holmgren's commentary** ("Modeling communities on permissioned data," `dholms.leaflet.pub/3mndhk7ihsc2g`): endorses the *layer*, not the *implementation*. He highlights "a general-purpose interoperable group-management service that sits on top of permissioned spaces" hosting community DIDs and exposing standard APIs for spaces, membership and roles, and frames the principle as *"put the genericness in the governance layer and keep the spaces themselves particular"* — ecosystem standardization should emerge in community-management tooling rather than in universal data structures. His open questions are exactly ours: should arbiters be hosted **by PDSs** (stateless, via OAuth credentials) or **by individual applications**? Should deploying an arbiter be expected of every community-focused app? How does a user manage communities "scattered across a bunch of different apps" once many arbiters exist? And he stresses **prioritizing migration between arbiter implementations**. Note the tension with the repo: Holmgren floats *stateless, OAuth-credentialed* arbiters; the implementation is *stateful, storing plaintext PDS passwords*. That gap is unresolved and is a live reason not to bet v1 on the current shape.

---

## Recommendation

> **v1 (October 2026): WRAP.** Ship app-held custody behind a `SchoolActorPort`. Do not run or depend on an arbiter.
> **Phase 2 (Q4 2026): PILOT, then adopt conditionally.** Stand up an `ArbiterAdapter` against one non-production school once the gate conditions below are met. Keep both adapters in the codebase indefinitely — the port is permanent, the backend is not.

### Why not adopt in v1

1. **It contradicts a settled decision, or else doubles our ops.** Adopting `arbiter.muni.town` means *Muni Town* custodies the school DID, not the hosted Free School service. Running our own `arbiter-server` instead means taking on an unlicensed, single-instance, plaintext-credential Rust service plus a persistent Jetstream consumer, ~6 weeks before ship.
2. **It buys us the one thing we already own, and none of what we actually need.** The membership/role/delegation model — the reason the Arbiter was interesting — was deleted. We write `coop.lexicon.membership` authorization either way. Adopting adds a second policy language on top.
3. **The differentiating feature isn't ready.** Layer-1 scoping depends on unshipped permission sets, new lexicon-resolution infra, and a non-standard extension key. Structural namespace enforcement is explicitly deferred.
4. **Fail-closed + single-instance + one recovery DID is the wrong risk profile for a community's first October.** A bad policy record takes the school's calendar offline, recoverable only by one DID, on a service with no HA.
5. **Three architectures in five months.** Whatever we integrate against today is unlikely to be the interface in Q1 2027. Holmgren's own priority — migration between arbiter implementations — is the strongest available argument for coding against a port rather than a product.

### Why not simply wait

The swap is cheap **only if the seam exists before the code is written**. Retrofitting "every school-authored write goes through one chokepoint, carries a scope, and returns a policy-shaped envelope" into a shipped app is expensive; doing it now costs roughly one afternoon. And the Arbiter is genuinely the right long-term home: the permission-set-scoped OAuth flow gives users a real consent screen for "this calendar app may write events as Boulder Free School" — something our v1 app-held credential cannot offer at all.

### The wrapper interface

One port, two adapters. Call sites only ever see the port.

```ts
// packages/school-actor/src/port.ts
type Did = `did:${string}`;
type Nsid = string;
type AtUri = `at://${string}`;

/** Every school-authored mutation in the product goes through this. No exceptions. */
export interface SchoolActorPort {

  /** Where the school's signing authority currently lives. */
  describeActor(i: { schoolDid: Did }): Promise<{
    schoolDid: Did;
    pdsEndpoint: string;
    custody: 'app-owned' | 'arbiter';
    arbiterServerDid?: Did;        // v1: undefined
    arbiterUrl?: string;           // v1: undefined
    online: boolean;               // arbiter: service+config+pipeline all resolvable
  }>;

  /** The ONE write primitive. Mirrors the arbiter proxy body 1:1 on purpose. */
  actAs(i: {
    schoolDid: Did;
    callerDid: Did;                       // the steward initiating (never the school)
    scope: Nsid;                          // REQUIRED in v1 even though v1 ignores it
    target?: `${Did}#${string}`;          // default `${schoolDid}#atproto_pds`
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    nsid: Nsid;                           // inner XRPC, e.g. com.atproto.repo.putRecord
    parameters?: Record<string, unknown>;
    body?: unknown;                       // `{ $bytes: base64 }` for blobs
    encoding?: string;                    // default application/json
    idempotencyKey?: string;
    audit: {
      reason: string;
      approvals?: { stewardDid: Did; at: string; sig?: string }[]; // two-steward threshold
    };
  }): Promise<ActResult>;

  // --- sugar over actAs; both adapters inherit these unchanged ---
  putRecordAsSchool(i: { schoolDid: Did; callerDid: Did; scope: Nsid;
    collection: Nsid; rkey: string; record: unknown; swapRecord?: string | null;
    audit: Audit }): Promise<{ uri: AtUri; cid: string; auditId: string }>;
  deleteRecordAsSchool(i: { schoolDid: Did; callerDid: Did; scope: Nsid;
    collection: Nsid; rkey: string; swapRecord?: string; audit: Audit }): Promise<{ auditId: string }>;
  uploadBlobAsSchool(i: { schoolDid: Did; callerDid: Did; scope: Nsid;
    bytes: Uint8Array; encoding: string; audit: Audit }): Promise<{ blob: unknown; auditId: string }>;

  // --- authorization: OUR model in v1; advisory mirror of Rego in Phase 2 ---
  authorize(i: { schoolDid: Did; callerDid: Did; action: SchoolAction; subject?: AtUri | Did }):
    Promise<{ allowed: boolean; role: 10|20|30|40|0; reason: string;
              requiresApprovals?: number }>;         // 2 for destructive actions
  listMembers(i: { schoolDid: Did; minRole?: number; cursor?: string }):
    Promise<{ members: { did: Did; role: number; via: AtUri }[]; cursor?: string }>;
  setMemberRole(i: { schoolDid: Did; callerDid: Did; subject: Did; role: 10|20|30|40;
    audit: Audit }): Promise<{ auditId: string }>;

  // --- the grant: the ONLY method whose return shape differs between adapters ---
  mintScopedGrant(i: { schoolDid: Did; callerDid: Did; audienceClientId: string;
    scope: Nsid; ttlSeconds?: number }): Promise<
      | { kind: 'app-internal'; grantId: string; scope: Nsid; expiresAt: string }
      | { kind: 'arbiter-scope'; grantId: string; scope: Nsid;
          proxyNsid: Nsid;            // `${scope}.arbiter.proxy`
          oauthScope: string;         // `rpc:${scope}.arbiter.proxy?aud=${serverDid}#arbiter`
          proxyHeader: string;        // `${serverDid}#arbiter` → atproto-proxy
          expiresAt?: string }>;
  revokeScopedGrant(i: { schoolDid: Did; grantId: string }): Promise<{ revoked: boolean }>;
}

/** Deliberately the arbiter's own envelope, so v1 UI already handles policy denials. */
type ActResult =
  | { ok: true;  status: number; output: unknown; auditId: string }
  | { ok: false; status: number; error: string; message?: string; auditId: string };

type Audit = { reason: string; approvals?: { stewardDid: Did; at: string }[] };
```

**`AppCustodyAdapter` (v1).** `actAs` → `authorize()` against `coop.lexicon.membership` → enforce the two-steward threshold for destructive actions → write the audit row → execute the inner XRPC with the school's own session (app-held credential). `mintScopedGrant` returns `kind:'app-internal'`: a capability row in our DB keyed `(clientId, scope)` with no network token. `describeActor` returns `custody:'app-owned'`.

**`ArbiterAdapter` (Phase 2).** `actAs` → `getServiceAuth({ aud: arbiterServerDid, lxm: \`${scope}.arbiter.proxy\` })` from the *caller's* PDS → `POST <callerPds>/xrpc/<scope>.arbiter.proxy` with `atproto-proxy: <arbiterServerDid>#arbiter` and body `{arbiterDid: schoolDid, target, method, nsid, parameters, body, encoding}` → return the envelope verbatim. `authorize()` becomes **advisory only** (it still drives UI affordances; the Rego layer is the enforcer). `mintScopedGrant` returns `kind:'arbiter-scope'` with the `rpc:` string the app adds to its OAuth client metadata.

**Invariants that must hold in v1 or the swap is not cheap:**

| # | Invariant | Why |
|---|---|---|
| 1 | **Zero** direct uses of the school session outside `actAs`. Lint this. | A single bypass becomes an un-migratable write path. |
| 2 | `scope` required on every call, even though v1 ignores it. | It becomes `trustedScopes` verbatim. Retrofitting scopes means auditing every call site. |
| 3 | `target` always `{did}#{serviceId}`, never a bare URL. | That is the arbiter's `target` format. |
| 4 | Responses use the `{ok,…} \| {ok:false,error:{status,error,message}}` envelope. | Deny paths exist in v1 UI; Phase 2 adds no new UI states. |
| 5 | One inner XRPC per `actAs`. No multi-call transactions. | Policy budget: 12 remote calls, 100 ms Rego. |
| 6 | Respect 2 MiB request / 8 MiB response now. Blobs as `{$bytes}`. | Arbiter hard caps. |
| 7 | CAS everywhere (`swapRecord`/`swapCommit`), never blind overwrite. | Matches the arbiter's own write discipline. |
| 8 | `authorize()` is a **pure function of records** (membership + config), no DB-only state. | It must be transliterable to Rego. Any hidden state is untranslatable. |
| 9 | Audit row carries `{callerDid, schoolDid, scope, nsid, decision, policySource}`; `policySource` = `'app:v1'` now, an `at://…/town.muni.arbiter.policy/<rkey>` later. | Audit log stays continuous across the swap. |
| 10 | Threshold approvals live in a **record** (an approvals sidecar), not in app memory. | A Rego layer can read a record; it cannot read our process state. |

### Role mapping: `coop.lexicon.membership` → Arbiter

| `coop` role | Our name | Legacy ladder (`access-levels.rego`, **retired** — vocabulary only) | How it is actually expressed on an Arbiter today |
|---|---|---|---|
| — | public / anon | `ReadMemberList` (0) | No credential. Plain public PDS reads; never touches the arbiter. |
| **10** | learner / member | `IsMember` (1) | Not in `simple.admins`. Our Rego layer reads `coop.lexicon.membership` and permits only self-authored records (RSVPs, attestations) — written by the *user's own* repo, not as the school. |
| **20** | teacher / host | `AddMembers` (2) + `ConfigureSpace` (4), scoped to own offerings | Our Rego layer: allow `putRecord`/`deleteRecord` on `community.lexicon.calendar.event` where the rkey is owned by this caller. Scope-gated to `school.freeskool.authCalendar`. |
| **30** | steward | `RemoveMembers` (3) + `ConfigureSpace` (4) + `CreateSpaces` (5) + `RemoveSpace` (6) | Listed in `town.muni.arbiter.simple.admins` (or our equivalent record). Rego allows moderation/curation NSIDs as the school. **Destructive actions require 2-of-N approvals read from an approvals record.** |
| **40** | root / founder | `Owner` (7) | Designated in `town.muni.arbiter.recovery/self` — the `installPolicy`/`resetConfig` gate. |

**Two mapping hazards, both of which argue for keeping thresholds in our layer:**

- `recovery/self.did` is a **single DID**, not a set. Our **two-steward threshold for destructive actions cannot be expressed at role 40** on the Arbiter. It must live in a policy layer reading an approvals record — i.e. in *our* logic — in v1 *and* Phase 2. Design it as a record now.
- Levels 20 and 30 have **no server-side representation at all**. The Arbiter's only native distinction is admin / not-admin. Everything between `IsMember` and `Owner` is Rego we write. Budget it as "port our authorizer to Rego," not "configure the Arbiter."

### Phase 2 gate conditions

Pilot when ≥4 hold; adopt in production when all hold:

1. **An explicit OSI license on `muni-town/arbiter`.** Hard prerequisite. Ask now — it is likely a one-line fix and it is the cheapest item on this list.
2. Roomy's **4k-space cutover completed in production** — the `TODO.md` "Pre-deployment" section closed. That is the scale proof we cannot generate ourselves.
3. **Permission sets + lexicon resolution shipped in the PDS**, or we consciously accept running layer 2 only (community pipeline, no scope gate) — which still gives us custody separation but no user-visible consent screen.
4. **Credential encryption at rest**, or we self-host and accept plaintext on a volume we control with a documented key-compromise runbook.
5. Either **multi-instance support**, or an accepted SPOF with a written recovery runbook that a non-engineer steward can execute (the `resetConfig` path, rehearsed).
6. A **resolvable `did:web`** for whichever instance we use — currently `did:web:arbiter.muni.town/.well-known/did.json` is a 404.
7. An **admins/roles record editor** exists, or we ship our own UI for whichever record our Rego layer reads.

---

## Sources

**Primary — repo** (`muni-town/arbiter` @ `16583192de93b8718594ba59841d3b994548aabe`, 2026-09-12, cloned to `scratchpad/research/r3_arbiter/`):

- `SERVER_PLAN.md` — §1 identity/routing, §2 serviceAuth, §3 policy context, §4 policy storage/hot-reload/lifecycle, §5 Turso + plaintext tradeoff, §6 bootstrap, §7 recovery, §8 axum, **§9 lexicon cleanup (the deletions)**, §10 testing, §11 multi-instance out of scope.
- `lexicons/town/muni/arbiter/{config,createAppPasswordArbiter,createArbiter,installPolicy,policy,proxy,recovery,resetConfig,service}.json` and `lexicons/town/muni/arbiter/simple/admins.json` — complete surface.
- `policies/arbiter/default-policy.rego` (current binary admin model); `policies/arbiter/access-levels.rego` (retired 8-level ladder; referenced only by `arbiter-simulator/src/lib/simulator.ts`).
- `docs/scratchpad/ai/arbiter-scopes-policy-pipeline.md` — the 10 locked decisions, end-to-end request flow, `community.lexicon.authCalendar` worked example, open risks.
- `docs/scratchpad/ai/TODO.md` — Roomy cutover, missing admins editor, deferred caching/persistence, deferred namespace enforcement, accepted behaviors.
- `docs/scratchpad/ai/STATUS.md` — "arbiter-core is essentially finished"; PDS-as-datastore.
- `crates/arbiter-server/src/config.rs` — every deployment flag and its default. `crates/arbiter-server/src/handlers.rs:75,83,88,213,361,432` — routing, size caps, remote-call cap, handoff depth, scoped-proxy flow. `crates/arbiter-server/src/auth.rs:38,42,161–226` — token age, skew, `aud`/`lxm` checks. `crates/arbiter-server/src/permission_set.rs` — the `x-town-muni-arbiter` convention and DNS-TXT lexicon resolution. `crates/arbiter-core/src/policy.rs:39` — 100 ms Rego budget. `crates/arbiter-server/Cargo.toml` — dependency set.
- `Dockerfile`, `compose.yaml`, `.github/workflows/deploy.yml`, `.github/workflows/deploy-manager.yml` (hosted URLs + production OAuth scope string), `arbiter-manager/.env.example`, `arbiter-manager/src/lib/arbiter.ts` (client method surface), `arbiter-manager/PRODUCT.md`, `local-review-context.md` (round-1 security review findings and accepted decisions), `Cargo.toml` (no `license` field).
- `git log` 2026-05-27 → 2026-09-12 (architecture churn); `GET api.github.com/repos/muni-town/arbiter` → `license: null`, 2 stars, 0 forks, 0 open issues, created 2026-04-09.

**Primary — posts:**

- zicklag, "The Arbiter — Group Management for Permissioned Spaces and Beyond," <https://zicklag.leaflet.pub/3mjrvb5pul224> — the 8 access levels, unified space model, delegation, `$admin`/`$publish`/`$labeler`, Quint spec status.
- zicklag, "Arbiter Progress Report 4," 2026-09-04, <https://zicklag.leaflet.pub/3muq24tg6lc2a> — arbiter scopes, permission sets, policy pipeline, calendar example, "hasn't been prototyped yet," "wild and experimental."
- Daniel Holmgren, "Modeling communities on permissioned data," <https://dholms.leaflet.pub/3mndhk7ihsc2g> — the endorsement and its open questions.

**Live checks, 2026-09-12:** `https://arbiter.muni.town/xrpc/town.muni.arbiter.proxy` → 401; `https://arbiter.muni.town/.well-known/did.json` → 404; `https://muni-town.github.io/arbiter/arbiter-manager/` → 200.

---

## Confidence / not verified

**High confidence (read directly from the repo at a pinned commit):** the complete lexicon surface and every input/output shape; the deletion of the space/member/role XRPCs; the two-layer Rego model and its outcome vocabulary; the serviceAuth mechanics (`aud`, `lxm`, 5 min / 30 s); all numeric limits; the config/record scheme; the deployment shape, flags, and dependency set; single-instance-by-design; plaintext credentials; the absence of any license; the write-as-group request flow.

**Medium confidence:**

- **Cost figures ($5–15/mo)** are my estimate from the artifact shape (static musl binary + libSQL file + one WebSocket), not a measured benchmark. No memory or throughput numbers exist — `TODO.md` itself lists Regorus VM memory at scale as unmeasured.
- **The blog posts were read via WebFetch summarization, not raw HTML.** The 8 access levels and the scope design are corroborated by `access-levels.rego` and `arbiter-scopes-policy-pipeline.md` respectively, so the substance is cross-checked; exact wording of any quotation from the posts should be re-read before publication.
- **Holmgren's position** comes from one post, fetched as a summary. I did not find the specific Bluesky thread in which he "endorsed it as the natural place for a community-management standard"; the post I did verify endorses the *layer* and leaves hosting open. If a stronger, more specific endorsement exists, it should be located and quoted directly — the recommendation does not change either way, but the framing would.

**Not verified:**

- **No second zicklag post beyond Progress Report 4** was searched for exhaustively; there may be a Progress Report 5. `arbiter-scopes-policy-pipeline.md` names PR4 as its source and is dated 2026-09-04, while the repo's last design change is 2026-09-10, so a more recent post may exist.
- **I did not build or run the server.** `cargo build` / `cargo test` were not executed; test coverage claims come from `SERVER_PLAN.md` §10, `TODO.md`, and `local-review-context.md` rather than observed test runs.
- **I did not exercise the hosted instance.** The 401 proves a live service; it does not prove the scoped-proxy or permission-set path works end to end. **No published permission-set lexicon with an `x-town-muni-arbiter` key was located anywhere** — so layer 1 appears to have never run against a real published scope. Worth confirming with zicklag before Phase 2.
- **Whether a Free School school DID created by our hosted service can later be imported** into an arbiter via `createAppPasswordArbiter` without losing history: the lexicon implies yes (app password proves control; records persist), and `local-review-context.md` records the decision "App-password holders may take over stewards." **Not tested.** This is the single most important thing to validate early, since the entire wrap strategy assumes it.
- **License intent.** I am reporting the absence of a license as fact; I have not asked Zicklag and have no basis to guess what he will choose.
- Exact Roomy cutover status beyond what `TODO.md` says; whether `blog.roomy.space`'s GA announcement implies the new engine is in production.
