/**
 * pg-boss wiring. One schedule per job, plus two continuous workers.
 *
 *   materialize-series   daily  02:10 UTC
 *   reminders            minutely
 *   retention            daily  03:30 UTC
 *   newsletter           monthly, 1st at 09:00 UTC (composes a draft only)
 *   notify-outbox        every minute: drains contrail's transactional change log
 *   push-outbox          every minute: drains our notification outbox
 *
 * pg-boss creates its own schema (`pgboss`), separate from both our `fs_*` tables and
 * contrail's, so the three migrate independently.
 */
import { PgBoss } from 'pg-boss'
import { config } from '../config.js'
import { log } from '../lib/logging.js'
import { materializeAllSeries } from './materialize-series.js'
import { runReminders } from './reminders.js'
import { runRetention } from './retention.js'
import { runMonthlyNewsletter } from './newsletter.js'
import { deliverOutbox } from '../notifications/dispatch.js'
import { drainOutbox } from '../index/outbox.js'
import { getIndexer } from '../index/indexer.js'

export const QUEUES = {
  materializeSeries: 'materialize-series',
  reminders: 'reminders',
  retention: 'retention',
  newsletter: 'newsletter',
  notifyOutbox: 'notify-outbox',
  pushOutbox: 'push-outbox',
  backfill: 'backfill',
} as const

export async function startJobs(): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: config().DATABASE_URL, schema: 'pgboss' })
  boss.on('error', (err: unknown) => log.error('pg-boss error', { detail: String(err) }))
  await boss.start()

  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue)
  }

  await boss.work(QUEUES.materializeSeries, async () => {
    const res = await materializeAllSeries()
    log.info('materialized series', { ...res })
  })
  await boss.work(QUEUES.reminders, async () => {
    const res = await runReminders()
    if (res.queued > 0) log.info('reminders queued', { ...res })
  })
  await boss.work(QUEUES.retention, async () => {
    await runRetention()
  })
  await boss.work(QUEUES.newsletter, async () => {
    await runMonthlyNewsletter()
  })
  await boss.work(QUEUES.notifyOutbox, async () => {
    const indexer = await getIndexer()
    // Drain in bounded rounds so one tick cannot run away.
    for (let i = 0; i < 5; i++) {
      const res = await drainOutbox(indexer)
      if (res.claimed === 0) break
    }
  })
  await boss.work(QUEUES.pushOutbox, async () => {
    const res = await deliverOutbox()
    if (res.delivered + res.failed > 0) log.info('notifications delivered', { ...res })
  })
  await boss.work(QUEUES.backfill, async () => {
    const indexer = await getIndexer()
    const res = await indexer.backfillFromPeers()
    log.info('peer backfill complete', { ...res })
  })

  await boss.schedule(QUEUES.materializeSeries, '10 2 * * *')
  await boss.schedule(QUEUES.reminders, '* * * * *')
  await boss.schedule(QUEUES.retention, '30 3 * * *')
  await boss.schedule(QUEUES.newsletter, '0 9 1 * *')
  await boss.schedule(QUEUES.notifyOutbox, '* * * * *')
  await boss.schedule(QUEUES.pushOutbox, '* * * * *')
  // Until `PdsChangeSource` exists (src/sync/README.md), a periodic backfill IS our
  // liveness floor for other people's writes.
  await boss.schedule(QUEUES.backfill, '*/15 * * * *')

  log.info('jobs started', { queues: Object.values(QUEUES).length })
  return boss
}
