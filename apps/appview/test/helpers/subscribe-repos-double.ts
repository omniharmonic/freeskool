/**
 * A local `com.atproto.sync.subscribeRepos` test double.
 *
 * It speaks the real wire format — each message is two concatenated DAG-CBOR
 * values, a header `{ op, t }` followed by the body — so `@atproto/xrpc-server`'s
 * `Subscription` and `@atproto/sync`'s commit parsers run unmodified against it.
 * Nothing here touches the network beyond `127.0.0.1`.
 *
 * Frame shapes were taken from the R4 probe output
 * (`packages/pds-follow/probes/raw-frames.mjs`), which dumped them off live PDSes.
 */
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { encode } from '@atproto/lex-cbor'
import { BlockMap, blocksToCarFile } from '@atproto/repo'
import { WebSocketServer, type WebSocket } from 'ws'

export type Frame = { t: string; body: Record<string, unknown> }

/** One `op: 1` message frame: CBOR header then CBOR body. */
export function encodeFrame(frame: Frame): Uint8Array {
  const header = encode({ op: 1, t: frame.t })
  const body = encode(frame.body as never)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

/**
 * A `#commit` carrying one record op, with a CAR slice the commit parser can read.
 * `ops[].cid` must be the CID of the record block, which is what `BlockMap.add`
 * returns, so the two can never drift.
 */
export async function commitFrame(options: {
  seq: number
  repo: string
  collection: string
  rkey: string
  record: Record<string, unknown>
  action?: 'create' | 'update' | 'delete'
  rev?: string
  time?: string
}): Promise<{ frame: Frame; cid: string }> {
  const blocks = new BlockMap()
  const recordCid = await blocks.add(options.record as never)
  // A real commit block is also in the CAR and is its root. Nothing we parse
  // needs its contents, but shipping one keeps the frame honest.
  const commitCid = await blocks.add({
    did: options.repo,
    version: 3,
    rev: options.rev ?? '3lzzzzzzzzzz2',
    data: recordCid,
    prev: null,
  } as never)
  const car = await blocksToCarFile(commitCid, blocks)
  const action = options.action ?? 'create'
  return {
    cid: recordCid.toString(),
    frame: {
      t: '#commit',
      body: {
        seq: options.seq,
        rebase: false,
        tooBig: false,
        repo: options.repo,
        commit: commitCid,
        rev: options.rev ?? '3lzzzzzzzzzz2',
        since: null,
        blocks: car,
        ops: [
          {
            action,
            path: `${options.collection}/${options.rkey}`,
            cid: action === 'delete' ? null : recordCid,
          },
        ],
        blobs: [],
        time: options.time ?? new Date().toISOString(),
      },
    },
  }
}

export function accountFrame(options: {
  seq: number
  did: string
  active: boolean
  status?: string
  time?: string
}): Frame {
  return {
    t: '#account',
    body: {
      seq: options.seq,
      did: options.did,
      time: options.time ?? new Date().toISOString(),
      active: options.active,
      ...(options.status ? { status: options.status } : {}),
    },
  }
}

export function identityFrame(options: { seq: number; did: string; handle?: string; time?: string }): Frame {
  return {
    t: '#identity',
    body: {
      seq: options.seq,
      did: options.did,
      time: options.time ?? new Date().toISOString(),
      ...(options.handle ? { handle: options.handle } : {}),
    },
  }
}

/**
 * A fatal error frame (`op: -1`). R4 observed `FutureCursor` arriving exactly like
 * this, followed by close 1008. `Subscription`'s `ensureChunkIsMessage` turns it into
 * a thrown `XRPCError`, which ends the iterator rather than reconnecting — the
 * fatal-error path the restart/quarantine escalation exists for.
 */
export function encodeErrorFrame(error: string, message?: string): Uint8Array {
  const header = encode({ op: -1 })
  const body = encode({ error, ...(message ? { message } : {}) } as never)
  const out = new Uint8Array(header.length + body.length)
  out.set(header, 0)
  out.set(body, header.length)
  return out
}

/** `#info` has no `seq`: it is stream metadata, and it always arrives first. */
export function infoFrame(name: string, message?: string): Frame {
  return { t: '#info', body: { name, ...(message ? { message } : {}) } }
}

export interface FakePds {
  /** `http://127.0.0.1:<port>`, normalised the way the peer registry stores it. */
  host: string
  /** Cursors the double has been dialled with, in connection order. `null` = none. */
  readonly cursors: Array<number | null>
  /** Number of completed upgrade requests. */
  readonly connections: number
  /** Request headers of each connection, in order. */
  readonly headers: Array<Record<string, string | string[] | undefined>>
  /** Frames the next connection will be sent, before `send()` pushes any more. */
  setGreeting(frames: Frame[]): void
  /** Answer every future connection with a fatal error frame, then close. */
  setFatal(error: string | null): void
  /** Push frames to every open socket. */
  send(frames: Frame[]): void
  /** Drop every open socket without closing the listener, forcing a reconnect. */
  dropConnections(): void
  close(): Promise<void>
}

/**
 * Start the double on an ephemeral loopback port. Each new connection is replied
 * to with the current greeting frames; `send()` pushes more at any time.
 */
export async function startFakePds(greeting: Frame[] = []): Promise<FakePds> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(404).end()
  })
  const wss = new WebSocketServer({ server, path: '/xrpc/com.atproto.sync.subscribeRepos' })
  const open = new Set<WebSocket>()
  const cursors: Array<number | null> = []
  const headers: Array<Record<string, string | string[] | undefined>> = []
  let currentGreeting = greeting
  let fatal: string | null = null
  let connections = 0

  wss.on('connection', (ws, req) => {
    connections++
    headers.push(req.headers)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const raw = url.searchParams.get('cursor')
    cursors.push(raw === null ? null : Number(raw))
    open.add(ws)
    ws.on('close', () => open.delete(ws))
    ws.on('error', () => open.delete(ws))
    if (fatal) {
      ws.send(encodeErrorFrame(fatal, 'cursor is in the future'))
      ws.close(1008)
      return
    }
    for (const frame of currentGreeting) ws.send(encodeFrame(frame))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    host: `http://127.0.0.1:${port}`,
    cursors,
    get connections() {
      return connections
    },
    headers,
    setGreeting(frames) {
      currentGreeting = frames
    },
    setFatal(error) {
      fatal = error
    },
    send(frames) {
      for (const ws of open) for (const frame of frames) ws.send(encodeFrame(frame))
    },
    dropConnections() {
      for (const ws of open) ws.terminate()
      open.clear()
    },
    async close() {
      for (const ws of open) ws.terminate()
      open.clear()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
