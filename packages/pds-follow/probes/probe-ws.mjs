// Probe subscribeRepos on a list of hosts using Node's built-in WebSocket (Node 22).
const hosts = process.argv.slice(2);
async function probe(host) {
  const wsUrl = host.replace(/^http/, 'ws') + '/xrpc/com.atproto.sync.subscribeRepos';
  return new Promise((resolve) => {
    let frames = 0, bytes = 0;
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { try { ws.close(); } catch {} resolve({ host, ok: frames > 0, frames, bytes, note: frames ? 'frames received' : 'connected, no frames in window' }); }, 12000);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {};
    ws.onmessage = (e) => { frames++; bytes += e.data.byteLength ?? 0; };
    ws.onerror = (e) => { clearTimeout(t); resolve({ host, ok: false, frames, bytes, note: 'error: ' + (e.message || 'ws error') }); };
    ws.onclose = (e) => { clearTimeout(t); resolve({ host, ok: frames > 0, frames, bytes, note: `closed ${e.code} ${e.reason || ''}` }); };
  });
}
for (const h of hosts) console.log(JSON.stringify(await probe(h)));
