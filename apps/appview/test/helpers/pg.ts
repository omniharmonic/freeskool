/**
 * Postgres test harness.
 *
 * The DB-backed suites need a REAL Postgres, because the whole point of
 * `PostgresSpaceStore` and of the feedback ballot separation is what the database does —
 * `ON CONFLICT DO NOTHING` as an atomic claim, a column that does not exist. A mock would
 * test nothing.
 *
 * If Postgres is unreachable the suite SKIPS with a message that says how to start it,
 * rather than failing: a contributor without Docker should still be able to run
 * `pnpm test` and see the pure suites pass.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { sql } from 'drizzle-orm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDb, type Db } from '../../src/db/index.js'
import type pg from 'pg'

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://freeschool:freeschool@localhost:5434/freeschool'

export const SKIP_MESSAGE =
  `Postgres at ${DATABASE_URL.replace(/\/\/[^@]*@/, '//***@')} is unreachable — skipping the DB-backed suite. ` +
  `Start it with: docker compose -f infra/compose.yml up -d postgres`

const here = path.dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = path.resolve(here, '../../drizzle')

let prepared: { db: Db; pool: pg.Pool } | undefined
let reachable: boolean | undefined

export async function pgAvailable(): Promise<boolean> {
  if (reachable !== undefined) return reachable
  try {
    const { db, pool } = createDb(DATABASE_URL)
    await db.execute(sql`select 1`)
    await migrate(db, { migrationsFolder: MIGRATIONS })
    prepared = { db, pool }
    reachable = true
  } catch {
    reachable = false
  }
  return reachable
}

export function testDb(): Db {
  if (!prepared) throw new Error('call pgAvailable() in beforeAll first')
  return prepared.db
}

export async function closeTestDb(): Promise<void> {
  await prepared?.pool.end()
  prepared = undefined
  reachable = undefined
}

/** Wipe only the tables a suite touches, so suites stay independent. */
export async function truncate(...tables: string[]): Promise<void> {
  const db = testDb()
  for (const t of tables) {
    if (!/^fs_[a-z_]+$/.test(t)) throw new Error(`refusing to truncate ${t}`)
    await db.execute(sql.raw(`TRUNCATE TABLE ${t} CASCADE`))
  }
}
