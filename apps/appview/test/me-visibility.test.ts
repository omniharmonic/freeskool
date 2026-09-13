/**
 * The two forced-off rules on `PUT /api/me/skill-claims`:
 *   - an OAuth-door session can never set `visibility: 'public'` at all (no unlock
 *     endpoint in v1 — see the controller ruling in the task brief);
 *   - a Tier B (sensitive/high-risk) skill needs an explicit `confirmTierB: true` before
 *     a public claim is written, for anyone else.
 * Pure decision function — no DB, no HTTP.
 */
import { describe, expect, it } from 'vitest'
import { checkPublicClaims } from '../src/http/routes/me.js'

describe('checkPublicClaims', () => {
  it('allows a non-public batch regardless of session kind or tier', () => {
    expect(checkPublicClaims('oauth', [], false)).toEqual({ ok: true })
    expect(checkPublicClaims('custodial', [], false)).toEqual({ ok: true })
  })

  it('locks out an OAuth-door session from any public claim, Tier A or B', () => {
    const out = checkPublicClaims('oauth', ['A'], false)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.status).toBe(403)
    expect(out.ok === false && out.error).toBe('PublicTogglesLocked')
  })

  it('oauth is locked even when confirmTierB is sent', () => {
    const out = checkPublicClaims('oauth', ['B'], true)
    expect(out.ok === false && out.error).toBe('PublicTogglesLocked')
  })

  it('requires confirmTierB for a custodial session publishing a Tier B claim', () => {
    const out = checkPublicClaims('custodial', ['B'], false)
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.status).toBe(400)
    expect(out.ok === false && out.error).toBe('TierBConfirmRequired')
  })

  it('allows a Tier B claim once confirmed', () => {
    expect(checkPublicClaims('custodial', ['B'], true)).toEqual({ ok: true })
  })

  it('allows an ordinary Tier A claim with no confirmation', () => {
    expect(checkPublicClaims('custodial', ['A'], false)).toEqual({ ok: true })
  })
})
