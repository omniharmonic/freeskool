// Find repos whose newest calendar record was written within the PDS cursor
// replay window (stock PDS_REPO_BACKFILL_LIMIT_MS = 1 day), so the live
// subscribeRepos path can be exercised by replaying from an old cursor.
import fs from 'node:fs'
const resolved = JSON.parse(fs.readFileSync('runs/dids_resolved.json', 'utf8'))
const now = Date.now()
const hits = []
const limit = 8
let i = 0
async function worker() {
  while (i < resolved.length) {
    const r = resolved[i++]
    for (const coll of ['community.lexicon.calendar.event', 'community.lexicon.calendar.rsvp']) {
      try {
        const u = new URL('/xrpc/com.atproto.repo.listRecords', r.pds)
        u.searchParams.set('repo', r.did); u.searchParams.set('collection', coll); u.searchParams.set('limit', '1')
        const res = await fetch(u, { signal: AbortSignal.timeout(15000) })
        if (!res.ok) continue
        const b = await res.json()
        const rec = b.records?.[0]
        if (!rec) continue
        const created = rec.value?.createdAt
        const ageH = created ? (now - Date.parse(created)) / 3.6e6 : Infinity
        if (ageH < 48) hits.push({ did: r.did, handle: r.handle, pds: r.pds, coll, createdAt: created, ageHours: +ageH.toFixed(1), uri: rec.uri })
      } catch {}
    }
  }
}
await Promise.all(Array.from({ length: limit }, worker))
hits.sort((a, b) => a.ageHours - b.ageHours)
console.log(JSON.stringify(hits, null, 1))
