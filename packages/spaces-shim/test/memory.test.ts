import { describe, it, expect } from 'vitest'
import { MemorySpaceStore } from '../src/memory.js'
import { SpaceAccessError } from '../src/types.js'

const school = 'did:plc:school'
const host = 'did:plc:host'
const a = 'did:plc:a'

describe('Spaces-shaped store (v1 in-memory reference; Postgres impl mirrors it)', () => {
  it('authority creates a space and controls membership', async () => {
    const s = new MemorySpaceStore()
    const space = await s.createSpace({ authority: school, spaceType: 'freeschool.draft.space.feedback', skey: 'boulder', policy: { read: ['moderator'], write: ['member'], hostMayRead: false } })
    expect(space.uri).toBe('at://did:plc:school/freeschool.draft.space.feedback/boulder')
    await s.addMember(space.uri, school, a, 'member')
    await expect(s.addMember(space.uri, a, host, 'member')).rejects.toBeInstanceOf(SpaceAccessError)
  })
  it('members write; non-members cannot; the host (subject) cannot read raw rows', async () => {
    const s = new MemorySpaceStore()
    const space = await s.createSpace({ authority: school, spaceType: 'freeschool.draft.space.feedback', skey: 'boulder', policy: { read: ['moderator'], write: ['member'], hostMayRead: false } })
    await s.addMember(space.uri, school, a, 'member')
    await s.addMember(space.uri, school, host, 'member')
    await s.addMember(space.uri, school, 'did:plc:steward', 'moderator')
    const rec = await s.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { host, direction: 'negative', text: 'x' })
    expect(rec.uri.startsWith(space.uri + '/did:plc:a/freeschool.draft.hostFeedback/')).toBe(true)
    await expect(s.putRecord(space.uri, 'did:plc:outsider', 'freeschool.draft.hostFeedback', {})).rejects.toBeInstanceOf(SpaceAccessError)
    await expect(s.listRecords(space.uri, host, 'freeschool.draft.hostFeedback')).rejects.toBeInstanceOf(SpaceAccessError)
    const rows = await s.listRecords(space.uri, 'did:plc:steward', 'freeschool.draft.hostFeedback')
    expect(rows).toHaveLength(1)
  })
  it('the aggregator service reads with the authority credential', async () => {
    const s = new MemorySpaceStore()
    const space = await s.createSpace({ authority: school, spaceType: 'freeschool.draft.space.feedback', skey: 'boulder', policy: { read: ['moderator'], write: ['member'], hostMayRead: false } })
    await s.addMember(space.uri, school, a, 'member')
    await s.putRecord(space.uri, a, 'freeschool.draft.hostFeedback', { host, direction: 'positive' })
    const rows = await s.listRecords(space.uri, school, 'freeschool.draft.hostFeedback')
    expect(rows[0]?.author).toBe(a)
  })
  it('removing a member revokes write', async () => {
    const s = new MemorySpaceStore()
    const space = await s.createSpace({ authority: school, spaceType: 'freeschool.draft.space.members', skey: 'boulder', policy: { read: ['member'], write: ['moderator'], hostMayRead: true } })
    await s.addMember(space.uri, school, a, 'moderator')
    await s.removeMember(space.uri, school, a)
    await expect(s.putRecord(space.uri, a, 'coop.lexicon.membership', {})).rejects.toBeInstanceOf(SpaceAccessError)
  })
})
