/**
 * Backfill `fs_skill_claim_index` from the app-side `skill-claims:<did>` blobs already
 * sitting in `fs_app_meta` (see `PUT /api/me/skill-claims` in `http/routes/me.ts`, the
 * `APP_SIDE_CLAIMS_KEY` array of 'school'-visibility claims).
 *
 *   pnpm --filter @freeschool/appview backfill-skill-claims
 *
 * The index only exists from this migration forward, so every member who saved a
 * 'school'-visibility claim BEFORE it landed has no row for it yet — this walks every
 * `skill-claims:%` key once and fills that in. It does not touch `visibility: 'public'`
 * rows: those are only known from a member's own PUT (or their repo), and this script
 * has no way to see the repo, so it leaves that half of the index for the next PUT to
 * (re)write, same as it always has.
 *
 * Idempotent: per `did`, it replaces only that did's 'school' rows (delete-then-insert in
 * one transaction), so running it twice — or after some members have already PUT through
 * the new code path — never duplicates or stales a row. Prints counts only (R9: no DIDs).
 */
import { and, eq, like } from 'drizzle-orm'
import { getDb, closeDb } from '../src/db/index.js'
import { appMeta, skillClaimIndex } from '../src/db/schema.js'
import { runMigrations } from '../src/db/migrate.js'
import { isMain } from '../src/lib/is-main.js'

const KEY_PREFIX = 'skill-claims:'

interface AppSideClaim {
  skill: string
  level: string
  note?: string
}

export async function backfillSkillClaims(): Promise<{ members: number; rows: number }> {
  const db = getDb()
  const rows = await db.select().from(appMeta).where(like(appMeta.key, `${KEY_PREFIX}%`))

  let members = 0
  let rowsWritten = 0
  for (const row of rows) {
    const did = row.key.slice(KEY_PREFIX.length)
    if (!did) continue
    const claims = Array.isArray(row.value) ? (row.value as AppSideClaim[]) : []
    const now = new Date()

    await db.transaction(async (tx) => {
      await tx.delete(skillClaimIndex).where(and(eq(skillClaimIndex.did, did), eq(skillClaimIndex.visibility, 'school')))
      if (claims.length > 0) {
        await tx.insert(skillClaimIndex).values(
          claims
            .filter((c): c is AppSideClaim => typeof c?.skill === 'string' && typeof c?.level === 'string')
            .map((claim) => ({
              did,
              skillUri: claim.skill,
              level: claim.level,
              visibility: 'school',
              updatedAt: now,
            })),
        )
      }
    })
    members += 1
    rowsWritten += claims.length
  }

  return { members, rows: rowsWritten }
}

if (isMain(import.meta.url)) {
  await runMigrations().catch(() => {})
  const { members, rows } = await backfillSkillClaims()
  console.log(`backfilled skill-claim index: members=${members} rows=${rows}`)
  await closeDb()
}
