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
   `school_did = ''`), prints counts only, and can be re-run.
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

## What this runbook does not cover

Flipping `MULTI_SCHOOL=1`, the neutral PDS hostname migration
(`docs/runbooks/pds-hostname-migration.md`), and the relay switch
(`docs/runbooks/relay-switch.md`) are separate, independently reversible steps.
