/**
 * Backfill the multi-school schema for a deployment that has only ever had one school
 * (MS §9 B). Every existing row belongs to Boulder, so each backfill is a single constant.
 *
 *   pnpm --filter @freeschool/appview backfill-school
 *
 * What it does, in order:
 *   1. `ensureLegacySchoolRow()` — the `fs_school` row from `SCHOOL_DID`/`SCHOOL_HANDLE`,
 *      and its `fs_school_domain` rows (the apex canonical, `<label>.<apex>` alias).
 *   2. imports `SCHOOL_APP_PASSWORD` into `fs_school_credential`, wrapped with
 *      `wrapSecret` under the same versioned `CUSTODY_KEYS` a member's password uses.
 *   3. copies `fs_member` (+ `fs_member_prefs.directory_listing` and `.public_role`) into
 *      `fs_membership`.
 *   4. stamps `school_did` on every per-school table, in batches of 5 000 by `ctid` so no
 *      statement holds a long lock on a big table.
 *
 * IDEMPOTENT: every insert is `ON CONFLICT DO NOTHING` and every update is guarded by
 * `school_did = ''` (the "not yet stamped" value), so a second run writes nothing at all.
 * Pass `--rotate-credential` to re-import the env app password over an existing row —
 * the only non-idempotent thing here, and it is opt-in.
 *
 * Prints counts only (R9: no DIDs in output).
 */
import { sql } from 'drizzle-orm'
import { closeDb, getDb, type Db } from '../src/db/index.js'
import { schoolCredential } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { wrapSecret } from '../src/lib/crypto.js'
import { ensureLegacySchoolRow, legacySchoolDid } from '../src/lib/schools.js'
import { runMigrations } from '../src/db/migrate.js'
import { isMain } from '../src/lib/is-main.js'

/**
 * Every table MS §4 gives a `school_did` to. Tables MS §4 calls global — `fs_member`,
 * `fs_member_prefs`, `fs_custodial_account`, `fs_notification_target`/`_pref`,
 * `fs_skill_tier`, `fs_skill_claim_index`, `fs_event_extra`, `fs_series_occurrence`,
 * `fs_app_meta`, the OAuth stores, the spaces shim — are deliberately absent.
 *
 * `fs_steward`, `fs_invite_link`, `fs_audit` and `fs_policy_cache` already carried the
 * column before this phase and their rows already hold a real DID, so they are swept too:
 * the guard is `school_did = ''`, which matches nothing there, and the sweep is proof of
 * that rather than a change to it.
 */
export const STAMPED_TABLES = [
  'fs_attendance',
  'fs_attendance_rollup',
  'fs_attendance_tally',
  'fs_attestation',
  'fs_audit',
  'fs_feedback',
  'fs_handoff',
  'fs_invite',
  'fs_invite_link',
  'fs_moderation_queue',
  'fs_newsletter_issue',
  'fs_newsletter_subscription',
  'fs_notification_feed',
  'fs_notification_outbox',
  'fs_notification_sent',
  /**
   * `fs_peer` was MISSING here until Task 11's privacy audit went looking for unstamped
   * rows and found one on the dev box. Its `school_did` was nullable before migration
   * 0012, which fills the NULLs with `''` — and nothing then stamped them, so a
   * deployment's `PEER_PDS_HOSTS` seed rows stayed unstamped forever. Harmless while
   * `activePeerHosts()` takes the union across schools (Task 3), but it leaves a row
   * MS §10.3 is right to flag, and `listPeers(schoolDid)` — what a steward sees and
   * edits — only finds it through the legacy school's `''` widening.
   */
  'fs_peer',
  'fs_policy_cache',
  'fs_request_rsvp',
  'fs_rsvp',
  'fs_skill_proposal',
  'fs_steward',
] as const

const BATCH = 5_000

export interface BackfillResult {
  schoolDid: string
  memberships: number
  credential: 'imported' | 'rotated' | 'present' | 'skipped'
  stamped: Record<string, number>
  /** Unstamped `fs_peer` rows dropped because a stamped twin already held the host. */
  shadowedPeers: number
}

export async function backfillSchool(
  options: { rotateCredential?: boolean; db?: Db } = {},
): Promise<BackfillResult> {
  const db = options.db ?? getDb()
  const did = await ensureLegacySchoolRow(
    { name: process.env.SCHOOL_NAME || undefined, city: process.env.SCHOOL_REGION || undefined },
    db,
  )
  if (!did) throw new Error('SCHOOL_DID is not set: there is no legacy school to back-fill from')

  const credential = await importCredential(db, did, options.rotateCredential ?? false)
  const memberships = await copyMemberships(db, did)

  // `fs_peer`'s primary key CONTAINS `school_did`, so an unstamped row cannot simply be
  // updated into place when a stamped twin already exists. See `dropShadowedPeers`.
  const shadowedPeers = await dropShadowedPeers(db, did)

  const stamped: Record<string, number> = {}
  for (const table of STAMPED_TABLES) stamped[table] = await stamp(db, table, did)

  return { schoolDid: did, memberships, credential, stamped, shadowedPeers }
}

/**
 * `fs_peer`'s PK became `(school_did, host)` in migration 0012, and `seedPeersFromEnv`
 * writes the legacy DID explicitly — so a deployment that re-seeded `PEER_PDS_HOSTS`
 * after deploying and before back-filling has TWO rows per host, `('', host)` and
 * `(<legacy>, host)`. Stamping the first would collide with the second on the primary
 * key and abort the whole backfill (observed on the dev box).
 *
 * The unstamped row is the older, less specific copy of the same fact — the same host,
 * the same school, since `''` IS the legacy school — so dropping it loses nothing. It is
 * dropped only where a stamped twin exists; a lone unstamped row is stamped normally.
 * `disabled_at` is respected: a host a steward disabled on the stamped row stays disabled,
 * and the shadow row cannot resurrect it.
 */
async function dropShadowedPeers(db: Db, did: string): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM fs_peer p
     WHERE p.school_did = ''
       AND EXISTS (SELECT 1 FROM fs_peer q WHERE q.host = p.host AND q.school_did = ${did})
  `)
  return result.rowCount ?? 0
}

/**
 * The school actor's app password moves from the environment into the database, wrapped,
 * because there is exactly one `SCHOOL_APP_PASSWORD` env var and there will be more than
 * one school (MS §5). `wrapSecret` picks a fresh IV every call, so re-wrapping an
 * unchanged password would still rewrite the row — hence `ON CONFLICT DO NOTHING` and an
 * explicit opt-in for rotation.
 */
async function importCredential(db: Db, did: string, rotate: boolean): Promise<BackfillResult['credential']> {
  const password = config().SCHOOL_APP_PASSWORD
  if (!password) return 'skipped'
  const wrapped = wrapSecret(password)
  const values = {
    schoolDid: did,
    keyVersion: wrapped.keyVersion,
    appPasswordWrapped: wrapped.blob,
    rotatedAt: new Date(),
  }
  if (rotate) {
    await db
      .insert(schoolCredential)
      .values(values)
      .onConflictDoUpdate({ target: schoolCredential.schoolDid, set: values })
    return 'rotated'
  }
  const inserted = await db
    .insert(schoolCredential)
    .values(values)
    .onConflictDoNothing()
    .returning({ schoolDid: schoolCredential.schoolDid })
  return inserted.length > 0 ? 'imported' : 'present'
}

/**
 * `fs_member` is the global "has ever signed in here" fact; `fs_membership` is the
 * per-school one that replaces it (MS §9 E). `directory_listing` comes across from
 * `fs_member_prefs` — a member who opted OUT of the directory must not be opted back in
 * by the migration — and defaults to `true` for anyone with no prefs row, which is what
 * `GET /api/me` already reports for them.
 */
async function copyMemberships(db: Db, did: string): Promise<number> {
  const result = await db.execute(sql`
    INSERT INTO fs_membership (did, school_did, door, directory_listing, public_role, joined_at, last_seen_at)
    SELECT m.did, ${did}, m.door, COALESCE(p.directory_listing, true), COALESCE(p.public_role, false),
           m.first_seen_at, m.last_seen_at
    FROM fs_member m
    LEFT JOIN fs_member_prefs p ON p.did = m.did
    ON CONFLICT DO NOTHING
  `)
  /**
   * A member who already had a membership row (this task's session path writes one) but
   * whose LEGACY opt-in predates it: carry the old global answer across, once, and only
   * for the legacy school. `AND NOT m.public_role` keeps this idempotent and never
   * downgrades an answer the member has since given through the new column.
   */
  await db.execute(sql`
    UPDATE fs_membership m
       SET public_role = true
      FROM fs_member_prefs p
     WHERE p.did = m.did AND m.school_did = ${did} AND p.public_role AND NOT m.public_role
  `)
  return result.rowCount ?? 0
}

/** One table, batched by `ctid` so no single statement locks a large table for long. */
async function stamp(db: Db, table: string, did: string): Promise<number> {
  if (!/^fs_[a-z_]+$/.test(table)) throw new Error(`refusing to update ${table}`)
  let total = 0
  for (;;) {
    const result = await db.execute(
      sql`UPDATE ${sql.raw(table)} SET school_did = ${did}
          WHERE school_did = '' AND ctid IN (
            SELECT ctid FROM ${sql.raw(table)} WHERE school_did = '' LIMIT ${BATCH})`,
    )
    const n = result.rowCount ?? 0
    total += n
    if (n < BATCH) return total
  }
}

if (isMain(import.meta.url)) {
  await runMigrations().catch(() => {})
  if (!legacySchoolDid()) {
    console.error('SCHOOL_DID is not set; run create-school first')
    process.exit(1)
  }
  const result = await backfillSchool({ rotateCredential: process.argv.includes('--rotate-credential') })
  const rows = Object.entries(result.stamped).filter(([, n]) => n > 0)
  console.log(
    `school row ensured; credential ${result.credential}; memberships ${result.memberships}` +
      (result.shadowedPeers > 0 ? `; shadowed peer rows dropped ${result.shadowedPeers}` : ''),
  )
  console.log(rows.length === 0 ? 'no rows needed stamping' : rows.map(([t, n]) => `${t}=${n}`).join(' '))
  await closeDb()
}
