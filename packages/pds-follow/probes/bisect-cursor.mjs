// Binary-search a PDS's seq space for the cursor whose first replayed event is
// just before a target wall-clock time. Works because seq is monotonic and each
// event carries `time`; lets us replay a narrow historical window instead of the
// whole 24h retention buffer.
import { decodeAll } from '@atproto/lex-cbor'
const [host, targetIso] = process.argv.slice(2)
const target = Date.parse(targetIso)

function firstEventAt(cursor) {
  const url = new URL('/xrpc/com.atproto.sync.subscribeRepos', host.replace(/^http/, 'ws'))
  url.searchParams.set('cursor', String(cursor))
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    const t = setTimeout(() => { ws.close(); resolve({ error: 'timeout' }) }, 20000)
    ws.onmessage = (e) => {
      const [h, b] = [...decodeAll(new Uint8Array(e.data))]
      if (h.op === -1) { clearTimeout(t); ws.close(); return resolve({ error: b.error }) }
      if (h.t === '#info') return // OutdatedCursor notice precedes the replay
      clearTimeout(t); ws.close()
      resolve({ seq: b.seq, time: b.time, t: h.t })
    }
    ws.onerror = () => { clearTimeout(t); resolve({ error: 'ws' }) }
    ws.onclose = () => { clearTimeout(t) }
  })
}

// establish head
const head = await firstEventAt(1)  // oldest retained
console.log('oldest retained:', JSON.stringify(head))
let lo = head.seq
let hi = (await (async () => {
  const r = await fetch(new URL('/xrpc/com.atproto.sync.getLatestCommit?did=did:plc:ewvi7nxzyoun6zhxrhs64oiz', host)).catch(() => null)
  return null
})()) ?? null
// probe forward for an upper bound
let probe = lo
let step = 1_000_000
let upper = null
while (upper === null && step >= 1) {
  const r = await firstEventAt(probe + step)
  if (r.error === 'FutureCursor') { step = Math.floor(step / 2) } else { probe += step; if (Date.parse(r.time) > target) { upper = probe } }
  if (step === 0) break
}
hi = upper ?? probe
console.log('bracket', lo, hi)
while (hi - lo > 50) {
  const mid = Math.floor((lo + hi) / 2)
  const r = await firstEventAt(mid)
  if (r.error) { lo = mid; continue }
  if (Date.parse(r.time) < target) lo = mid
  else hi = mid
  process.stderr.write(`  ${lo}..${hi} ${r.time}\n`)
}
const final = await firstEventAt(lo)
console.log('CURSOR', lo, JSON.stringify(final))
