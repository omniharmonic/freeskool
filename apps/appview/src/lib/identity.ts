/**
 * DID → PDS endpoint resolution.
 *
 * Local development runs a PDS on `localhost`, whose DIDs may not be resolvable
 * through the public PLC directory or through contrail's default Slingshot resolver.
 * `DID_DOC_OVERRIDES` lets us pin those without weakening anything in production:
 * a DID is only ever resolved locally if one of our configured peer hosts actually
 * reports hosting it.
 */
import { config } from '../config.js'

const cache = new Map<string, { endpoint: string | null; at: number }>()
const TTL_MS = 60_000

export async function resolvePdsEndpoint(did: string): Promise<string | null> {
  const hit = cache.get(did)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.endpoint
  const endpoint = (await fromDidDoc(did)) ?? (await fromPeerHosts(did))
  cache.set(did, { endpoint, at: Date.now() })
  return endpoint
}

async function fromDidDoc(did: string): Promise<string | null> {
  const url = did.startsWith('did:web:')
    ? `https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`
    : `https://plc.directory/${encodeURIComponent(did)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const doc = (await res.json()) as { service?: Array<{ id?: string; type?: string; serviceEndpoint?: string }> }
    const svc = doc.service?.find(
      (s) => s.id?.endsWith('#atproto_pds') || s.type === 'AtprotoPersonalDataServer',
    )
    return typeof svc?.serviceEndpoint === 'string' ? svc.serviceEndpoint : null
  } catch {
    return null
  }
}

/** Last resort for local dev: ask each configured PDS whether it hosts the repo. */
async function fromPeerHosts(did: string): Promise<string | null> {
  for (const host of [config().PDS_URL, ...config().PEER_PDS_HOSTS]) {
    try {
      const res = await fetch(
        `${host.replace(/\/$/, '')}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(did)}`,
        { signal: AbortSignal.timeout(4000) },
      )
      if (res.ok) return host.replace(/\/$/, '')
    } catch {
      // fall through to the next host
    }
  }
  return null
}

export function clearIdentityCache(): void {
  cache.clear()
}
