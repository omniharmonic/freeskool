/**
 * Peer-registry config for the Free School AppView's direct-PDS federation.
 *
 * There is no relay in this model: the AppView holds a list of PDS hosts it
 * trusts enough to hold an open `com.atproto.sync.subscribeRepos` socket
 * against, plus a list of DIDs it wants the full history of. This file is the
 * file-backed stand-in for the `peer_host` / `peer_repo` tables the production
 * AppView will keep in Postgres.
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve as resolvePath } from 'node:path'

/** A single PDS we hold a subscribeRepos socket against. */
export type PeerHost = {
  /** Stable short name; used in log lines and as the cursor-store key prefix. */
  name: string
  /**
   * PDS origin, no path and no `/xrpc`. `https://` or `http://` — the
   * ws/wss upgrade is derived from it. Must be a *single* PDS instance:
   * `https://bsky.social` is an entryway that fans out to dozens of
   * `*.host.bsky.network` PDSes and does not serve a useful firehose.
   */
  host: string
  /** Set false to keep a host in the registry without dialling it. */
  enabled?: boolean
  /**
   * Allow plain-HTTP / private-network identity resolution for this peer.
   * Required for a local reference PDS (`http://localhost:3000`), because
   * `@atproto/identity` routes DID and handle resolution through an
   * SSRF-protected fetch by default that refuses private IPs and custom ports.
   */
  allowPrivateNetwork?: boolean
  /**
   * Skip commit signature + MST proof verification for this peer's stream.
   * Only sane for a local dev PDS whose DIDs are not in a public PLC.
   */
  unauthenticatedCommits?: boolean
}

export type Config = {
  peers: PeerHost[]
  /** Collections we index. Trailing `.*` is a prefix wildcard (`@atproto/sync` semantics). */
  collections: string[]
  /** DIDs to backfill on `backfill` / on `follow --backfill`. */
  backfillDids: string[]
  /** Where per-host cursors are persisted. Relative paths resolve against the config file. */
  cursorFile: string
  /** `listRecords` is cheap and collection-scoped; `getRepo` is a verifiable whole-repo CAR. */
  backfillMethod: 'listRecords' | 'getRepo'
  /** PLC directory used for did:plc resolution. */
  plcUrl: string
  /** Exponential-backoff ceiling in seconds handed to @atproto/sync. */
  maxReconnectSeconds: number
  /** WebSocket heartbeat interval (Node only); a dead socket is detected within ~2x this. */
  heartbeatIntervalMs: number
}

const DEFAULTS: Omit<Config, 'peers'> = {
  collections: [
    'community.lexicon.calendar.event',
    'community.lexicon.calendar.rsvp',
  ],
  backfillDids: [],
  cursorFile: './.cursors.json',
  backfillMethod: 'listRecords',
  plcUrl: 'https://plc.directory',
  maxReconnectSeconds: 64,
  heartbeatIntervalMs: 10_000,
}

export type LoadedConfig = Config & { cursorFilePath: string; configPath: string }

export async function loadConfig(path: string): Promise<LoadedConfig> {
  const configPath = resolvePath(process.cwd(), path)
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as Partial<Config>

  if (!Array.isArray(raw.peers) || raw.peers.length === 0) {
    throw new Error(`${configPath}: "peers" must be a non-empty array`)
  }

  const cfg: Config = { ...DEFAULTS, ...raw, peers: raw.peers }

  for (const peer of cfg.peers) {
    if (!peer.name) throw new Error(`${configPath}: every peer needs a "name"`)
    if (!/^https?:\/\//.test(peer.host)) {
      throw new Error(`${configPath}: peer "${peer.name}" host must start with http:// or https://`)
    }
    // Normalise: no trailing slash, no /xrpc — both break URL construction in
    // @atproto/xrpc-server's Subscription, which appends `/xrpc/<method>`.
    peer.host = peer.host.replace(/\/+$/, '').replace(/\/xrpc$/, '')
  }

  return {
    ...cfg,
    configPath,
    cursorFilePath: resolvePath(dirname(configPath), cfg.cursorFile),
  }
}

export const enabledPeers = (cfg: Config): PeerHost[] =>
  cfg.peers.filter((p) => p.enabled !== false)

/** `https://pds.example` -> `wss://pds.example` (what Subscription wants as `service`). */
export const toWsOrigin = (host: string): string =>
  host.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
