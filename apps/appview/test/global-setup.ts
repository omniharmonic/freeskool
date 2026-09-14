/**
 * Vitest global setup: the DB-backed suites TRUNCATE shared `fs_*` tables, so they must
 * never point at the database the dev AppView (and the demo seed) use. `vitest.config.ts`
 * pins `DATABASE_URL` to `freeschool_test`; this creates that database if it is missing
 * and applies the migrations (fs_* via drizzle, contrail schema via contrail.init()).
 * Set `TEST_DATABASE_URL` to run the suite somewhere else (CI); `DATABASE_URL` from a
 * sourced .env is deliberately ignored so the dev database is never truncated.
 */
import pg from 'pg'

const TEST_DATABASE_URL = 'postgres://freeschool:freeschool@localhost:5434/freeschool_test'

export default async function setup(): Promise<void> {
  // `test.env` in vitest.config.ts reaches the test workers, not this setup process:
  // pin the variable here too, BEFORE `config()` is first read by the migration import,
  // or the migrations (and contrail's schema) land on the dev database instead.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? TEST_DATABASE_URL
  const url = new URL(process.env.DATABASE_URL)
  const dbName = url.pathname.replace(/^\//, '')
  const admin = new URL(url.toString())
  admin.pathname = '/postgres'
  const client = new pg.Client({ connectionString: admin.toString() })
  try {
    await client.connect()
  } catch {
    return // no Postgres: the suites skip themselves via pgAvailable()
  }
  try {
    const { rows } = await client.query('select 1 from pg_database where datname = $1', [dbName])
    if (rows.length === 0) await client.query(`create database "${dbName}"`)
  } finally {
    await client.end()
  }
  const { runMigrations } = await import('../src/db/migrate.js')
  const { closeDb } = await import('../src/db/index.js')
  await runMigrations()
  await closeDb()
}
