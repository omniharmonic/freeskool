/**
 * The privacy audit's two pure parts: what counts as "naming a DID", and which namings are
 * exempt. No network, no database — `scripts/privacy-audit.ts` keeps the rules in functions
 * precisely so they can be read and tested here rather than inferred from a table.
 */
import { describe, expect, it } from 'vitest'
import { namedDids, verdictFor, type ConsentFacts } from '../scripts/privacy-audit.js'
import { NSID } from '../src/lexicons/nsids.js'

const SCHOOL = 'did:plc:school00000000000000000'
const HOST = 'did:plc:host000000000000000000'
const MEMBER = 'did:plc:member00000000000000000'
const STEWARD = 'did:plc:steward0000000000000000'

const facts = (over: Partial<ConsentFacts> = {}): ConsentFacts => ({
  schoolDids: new Set([SCHOOL]),
  publishRoles: false,
  publicRoleOptIn: new Set(),
  attestationConsentTable: false,
  ...over,
})

describe('namedDids', () => {
  it('finds a bare DID, and says where', () => {
    expect(namedDids({ subject: MEMBER })).toEqual([{ path: 'subject', did: MEMBER }])
  })

  it('finds the authority of an at-uri', () => {
    expect(namedDids({ subject: { uri: `at://${HOST}/community.lexicon.calendar.event/abc` } })).toEqual([
      { path: 'subject.uri', did: HOST },
    ])
  })

  it('walks arrays and nested objects, with indexed paths', () => {
    expect(namedDids({ actors: [STEWARD, MEMBER] })).toEqual([
      { path: 'actors.0', did: STEWARD },
      { path: 'actors.1', did: MEMBER },
    ])
  })

  it('ignores strings that merely mention a did-ish word', () => {
    expect(namedDids({ reason: 'did you ask them first?', text: 'at://handle.test/x/y' })).toEqual([])
  })
})

describe('verdictFor', () => {
  it('allows a membership claim only with publishRoles AND the member’s opt-in', () => {
    const named = { path: 'subject', did: MEMBER }
    expect(verdictFor(NSID.membership, SCHOOL, named, facts()).allowed).toBe(false)
    expect(verdictFor(NSID.membership, SCHOOL, named, facts({ publishRoles: true })).allowed).toBe(false)
    expect(
      verdictFor(NSID.membership, SCHOOL, named, facts({ publishRoles: true, publicRoleOptIn: new Set([MEMBER]) }))
        .allowed,
    ).toBe(true)
  })

  it('refuses a membership claim in a repo that is not a school’s', () => {
    const both = facts({ publishRoles: true, publicRoleOptIn: new Set([MEMBER]) })
    expect(verdictFor(NSID.membership, HOST, { path: 'subject', did: MEMBER }, both).allowed).toBe(false)
  })

  it('allows steward DIDs in a moderation record’s actors[], and nowhere else', () => {
    expect(verdictFor(NSID.moderationAction, SCHOOL, { path: 'actors.0', did: STEWARD }, facts()).allowed).toBe(true)
    expect(verdictFor(NSID.moderationAction, SCHOOL, { path: 'subjectDid', did: MEMBER }, facts()).allowed).toBe(false)
  })

  it('never allows an attestation while there is no double-opt-in table', () => {
    const verdict = verdictFor(NSID.skillAttestation, HOST, { path: 'subject', did: MEMBER }, facts())
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('double-opt-in')
  })

  it('treats a school DID as an institution, not a person', () => {
    expect(verdictFor(NSID.approval, STEWARD, { path: 'proposal', did: SCHOOL }, facts()).allowed).toBe(true)
  })

  it('flags an opt-in public RSVP, which names its host through the event at-uri', () => {
    expect(verdictFor(NSID.rsvp, MEMBER, { path: 'subject.uri', did: HOST }, facts()).allowed).toBe(false)
  })
})
