/**
 * Firehose readiness check (federation-phase Task 8, `docs/interop-audit.md` gap 1,
 * `docs/runbooks/relay-switch.md`).
 *
 * Three independent checks, in order:
 *
 *   1. (optional) `--request-crawl` — POST `com.atproto.sync.requestCrawl` to the relay
 *      with our PDS hostname, a manual kick for when the PDS's own startup/account-create
 *      announce did not reach it (or to re-announce after `PDS_CRAWLERS` was unset and
 *      reset).
 *   2. Does the relay already know our repos? `GET com.atproto.sync.getLatestCommit` for
 *      the school DID and the authority DID, against `--relay` (default
 *      `https://bsky.network`).
 *   3. Listen on Jetstream (`--jetstream`, default
 *      `wss://jetstream2.us-east.bsky.network/subscribe`) for `--seconds` (default 60),
 *      filtered to `wantedDids` = school + authority, and tally events by collection.
 *
 *   pnpm --filter @freeschool/appview verify-relay
 *   pnpm --filter @freeschool/appview verify-relay -- --seconds=30 --expect
 *   pnpm --filter @freeschool/appview verify-relay -- --request-crawl
 *
 * `--expect` (no value needed) makes the process exit non-zero if nothing arrived in the
 * window — use it in a deploy check; omit it to just look. `--expect=<collection,...>`
 * additionally requires each named collection to have been seen at least once.
 *
 * R9: every DID and cursor value printed is TRUNCATED to 12 characters. This script is a
 * diagnostic, not a place identifiers belong in full.
 */
import { config } from '../src/config.js'
import { isMain } from '../src/lib/is-main.js'

/* ───────────────────────────────────────── args ─────────────────────────────────────── */

export interface VerifyRelayArgs {
  seconds: number
  expect: boolean
  expectCollections: string[]
  requestCrawl: boolean
  relay: string
  jetstream: string
  schoolDid?: string
  authorityDid?: string
  pdsHost?: string
}

const DEFAULT_RELAY = 'https://bsky.network'
const DEFAULT_JETSTREAM = 'wss://jetstream2.us-east.bsky.network/subscribe'

function flagValue(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return undefined
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : ''
}

/** Pure, testable: no env, no config, no network. */
export function parseArgs(argv: string[]): VerifyRelayArgs {
  const secondsRaw = flagValue(argv, 'seconds')
  const seconds = secondsRaw ? Number(secondsRaw) : 60
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--seconds must be a positive number, got ${JSON.stringify(secondsRaw)}`)
  }
  const expectRaw = flagValue(argv, 'expect')
  const expect = expectRaw !== undefined
  const expectCollections = expectRaw ? expectRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  return {
    seconds,
    expect,
    expectCollections,
    requestCrawl: argv.includes('--request-crawl'),
    relay: flagValue(argv, 'relay') || DEFAULT_RELAY,
    jetstream: flagValue(argv, 'jetstream') || DEFAULT_JETSTREAM,
    schoolDid: flagValue(argv, 'school-did'),
    authorityDid: flagValue(argv, 'authority-did'),
    pdsHost: flagValue(argv, 'pds-host'),
  }
}

/* ───────────────────────────────────── tallying ─────────────────────────────────────── */

export interface Tally {
  byCollection: Map<string, number>
  total: number
  malformed: number
  latestCursor: number | null
  dids: Set<string>
}

export function createTally(): Tally {
  return { byCollection: new Map(), total: 0, malformed: 0, latestCursor: null, dids: new Set() }
}

interface JetstreamCommitEvent {
  did?: string
  time_us?: number
  kind?: string
  commit?: { collection?: string; rkey?: string; operation?: string }
}

/** Parse one raw Jetstream frame and fold it into `tally`. Never throws. */
export function recordEvent(tally: Tally, raw: string): void {
  let evt: JetstreamCommitEvent
  try {
    evt = JSON.parse(raw) as JetstreamCommitEvent
  } catch {
    tally.malformed += 1
    return
  }
  tally.total += 1
  const collection = evt.commit?.collection ?? `(${evt.kind ?? 'unknown'})`
  tally.byCollection.set(collection, (tally.byCollection.get(collection) ?? 0) + 1)
  if (evt.did) tally.dids.add(evt.did)
  if (typeof evt.time_us === 'number') {
    tally.latestCursor = tally.latestCursor === null ? evt.time_us : Math.max(tally.latestCursor, evt.time_us)
  }
}

/**
 * The slice of the WebSocket interface this script needs — real or fake. One untyped
 * signature (rather than per-event overloads) so a plain test double structurally matches
 * it without having to reproduce WebSocket's own overload set.
 */
export interface SocketLike {
  addEventListener(type: string, listener: (ev: any) => void): void
  close(): void
}

/** Wires a socket's `message` events into `tally`. Returns nothing to unwind — the caller owns `close()`. */
export function attachTally(socket: SocketLike, tally: Tally): void {
  socket.addEventListener('message', (ev: { data: unknown }) => {
    const raw = typeof ev.data === 'string' ? ev.data : String(ev.data)
    recordEvent(tally, raw)
  })
}

/* ─────────────────────────────────────── formatting ─────────────────────────────────── */

/** R9: truncate any identifier before it reaches stdout. */
export function short(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id
}

export function buildJetstreamUrl(base: string, dids: string[]): string {
  const url = new URL(base)
  for (const did of dids) url.searchParams.append('wantedDids', did)
  return url.toString()
}

function formatSummary(tally: Tally): string {
  const lines: string[] = []
  lines.push(`total=${tally.total} malformed=${tally.malformed} dids-seen=${tally.dids.size}`)
  if (tally.byCollection.size === 0) {
    lines.push('  (no events)')
  } else {
    for (const [collection, count] of [...tally.byCollection.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${collection}: ${count}`)
    }
  }
  lines.push(`latest cursor (time_us): ${tally.latestCursor ?? '(none)'}`)
  lines.push(`dids seen: ${[...tally.dids].map(short).join(', ') || '(none)'}`)
  return lines.join('\n')
}

/* ────────────────────────────────────── relay calls ─────────────────────────────────── */

export interface ExistenceResult {
  did: string
  known: boolean
  status: number
  detail: string
}

/** `com.atproto.sync.getLatestCommit` — does the relay already have a copy of this repo? */
export async function checkRelayKnowsRepo(relayBaseUrl: string, did: string): Promise<ExistenceResult> {
  const url = `${relayBaseUrl.replace(/\/$/, '')}/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent(did)}`
  const res = await fetch(url)
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { cid?: string; rev?: string }
    return { did, known: true, status: res.status, detail: `rev=${body.rev ?? '?'}` }
  }
  const text = await res.text().catch(() => '')
  return { did, known: false, status: res.status, detail: text.slice(0, 200) }
}

export interface RequestCrawlResult {
  ok: boolean
  status: number
  body: string
}

/** `com.atproto.sync.requestCrawl` — ask the relay to (re-)crawl our PDS. */
export async function requestCrawl(relayBaseUrl: string, hostname: string): Promise<RequestCrawlResult> {
  const res = await fetch(`${relayBaseUrl.replace(/\/$/, '')}/xrpc/com.atproto.sync.requestCrawl`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hostname }),
  })
  const body = await res.text().catch(() => '')
  return { ok: res.ok, status: res.status, body: body.slice(0, 200) }
}

/* ──────────────────────────────────────── main ──────────────────────────────────────── */

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const c = config()
  const schoolDid = args.schoolDid || c.SCHOOL_DID
  const authorityDid = args.authorityDid || c.AUTHORITY_DID
  const dids = [schoolDid, authorityDid].filter((d): d is string => Boolean(d))
  if (dids.length === 0) {
    console.error('no DID to watch: set SCHOOL_DID / AUTHORITY_DID, or pass --school-did= / --authority-did=')
    return 1
  }
  const pdsHost = args.pdsHost || new URL(c.PDS_URL).hostname

  if (args.requestCrawl) {
    console.log(`requestCrawl → ${args.relay} hostname=${pdsHost}`)
    const result = await requestCrawl(args.relay, pdsHost)
    console.log(`  ${result.ok ? 'ok' : 'FAILED'} status=${result.status} ${result.body}`)
  }

  console.log(`existence check → ${args.relay}`)
  for (const did of dids) {
    const result = await checkRelayKnowsRepo(args.relay, did)
    console.log(`  ${short(did)}: ${result.known ? 'known' : 'NOT known'} (status=${result.status}) ${result.detail}`)
  }

  const jetstreamUrl = buildJetstreamUrl(args.jetstream, dids)
  console.log(`listening on Jetstream for ${args.seconds}s: ${args.jetstream} (wantedDids=${dids.map(short).join(',')})`)

  const tally = createTally()
  const socket = new WebSocket(jetstreamUrl) as unknown as SocketLike
  let socketError: string | undefined
  socket.addEventListener('error', (ev) => {
    socketError = ev instanceof Error ? ev.message : String(ev)
  })
  attachTally(socket, tally)
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      socket.close()
      resolve()
    }, args.seconds * 1000)
    socket.addEventListener('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })

  if (socketError) console.error(`socket error: ${socketError}`)
  console.log(formatSummary(tally))

  if (args.expect) {
    if (tally.total === 0) {
      console.error('FAIL: --expect was given and nothing arrived in the window')
      return 2
    }
    const missing = args.expectCollections.filter((c) => !tally.byCollection.has(c))
    if (missing.length > 0) {
      console.error(`FAIL: expected collection(s) never seen: ${missing.join(', ')}`)
      return 2
    }
  }
  return 0
}

if (isMain(import.meta.url)) {
  const code = await main(process.argv.slice(2))
  process.exit(code)
}
