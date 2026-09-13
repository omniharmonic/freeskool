import { describe, it, expect } from 'vitest'
import { Role } from '@freeschool/shared'
import { AppCustodyAdapter, SchoolActError, type AuditRow, type Did } from '../src/index.js'

const school = 'did:plc:school' as Did
const steward1 = 'did:plc:s1' as Did, steward2 = 'did:plc:s2' as Did, host = 'did:plc:host' as Did, member = 'did:plc:m' as Did

function make(roles: Record<string, Role>, threshold = 2) {
  const audit: AuditRow[] = []
  const calls: unknown[] = []
  const adapter = new AppCustodyAdapter({
    roles: { roleOf: async (_s, did) => roles[did] ?? Role.Visitor },
    policy: { destructiveActionStewards: async () => threshold },
    audit: { write: async (row) => { audit.push(row); return `audit-${audit.length}` } },
    session: { call: async (i) => { calls.push(i); return { status: 200, output: { uri: 'at://did:plc:school/x/y', cid: 'bafy' } } } },
    pdsEndpoint: 'http://localhost:3000',
    now: () => '2026-09-12T00:00:00Z',
  })
  return { adapter, audit, calls }
}
const roles = { [steward1]: Role.Steward, [steward2]: Role.Steward, [host]: Role.Host, [member]: Role.Member }

describe('AppCustodyAdapter', () => {
  it('a host may publish an event as the school; the write is audited and executed once', async () => {
    const { adapter, audit, calls } = make(roles)
    const r = await adapter.putRecordAsSchool({ schoolDid: school, callerDid: host, scope: 'freeschool.draft.authCalendar', action: 'publish-event', collection: 'community.lexicon.calendar.event', rkey: '3k', record: { name: 'Bike repair' }, audit: { reason: 'new class' } })
    expect(r.uri).toBe('at://did:plc:school/x/y')
    expect(calls).toHaveLength(1)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ decision: 'allow', action: 'publish-event', policySource: 'app:v1', callerDid: host })
  })
  it('a member cannot publish as the school; denial is audited and nothing executes', async () => {
    const { adapter, audit, calls } = make(roles)
    const r = await adapter.actAs({ schoolDid: school, callerDid: member, scope: 's', action: 'publish-event', method: 'POST', nsid: 'com.atproto.repo.putRecord', audit: { reason: 'x' } })
    expect(r.ok).toBe(false)
    expect(calls).toHaveLength(0)
    expect(audit[0]?.decision).toBe('deny')
  })
  it('destructive actions need two stewards; one steward alone is refused', async () => {
    const { adapter, calls } = make(roles)
    const r = await adapter.actAs({ schoolDid: school, callerDid: steward1, scope: 's', action: 'remove-listing', method: 'POST', nsid: 'com.atproto.repo.deleteRecord', audit: { reason: 'duplicate listing' } })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('ErrThresholdNotMet')
    expect(calls).toHaveLength(0)
  })
  it('destructive action succeeds with a second steward approval', async () => {
    const { adapter, audit } = make(roles)
    const r = await adapter.deleteRecordAsSchool({ schoolDid: school, callerDid: steward1, scope: 's', action: 'remove-listing', collection: 'coop.lexicon.event.listing', rkey: '3k', audit: { reason: 'duplicate listing', approvals: [{ stewardDid: steward2, at: '2026-09-12T00:00:00Z' }] } })
    expect(r.auditId).toBe('audit-1')
    expect(audit[0]?.approvals).toHaveLength(1)
  })
  it('a non-steward cannot count as an approver', async () => {
    const { adapter } = make(roles)
    await expect(adapter.deleteRecordAsSchool({ schoolDid: school, callerDid: steward1, scope: 's', action: 'remove-listing', collection: 'c', rkey: 'r', audit: { reason: 'x', approvals: [{ stewardDid: host, at: 'now' }] } })).rejects.toBeInstanceOf(SchoolActError)
  })
  it('a written reason and a scope are mandatory', async () => {
    const { adapter } = make(roles)
    await expect(adapter.actAs({ schoolDid: school, callerDid: steward1, scope: 's', action: 'publish-event', method: 'POST', nsid: 'n', audit: { reason: '   ' } })).rejects.toThrow(/reason/)
    await expect(adapter.actAs({ schoolDid: school, callerDid: steward1, scope: '', action: 'publish-event', method: 'POST', nsid: 'n', audit: { reason: 'ok' } })).rejects.toThrow(/scope/)
  })
})
