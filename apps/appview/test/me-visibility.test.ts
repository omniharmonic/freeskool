/**
 * The forced-off rules on `PUT /api/me/skill-claims`:
 *   - an OAuth-door session publishing ANY tier needs `confirmPublicLinkage: true` first
 *     (Task 7: publishing from an existing account links it to this school permanently —
 *     the confirmation replaces the old hard "PublicTogglesLocked" refusal);
 *   - a Tier B (sensitive/high-risk) skill needs an explicit `confirmTierB: true` before a
 *     public claim is written, for anyone (oauth included, on top of the linkage confirm).
 * Pure decision function — no DB, no HTTP.
 */
import { describe, expect, it } from 'vitest'
import { checkPublicClaims } from '../src/http/routes/me.js'

describe('checkPublicClaims', () => {
  it('allows a non-public batch regardless of session kind or tier', () => {
    expect(checkPublicClaims('oauth', [], false)).toEqual({ ok: true })
    expect(checkPublicClaims('custodial', [], false)).toEqual({ ok: true })
  })

  it('requires confirmPublicLinkage for an OAuth-door session publishing a Tier A claim', () => {
    const out = checkPublicClaims('oauth', ['A'], false)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.status).toBe(400)
    expect(out.ok === false && out.error).toBe('PublicLinkageConfirmRequired')
  })

  it('requires confirmPublicLinkage for an OAuth-door session even when confirmTierB is sent', () => {
    const out = checkPublicClaims('oauth', ['B'], true)
    expect(out.ok === false && out.error).toBe('PublicLinkageConfirmRequired')
  })

  it('allows an OAuth-door session to publish a Tier A claim once confirmPublicLinkage is sent', () => {
    expect(checkPublicClaims('oauth', ['A'], false, true)).toEqual({ ok: true })
  })

  it('an OAuth-door session confirming linkage for a Tier B claim still needs confirmTierB', () => {
    const out = checkPublicClaims('oauth', ['B'], false, true)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.status).toBe(400)
    expect(out.ok === false && out.error).toBe('TierBConfirmRequired')
  })

  it('allows an OAuth-door Tier B claim once both confirmations are sent', () => {
    expect(checkPublicClaims('oauth', ['B'], true, true)).toEqual({ ok: true })
  })

  it('requires confirmTierB for a custodial session publishing a Tier B claim, unaffected by confirmPublicLinkage', () => {
    const out = checkPublicClaims('custodial', ['B'], false)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.status).toBe(400)
    expect(out.ok === false && out.error).toBe('TierBConfirmRequired')
  })

  it('allows a Tier B claim once confirmed for a custodial session', () => {
    expect(checkPublicClaims('custodial', ['B'], true)).toEqual({ ok: true })
  })

  it('allows an ordinary Tier A claim with no confirmation for a custodial session', () => {
    expect(checkPublicClaims('custodial', ['A'], false)).toEqual({ ok: true })
  })
})
