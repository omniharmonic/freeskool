#!/usr/bin/env node
/**
 * follow-pds — direct-PDS federation spike for the Free School AppView.
 *
 * Author of record: Benjamin Life (@omniharmonic)
 *
 * No relay, no firehose aggregator. Reads a peer registry (`peers.json`) of PDS
 * hosts and DIDs, holds one `com.atproto.sync.subscribeRepos` socket per host
 * with its own persisted cursor, backfills configured DIDs from their own PDS,
 * filters down to the calendar collections, and prints one JSON object per line.
 *
 * Commands:
 *   follow    [--config peers.json] [--backfill] [--duration 120] [--no-verify]
 *   backfill  [--config peers.json] [--method listRecords|getRepo] [--did <did>]...
 *   resolve   [--config peers.json] <handle-or-did>...
 *   discover  [--config peers.json] [--relay <url>] [--limit 100]
 *
 * Everything it emits is NDJSON on stdout; logs go to stderr, so
 * `node follow-pds.js follow > events.ndjson` gives a clean event log.
 */

import { parseArgs } from 'node:util'
import { Firehose, MemoryRunner } from '@atproto/sync'
import type { Event } from '@atproto/sync'
import { backfillDid } from './backfill.js'
import { enabledPeers, loadConfig, toWsOrigin, type LoadedConfig, type PeerHost } from './config.js'
import { CursorStore } from './cursors.js'
import { hasMoved, Identity } from './identity.js'
import { lexToJson } from './lex-json.js'

// ---------------------------------------------------------------- output

const emit = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

const log = (...parts: unknown[]): void => {
  process.stderr.write(`[${new Date().toISOString()}] ${parts.map(String).join(' ')}\n`)
}

// ---------------------------------------------------------------- follower

type Stats = {
  /** Events that reached handleEvent — i.e. already collection-filtered. */
  handled: number
  records: number
  identity: number
  account: number
  sync: number
  errors: number
  reconnects: number
  /**
   * Latest cursor the runner has committed for this host. It advances on *every*
   * frame the socket delivers, including commits dropped by the collection
   * filter, so a live socket shows cursorSeq climbing while handled stays 0.
   * That is the signal that the connection is healthy but nothing matched.
   */
  cursorSeq?: number
}

class PeerFollower {
  readonly stats: Stats = {
    handled: 0, records: 0, identity: 0, account: 0, sync: 0, errors: 0, reconnects: 0,
  }
  private firehose: Firehose | null = null
  private runner: MemoryRunner | null = null

  constructor(
    private readonly peer: PeerHost,
    private readonly cfg: LoadedConfig,
    private readonly cursors: CursorStore,
    private readonly identity: Identity,
    private readonly opts: { verify: boolean; trackedDids: Set<string> },
  ) {}

  start(): void {
    const startCursor = this.cursors.get(this.peer.host)

    // MemoryRunner gives a partitioned queue: events from different repos run
    // concurrently, events from one repo run strictly in order (the guarantee
    // the sync spec requires), and its cursor only advances past a contiguous
    // prefix of completed work, so a crash replays rather than skips.
    this.runner = new MemoryRunner({
      ...(startCursor !== undefined ? { startCursor } : {}),
      concurrency: 8,
      setCursor: async (cursor: number) => {
        this.stats.cursorSeq = cursor
        this.cursors.set(this.peer.host, cursor)
      },
    })

    this.firehose = new Firehose({
      // `service` is an origin; @atproto/xrpc-server appends
      // `/xrpc/com.atproto.sync.subscribeRepos?cursor=N` itself.
      service: toWsOrigin(this.peer.host),
      idResolver: this.identity.resolver(this.peer.allowPrivateNetwork),
      runner: this.runner,
      // Server-side filtering does not exist on subscribeRepos: every commit on
      // the host arrives and @atproto/sync drops non-matching ops client-side.
      filterCollections: this.cfg.collections,
      unauthenticatedCommits: this.peer.unauthenticatedCommits ?? !this.opts.verify,
      unauthenticatedHandles: !this.opts.verify,
      maxReconnectSeconds: this.cfg.maxReconnectSeconds,
      heartbeatIntervalMs: this.cfg.heartbeatIntervalMs,
      handleEvent: (evt) => this.onEvent(evt),
      onError: (err) => {
        this.stats.errors++
        if (err.name === 'FirehoseSubscriptionError') this.stats.reconnects++
        log(`! ${this.peer.name}: ${err.name}: ${err.message}`)
      },
    })
    void this.firehose.start()
    log(`-> ${this.peer.name} ${toWsOrigin(this.peer.host)}/xrpc/com.atproto.sync.subscribeRepos cursor=${startCursor ?? '(head)'}`)
  }

  private async onEvent(evt: Event): Promise<void> {
    this.stats.handled++
    switch (evt.event) {
      case 'create':
      case 'update':
      case 'delete': {
        this.stats.records++
        emit({
          kind: 'record',
          source: 'live',
          peer: this.peer.name,
          host: this.peer.host,
          seq: evt.seq,
          time: evt.time,
          action: evt.event,
          did: evt.did,
          collection: evt.collection,
          rkey: evt.rkey,
          uri: evt.uri.toString(),
          rev: evt.rev,
          commit: evt.commit.toString(),
          ...(evt.event === 'delete'
            ? {}
            : { cid: evt.cid.toString(), record: lexToJson(evt.record) }),
        })
        return
      }
      case 'identity': {
        this.stats.identity++
        // An #identity event means "something in this DID document may have
        // changed" — handle, signing key, or PDS endpoint. It does not say
        // which. The only correct response is to re-resolve, and the thing we
        // care most about is a changed PDS endpoint.
        let moved: boolean | undefined
        let newPds: string | undefined
        if (this.opts.trackedDids.has(evt.did)) {
          try {
            const resolved = await this.identity.resolve(evt.did, {
              forceRefresh: true,
              allowPrivateNetwork: this.peer.allowPrivateNetwork,
            })
            newPds = resolved.pds
            moved = hasMoved(this.peer.host, resolved.pds)
          } catch (err) {
            log(`! ${this.peer.name}: re-resolve ${evt.did} failed: ${String(err)}`)
          }
        }
        emit({
          kind: 'identity', peer: this.peer.name, host: this.peer.host,
          seq: evt.seq, time: evt.time, did: evt.did, handle: evt.handle,
          ...(newPds ? { pds: newPds } : {}),
          ...(moved !== undefined ? { movedOffThisPeer: moved } : {}),
        })
        return
      }
      case 'account': {
        this.stats.account++
        // active=false means "this host no longer serves this repo". The status
        // distinguishes a user-initiated deactivation (often step 1 of a PDS
        // migration) from moderation (takendown/suspended) or deletion.
        emit({
          kind: 'account', peer: this.peer.name, host: this.peer.host,
          seq: evt.seq, time: evt.time, did: evt.did,
          active: evt.active, status: evt.status ?? null,
        })
        return
      }
      case 'sync': {
        this.stats.sync++
        // #sync asserts a repo's current state without carrying the diff that
        // got it there. Treat it as "your view of this repo may be stale":
        // compare `rev` to what we stored and re-backfill with `since` if behind.
        emit({
          kind: 'sync', peer: this.peer.name, host: this.peer.host,
          seq: evt.seq, time: evt.time, did: evt.did, rev: evt.rev, cid: evt.cid.toString(),
        })
        return
      }
    }
  }

  async stop(): Promise<void> {
    await this.firehose?.destroy()
    await this.runner?.destroy()
  }
}

// ---------------------------------------------------------------- commands

async function cmdFollow(cfg: LoadedConfig, flags: Record<string, unknown>): Promise<void> {
  const cursors = new CursorStore(cfg.cursorFilePath)
  await cursors.load()
  const identity = new Identity(cfg.plcUrl)
  const verify = flags['no-verify'] !== true
  const trackedDids = new Set(cfg.backfillDids)

  if (flags['backfill'] === true) {
    await runBackfill(cfg, identity, cfg.backfillDids, String(flags['method'] ?? cfg.backfillMethod) as 'listRecords' | 'getRepo', verify)
  }

  const peers = enabledPeers(cfg)
  const followers = peers.map((p) => new PeerFollower(p, cfg, cursors, identity, { verify, trackedDids }))
  for (const f of followers) f.start()

  const durationSec = flags['duration'] !== undefined ? Number(flags['duration']) : undefined
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    log('shutting down...')
    await Promise.all(followers.map((f) => f.stop()))
    await cursors.close()
    log('cursors: ' + JSON.stringify(cursors.all()))
    for (const [i, f] of followers.entries()) {
      log(`stats ${peers[i]!.name}: ${JSON.stringify(f.stats)}`)
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  const statsTimer = setInterval(() => {
    for (const [i, f] of followers.entries()) {
      log(`stats ${peers[i]!.name}: ${JSON.stringify(f.stats)}`)
    }
  }, 30_000)
  statsTimer.unref()

  if (durationSec !== undefined) {
    setTimeout(() => void shutdown(), durationSec * 1000)
  }
}

async function runBackfill(
  cfg: LoadedConfig,
  identity: Identity,
  dids: string[],
  method: 'listRecords' | 'getRepo',
  verify: boolean,
): Promise<void> {
  if (dids.length === 0) {
    log('backfill: no DIDs configured (set "backfillDids" in peers.json or pass --did)')
    return
  }
  log(`backfill: ${dids.length} did(s) via ${method}, collections=[${cfg.collections.join(', ')}]`)
  for (const did of dids) {
    const res = await backfillDid(identity, did, cfg.collections, { method, verify })
    if (res.error) {
      log(`! backfill ${did}: ${res.status ?? 'error'}: ${res.error}`)
      emit({ kind: 'backfill-error', did, pds: res.pds, status: res.status ?? null, error: res.error })
      continue
    }
    log(`backfill ${did} @ ${res.pds}: ${res.records.length} record(s)${res.bytesFetched ? ` from ${res.bytesFetched} bytes of CAR` : ''}${res.rev ? ` rev=${res.rev}` : ''}`)
    for (const rec of res.records) emit(rec)
  }
}

async function cmdBackfill(cfg: LoadedConfig, flags: Record<string, unknown>): Promise<void> {
  const identity = new Identity(cfg.plcUrl)
  const explicit = (flags['did'] as string[] | undefined) ?? []
  const dids = explicit.length > 0 ? explicit : cfg.backfillDids
  const method = String(flags['method'] ?? cfg.backfillMethod) as 'listRecords' | 'getRepo'
  await runBackfill(cfg, identity, dids, method, flags['no-verify'] !== true)
}

/** handle/DID -> DID -> PDS. Prints the host list a DID list implies. */
async function cmdResolve(cfg: LoadedConfig, actors: string[]): Promise<void> {
  const identity = new Identity(cfg.plcUrl)
  const dids: string[] = []
  for (const actor of actors) {
    const did = await identity.toDid(actor)
    if (!did) {
      emit({ kind: 'resolve', actor, error: 'handle did not resolve' })
      continue
    }
    try {
      const r = await identity.resolve(did)
      dids.push(did)
      emit({ kind: 'resolve', actor, did, handle: r.handle, pds: r.pds, signingKey: r.signingKey })
    } catch (err) {
      emit({ kind: 'resolve', actor, did, error: String(err) })
    }
  }
  const { hosts } = await identity.hostsForDids(dids)
  emit({
    kind: 'peer-registry-suggestion',
    peers: [...hosts.entries()].map(([host, hostDids]) => ({
      name: new URL(host).hostname.split('.').slice(0, -1).join('.') || new URL(host).hostname,
      host,
      dids: hostDids,
    })),
  })
}

/**
 * Find repos that actually hold one of our collections.
 *
 * `com.atproto.sync.listReposByCollection` is the network's collection index.
 * It is public on a relay; on every PDS tested it answered `AuthMissing`, so
 * the pragmatic bootstrap is to ask a relay once for candidate DIDs, resolve
 * them to PDS hosts, and write those hosts into the peer registry — after
 * which the relay is never needed again.
 */
async function cmdDiscover(cfg: LoadedConfig, flags: Record<string, unknown>): Promise<void> {
  const relay = String(flags['relay'] ?? 'https://relay1.us-east.bsky.network')
  const limit = Number(flags['limit'] ?? 100)
  const identity = new Identity(cfg.plcUrl)
  for (const collection of cfg.collections) {
    const url = new URL('/xrpc/com.atproto.sync.listReposByCollection', relay)
    url.searchParams.set('collection', collection)
    url.searchParams.set('limit', String(Math.min(limit, 2000)))
    const res = await fetch(url)
    if (!res.ok) {
      emit({ kind: 'discover-error', collection, source: relay, status: res.status, body: await res.text() })
      continue
    }
    const body = (await res.json()) as { repos: Array<{ did: string }>; cursor?: string }
    const dids = body.repos.map((r) => r.did)
    const { hosts, failures } = await identity.hostsForDids(dids)
    emit({
      kind: 'discover',
      collection,
      source: relay,
      didCount: dids.length,
      hostCount: hosts.size,
      hosts: [...hosts.entries()]
        .map(([host, hostDids]) => ({ host, dids: hostDids }))
        .sort((a, b) => b.dids.length - a.dids.length),
      unresolved: failures,
    })
  }
}

// ---------------------------------------------------------------- cli

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c', default: './peers.json' },
      duration: { type: 'string', short: 'd' },
      method: { type: 'string', short: 'm' },
      did: { type: 'string', multiple: true },
      relay: { type: 'string' },
      limit: { type: 'string' },
      backfill: { type: 'boolean', default: false },
      'no-verify': { type: 'boolean', default: false },
    },
  })

  const command = positionals[0] ?? 'follow'
  const cfg = await loadConfig(String(values.config))
  log(`config ${cfg.configPath}: ${enabledPeers(cfg).length}/${cfg.peers.length} peer(s) enabled, cursors at ${cfg.cursorFilePath}`)

  switch (command) {
    case 'follow':
      return await cmdFollow(cfg, values as Record<string, unknown>)
    case 'backfill':
      return await cmdBackfill(cfg, values as Record<string, unknown>)
    case 'resolve':
      return await cmdResolve(cfg, positionals.slice(1))
    case 'discover':
      return await cmdDiscover(cfg, values as Record<string, unknown>)
    default:
      log(`unknown command "${command}"; expected follow | backfill | resolve | discover`)
      process.exitCode = 2
  }
}

main().catch((err) => {
  log('fatal:', err instanceof Error ? (err.stack ?? err.message) : String(err))
  process.exit(1)
})
