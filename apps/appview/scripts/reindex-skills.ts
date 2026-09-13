/**
 * Ask the indexer to pull every taxonomy record from the authority's repo right now.
 *
 *   AUTHORITY_DID=did:plc:... pnpm --filter @freeschool/appview reindex-skills
 *
 * Why: contrail backfills a repo once and then follows the live stream from "head".
 * Records written to the authority BEFORE the AppView (re)started — a reseed of
 * `infra/seed/skills/skills-seed.jsonl`, for instance — are neither in the backfill
 * (already completed) nor in the live stream (older than head). `notify()` is the
 * read-your-writes path the propose-a-skill route uses for one record; this runs it
 * for the whole seed. Idempotent. Prints counts only.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../src/config.js'
import { getIndexer } from '../src/index/indexer.js'
import { isMain } from '../src/lib/is-main.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SEED = path.resolve(here, '../../../infra/seed/skills/skills-seed.jsonl')

export async function reindexSkills(authorityDid = config().AUTHORITY_DID, seedPath = SEED): Promise<number> {
  if (!authorityDid) throw new Error('AUTHORITY_DID is not set')
  const ids = fs
    .readFileSync(seedPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { id: string })
    .map((r) => r.id)
  const indexer = await getIndexer()
  const BATCH = 25 // contrail: max 25 URIs per notify()
  for (let i = 0; i < ids.length; i += BATCH) {
    const uris = ids.slice(i, i + BATCH).map((id) => `at://${authorityDid}/freeschool.draft.skill/${id}`)
    await indexer.notify(uris)
  }
  return ids.length
}

if (isMain(import.meta.url)) {
  const n = await reindexSkills()
  console.log(`reindex-skills: notified ${n} taxonomy records`)
  process.exit(0)
}
