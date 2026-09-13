/**
 * Role derivation WIRING.
 *
 * `deriveRole` itself is tested in `@freeschool/shared`. What is tested here is the thing
 * that can actually break in the AppView: that the evidence we gather is threaded into
 * `deriveRole` with the school's policy thresholds, and that `AppCustodyAdapter` then
 * gates on the result — including the destructive-action approval threshold, which is the
 * one place a wiring mistake would be silently permissive.
 */
import { describe, expect, it } from 'vitest'
import { AppCustodyAdapter, type AuditRow, type Did } from '@freeschool/school-actor'
import { Role, defaultThresholds, deriveRole, type Evidence } from '@freeschool/shared'
import { mergeThresholds } from '../src/lib/policy.js'

const SCHOOL = 'did:plc:school' as Did
const MEMBER = 'did:plc:member' as Did
const HOST = 'did:plc:host' as Did
const STEWARD_A = 'did:plc:stewarda' as Did
const STEWARD_B = 'did:plc:stewardb' as Did

const baseEvidence: Evidence = {
  hasProfile: true,
  inviteOrVouch: false,
  attendedConfirmed: 0,
  hostedEvents: 0,
  upheldNegativeFeedback: 0,
  stewardAppointed: false,
}

function adapter(options: {
  roles: Record<string, Role>
  stewards?: number
  calls?: Array<{ nsid: string }>
  audits?: AuditRow[]
}) {
  const audits = options.audits ?? []
  const calls = options.calls ?? []
  return new AppCustodyAdapter({
    roles: { async roleOf(_school, did) { return options.roles[did] ?? Role.Visitor } },
    policy: { async destructiveActionStewards() { return options.stewards ?? 2 } },
    audit: {
      async write(row) {
        audits.push(row)
        return `audit-${audits.length}`
      },
    },
    session: {
      async call(i) {
        calls.push({ nsid: i.nsid })
        return { status: 200, output: { uri: `at://${SCHOOL}/x/1`, cid: 'bafy' } }
      },
    },
    pdsEndpoint: 'http://localhost:3000',
  })
}

describe('policy thresholds feed deriveRole', () => {
  it('merges a partial policy record over Lex defaults', () => {
    expect(mergeThresholds(undefined)).toEqual(defaultThresholds)
    expect(mergeThresholds({ hostMinAttended: 2 })).toEqual({ ...defaultThresholds, hostMinAttended: 2 })
    // A nonsense value is ignored rather than propagated as NaN into a comparison.
    expect(mergeThresholds({ feedbackK: 'three' }).feedbackK).toBe(defaultThresholds.feedbackK)
  })

  it('open-by-default thresholds make a member with a profile a Host on day one', () => {
    expect(deriveRole(baseEvidence, mergeThresholds(undefined))).toBe(Role.Host)
  })

  it('a school that requires an attendance before hosting demotes the same evidence to Member', () => {
    const strict = mergeThresholds({ hostMinAttended: 1 })
    expect(deriveRole(baseEvidence, strict)).toBe(Role.Member)
    expect(deriveRole({ ...baseEvidence, attendedConfirmed: 1 }, strict)).toBe(Role.Host)
  })

  it('a school that gates membership on an invite turns no-invite evidence into a Visitor', () => {
    const gated = mergeThresholds({ memberRequires: 'invite-or-vouch' })
    expect(deriveRole(baseEvidence, gated)).toBe(Role.Visitor)
    expect(deriveRole({ ...baseEvidence, inviteOrVouch: true }, gated)).toBe(Role.Host)
  })

  it('upheld negative feedback blocks the Facilitator step but not hosting', () => {
    const t = mergeThresholds({ facilitatorMinHosted: 3 })
    expect(deriveRole({ ...baseEvidence, hostedEvents: 3 }, t)).toBe(Role.Facilitator)
    expect(deriveRole({ ...baseEvidence, hostedEvents: 3, upheldNegativeFeedback: 1 }, t)).toBe(Role.Host)
  })
})

describe('AppCustodyAdapter gates on the derived role', () => {
  it('lets a Host publish and records an allow', async () => {
    const audits: AuditRow[] = []
    const port = adapter({ roles: { [HOST]: Role.Host }, audits })
    const res = await port.putRecordAsSchool({
      schoolDid: SCHOOL,
      callerDid: HOST,
      scope: 'coop.lexicon.event.listing',
      action: 'publish-event',
      collection: 'coop.lexicon.event.listing',
      rkey: 'abc',
      record: {},
      audit: { reason: 'published a class' },
    })
    expect(res.uri).toContain('at://')
    expect(audits.map((a) => a.decision)).toEqual(['allow'])
  })

  it('refuses a Member and still writes a deny row', async () => {
    const audits: AuditRow[] = []
    const port = adapter({ roles: { [MEMBER]: Role.Member }, audits })
    const res = await port.actAs({
      schoolDid: SCHOOL,
      callerDid: MEMBER,
      scope: 'coop.lexicon.event.listing',
      method: 'POST',
      nsid: 'com.atproto.repo.putRecord',
      action: 'publish-event',
      audit: { reason: 'trying to publish' },
    })
    expect(res.ok).toBe(false)
    expect(audits[0]?.decision).toBe('deny')
  })

  it('a lone steward cannot take a destructive action; two can', async () => {
    const calls: Array<{ nsid: string }> = []
    const port = adapter({ roles: { [STEWARD_A]: Role.Steward, [STEWARD_B]: Role.Steward }, stewards: 2, calls })

    const alone = await port.actAs({
      schoolDid: SCHOOL,
      callerDid: STEWARD_A,
      scope: 'freeschool.draft.moderationAction',
      method: 'POST',
      nsid: 'com.atproto.repo.putRecord',
      action: 'remove-listing',
      audit: { reason: 'off-topic' },
    })
    expect(alone.ok).toBe(false)
    expect(alone.ok === false && alone.error).toBe('ErrThresholdNotMet')

    const together = await port.actAs({
      schoolDid: SCHOOL,
      callerDid: STEWARD_A,
      scope: 'freeschool.draft.moderationAction',
      method: 'POST',
      nsid: 'com.atproto.repo.putRecord',
      action: 'remove-listing',
      audit: { reason: 'off-topic', approvals: [{ stewardDid: STEWARD_B, at: new Date().toISOString() }] },
    })
    expect(together.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('an approval from a non-steward does not count', async () => {
    const port = adapter({ roles: { [STEWARD_A]: Role.Steward, [HOST]: Role.Host }, stewards: 2 })
    const res = await port.actAs({
      schoolDid: SCHOOL,
      callerDid: STEWARD_A,
      scope: 'freeschool.draft.moderationAction',
      method: 'POST',
      nsid: 'com.atproto.repo.putRecord',
      action: 'suspend-role',
      audit: { reason: 'harm', approvals: [{ stewardDid: HOST, at: new Date().toISOString() }] },
    })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toBe('ErrPermissionDenied')
  })

  it('a reason is mandatory — there is no unaudited path', async () => {
    const port = adapter({ roles: { [STEWARD_A]: Role.Steward } })
    await expect(
      port.actAs({
        schoolDid: SCHOOL,
        callerDid: STEWARD_A,
        scope: 'x',
        method: 'POST',
        nsid: 'com.atproto.repo.putRecord',
        action: 'write-policy',
        audit: { reason: '   ' },
      }),
    ).rejects.toThrow(/reason is mandatory/)
  })
})
