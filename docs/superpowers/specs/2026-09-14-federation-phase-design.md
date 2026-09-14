# Federation phase: multi-school, peers, firehose, neutral PDS

Date: 2026-09-14. Author of record: Benjamin Life (@omniharmonic). Status: approved for autonomous execution. Authority for the multi-school design is `docs/superpowers/specs/2026-09-13-multi-school-design.md` (sections cited as MS §n); for publication tiers, `docs/interop-audit.md`; for UX leftovers, `docs/plans/refinement-ux-audit.md`.

## 1. Why

Benjamin, 2026-09-14: "We'll get to implementing the firehose. We should publish peers in the school record. PDS hostname should be made neutral according to the design. Let's merge the PRs and handle deployment and then produce an implementation plan based on the findings of the reports, execute it, and do e2e testing on all our outputs. This is the final long-running step before we have a fully functioning, federated free skool system."

PR #2 is merged and released (see `docs/deployment.md`). This phase builds MS §11 phases 1–6, publishes the school's peer list, prepares the relay switch, migrates the PDS to a neutral hostname once a domain is chosen, closes the engineering-owned interop and UX leftovers, and proves all of it with a tenant-isolation suite, two-school persona journeys and a per-school privacy audit.

## 2. Rulings on MS §12 (Benjamin's answers and the controller's defaults)

| # | Question | Ruling |
|---|---|---|
| 1 | Who may start a school | `SCHOOL_CREATION=closed`: operator script only. No self-serve in this phase. |
| 2 | Apex Boulder or network | Apex `freeskool.xyz` stays Boulder's app. `boulder.freeskool.xyz` serves the handle well-known AND the Boulder app (MS §3 inversion). New cities get `<city>.freeskool.xyz`. A network front door is a later phase. |
| 3 | Move the handle domain | Yes, with the PDS: one neutral domain hosts the PDS (`pds.<neutral>`) and member handles (`<name>.<neutral>`). Benjamin picks the domain; the migration is designed and scripted here (MS §3, §9) and executed when the domain exists. Existing DIDs are updated through the PDS's own PLC signing path. |
| 4 | Per-school handle domains | Refused in this phase. One neutral handle domain. |
| 5 | Cross-school vouches | Scoped per school (R9). No double-opt-in record yet. |
| 6 | Taxonomy power | Stewards keep "deprecate/move" (the taxonomy operator is Benjamin's own schools for now). Per-school "hide here" is Phase 7, deferred. |
| 7 | Cross-school aggregates | No. Nothing about school B is served to a member of school A except public records. |
| 8 | COhere double-listing | Benjamin's question for Aaron Gabriel; code dedupes nothing. |
| 9 | Publish `peers` | Yes, per school, in `freeschool.draft.school` (`peers`, `tags`), written by the school actor when a steward edits peers. |
| 10 | Leaving a school | `left_at` hides the member from that school's directory and skill-page people, retracts the published role claim if any, keeps their classes on that calendar (public records they wrote). |
| 11 | When | Now, branch `federation`, flag `MULTI_SCHOOL` default `0` until the two-school e2e suite is green. |

Firehose: production sets `PDS_CRAWLERS=https://bsky.network` at the end of this phase, after the neutral hostname is live, so the first records the network sees carry the neutral endpoint. Until then `docs/interop-audit.md` gap 1 stays "decided: yes, pending hostname".

## 3. Scope (build order = MS §11)

1. **Caddy inversion and reserved labels** (MS §3): handle hosts serve only `/.well-known/atproto-did` from the PDS; everything else on `*.freeskool.xyz` goes to the app; `GET /internal/tls-check` on the AppView answers the on-demand `ask`; reserved labels shared by the handle generator, handle chooser and school creation.
2. **Schema** (MS §4, §9 A–C): `fs_school`, `fs_membership`, `fs_school_credential` (encrypted under `CUSTODY_KEYS`), `school_did` on every per-school table, backfill from `SCHOOL_DID`, additive migrations, rollback documented.
3. **Tenant threading** (MS §5, Appendix A): `currentSchool(c)` replaces every `config().SCHOOL_DID` read; `SchoolActorPort` registry keyed by school; policy, roles, stewards, peers, proposals, attestations, directory prefs scoped per school; `MULTI_SCHOOL=0` means "one school, new code paths live".
4. **Sessions and routing** (MS §3): `fs_session.current_school_did`; host → school resolution (`fs_school_domain`); cookie `Domain=.freeskool.xyz`; OAuth stays on the apex; school picker for members of several schools.
5. **School lifecycle** (MS §8): `scripts/create-school.ts` becomes `POST /api/schools` behind `SCHOOL_CREATION=closed` (operator token) plus founder steward bootstrap; `GET /api/schools` (public: name, city, handle, tags); leaving a school (ruling 10).
6. **Federation** (MS §7, interop gaps 4a/4b): `peers`/`tags` published in the school record and re-published on steward edits; `PUT /api/admin/peers` updates the record through the school actor; peer registry per school; peer AppViews' school records indexed and shown as "Nearby schools"; cross-school listing routing with per-school tags.
7. **Neutral PDS hostname migration** (MS §3, ruling 3): runbook + `scripts/migrate-pds-hostname.ts` (dry-run; per account: sign and submit the PLC operation for the new service endpoint and handle through the PDS; verify resolution), Caddy/DNS steps, `PDS_HOSTNAME`/`PDS_SERVICE_HANDLE_DOMAINS` change, handle rewrite for custodial accounts, tests against the dev PDS. Executed on production only after Benjamin names the domain.
8. **Firehose readiness**: `PDS_CRAWLERS` documented and staged; a `scripts/verify-relay.ts` that reads Jetstream for the school DID's records; production flip at the end.
9. **Interop leftovers**: validate every borrowed record we write against the community and coop lexicon JSON in tests (gap 6); document what remains Lucian's (gap 7).
10. **UX leftovers**: explain what a vouch is inline (journey 12); "Ask <name> to teach this" from a profile creates a request tagged app-side to that member and notifies them (13); admin vocabulary help text and newsletter preview always visible (14–15); collapse welcome cards 2–3 behind Next (7); final-review nits 6, 7, 9.
11. **Testing** (MS §11 test plan): tenant-isolation suite driven by a route table; two-school demo seed (`seed:demo --schools boulder,denver`); `apps/web/e2e/multi-school.spec.ts` (Maya in both; Denver steward gets nothing on Boulder); `privacy-audit --school=<did>`; migration fixture test; full regression (unit, e2e personas, mvp, audit).

## 4. Non-goals

Custom domain aliases and per-school skill curation (MS Phase 7); self-serve school creation; cross-school vouches; a network front door on the apex; internationalization.

## 5. Acceptance

With `MULTI_SCHOOL=1` on localhost: two seeded schools on `boulder.localhost`-style hosts (or header-based host selection in dev); Maya sees both, switches, and her vouches/RSVPs/role differ; a Denver steward has no steward power on Boulder; every list endpoint passes the isolation suite; the per-school privacy audit reports zero violations; the school record on the dev PDS carries `peers` and `tags`; the hostname migration script completes a dry run and a real run against the dev PDS; all existing suites stay green; `docs/deployment.md` carries the production runbook for the flag flip, the hostname migration and the relay switch.
