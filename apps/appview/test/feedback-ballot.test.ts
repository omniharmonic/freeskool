/**
 * Feedback ballot separation.
 *
 * The claim under test is the strongest privacy claim in this codebase: after a feedback
 * window closes, NOBODY — not a steward, not an operator with the database, not a court
 * order — can tell who wrote a given piece of feedback. The proof has three parts:
 *
 *   1. the `fs_feedback` table has no column that could hold an author;
 *   2. the ballot is `hmac(perEventKey, did)`, and `perEventKey` is destroyed at close;
 *   3. a second submission by the same DID is refused by the ballot table, so the scheme
 *      still prevents ballot-stuffing.
 *
 * Needs a real Postgres: the atomic claim and the absent column are database facts.
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { ballotToken, newBallotKey } from '../src/lib/crypto.js'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { feedback, feedbackBallot, feedbackWindow } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'

// The DB cases self-skip via `if (!available) return` rather than failing: see helpers/pg.ts.

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})
afterAll(async () => {
  if (available) await closeTestDb()
})

describe('the ballot token itself', () => {
  it('is deterministic per (key, did) and unlinkable across events', () => {
    const keyA = newBallotKey()
    const keyB = newBallotKey()
    const did = 'did:plc:alice'
    expect(ballotToken(keyA, did, 'pepper')).toBe(ballotToken(keyA, did, 'pepper'))
    // Two events -> two keys -> two unrelated tokens for the same person.
    expect(ballotToken(keyA, did, 'pepper')).not.toBe(ballotToken(keyB, did, 'pepper'))
    // Two people under the same key -> different tokens.
    expect(ballotToken(keyA, 'did:plc:bob', 'pepper')).not.toBe(ballotToken(keyA, did, 'pepper'))
    // The deployment pepper matters, so a leaked DB alone is not enough pre-destruction.
    expect(ballotToken(keyA, did, 'other')).not.toBe(ballotToken(keyA, did, 'pepper'))
  })

  it('does not reveal the DID: the token is not reversible or a prefix of anything', () => {
    const key = newBallotKey()
    const token = ballotToken(key, 'did:plc:alice', 'pepper')
    expect(token).not.toContain('alice')
    expect(token).not.toContain('did:')
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  })
})

describe('in the database', () => {
  const EVENT = 'at://did:plc:host/community.lexicon.calendar.event/feedbacktest'

  it('the feedback table has NO column that could hold an author', async () => {
    if (!available) return
    const cols = await testDb().execute(
      sql`select column_name from information_schema.columns where table_name = 'fs_feedback'`,
    )
    const names = (cols.rows as Array<{ column_name: string }>).map((r) => r.column_name).sort()
    expect(names).toEqual(['aspects', 'day', 'direction', 'event_uri', 'host_did', 'id', 'school_did', 'text'])
    // host_did is the SUBJECT of the feedback and school_did is the SCHOOL it was given
    // in (MS §4: k-anonymity is computed within one school). Neither is its author, and
    // nothing else here is a DID at all.
    expect(names.filter((n) => n.includes('author') || n.includes('ballot') || n.includes('attendee'))).toEqual([])
  })

  it('stores content with a DATE, not a timestamp, so write order cannot re-pair rows', async () => {
    if (!available) return
    const type = await testDb().execute(
      sql`select data_type from information_schema.columns where table_name = 'fs_feedback' and column_name = 'day'`,
    )
    expect((type.rows[0] as { data_type: string }).data_type).toBe('date')
  })

  it('keeps ballots and content in separate tables with no join key', async () => {
    if (!available) return
    await truncate('fs_feedback', 'fs_feedback_ballot', 'fs_feedback_window')
    const db = testDb()
    const key = newBallotKey()
    await db.insert(feedbackWindow).values({
      eventUri: EVENT,
      closesAt: new Date(Date.now() + 86_400_000),
      ballotKey: key,
    })

    const voters = ['did:plc:a', 'did:plc:b', 'did:plc:c']
    for (const [i, did] of voters.entries()) {
      await db.insert(feedbackBallot).values({ eventUri: EVENT, ballot: ballotToken(key, did, 'pepper') })
      await db.insert(feedback).values({
        id: `row-${i}`,
        eventUri: EVENT,
        hostDid: 'did:plc:host',
        direction: i === 2 ? 'negative' : 'positive',
        aspects: { teaching: 4 },
        text: `comment ${i}`,
        day: new Date().toISOString().slice(0, 10),
      })
    }

    const ballots = await db.select().from(feedbackBallot).where(eq(feedbackBallot.eventUri, EVENT))
    const rows = await db.select().from(feedback).where(eq(feedback.eventUri, EVENT))
    expect(ballots).toHaveLength(3)
    expect(rows).toHaveLength(3)
    // No row in either table references a row in the other.
    const rowBlob = JSON.stringify(rows)
    for (const b of ballots) expect(rowBlob).not.toContain(b.ballot)
    for (const v of voters) expect(rowBlob).not.toContain(v)
  })

  it('a second ballot from the same DID is refused, so the scheme still stops stuffing', async () => {
    if (!available) return
    await truncate('fs_feedback_ballot', 'fs_feedback_window')
    const db = testDb()
    const key = newBallotKey()
    await db
      .insert(feedbackWindow)
      .values({ eventUri: EVENT, closesAt: new Date(Date.now() + 86_400_000), ballotKey: key })
    const ballot = ballotToken(key, 'did:plc:a', 'pepper')
    const first = await db
      .insert(feedbackBallot)
      .values({ eventUri: EVENT, ballot })
      .onConflictDoNothing()
      .returning({ ballot: feedbackBallot.ballot })
    const second = await db
      .insert(feedbackBallot)
      .values({ eventUri: EVENT, ballot })
      .onConflictDoNothing()
      .returning({ ballot: feedbackBallot.ballot })
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  it('destroying the per-event key makes the mapping permanently unrecoverable', async () => {
    if (!available) return
    await truncate('fs_feedback_ballot', 'fs_feedback_window')
    const db = testDb()
    const key = newBallotKey()
    await db
      .insert(feedbackWindow)
      .values({ eventUri: EVENT, closesAt: new Date(Date.now() - 1000), ballotKey: key })
    const ballot = ballotToken(key, 'did:plc:a', 'pepper')
    await db.insert(feedbackBallot).values({ eventUri: EVENT, ballot })

    await db
      .update(feedbackWindow)
      .set({ ballotKey: null, keyDestroyedAt: new Date(), publishedAt: new Date(), summary: { released: false } })
      .where(eq(feedbackWindow.eventUri, EVENT))

    const after = await db.select().from(feedbackWindow).where(eq(feedbackWindow.eventUri, EVENT))
    expect(after[0]?.ballotKey).toBeNull()
    // With the key gone, the only way to link `ballot` back to a DID is to guess the key:
    // a different key over the same DID yields an unrelated token.
    expect(ballotToken(newBallotKey(), 'did:plc:a', 'pepper')).not.toBe(ballot)
  })
})
