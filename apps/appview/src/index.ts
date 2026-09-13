/**
 * Server entry. Migrate, init the index, start the HTTP server, start the jobs.
 *
 * `FREESCHOOL_NO_JOBS=1` runs HTTP only, which is what the smoke test uses: a minutely
 * cron racing a scripted sequence makes the output unreadable.
 */
import { serve } from '@hono/node-server'
import { config, redactedConfig } from './config.js'
import { createApp } from './http/app.js'
import { runMigrations } from './db/migrate.js'
import { log } from './lib/logging.js'
import { startJobs } from './jobs/index.js'
import { getIndexer } from './index/indexer.js'
import { refreshPolicyCache } from './lib/policy.js'
import { closeDb } from './db/index.js'
import { isMain } from './lib/is-main.js'

export async function main(): Promise<{ close: () => Promise<void> }> {
  const c = config()
  log.info('starting appview', redactedConfig(c))

  await runMigrations()
  const indexer = await getIndexer()
  await indexer.init()
  if (c.SCHOOL_DID) await refreshPolicyCache(c.SCHOOL_DID).catch(() => {})

  const app = createApp()
  const server = serve({ fetch: app.fetch, port: c.APPVIEW_PORT })
  log.info('http listening', { port: c.APPVIEW_PORT })

  const boss = process.env.FREESCHOOL_NO_JOBS === '1' ? undefined : await startJobs()

  const close = async () => {
    await boss?.stop({ graceful: true }).catch(() => {})
    server.close()
    await closeDb()
  }
  return { close }
}

if (isMain(import.meta.url)) {
  const { close } = await main()
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info('shutting down')
      void close().then(() => process.exit(0))
    })
  }
}
