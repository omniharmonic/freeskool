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
import { describeError, log } from './lib/logging.js'
import { startJobs } from './jobs/index.js'
import { getIndexer } from './index/indexer.js'
import { startPeerLiveSync } from './index/live-sync.js'
import { refreshPolicyCache } from './lib/policy.js'
import { ensureLegacySchoolRow } from './lib/schools.js'
import { seedSkillTiers } from './lib/skill-tiers.js'
import { resetDevMailSink } from './lib/mail.js'
import { closeDb } from './db/index.js'
import { isMain } from './lib/is-main.js'

export async function main(): Promise<{ close: () => Promise<void> }> {
  const c = config()
  log.info('starting appview', redactedConfig(c))

  // One run, one dev mail sink (A11) — see `lib/mail.ts#resetDevMailSink`. No-op with SMTP.
  await resetDevMailSink()

  await runMigrations()
  // The env-configured school becomes a `fs_school` row (idempotent, no-op when
  // `SCHOOL_DID` is unset). Must follow the migrations and precede anything that reads
  // the registry. `scripts/backfill-school.ts` is what stamps the existing rows.
  await ensureLegacySchoolRow().catch((err) =>
    log.warn('could not ensure the legacy school row', { detail: describeError(err) }),
  )
  // Idempotent: a fresh deploy enforces the Tier B gate from the first boot, not only
  // once an operator remembers to run it by hand.
  await seedSkillTiers().catch((err) => log.warn('skill-tier boot-seed failed', { detail: describeError(err) }))
  const indexer = await getIndexer()
  await indexer.init()
  if (c.SCHOOL_DID) await refreshPolicyCache(c.SCHOOL_DID).catch(() => {})

  const app = createApp()
  const server = serve({ fetch: app.fetch, port: c.APPVIEW_PORT })
  log.info('http listening', { port: c.APPVIEW_PORT })

  const boss = process.env.FREESCHOOL_NO_JOBS === '1' ? undefined : await startJobs()

  /**
   * Live indexing from the peer registry. Treated as a background worker alongside
   * the jobs, so `FREESCHOOL_NO_JOBS=1` (the smoke test) gets a quiet HTTP-only
   * process, and a failure to attach degrades to the 15-minute backfill rather than
   * taking the server down with it.
   */
  const liveSync =
    boss && c.PEER_LIVE_SYNC
      ? await startPeerLiveSync(indexer).catch((err) => {
          log.warn('peer live sync failed to start; falling back to periodic backfill', {
            detail: describeError(err),
          })
          return undefined
        })
      : undefined

  const close = async () => {
    await liveSync?.stop().catch(() => {})
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
