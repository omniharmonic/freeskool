import { describe, it, expect } from 'vitest'
import { Role, deriveRole, defaultThresholds, type Evidence, type Thresholds } from '../src/roles.js'

const base: Evidence = { hasProfile: false, inviteOrVouch: false, attendedConfirmed: 0, hostedEvents: 0, upheldNegativeFeedback: 0, stewardAppointed: false }

describe('deriveRole — Lex defaults (open on day one)', () => {
  it('a visitor with nothing is a visitor', () => {
    expect(deriveRole(base, defaultThresholds)).toBe(Role.Visitor)
  })
  it('anyone with a profile is a member and may host on day one', () => {
    const r = deriveRole({ ...base, hasProfile: true }, defaultThresholds)
    expect(r).toBe(Role.Host)
  })
  it('facilitator requires hosted events and no upheld negative feedback', () => {
    expect(deriveRole({ ...base, hasProfile: true, hostedEvents: 3 }, defaultThresholds)).toBe(Role.Facilitator)
    expect(deriveRole({ ...base, hasProfile: true, hostedEvents: 3, upheldNegativeFeedback: 1 }, defaultThresholds)).toBe(Role.Host)
  })
  it('steward is appointed/elected, never derived from counts', () => {
    expect(deriveRole({ ...base, hasProfile: true, stewardAppointed: true }, defaultThresholds)).toBe(Role.Steward)
    expect(deriveRole({ ...base, hasProfile: true, hostedEvents: 100 }, defaultThresholds)).toBe(Role.Facilitator)
  })
})

describe('deriveRole — gated school policy (opt-in)', () => {
  const gated: Thresholds = { ...defaultThresholds, memberRequires: 'invite-or-vouch', hostMinAttended: 2 }
  it('profile alone is not enough when the school requires an invite or vouch', () => {
    expect(deriveRole({ ...base, hasProfile: true }, gated)).toBe(Role.Visitor)
    expect(deriveRole({ ...base, hasProfile: true, inviteOrVouch: true }, gated)).toBe(Role.Member)
  })
  it('hosting unlocks after the attendance threshold', () => {
    expect(deriveRole({ ...base, hasProfile: true, inviteOrVouch: true, attendedConfirmed: 1 }, gated)).toBe(Role.Member)
    expect(deriveRole({ ...base, hasProfile: true, inviteOrVouch: true, attendedConfirmed: 2 }, gated)).toBe(Role.Host)
  })
  it('attended-one gate admits after one confirmed attendance', () => {
    const t: Thresholds = { ...defaultThresholds, memberRequires: 'attended-one' }
    expect(deriveRole({ ...base, hasProfile: true }, t)).toBe(Role.Visitor)
    expect(deriveRole({ ...base, hasProfile: true, attendedConfirmed: 1 }, t)).toBe(Role.Host)
  })
})
