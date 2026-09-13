import { Hono } from 'hono'
import { sql } from 'drizzle-orm'
import { getDb } from '../../db/index.js'
import type { AppEnv } from '../session.js'
import { config } from '../../config.js'

export const health = new Hono<AppEnv>()

health.get('/api/health', async (c) => {
  const checks: Record<string, 'ok' | 'down'> = {}
  try {
    await getDb().execute(sql`select 1`)
    checks.postgres = 'ok'
  } catch {
    checks.postgres = 'down'
  }
  try {
    const res = await fetch(`${config().PDS_URL.replace(/\/$/, '')}/xrpc/_health`, {
      signal: AbortSignal.timeout(3000),
    })
    checks.pds = res.ok ? 'ok' : 'down'
  } catch {
    checks.pds = 'down'
  }
  const ok = Object.values(checks).every((v) => v === 'ok')
  return c.json(
    {
      status: ok ? 'ok' : 'degraded',
      checks,
      school: Boolean(config().SCHOOL_DID),
      version: '0.0.1',
    },
    ok ? 200 : 503,
  )
})
