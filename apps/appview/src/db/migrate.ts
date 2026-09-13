/**
 * Runs the drizzle migrations for our `fs_*` tables, then lets contrail create its
 * own schema (`contrail.init()`), which is idempotent.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { closeDb, getDb } from './index.js'
import { createIndexer } from '../index/indexer.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const MIGRATIONS_FOLDER = path.resolve(here, '../../drizzle')

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER })
  const indexer = await createIndexer()
  await indexer.init()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runMigrations()
  console.log('migrations applied (fs_* via drizzle, contrail schema via contrail.init())')
  await closeDb()
}
