/**
 * `PostgresSpaceStore` against a real Postgres.
 *
 * These are `packages/spaces-shim/test/memory.test.ts` — the SAME four cases, the same
 * assertions — re-pointed at the Postgres implementation, plus a handful of extra cases
 * for the things only a database can get wrong (re-adding a member, idempotent
 * `createSpace`, deletes by a non-author). If the two implementations ever diverge, one of
 * these fails.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { SpaceAccessError, type Did } from '@freeschool/spaces-shim'
import { PostgresSpaceStore } from '../src/spaces/postgres-store.js'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'

const school = 'did:plc:school' as Did
const host = 'did:plc:host' as Did
const a = 'did:plc:a' as Did
const steward = 'did:plc:steward' as Did

let available = false
let store: PostgresSpaceStore

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) {
    console.warn(SKIP_MESSAGE)
    return
  }
  store = new PostgresSpaceStore(testDb())
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_space_record', 'fs_space_member', 'fs_space')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

const feedbackSpace = () =>
  store.createSpace({
    authority: school,
    spaceType: 'freeschool.draft.space.feedback',
    skey: 'boulder',
    policy: { read: ['moderator'], write: ['member'], hostMayRead: false },
  })

describe('Spaces-shaped store over Postgres (mirrors the in-memory reference)', () => {
  it('authority creates a space and controls membership', async () => {
    if (!available) return
    const space = await feedbackSpace()
    expect(space.uri).toBe('at://did:plc:school/freeschool.draft.space.feedback/boulder')
    await store.addMember(space.uri, school, a, 'member')
    await expect(store.addMember(space.uri, a, host, 'member')).rejects.toBeInstanceOf(SpaceAccessError)
  })

  it('members write; non-members cannot; the host (subject) cannot read raw rows', async () => {
    if (!available) return
    const space = await feedbackSpace()
    await store.addMember(space.uri, school, a, 'member')
    await store.addMember(space.uri, school, host, 'member')
    await store.addMember(space.uri, school, steward, 'moderator')
    const rec = await store.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', {
      host,
      direction: 'negative',
      text: 'x',
    })
    expect(rec.uri.startsWith(space.uri + '/did:plc:a/freeschool.draft.hostFeedback/')).toBe(true)
    await expect(
      store.putRecord(space.uri, 'did:plc:outsider' as Did, 'freeschool.draft.hostFeedback', {}),
    ).rejects.toBeInstanceOf(SpaceAccessError)
    // `host` IS a member, but `write`-only policy + hostMayRead:false means no raw rows.
    await expect(store.listRecords(space.uri, host, 'freeschool.draft.hostFeedback')).rejects.toBeInstanceOf(
      SpaceAccessError,
    )
    const rows = await store.listRecords(space.uri, steward, 'freeschool.draft.hostFeedback')
    expect(rows).toHaveLength(1)
  })

  it('the aggregator service reads with the authority credential', async () => {
    if (!available) return
    const space = await feedbackSpace()
    await store.addMember(space.uri, school, a, 'member')
    await store.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { host, direction: 'positive' })
    const rows = await store.listRecords(space.uri, school, 'freeschool.draft.hostFeedback')
    expect(rows[0]?.author).toBe(a)
  })

  it('removing a member revokes write', async () => {
    if (!available) return
    const space = await store.createSpace({
      authority: school,
      spaceType: 'freeschool.draft.space.members',
      skey: 'boulder',
      policy: { read: ['member'], write: ['moderator'], hostMayRead: true },
    })
    await store.addMember(space.uri, school, a, 'moderator')
    await store.removeMember(space.uri, school, a)
    await expect(store.putRecord(space.uri, a, 'coop.lexicon.membership', {})).rejects.toBeInstanceOf(SpaceAccessError)
  })
})

describe('things only the database can get wrong', () => {
  it('createSpace is idempotent and updates the policy in place', async () => {
    if (!available) return
    const first = await feedbackSpace()
    const again = await store.createSpace({
      authority: school,
      spaceType: 'freeschool.draft.space.feedback',
      skey: 'boulder',
      policy: { read: ['member', 'moderator'], write: ['member'], hostMayRead: false },
    })
    expect(again.uri).toBe(first.uri)
    const loaded = await store.getSpace(first.uri)
    expect(loaded?.policy.read).toEqual(['member', 'moderator'])
  })

  it('getSpace returns null for an unknown space, and operations throw', async () => {
    if (!available) return
    expect(await store.getSpace('at://did:plc:nobody/x/y')).toBeNull()
    await expect(store.listMembers('at://did:plc:nobody/x/y', school)).rejects.toBeInstanceOf(SpaceAccessError)
  })

  it('re-adding a member changes their role rather than duplicating the row', async () => {
    if (!available) return
    const space = await feedbackSpace()
    await store.addMember(space.uri, school, a, 'member')
    await store.addMember(space.uri, school, a, 'moderator')
    const members = await store.listMembers(space.uri, school)
    expect(members).toEqual([{ did: a, role: 'moderator' }])
  })

  it('a moderator inherits member read rights when policy grants them to members', async () => {
    if (!available) return
    const space = await store.createSpace({
      authority: school,
      spaceType: 'freeschool.draft.space.members',
      skey: 'x',
      policy: { read: ['member'], write: ['member'], hostMayRead: true },
    })
    await store.addMember(space.uri, school, steward, 'moderator')
    await store.putRecord(space.uri, steward, 'coop.lexicon.membership', { subject: a, role: 10 })
    const rows = await store.listRecords(space.uri, steward, 'coop.lexicon.membership')
    expect(rows).toHaveLength(1)
  })

  it('the author may delete their own record; a bystander may not; the authority may', async () => {
    if (!available) return
    const space = await feedbackSpace()
    await store.addMember(space.uri, school, a, 'member')
    await store.addMember(space.uri, school, host, 'member')
    const rec = await store.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { direction: 'positive' })

    await expect(store.deleteRecord(space.uri, host, rec.uri)).rejects.toBeInstanceOf(SpaceAccessError)
    await store.deleteRecord(space.uri, a, rec.uri)
    expect(await store.listRecords(space.uri, school, 'freeschool.draft.hostFeedback')).toHaveLength(0)

    const second = await store.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { direction: 'negative' })
    await store.deleteRecord(space.uri, school, second.uri)
    expect(await store.listRecords(space.uri, school, 'freeschool.draft.hostFeedback')).toHaveLength(0)
  })

  it('deleting a record that does not exist is a no-op, not an error', async () => {
    if (!available) return
    const space = await feedbackSpace()
    await expect(store.deleteRecord(space.uri, school, `${space.uri}/did:plc:a/x/nope`)).resolves.toBeUndefined()
  })

  it('an explicit rkey makes putRecord an upsert', async () => {
    if (!available) return
    const space = await feedbackSpace()
    await store.addMember(space.uri, school, a, 'member')
    await store.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { v: 1 }, 'fixed')
    await store.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { v: 2 }, 'fixed')
    const rows = await store.listRecords<{ v: number }>(space.uri, school, 'freeschool.draft.hostFeedback')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value.v).toBe(2)
  })

  it('records are scoped to their collection and their space', async () => {
    if (!available) return
    const space = await feedbackSpace()
    await store.addMember(space.uri, school, a, 'member')
    await store.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { v: 1 })
    expect(await store.listRecords(space.uri, school, 'something.else')).toHaveLength(0)
  })
})
