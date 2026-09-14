/**
 * Vitest global setup: the DB-backed suites TRUNCATE shared `fs_*` tables, so they must
 * never point at the database the dev AppView (and the demo seed) use. `vitest.config.ts`
 * pins `DATABASE_URL` to `freeschool_test`; this creates that database if it is missing
 * and applies the migrations (fs_* via drizzle, contrail schema via contrail.init()).
 * Set `DATABASE_URL` explicitly to run the suite somewhere else (CI).
 */
import pg from 'pg'

export default async function setup(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://freeschool:freeschool@localhost:5434/freeschool_test')
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
