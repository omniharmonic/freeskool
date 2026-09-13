/**
 * `PdsChangeSource` — live indexing from peer PDS hosts.
 *
 * The hermetic suites run a local `subscribeRepos` test double (see
 * `helpers/subscribe-repos-double.ts`) that speaks the real two-CBOR-value frame
 * format, so `@atproto/xrpc-server`'s `Subscription` and `@atproto/sync`'s commit
 * parsers run unmodified. Nothing here reaches the network beyond `127.0.0.1`, and
 * nothing prints: every log line goes to a capturing logger that the tests assert on.
 *
 * The last suite is the end-to-end proof R4 could not produce — write a record to a
 * real PDS and watch it come back out of that PDS's own firehose — and skips when
 * `PDS_URL` is unreachable.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { like } from 'drizzle-orm'
import { appMeta } from '../src/db/schema.js'
import { closeTestDb, pgAvailable, testDb } from './helpers/pg.js'
import { PdsChangeSource, PDS_SOURCE_SEMANTICS } from '../src/sync/pds-change-source.js'
import { encodeCursorMap, decodeCursorMap, cursorMapReached } from '../src/sync/cursor-map.js'
import { AppMetaPeerState, MemoryPeerState } from '../src/sync/peer-state.js'
import { APPVIEW_VERSION, peerName, peerUserAgent } from '../src/index/live-sync.js'
import { PeerRepair, REPAIR_SOURCE_ID } from '../src/sync/repair.js'
import { Identity } from '@freeschool/pds-follow'
import { NSID } from '../src/lexicons/nsids.js'
import {
  accountFrame,
  commitFrame,
  identityFrame,
  infoFrame,
  startFakePds,
  type FakePds,
} from './helpers/subscribe-repos-double.js'
import type { IndexTarget, PeerRepairRequest, RepairQueue } from '../src/sync/pds-change-source.js'
import type { IngestEvent } from '@atmo-dev/contrail'

const DID = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER_DID = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'

function eventRecord(name: string) {
  return {
    $type: NSID.event,
    name,
    createdAt: '2026-09-12T10:00:00.000Z',
    startsAt: '2026-10-01T18:00:00.000Z',
    mode: 'community.lexicon.calendar.event#inperson',
    status: 'community.lexicon.calendar.event#scheduled',
  }
}

/** Records everything handed to contrail, so the suites never need a database. */
function recordingTarget(): IndexTarget & { events: IngestEvent[] } {
  const events: IngestEvent[] = []
  return {
    events,
    async ingest(batch) {
      events.push(...batch)
      return { accepted: batch.length }
    },
  }
}

function recordingRepair(): RepairQueue & { requests: PeerRepairRequest[] } {
  const requests: PeerRepairRequest[] = []
  return {
    requests,
    async enqueue(request) {
      requests.push(request)
    },
  }
}

function capturingLogger(): { lines: string[]; info: (m: string, f?: object) => void; warn: (m: string, f?: object) => void } {
  const lines: string[] = []
  const push = (m: string, f?: object) => lines.push(`${m} ${f ? JSON.stringify(f) : ''}`)
  return { lines, info: push, warn: push }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/* ─────────────────────────────── the cursor-map codec ─────────────────────────────── */

describe('cursor map codec', () => {
  it('round-trips and is canonical regardless of insertion order', () => {
    const a = encodeCursorMap({ 'https://b.example': 2, 'https://a.example': 1 })
    const b = encodeCursorMap({ 'https://a.example': 1, 'https://b.example': 2 })
    expect(a).toBe(b)
    expect(decodeCursorMap(a)).toEqual({ 'https://a.example': 1, 'https://b.example': 2 })
  })

  it('is reached only when every host is at or past the target', () => {
    const through = { a: 5, b: 7 }
    expect(cursorMapReached({ a: 5, b: 7 }, through)).toBe(true)
    expect(cursorMapReached({ a: 5, b: 6 }, through)).toBe(false)
    expect(cursorMapReached({ a: 9 }, through)).toBe(false)
  })
})

describe('source semantics', () => {
  it('tells contrail there is no explicit head, which is what forces mark()', () => {
    expect(PDS_SOURCE_SEMANTICS.explicitHead).toBe(false)
    expect(PDS_SOURCE_SEMANTICS.accountLifecycle).toBe(true)
    expect(PDS_SOURCE_SEMANTICS.ordinaryDeletes).toBe(true)
  })
})

/* ───────────────────────────────── the live source ───────────────────────────────── */

describe('PdsChangeSource live sync', () => {
  const running: Array<{ stop: () => Promise<void> }> = []
  const servers: FakePds[] = []

  afterEach(async () => {
    while (running.length) await running.pop()!.stop()
    while (servers.length) await servers.pop()!.close()
  })

  async function source(options: {
    fake: FakePds
    state?: MemoryPeerState
    target?: ReturnType<typeof recordingTarget>
    repair?: ReturnType<typeof recordingRepair>
    logger?: ReturnType<typeof capturingLogger>
    readIdleTimeoutMs?: number
  }) {
    const state = options.state ?? new MemoryPeerState()
    const target = options.target ?? recordingTarget()
    const repair = options.repair ?? recordingRepair()
    const logger = options.logger ?? capturingLogger()
    const src = new PdsChangeSource({
      hosts: [{ host: options.fake.host, name: 'fake-peer' }],
      epoch: 'test-epoch-1',
      collections: [NSID.event, NSID.rsvp],
      userAgent: 'freeschool-appview/0.0.1 (+http://localhost:4000)',
      unauthenticatedCommits: true,
      state,
      target,
      repair,
      logger,
      // Keep the suite fast: the real default is 16 s.
      maxReconnectSeconds: 1,
      ...(options.readIdleTimeoutMs !== undefined ? { readIdleTimeoutMs: options.readIdleTimeoutMs } : {}),
    })
    return { src, state, target, repair, logger }
  }

  it('indexes a calendar event carried by a #commit', async () => {
    const { frame, cid } = await commitFrame({
      seq: 41,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey001',
      record: eventRecord('Intro to sourdough'),
    })
    const fake = await startFakePds([frame])
    servers.push(fake)
    const { src, target } = await source({ fake })
    running.push(src)
    await src.start()

    await waitFor(() => target.events.length >= 1)
    expect(target.events).toHaveLength(1)
    const evt = target.events[0]!
    expect(evt.uri).toBe(`at://${DID}/${NSID.event}/3lfakerkey001`)
    expect(evt.collection).toBe(NSID.event)
    expect(evt.operation).toBe('create')
    expect(evt.cid).toBe(cid)
    expect(JSON.parse(evt.record!)).toMatchObject({ name: 'Intro to sourdough' })
    // Source ordering metadata is what lets contrail drop a replay from the
    // 15-minute backfill that arrives after this.
    expect(evt.source?.epoch).toBe('test-epoch-1')
    expect(evt.source?.cursor).toBe('41')
  })

  it('drops ops in collections we do not index', async () => {
    const { frame } = await commitFrame({
      seq: 7,
      repo: DID,
      collection: 'app.bsky.feed.post',
      rkey: '3lfakerkey002',
      record: { $type: 'app.bsky.feed.post', text: 'hi', createdAt: '2026-09-12T10:00:00.000Z' },
    })
    const wanted = await commitFrame({
      seq: 8,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey003',
      record: eventRecord('Bike repair'),
    })
    const fake = await startFakePds([frame, wanted.frame])
    servers.push(fake)
    const { src, target } = await source({ fake })
    running.push(src)
    await src.start()

    await waitFor(() => target.events.length >= 1)
    expect(target.events).toHaveLength(1)
    expect(target.events[0]!.collection).toBe(NSID.event)
  })

  it('persists the per-host cursor monotonically and resumes from the stored value', async () => {
    const first = await commitFrame({
      seq: 100,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey004',
      record: eventRecord('Seed swap'),
    })
    const fake = await startFakePds([first.frame])
    servers.push(fake)
    const state = new MemoryPeerState()
    const one = await source({ fake, state })
    running.push(one.src)
    await one.src.start()

    await waitFor(() => one.target.events.length >= 1)
    await one.src.flush()
    expect(await state.getCursor(fake.host)).toBe(100)
    // Monotonic: a partition finishing late must never walk the cursor backwards.
    state.recordCursor(fake.host, 40)
    await state.flush()
    expect(await state.getCursor(fake.host)).toBe(100)

    // A fresh process with the same store must dial with the stored cursor.
    await running.pop()!.stop()
    fake.setGreeting([])
    const two = await source({ fake, state })
    running.push(two.src)
    await two.src.start()
    await waitFor(() => fake.cursors.length >= 2)
    expect(fake.cursors[1]).toBe(100)
  })

  it('re-dials with the stored cursor after the socket drops', async () => {
    const first = await commitFrame({
      seq: 55,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey005',
      record: eventRecord('Mending circle'),
    })
    const fake = await startFakePds([first.frame])
    servers.push(fake)
    const { src, logger } = await source({ fake })
    running.push(src)
    await src.start()
    await waitFor(() => fake.cursors.length >= 1)

    fake.setGreeting([])
    fake.dropConnections()
    await waitFor(() => fake.cursors.length >= 2, 15_000)
    expect(fake.cursors[1]).toBe(55)
    // Reconnects are logged by host NAME, never by DID (R9).
    const reconnects = logger.lines.filter((l) => l.includes('peer reconnect'))
    expect(reconnects.length).toBeGreaterThan(0)
    expect(reconnects.join('\n')).toContain('fake-peer')
    expect(logger.lines.join('\n')).not.toContain('did:plc:')
  })

  it('sends a User-Agent so peer operators can identify us', async () => {
    const fake = await startFakePds([])
    servers.push(fake)
    const { src } = await source({ fake })
    running.push(src)
    await src.start()
    await waitFor(() => fake.headers.length >= 1)
    expect(fake.headers[0]!['user-agent']).toBe('freeschool-appview/0.0.1 (+http://localhost:4000)')
  })

  it('enqueues a listRecords repair for the whole host on #info OutdatedCursor', async () => {
    const fake = await startFakePds([infoFrame('OutdatedCursor', 'Requested cursor exceeded limit. Possibly missing events')])
    servers.push(fake)
    const { src, repair } = await source({ fake })
    running.push(src)
    await src.start()

    await waitFor(() => repair.requests.length >= 1)
    expect(repair.requests[0]).toMatchObject({ host: fake.host, reason: 'OutdatedCursor' })
  })

  it('ignores #info names other than OutdatedCursor', async () => {
    const fake = await startFakePds([infoFrame('SomethingElse')])
    servers.push(fake)
    const { src, repair } = await source({ fake })
    running.push(src)
    await src.start()
    await waitFor(() => fake.connections >= 1)
    await new Promise((r) => setTimeout(r, 200))
    expect(repair.requests).toHaveLength(0)
  })

  it('maps #account statuses onto the peer repo status', async () => {
    const fake = await startFakePds([
      accountFrame({ seq: 10, did: DID, active: false, status: 'deleted' }),
      accountFrame({ seq: 11, did: OTHER_DID, active: false, status: 'desynchronized' }),
    ])
    servers.push(fake)
    const { src, state } = await source({ fake })
    running.push(src)
    await src.start()

    await waitFor(async () => (await state.getRepoStatus(fake.host, OTHER_DID)) !== undefined)
    expect(await state.getRepoStatus(fake.host, DID)).toBe('deleted')
    // `desynchronized` and `throttled` are in the lexicon but missing from
    // @atproto/sync's AccountStatus, which is why we read the frame ourselves.
    expect(await state.getRepoStatus(fake.host, OTHER_DID)).toBe('desynchronized')
  })

  it('maps active=true back to active', async () => {
    const fake = await startFakePds([accountFrame({ seq: 12, did: DID, active: true })])
    servers.push(fake)
    const { src, state } = await source({ fake })
    running.push(src)
    await src.start()
    await waitFor(async () => (await state.getRepoStatus(fake.host, DID)) !== undefined)
    expect(await state.getRepoStatus(fake.host, DID)).toBe('active')
  })

  it('re-resolves on #identity and flags a repo that moved off this peer', async () => {
    const fake = await startFakePds([identityFrame({ seq: 20, did: DID })])
    servers.push(fake)
    const state = new MemoryPeerState()
    const resolved: string[] = []
    const src = new PdsChangeSource({
      hosts: [{ host: fake.host, name: 'fake-peer' }],
      epoch: 'test-epoch-1',
      collections: [NSID.event],
      userAgent: 'freeschool-appview/test (+http://localhost:4000)',
      unauthenticatedCommits: true,
      state,
      target: recordingTarget(),
      repair: recordingRepair(),
      logger: capturingLogger(),
      maxReconnectSeconds: 1,
      resolvePdsEndpoint: async (did) => {
        resolved.push(did)
        return 'https://elsewhere.example'
      },
    })
    running.push(src)
    await src.start()

    await waitFor(async () => (await state.getRepo(fake.host, DID))?.movedOffThisPeer === true)
    expect(resolved).toEqual([DID])
    const repo = await state.getRepo(fake.host, DID)
    expect(repo).toMatchObject({ movedOffThisPeer: true, pds: 'https://elsewhere.example' })
  })

  it('does not flag a repo whose DID doc still names this peer', async () => {
    const fake = await startFakePds([identityFrame({ seq: 21, did: DID })])
    servers.push(fake)
    const state = new MemoryPeerState()
    const src = new PdsChangeSource({
      hosts: [{ host: fake.host, name: 'fake-peer' }],
      epoch: 'test-epoch-1',
      collections: [NSID.event],
      userAgent: 'freeschool-appview/test (+http://localhost:4000)',
      unauthenticatedCommits: true,
      state,
      target: recordingTarget(),
      repair: recordingRepair(),
      logger: capturingLogger(),
      maxReconnectSeconds: 1,
      resolvePdsEndpoint: async () => fake.host,
    })
    running.push(src)
    await src.start()

    await waitFor(async () => (await state.getRepo(fake.host, DID)) !== undefined)
    expect((await state.getRepo(fake.host, DID))?.movedOffThisPeer).toBe(false)
  })

  it('mark() opens a socket, takes the head seq per host, and closes', async () => {
    const head = await commitFrame({
      seq: 9001,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey006',
      record: eventRecord('Head marker'),
    })
    const fake = await startFakePds([head.frame])
    servers.push(fake)
    const { src } = await source({ fake })
    const position = await src.mark({ collections: [NSID.event] })
    expect(position.source).toBe('pds-subscribe-repos')
    expect(position.epoch).toBe('test-epoch-1')
    expect(decodeCursorMap(position.cursor)).toEqual({ [fake.host]: 9001 })
  })

  it('read() replays after→through and reports caughtUp at the boundary', async () => {
    const a = await commitFrame({
      seq: 1,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey007',
      record: eventRecord('Replay one'),
    })
    const b = await commitFrame({
      seq: 2,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey008',
      record: eventRecord('Replay two'),
    })
    const fake = await startFakePds([a.frame, b.frame])
    servers.push(fake)
    const { src } = await source({ fake })

    const mutations: string[] = []
    let caughtUp = false
    for await (const batch of src.read({
      collections: [NSID.event],
      after: { source: 'pds-subscribe-repos', epoch: 'test-epoch-1', cursor: encodeCursorMap({ [fake.host]: 0 }) },
      through: { source: 'pds-subscribe-repos', epoch: 'test-epoch-1', cursor: encodeCursorMap({ [fake.host]: 2 }) },
    })) {
      for (const m of batch.mutations) mutations.push(m.uri)
      if (batch.caughtUp) {
        caughtUp = true
        break
      }
    }
    expect(caughtUp).toBe(true)
    expect(mutations).toEqual([
      `at://${DID}/${NSID.event}/3lfakerkey007`,
      `at://${DID}/${NSID.event}/3lfakerkey008`,
    ])
  })

  it('read() leaves the checkpoint short of through when the boundary never arrives', async () => {
    // Only seq 1 exists, but `through` asks for 5: an honest source must NOT claim
    // caughtUp, or contrail would certify a gap it never saw.
    const a = await commitFrame({
      seq: 1,
      repo: DID,
      collection: NSID.event,
      rkey: '3lfakerkey009',
      record: eventRecord('Lonely event'),
    })
    const fake = await startFakePds([a.frame])
    servers.push(fake)
    const { src } = await source({ fake, readIdleTimeoutMs: 150 })

    const batches: Array<{ cursor: string; caughtUp: boolean }> = []
    for await (const batch of src.read({
      collections: [NSID.event],
      after: { source: 'pds-subscribe-repos', epoch: 'test-epoch-1', cursor: encodeCursorMap({ [fake.host]: 0 }) },
      through: { source: 'pds-subscribe-repos', epoch: 'test-epoch-1', cursor: encodeCursorMap({ [fake.host]: 5 }) },
    })) {
      batches.push({ cursor: batch.checkpoint.cursor, caughtUp: batch.caughtUp })
    }
    expect(batches.every((b) => !b.caughtUp)).toBe(true)
    expect(decodeCursorMap(batches.at(-1)!.cursor)).toEqual({ [fake.host]: 1 })
  })

  it('refuses a position from another epoch rather than comparing incomparable cursors', async () => {
    const fake = await startFakePds([])
    servers.push(fake)
    const { src } = await source({ fake })
    const iterate = async () => {
      for await (const _ of src.read({
        collections: [NSID.event],
        after: { source: 'pds-subscribe-repos', epoch: 'other-epoch', cursor: '' },
        through: { source: 'pds-subscribe-repos', epoch: 'test-epoch-1', cursor: '' },
      })) {
        /* unreachable */
      }
    }
    await expect(iterate()).rejects.toThrow(/epoch/i)
  })
})

/* ──────────────────────────────── the repair worker ──────────────────────────────── */

describe('PeerRepair', () => {
  const servers: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    while (servers.length) await servers.pop()!.close()
  })

  /** The one XRPC method a `listRecords` repair calls. */
  async function fakeListRecords(records: Array<{ rkey: string; value: Record<string, unknown> }>) {
    const { createServer } = await import('node:http')
    const { cidForLex } = await import('@atproto/lex-cbor')
    // Real CIDs: @atproto/api validates the `cid` field, and a CID that actually
    // matches the record is what contrail's optional cid check would demand.
    const withCids = await Promise.all(
      records.map(async (r) => ({ ...r, cid: (await cidForLex(r.value as never)).toString() })),
    )
    const calls: Array<{ repo: string; collection: string }> = []
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.endsWith('com.atproto.repo.listRecords')) {
        res.writeHead(404).end()
        return
      }
      const repo = url.searchParams.get('repo') ?? ''
      const collection = url.searchParams.get('collection') ?? ''
      calls.push({ repo, collection })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          records:
            collection === NSID.event
              ? withCids.map((r) => ({
                  uri: `at://${repo}/${collection}/${r.rkey}`,
                  cid: r.cid,
                  value: r.value,
                }))
              : [],
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const handle = {
      host: `http://127.0.0.1:${port}`,
      calls,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
    servers.push(handle)
    return handle
  }

  it('re-reads every repo on the host with listRecords and ingests the result', async () => {
    const pds = await fakeListRecords([{ rkey: '3lrepaired001', value: eventRecord('Recovered from a gap') }])
    const target = recordingTarget()
    const repair = new PeerRepair({
      collections: [NSID.event, NSID.rsvp],
      target,
      nameForHost: () => 'fake-peer',
      logger: capturingLogger(),
      identity: new Identity('https://plc.directory'),
      allowPrivateNetwork: () => true,
      listReposForHost: async () => [DID, OTHER_DID],
    })

    await repair.enqueue({ host: pds.host, reason: 'OutdatedCursor' })
    await repair.drain()

    // Both repos, both configured collections.
    expect(pds.calls).toHaveLength(4)
    expect(new Set(pds.calls.map((c) => c.repo))).toEqual(new Set([DID, OTHER_DID]))
    expect(target.events).toHaveLength(2)
    for (const event of target.events) {
      expect(event.collection).toBe(NSID.event)
      // `update` because a repaired record may or may not already be indexed, and the
      // page is the repo's current state either way.
      expect(event.operation).toBe('update')
      expect(event.source?.id).toBe(REPAIR_SOURCE_ID)
    }
  })

  it('does not repeat a repair for the same host inside the cooldown', async () => {
    const pds = await fakeListRecords([])
    let listed = 0
    const repair = new PeerRepair({
      collections: [NSID.event],
      target: recordingTarget(),
      nameForHost: () => 'fake-peer',
      logger: capturingLogger(),
      identity: new Identity('https://plc.directory'),
      allowPrivateNetwork: () => true,
      cooldownMs: 60_000,
      listReposForHost: async () => {
        listed++
        return [DID]
      },
    })
    await repair.enqueue({ host: pds.host, reason: 'OutdatedCursor' })
    await repair.enqueue({ host: pds.host, reason: 'OutdatedCursor' })
    await repair.drain()
    expect(listed).toBe(1)
  })

  it('stops accepting work once stopped', async () => {
    const pds = await fakeListRecords([])
    let listed = 0
    const repair = new PeerRepair({
      collections: [NSID.event],
      target: recordingTarget(),
      nameForHost: () => 'fake-peer',
      logger: capturingLogger(),
      identity: new Identity('https://plc.directory'),
      allowPrivateNetwork: () => true,
      listReposForHost: async () => {
        listed++
        return [DID]
      },
    })
    await repair.stop()
    await repair.enqueue({ host: pds.host, reason: 'OutdatedCursor' })
    await repair.drain()
    expect(listed).toBe(0)
  })
})

/* ─────────────────────────────── the production wiring ─────────────────────────────── */

describe('live-sync wiring', () => {
  it('builds the User-Agent R4 asks for, from a version that has not drifted', async () => {
    const { readFile } = await import('node:fs/promises')
    const here = new URL('../package.json', import.meta.url)
    const manifest = JSON.parse(await readFile(here, 'utf8')) as { version: string }
    expect(APPVIEW_VERSION).toBe(manifest.version)
    expect(peerUserAgent(APPVIEW_VERSION, 'https://freeschool.example')).toBe(
      `freeschool-appview/${manifest.version} (+https://freeschool.example)`,
    )
  })

  it('names a peer by its leading label, but keeps an IP literal whole', () => {
    expect(peerName('https://pds.example.org')).toBe('pds')
    expect(peerName('http://localhost:3000')).toBe('localhost')
    expect(peerName('http://127.0.0.1:3000')).toBe('127.0.0.1')
  })
})

/* ─────────────────── the production store, against a real Postgres ─────────────────── */

/**
 * `AppMetaPeerState` is the only piece the hermetic suites substitute away, so it gets
 * its own live-Postgres pass. Keys are suffixed per run and deleted afterwards rather
 * than truncating `fs_app_meta`, which other suites also use.
 */
const PG_AVAILABLE = await pgAvailable()

describe.skipIf(!PG_AVAILABLE)('AppMetaPeerState (live Postgres)', () => {
  const host = `https://peer-state-${Math.random().toString(36).slice(2, 8)}.example`

  afterAll(async () => {
    await testDb().delete(appMeta).where(like(appMeta.key, `%${host.replace('https://', '')}%`))
    await closeTestDb()
  })

  it('persists a cursor monotonically across store instances', async () => {
    const one = new AppMetaPeerState(testDb(), 5)
    one.recordCursor(host, 1_030_000_000)
    await one.flush()
    // `bigint` territory: R4 notes one live host was already past 1.03e9.
    expect(await new AppMetaPeerState(testDb()).getCursor(host)).toBe(1_030_000_000)

    const two = new AppMetaPeerState(testDb(), 5)
    two.recordCursor(host, 12)
    await two.flush()
    expect(await new AppMetaPeerState(testDb()).getCursor(host)).toBe(1_030_000_000)
  })

  it('persists repo status, the moved flag and the newest rev without losing the others', async () => {
    const store = new AppMetaPeerState(testDb(), 5)
    await store.setRepoStatus(host, DID, 'desynchronized', '2026-09-12T10:00:00.000Z')
    await store.setRepoIdentity(host, DID, { movedOffThisPeer: true, pds: 'https://new.example', at: '2026-09-12T10:01:00.000Z' })
    await store.setRepoRev(host, DID, '3lzzzzzzzzzz2')
    // An older rev must not overwrite a newer one.
    await store.setRepoRev(host, DID, '3laaaaaaaaaa1')

    const fresh = await new AppMetaPeerState(testDb()).getRepo(host, DID)
    expect(fresh).toMatchObject({
      status: 'desynchronized',
      movedOffThisPeer: true,
      pds: 'https://new.example',
      lastRev: '3lzzzzzzzzzz2',
    })
  })
})

/* ──────────────────────── end-to-end against the local PDS ──────────────────────── */

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:3000'

/**
 * The end-to-end proof R4 could not produce: write a record to a real PDS and watch
 * it come back out of that PDS's own firehose. Needs the reference PDS up AND the
 * admin password (to mint a throwaway account), so it is gated, not failed — a
 * contributor without `pnpm infra:up` should still get a green run.
 */
async function liveEnvironment(): Promise<boolean> {
  if (!process.env.PDS_ADMIN_PASSWORD) return false
  try {
    const res = await fetch(`${PDS_URL}/xrpc/_health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

const LIVE_PDS = await liveEnvironment()

describe.skipIf(!LIVE_PDS)('PdsChangeSource against the live local PDS', () => {
  it('sees a record written to the PDS arrive on its own firehose within 10s', async () => {
    const { createAccount, createInviteCode, agentForAppPassword, createRecord, deleteRecord } = await import(
      '../src/lib/pds.js'
    )
    const { config } = await import('../src/config.js')
    const suffix = Math.random().toString(36).slice(2, 8)
    const handle = `live-source-${suffix}.${config().handleDomain}`
    const password = `pw-${Math.random().toString(36).slice(2)}`
    const account = await createAccount({
      handle,
      email: `live-source-${suffix}@example.invalid`,
      password,
      inviteCode: await createInviteCode(),
    })
    const { agent } = await agentForAppPassword(handle, password)

    const target = recordingTarget()
    const src = new PdsChangeSource({
      hosts: [{ host: PDS_URL, name: 'local-pds' }],
      epoch: 'test-live-1',
      collections: [NSID.event],
      userAgent: 'freeschool-appview/test (+http://localhost:4000)',
      // The dev PDS's DIDs may not have propagated to the public PLC yet.
      unauthenticatedCommits: true,
      state: new MemoryPeerState(),
      target,
      repair: recordingRepair(),
      logger: capturingLogger(),
    })
    try {
      await src.start()
      // Let the socket attach before writing, so the record is live traffic rather
      // than something only a cursor replay would have found.
      await new Promise((r) => setTimeout(r, 500))
      const written = await createRecord(agent, {
        repo: account.did,
        collection: NSID.event,
        record: eventRecord(`Live source proof ${suffix}`),
      })
      const rkey = written.uri.split('/').pop()!
      await waitFor(() => target.events.some((e) => e.uri === written.uri), 10_000)
      const seen = target.events.find((e) => e.uri === written.uri)!
      expect(seen.collection).toBe(NSID.event)
      expect(seen.operation).toBe('create')
      expect(JSON.parse(seen.record!)).toMatchObject({ name: `Live source proof ${suffix}` })

      // And a delete arrives as a delete, which is what `ordinaryDeletes: true` claims.
      await deleteRecord(agent, { repo: account.did, collection: NSID.event, rkey })
      await waitFor(() => target.events.some((e) => e.uri === written.uri && e.operation === 'delete'), 10_000)
    } finally {
      await src.stop()
    }
  }, 45_000)
})
