// Raw subscribeRepos frame inspector: prints the header + scalar body fields of
// each frame without going through @atproto/sync, so we can see exactly what a
// PDS puts on the wire (#commit / #sync / #identity / #account / #info, errors).
import { decodeAll } from '@atproto/lex-cbor'

const [host, cursorArg, seconds] = process.argv.slice(2)
const url = new URL('/xrpc/com.atproto.sync.subscribeRepos', host.replace(/^http/, 'ws'))
if (cursorArg !== undefined && cursorArg !== '-') url.searchParams.set('cursor', cursorArg)
const limitMs = (Number(seconds ?? 15)) * 1000

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'
let n = 0
const counts = {}
console.log('DIAL', url.toString())
const t = setTimeout(() => { ws.close(1000); }, limitMs)
ws.onmessage = (e) => {
  const bytes = new Uint8Array(e.data)
  const [header, body] = [...decodeAll(bytes)]
  const t = header.t ?? `op=${header.op}`
  counts[t] = (counts[t] ?? 0) + 1
  if (n++ < 8 || header.op === -1 || t === '#info' || t === '#sync' || t === '#identity' || t === '#account') {
    const scalars = {}
    for (const [k, v] of Object.entries(body ?? {})) {
      if (v instanceof Uint8Array) scalars[k] = `<bytes ${v.byteLength}>`
      else if (Array.isArray(v)) scalars[k] = v.map((o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([kk, vv]) => [kk, String(vv)])) : String(o)))
      else if (v && typeof v === 'object') scalars[k] = String(v)
      else scalars[k] = v
    }
    console.log(JSON.stringify({ header, body: scalars }))
  }
}
ws.onclose = (e) => { clearTimeout(t); console.log('CLOSE', e.code, e.reason); console.log('COUNTS', JSON.stringify(counts)); process.exit(0) }
ws.onerror = (e) => { console.log('ERROR', e.message ?? 'ws error') }
