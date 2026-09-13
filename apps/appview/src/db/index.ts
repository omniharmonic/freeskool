import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { config } from '../config.js'
import { schema } from './schema.js'

export type Db = NodePgDatabase<typeof schema> & { $client: pg.Pool }

let pool: pg.Pool | undefined
let db: Db | undefined

export function getPool(connectionString = config().DATABASE_URL): pg.Pool {
  return (pool ??= new pg.Pool({ connectionString, max: 10 }))
}

export function getDb(): Db {
  return (db ??= drizzle(getPool(), { schema }) as Db)
}

export async function closeDb(): Promise<void> {
  await pool?.end()
  pool = undefined
  db = undefined
}

/** Used by tests: an isolated pool/drizzle pair that does not touch the singletons. */
export function createDb(connectionString: string): { db: Db; pool: pg.Pool } {
  const p = new pg.Pool({ connectionString, max: 4 })
  return { db: drizzle(p, { schema }) as Db, pool: p }
}

export { schema }
