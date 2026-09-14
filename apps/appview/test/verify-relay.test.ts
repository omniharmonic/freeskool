import { describe, expect, it } from 'vitest'
import {
  attachTally,
  buildJetstreamUrl,
  createTally,
  parseArgs,
  recordEvent,
  short,
  type SocketLike,
} from '../scripts/verify-relay.js'

describe('verify-relay: argument parsing', () => {
  it('defaults seconds to 60 and every flag to off', () => {
    const args = parseArgs([])
    expect(args.seconds).toBe(60)
    expect(args.expect).toBe(false)
    expect(args.expectCollections).toEqual([])
    expect(args.requestCrawl).toBe(false)
    expect(args.relay).toBe('https://bsky.network')
    expect(args.jetstream).toBe('wss://jetstream2.us-east.bsky.network/subscribe')
    expect(args.schoolDid).toBeUndefined()
    expect(args.authorityDid).toBeUndefined()
    expect(args.pdsHost).toBeUndefined()
  })

  it('parses --seconds=', () => {
    expect(parseArgs(['--seconds=30']).seconds).toBe(30)
  })

  it('rejects a non-positive or non-numeric --seconds', () => {
    expect(() => parseArgs(['--seconds=0'])).toThrow()
    expect(() => parseArgs(['--seconds=-5'])).toThrow()
    expect(() => parseArgs(['--seconds=nope'])).toThrow()
  })

  it('--expect with no value enables the empty-window check with no required collections', () => {
    const args = parseArgs(['--expect'])
    expect(args.expect).toBe(true)
    expect(args.expectCollections).toEqual([])
  })

  it('--expect=<collections> enables the check and names what must be seen', () => {
    const args = parseArgs(['--expect=coop.lexicon.event.listing,community.lexicon.calendar.event'])
    expect(args.expect).toBe(true)
    expect(args.expectCollections).toEqual(['coop.lexicon.event.listing', 'community.lexicon.calendar.event'])
  })

  it('parses --request-crawl, --relay=, --jetstream=, and the DID/host overrides', () => {
    const args = parseArgs([
      '--request-crawl',
      '--relay=https://relay.test',
      '--jetstream=wss://jetstream.test/subscribe',
      '--school-did=did:plc:school',
      '--authority-did=did:plc:authority',
      '--pds-host=pds.example.test',
    ])
    expect(args.requestCrawl).toBe(true)
    expect(args.relay).toBe('https://relay.test')
    expect(args.jetstream).toBe('wss://jetstream.test/subscribe')
    expect(args.schoolDid).toBe('did:plc:school')
    expect(args.authorityDid).toBe('did:plc:authority')
    expect(args.pdsHost).toBe('pds.example.test')
  })
})

describe('verify-relay: buildJetstreamUrl', () => {
  it('repeats wantedDids once per DID, order preserved', () => {
    const url = buildJetstreamUrl('wss://jetstream2.us-east.bsky.network/subscribe', [
      'did:plc:school',
      'did:plc:authority',
    ])
    const parsed = new URL(url)
    expect(parsed.searchParams.getAll('wantedDids')).toEqual(['did:plc:school', 'did:plc:authority'])
  })

  it('with no DIDs, adds no wantedDids param', () => {
    const url = buildJetstreamUrl('wss://jetstream2.us-east.bsky.network/subscribe', [])
    expect(new URL(url).searchParams.has('wantedDids')).toBe(false)
  })
})

describe('verify-relay: short (R9 truncation)', () => {
  it('truncates anything over 12 characters and marks it truncated', () => {
    expect(short('did:plc:abcdefghijklmnop')).toBe('did:plc:abcd…')
  })

  it('leaves short strings untouched', () => {
    expect(short('short')).toBe('short')
  })
})

describe('verify-relay: recordEvent / createTally', () => {
  it('tallies by collection, total, dids, and the latest cursor', () => {
    const tally = createTally()
    recordEvent(
      tally,
      JSON.stringify({
        did: 'did:plc:school',
        time_us: 100,
        kind: 'commit',
        commit: { collection: 'coop.lexicon.event.listing', rkey: 'a', operation: 'create' },
      }),
    )
    recordEvent(
      tally,
      JSON.stringify({
        did: 'did:plc:authority',
        time_us: 200,
        kind: 'commit',
        commit: { collection: 'coop.lexicon.event.listing', rkey: 'b', operation: 'create' },
      }),
    )
    recordEvent(
      tally,
      JSON.stringify({
        did: 'did:plc:school',
        time_us: 150,
        kind: 'commit',
        commit: { collection: 'community.lexicon.calendar.event', rkey: 'c', operation: 'create' },
      }),
    )

    expect(tally.total).toBe(3)
    expect(tally.byCollection.get('coop.lexicon.event.listing')).toBe(2)
    expect(tally.byCollection.get('community.lexicon.calendar.event')).toBe(1)
    expect(tally.dids).toEqual(new Set(['did:plc:school', 'did:plc:authority']))
    // time_us values arrive out of order (150 after 200); the latest cursor is the max seen.
    expect(tally.latestCursor).toBe(200)
  })

  it('falls back to a "(kind)" bucket when commit.collection is absent', () => {
    const tally = createTally()
    recordEvent(tally, JSON.stringify({ did: 'did:plc:school', kind: 'identity' }))
    expect(tally.byCollection.get('(identity)')).toBe(1)
  })

  it('counts malformed frames without throwing and without touching the other tallies', () => {
    const tally = createTally()
    recordEvent(tally, '{not json')
    expect(tally.malformed).toBe(1)
    expect(tally.total).toBe(0)
    expect(tally.byCollection.size).toBe(0)
  })
})

/** A fake `WebSocket`-shaped object: stores listeners, lets the test fire them by hand. */
class FakeSocket implements SocketLike {
  private listeners = new Map<string, Array<(ev: unknown) => void>>()

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  emit(type: string, ev: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(ev)
  }

  close(): void {
    this.emit('close', {})
  }
}

describe('verify-relay: attachTally wires a fake socket', () => {
  it('tallies every message event delivered to the socket', () => {
    const socket = new FakeSocket()
    const tally = createTally()
    attachTally(socket, tally)

    socket.emit('message', { data: JSON.stringify({ did: 'did:plc:school', time_us: 1, commit: { collection: 'freeschool.draft.school' } }) })
    socket.emit('message', { data: JSON.stringify({ did: 'did:plc:school', time_us: 2, commit: { collection: 'freeschool.draft.school' } }) })

    expect(tally.total).toBe(2)
    expect(tally.byCollection.get('freeschool.draft.school')).toBe(2)
    expect(tally.latestCursor).toBe(2)
  })

  it('handles a Buffer-shaped `data` (the raw WebSocket delivers one over the wire)', () => {
    const socket = new FakeSocket()
    const tally = createTally()
    attachTally(socket, tally)

    const raw = JSON.stringify({ did: 'did:plc:school', time_us: 5, commit: { collection: 'coop.lexicon.event.listing' } })
    socket.emit('message', { data: Buffer.from(raw) })

    expect(tally.total).toBe(1)
    expect(tally.byCollection.get('coop.lexicon.event.listing')).toBe(1)
  })

  it('closing the fake socket does not throw and leaves the tally untouched', () => {
    const socket = new FakeSocket()
    const tally = createTally()
    attachTally(socket, tally)
    expect(() => socket.close()).not.toThrow()
    expect(tally.total).toBe(0)
  })
})
