/**
 * Identity resolution: handle -> DID -> DID document -> PDS endpoint.
 *
 * This is what turns a list of school/teacher DIDs into the peer-host list the
 * subscribeRepos follower dials, and it is also how we notice a repo has
 * migrated: the DID document's `#atproto_pds` service endpoint is the only
 * authority on where a repo lives right now.
 */

import { IdResolver } from '@atproto/identity'
import type { AtprotoData, DidDocument } from '@atproto/identity'

export type Resolved = AtprotoData & { doc: DidDocument }

export class Identity {
  /** SSRF-protected resolver: the default, used for every public peer. */
  private readonly safe: IdResolver
  /**
   * Permissive resolver for local dev. `@atproto/identity` refuses private IPs,
   * `http:`, and custom ports unless you hand it your own `fetch`, which it then
   * uses as-is. Only reachable via `allowPrivateNetwork` on a peer.
   */
  private readonly unsafe: IdResolver

  constructor(plcUrl: string) {
    this.safe = new IdResolver({ plcUrl })
    this.unsafe = new IdResolver({ plcUrl, fetch: globalThis.fetch })
  }

  resolver(allowPrivateNetwork = false): IdResolver {
    return allowPrivateNetwork ? this.unsafe : this.safe
  }

  /** `alice.example.com` or `did:plc:...` -> DID. Returns null if unresolvable. */
  async toDid(actor: string, allowPrivateNetwork = false): Promise<string | null> {
    if (actor.startsWith('did:')) return actor
    return (await this.resolver(allowPrivateNetwork).handle.resolve(actor)) ?? null
  }

  /** DID -> { did, handle, signingKey, pds, doc }. Throws if the DID will not resolve. */
  async resolve(did: string, opts: { forceRefresh?: boolean; allowPrivateNetwork?: boolean } = {}): Promise<Resolved> {
    const resolver = this.resolver(opts.allowPrivateNetwork)
    const doc = await resolver.did.ensureResolve(did, opts.forceRefresh)
    const data = await resolver.did.resolveAtprotoData(did, opts.forceRefresh)
    return { ...data, doc }
  }

  /**
   * Turn a DID list into the deduped host list to subscribe to.
   * This is the "peer registry derivation" step: you configure *who* you follow,
   * and identity resolution tells you *where* to listen.
   */
  async hostsForDids(
    dids: string[],
    opts: { allowPrivateNetwork?: boolean } = {},
  ): Promise<{ hosts: Map<string, string[]>; failures: Array<{ did: string; error: string }> }> {
    const hosts = new Map<string, string[]>()
    const failures: Array<{ did: string; error: string }> = []
    for (const did of dids) {
      try {
        const { pds } = await this.resolve(did, opts)
        const origin = new URL(pds).origin
        const list = hosts.get(origin) ?? []
        list.push(did)
        hosts.set(origin, list)
      } catch (err) {
        failures.push({ did, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { hosts, failures }
  }
}

/**
 * Has this repo moved off the host we are subscribed to?
 *
 * Call on every `#identity` event for a DID we track. A `true` here means:
 * stop expecting commits for that DID on this socket, add the new host to the
 * registry, and backfill from `since = <last rev we indexed>` against the new
 * PDS so nothing written during the move is lost.
 */
export function hasMoved(expectedHost: string, resolvedPds: string): boolean {
  try {
    return new URL(expectedHost).origin !== new URL(resolvedPds).origin
  } catch {
    return true
  }
}
