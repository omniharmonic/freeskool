# Runbook: the multi-school migration (federation Task 2 + Task 3)

Author of record: Benjamin Life (@omniharmonic). Applies to migrations `0011`, `0012` and
`0013` on `apps/appview`. Design authority: `docs/superpowers/specs/2026-09-13-multi-school-design.md`
(MS §4, §9) and `docs/superpowers/specs/2026-09-14-federation-phase-design.md`.

## The one thing that matters

**This is not a rolling deploy.** Take the app down, migrate, deploy, back-fill, bring it
up. `0012` changes five primary keys and a unique index, and the code on either side of it
disagrees about what they are:

| Table | Old key | New key | Old code's write |
|---|---|---|---|
| `fs_attendance_tally` | `(did)` | `(did, school_did)` | `ON CONFLICT (did) DO UPDATE` |
| `fs_steward` | `(did)` | `(did, school_did)` | `ON CONFLICT (did) DO UPDATE` |
| `fs_newsletter_subscription` | `(did)` | `(did, school_did)` | `ON CONFLICT (did) DO UPDATE` |
| `fs_peer` | `(host)` | `(school_did, host)` | `ON CONFLICT (host) DO UPDATE` |
| `fs_attestation` | unique `(attester, subject, skill)` | `+ school_did` | `ON CONFLICT (attester, subject, skill)` |

Postgres resolves an `ON CONFLICT (cols)` target against an index that covers exactly
those columns. Once the migration lands there is no such index, so **every one of those
writes from an old process raises `there is no unique or exclusion constraint matching the
ON CONFLICT specification` — a 500, immediately.** Two instances of the old code taking
attendance during a rolling deploy is not a slow failure; it is every attendance save on
that instance erroring until it is replaced.

The reverse is also true: new code against the pre-`0012` schema fails the same way on the
widened targets. So the migration and the deploy are one atomic step with the app stopped.

`0011` and `0013` are both additive (new tables, new columns with non-volatile defaults)
and are safe in either order relative to the deploy. They are listed here only because
they run in the same `db:migrate` pass.

## Order

1. **Stop the app.** Every instance. Jobs included (`pg-boss` workers write
   `fs_attendance_tally` through `bumpTally`).
2. **Back up.** `pg_dump` before a key change, always.
3. **Migrate.** `pnpm --filter @freeschool/appview db:migrate`. Applies `0011`
   (schools, memberships, credentials, `school_did` everywhere), `0012` (the keys above)
   and `0013` (`fs_membership.public_role`).
4. **Deploy the new code.** Do not start it yet if your platform separates the two; if it
   does not, starting here is fine — step 5 is safe with the app up.
5. **Back-fill.** `pnpm --filter @freeschool/appview backfill-school`. This
   - writes the `fs_school` / `fs_school_domain` rows from `SCHOOL_DID` / `SCHOOL_HANDLE`,
   - imports `SCHOOL_APP_PASSWORD` into `fs_school_credential`, wrapped under `CUSTODY_KEYS`,
   - copies `fs_member` (+ `fs_member_prefs.directory_listing` and `.public_role`) into
     `fs_membership`,
   - stamps `school_did` on every per-school table, in batches of 5 000 by `ctid`.

   It is idempotent (`ON CONFLICT DO NOTHING`, and every update is guarded by
   `school_did = ''`), prints counts only, and can be re-run **while the legacy school is
   still the only school**. Once a second school exists it refuses to run at all — a
   re-run's `fs_member` sweep can no longer assume every member belongs to the legacy
   school, so it would otherwise fabricate a legacy membership for a member who has since
   joined only the new school. Pass `--force` only after confirming that is not happening;
   `copyMemberships` is additionally narrowed to members with no `fs_membership` row
   anywhere, so even a forced re-run cannot conscript a member who already belongs
   somewhere.
6. **Verify.** `pnpm --filter @freeschool/appview privacy-audit`, plus a spot check that
   `SELECT count(*) FROM fs_attendance_tally WHERE school_did = ''` is `0`.
7. **Only then** create a second school. Not before — see below.

`MULTI_SCHOOL` stays `0` throughout. Flipping it is a separate change (federation Task 4's
sessions and routing land first), and it is a pure config flip with no schema behind it.

## Why the back-fill must precede the second school

Between `0011` and the back-fill, rows written before this phase carry
`school_did = ''`. `apps/appview/src/lib/school-scope.ts` reads `''` as *"the legacy
school, and no other"* — it widens the filter to include those rows **only when the school
being queried IS the env-configured one**. That is correct and safe: a second school can
never see an unstamped row.

But it is a transition rule, not a resting state. Two consequences until step 5 runs:

- every per-school query carries an extra `OR school_did = ''` for the legacy school;
- `bumpTally` and `newsletter-subscriptions#subscribe` have to UPDATE against that widened
  predicate before inserting, because the new PKs let `('x','')` and `('x','did:plc:…')`
  coexist and a naive stamped upsert would fork one person's history into two rows.

Both are handled in code, and both disappear once nothing is unstamped.

## Rollback

- **After `0011`/`0013`, before `0012`:** nothing to do. Both are additive; old code
  ignores the new tables and columns.
- **After `0012`:** rolling back the CODE alone does not work — the old `ON CONFLICT`
  targets no longer exist. Roll back the migration too:

  ```sql
  ALTER TABLE fs_attendance_tally DROP CONSTRAINT fs_attendance_tally_did_school_did_pk;
  ALTER TABLE fs_attendance_tally ADD  PRIMARY KEY (did);
  -- …same shape for fs_steward, fs_newsletter_subscription;
  -- fs_peer back to PRIMARY KEY (host);
  DROP INDEX fs_attestation_unique;
  CREATE UNIQUE INDEX fs_attestation_unique
      ON fs_attestation (attester_did, subject_did, skill_uri);
  ```

  Each `ADD PRIMARY KEY` fails if the back-fill (or a second school) has produced two rows
  for one DID. That is the real point of no return, and it is why step 7 is last: **once a
  second school exists, `0012` is not reversible.**
- The `school_did` values the back-fill wrote are harmless to old code, which never reads
  the column. There is no un-stamp step and there should not be one.

## Testing this, before and after

Four suites cover this migration, in the order you would reach for them.

**1. The migration itself, from a fixture.** `apps/appview/test/migration-fixture.test.ts`
creates a throwaway database, replays `drizzle/meta/_journal.json` **up to `0010`** (the
last migration before the federation phase), loads
`apps/appview/test/fixtures/pre-federation-rows.sql` — a real single-school deployment's
worth of rows — then runs `0011`…HEAD and `backfill-school` over it and asserts the result:
every scoped table stamped and nothing left at `''`, one `fs_membership` row per
`fs_member` carrying that member's own `directory_listing` and `public_role`, the four
tables that already held a real `school_did` untouched, a second run stamping nothing, and
the existing suites' invariants (`roleOf`, `listMembers`, per-school vouches) still true on
the migrated database.

The schema comes from the journal on purpose: a checked-in `pg_dump` of the old schema is
a second copy of the migrations and rots the first time somebody adds a column.

**2. The flag, both ways.** The same suite ends with `MULTI_SCHOOL` off and on against the
migrated database: with the flag **off** an unknown host is still the legacy school (the
pre-federation answer, i.e. the rollback works *after* the migration has run); with it
**on** and only one school, an unknown host still resolves (which is what makes the flip a
non-event for a city with no neighbour); with it on and a second `fs_school` row present,
an unknown host is `404 UnknownSchool` — never 403.

**3. Tenant isolation, route by route.** `apps/appview/test/tenant-isolation.test.ts`: two
schools, three members and a steward of one who is an ordinary member of the other, and a
ROUTE TABLE asked on both hosts. Every route asserts both halves — none of the other
school's rows, **and** its own school's row present, so an endpoint that returns nothing
cannot pass trivially. Adding a route is one line. A second table pins the handful of
surfaces that are global on purpose (the skill taxonomy, published profiles, the public
practitioner directory) as answering identically on both hosts, so they cannot drift in
either direction unnoticed.

**4. Two schools end to end.**

```
pnpm --filter @freeschool/appview seed:demo --schools boulder,denver
pnpm --filter @freeschool/web exec playwright test e2e/multi-school.spec.ts
```

The seed creates Denver through the real `createSchool`, gives it a policy that asks for
one attended class before hosting, and puts Maya in both cities with the same profile and
claims and different vouches, RSVPs and derived role — Host in Boulder, Member in Denver.
`apps/appview/.demo-users.json` gains `school` and `schools` per persona.

**A dev-stack caveat that is not a product bug.** In production every city is a subdomain
of one registrable domain and `SESSION_COOKIE_DOMAIN=.freeskool.xyz` carries the session
across the school switcher's hop. Locally the cities are `*.localhost`, and **Chromium
refuses a cookie with `Domain=localhost` or `Domain=.localhost` outright** — it stores
nothing at all, so no configuration of the dev AppView can make one session span
`boulder.localhost` and `denver.localhost`. The dev AppView therefore runs with
`SESSION_COOKIE_DOMAIN=` (host-only cookies, one per city) and the e2e journey asserts the
server half of the switch (`POST /api/auth/switch-school` moves the session and names the
host) plus the navigation, then signs in through the second city's own door. Nothing about
production changes.

**5. The privacy audit, per school.**

```
pnpm --filter @freeschool/appview privacy-audit              # every school, then the whole PDS
pnpm --filter @freeschool/appview privacy-audit --school=did:plc:…
```

Each school gets its own report over its own repos with **its own** consent gates
(`fs_membership.public_role` and that school's `thresholds.publishRoles` — never another
school's), plus MS §10.3's two cross-tenant assertions: no scoped `fs_*` row left unstamped
or naming a school that is not in `fs_school` (reported once, under the legacy school,
because an unstamped row is that school's by `school-scope.ts`'s rule), and no public
response on a school's own host naming a DID whose only membership is in another school.
An unscoped run finishes with the whole-PDS sweep, so a repo belonging to no school is
still audited.

## Two things that went wrong on the dev box, and what they mean for production

Both were found by running this migration out of order on the development stack — the app
served traffic for a day on the new code before anybody back-filled it. **Step 5 before
step 7 is not bureaucracy**, and here is what it prevents:

1. **A vouch forked instead of being adopted.** `fs_attestation`'s unique index gained
   `school_did` in `0012`, so a pre-tenancy row (`school_did = ''`) no longer collides with
   a stamped insert for the same (attester, subject, skill). A re-vouch in that window
   created a SECOND row — inflating the subject's count — and then `backfill-school` failed
   with a unique violation trying to stamp the older one. `createAttestation` now adopts the
   unstamped row first (the same discipline `bumpTally` and `subscribe` already followed),
   for the legacy school and no other.
2. **`fs_peer` was never stamped at all, and then could not be.** It was missing from
   `STAMPED_TABLES`, so `PEER_PDS_HOSTS` seed rows stayed at `''` forever. Adding it
   revealed the second half: `seedPeersFromEnv` writes the legacy DID explicitly on the new
   code, so a host can have both `('', host)` and `(<legacy>, host)` — and `fs_peer`'s
   primary key CONTAINS `school_did`, so stamping the first collides with the second.
   `backfill-school` now drops the shadowed unstamped row before stamping, and reports how
   many it dropped.

A third thing is worth knowing rather than fixing: **`backfill-school` maps every
`fs_member` row to the legacy school**, which is exactly right for pre-tenancy data and
wrong for anybody who joined a second school after the flag went on. Running it late (after
a second school exists) therefore quietly makes those members members of the legacy school
too. It is the same reason step 7 is last, stated from the other side.

## What this runbook does not cover

Flipping `MULTI_SCHOOL=1`, the neutral PDS hostname migration
(`docs/runbooks/pds-hostname-migration.md`), and the relay switch
(`docs/runbooks/relay-switch.md`) are separate, independently reversible steps.
