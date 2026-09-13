// @atproto/sync's Firehose constructs its Subscription WITHOUT passing
// `onReconnectError`, so transient reconnects are invisible to `onError`.
// Going one layer down to @atproto/ws-client exposes them, which is how you get
// reconnect observability in an AppView.
import { websocket } from '@atproto/ws-client'
const host = process.argv[2]
const t0 = Date.now()
const el = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's'
const url = () => host.replace(/^http/, 'ws') + '/xrpc/com.atproto.sync.subscribeRepos'
const ctl = new AbortController()
setTimeout(() => ctl.abort(new Error('done')), Number(process.argv[3] ?? 60) * 1000)
try {
  for await (const _ of websocket(url, {
    dataMode: 'binary',
    maxReconnectSeconds: 64,
    heartbeat: { intervalMs: 5000 },
    signal: ctl.signal,
    onOpen: () => console.log(el(), 'onOpen (stream live)'),
    onConnect: () => console.log(el(), 'onConnect'),
    onDisconnect: () => console.log(el(), 'onDisconnect'),
    onReconnect: (err, { attempt }) => console.log(el(), `onReconnect attempt=${attempt} err=${err?.constructor?.name}: ${err?.message}`),
    onError: (err) => console.log(el(), 'onError (fatal)', err?.message),
    onClose: (d) => console.log(el(), 'onClose', JSON.stringify(d)),
  })) { /* frames ignored; we only care about lifecycle */ }
} catch (err) { console.log(el(), 'iterator rejected:', err?.message) }
