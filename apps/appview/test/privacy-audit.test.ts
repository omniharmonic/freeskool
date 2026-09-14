/**
 * The privacy audit's two pure parts: what counts as "naming a DID", and which namings are
 * exempt. No network, no database — `scripts/privacy-audit.ts` keeps the rules in functions
 * precisely so they can be read and tested here rather than inferred from a table.
 */
import { describe, expect, it } from 'vitest'
import { AUDITED_COLLECTIONS, namedDids, textMentions, verdictFor, type ConsentFacts } from '../scripts/privacy-audit.js'
import { NSID } from '../src/lexicons/nsids.js'

const SCHOOL = 'did:plc:school00000000000000000'
const HOST = 'did:plc:host000000000000000000'
const MEMBER = 'did:plc:member00000000000000000'
const STEWARD = 'did:plc:steward0000000000000000'

const OTHER_SCHOOL = 'did:plc:other0000000000000000000'

/**
 * Both consent gates are PER SCHOOL (federation phase): `publishRoles` and the opt-in set
 * are keyed by the school whose repo holds the claim. `at` is the shorthand these tests
 * use for "these gates, in THIS school"; `facts()` with neither means nothing is exempt.
 */
const facts = (over: Partial<ConsentFacts> = {}): ConsentFacts => ({
  schoolDids: new Set([SCHOOL, OTHER_SCHOOL]),
  publishRoles: new Map(),
  publicRoleOptIn: new Map(),
  attestationConsentTable: false,
  ...over,
})

const at = (schoolDid: string, options: { publishRoles?: boolean; optIn?: string[] }): Partial<ConsentFacts> => ({
  ...(options.publishRoles === undefined ? {} : { publishRoles: new Map([[schoolDid, options.publishRoles]]) }),
  ...(options.optIn ? { publicRoleOptIn: new Map([[schoolDid, new Set(options.optIn)]]) } : {}),
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

  /**
   * #13. The scan used to be ANCHORED to the whole string value, so a DID anywhere other
   * than alone in its own field was invisible — which is most of the places a DID actually
   * ends up in a free-text record.
   */
  describe('scans INSIDE strings, not only whole-value matches', () => {
    it('finds a DID mentioned mid-sentence', () => {
      expect(namedDids({ reason: `please ask ${MEMBER} before reposting` })).toEqual([{ path: 'reason', did: MEMBER }])
    })

    it('finds an at-uri mid-sentence, and reports its authority once', () => {
      expect(namedDids({ note: `see at://${HOST}/community.lexicon.calendar.event/abc for details` })).toEqual([
        { path: 'note', did: HOST },
      ])
    })

    it('does not report an at-uri’s authority twice (once as a uri, once as a bare DID)', () => {
      expect(namedDids({ subject: { uri: `at://${HOST}/community.lexicon.calendar.event/abc` } })).toEqual([
        { path: 'subject.uri', did: HOST },
      ])
    })

    it('finds several distinct DIDs in one string, and dedupes a repeat', () => {
      const found = namedDids({ text: `${MEMBER} and ${STEWARD} and ${MEMBER} again` })
      expect(found.map((f) => f.did)).toEqual([MEMBER, STEWARD])
      expect(found.every((f) => f.path === 'text')).toBe(true)
    })
  })
})

describe('textMentions: a handle or a DID written into free text', () => {
  it('flags an @handle in a reason', () => {
    expect(textMentions({ reason: 'repeated no-shows after @alice.test was warned' })).toEqual([
      { path: 'reason', kind: 'handle' },
    ])
  })

  it('flags a did: in a note, a description and a suppliesNote', () => {
    expect(textMentions({ note: 'ask did:plc:abc123 first' })).toEqual([{ path: 'note', kind: 'did' }])
    expect(textMentions({ description: 'co-taught with did:plc:abc123' })).toEqual([{ path: 'description', kind: 'did' }])
    expect(textMentions({ suppliesNote: 'borrow a jig from did:plc:abc123' })).toEqual([
      { path: 'suppliesNote', kind: 'did' },
    ])
  })

  it('flags both kinds in one field', () => {
    expect(textMentions({ reason: 'did:plc:abc123, aka @alice.test' }).map((m) => m.kind).sort()).toEqual([
      'did',
      'handle',
    ])
  })

  it('leaves ordinary prose, and a bare domain, alone — the leading @ is required', () => {
    expect(textMentions({ reason: 'kept missing the class at boulder.test on Thursdays' })).toEqual([])
    expect(textMentions({ description: 'Bring a jar. We meet at 6.' })).toEqual([])
  })

  it('only scans fields a human wrote, so a structural ref is not double-reported', () => {
    expect(textMentions({ subject: `at://${HOST}/x/y`, skill: `at://${HOST}/freeschool.draft.skill/s` })).toEqual([])
  })

  it('walks nested objects and arrays', () => {
    expect(textMentions({ items: [{ note: 'see @dana.bsky.social' }] })).toEqual([
      { path: 'items.0.note', kind: 'handle' },
    ])
  })
})

describe('the school-written collections F1 added', () => {
  for (const nsid of [NSID.eventListing, NSID.occurrence, NSID.claim, NSID.skillClaim, NSID.policy, NSID.school]) {
    it(`audits ${nsid}`, () => {
      expect((AUDITED_COLLECTIONS as readonly string[]).includes(nsid)).toBe(true)
    })
  }

  it('lets a school listing name the host through the event strongRef, and nowhere else', () => {
    const eventRef = { path: 'event.uri', did: HOST }
    expect(verdictFor(NSID.eventListing, SCHOOL, eventRef, facts()).allowed).toBe(true)
    expect(verdictFor(NSID.eventListing, SCHOOL, { path: 'curatedFor', did: HOST }, facts()).allowed).toBe(false)
  })

  it('lets an occurrence name the host through its event and series refs', () => {
    expect(verdictFor(NSID.occurrence, SCHOOL, { path: 'event.uri', did: HOST }, facts()).allowed).toBe(true)
    expect(verdictFor(NSID.occurrence, SCHOOL, { path: 'series.uri', did: HOST }, facts()).allowed).toBe(true)
    expect(verdictFor(NSID.occurrence, SCHOOL, { path: 'hostDid', did: HOST }, facts()).allowed).toBe(false)
  })

  it('lets a claim name the asker through the request ref only', () => {
    expect(verdictFor(NSID.claim, HOST, { path: 'request.uri', did: MEMBER }, facts()).allowed).toBe(true)
    expect(verdictFor(NSID.claim, HOST, { path: 'claimedFrom', did: MEMBER }, facts()).allowed).toBe(false)
  })

  it('lets a skill claim name the taxonomy authority through `skill`', () => {
    expect(verdictFor(NSID.skillClaim, MEMBER, { path: 'skill', did: HOST }, facts()).allowed).toBe(true)
    expect(verdictFor(NSID.skillClaim, MEMBER, { path: 'vouchedBy', did: HOST }, facts()).allowed).toBe(false)
  })

  it('allows nothing but the school’s own DID in a policy or school record', () => {
    expect(verdictFor(NSID.policy, SCHOOL, { path: 'thresholds.owner', did: MEMBER }, facts()).allowed).toBe(false)
    expect(verdictFor(NSID.school, SCHOOL, { path: 'peers.0', did: MEMBER }, facts()).allowed).toBe(false)
    // A school DID stays exempt as an institutional actor (exemption 4).
    expect(verdictFor(NSID.school, SCHOOL, { path: 'peers.0', did: SCHOOL }, facts()).allowed).toBe(true)
  })
})

describe('verdictFor', () => {
  it('allows a membership claim only with publishRoles AND the member’s opt-in', () => {
    const named = { path: 'subject', did: MEMBER }
    expect(verdictFor(NSID.membership, SCHOOL, named, facts()).allowed).toBe(false)
    expect(verdictFor(NSID.membership, SCHOOL, named, facts(at(SCHOOL, { publishRoles: true }))).allowed).toBe(false)
    expect(
      verdictFor(NSID.membership, SCHOOL, named, facts(at(SCHOOL, { publishRoles: true, optIn: [MEMBER] }))).allowed,
    ).toBe(true)
  })

  it('refuses a membership claim in a repo that is not a school’s', () => {
    const both = facts(at(SCHOOL, { publishRoles: true, optIn: [MEMBER] }))
    expect(verdictFor(NSID.membership, HOST, { path: 'subject', did: MEMBER }, both).allowed).toBe(false)
  })

  /**
   * THE BUG THIS REPLACED (Task 3 re-review, fixed in Task 11). Both gates used to be
   * read from the GLOBAL `fs_member_prefs.public_role` and the HOME school's policy, for
   * every repo the audit looked at — so consent given to Boulder cleared a claim written
   * by Denver, and Boulder's `publishRoles` cleared a claim in a school whose own policy
   * had it off. The repo the claim lives in IS the school it is about, and that is what
   * decides now.
   */
  it('reads BOTH gates from the school whose repo holds the claim, not from another one', () => {
    const named = { path: 'subject', did: MEMBER }
    // Consent and a policy in SCHOOL exempt nothing in OTHER_SCHOOL's repo.
    const inSchoolOnly = facts(at(SCHOOL, { publishRoles: true, optIn: [MEMBER] }))
    expect(verdictFor(NSID.membership, OTHER_SCHOOL, named, inSchoolOnly).allowed).toBe(false)

    // The member opted in HERE but this school's policy does not publish roles.
    const optedInNoPolicy = facts({
      publishRoles: new Map([[OTHER_SCHOOL, false]]),
      publicRoleOptIn: new Map([[OTHER_SCHOOL, new Set([MEMBER])]]),
    })
    expect(verdictFor(NSID.membership, OTHER_SCHOOL, named, optedInNoPolicy).reason).toContain('publishRoles')

    // This school publishes roles, but this member opted in somewhere else.
    const policyNoOptIn = facts({
      publishRoles: new Map([[OTHER_SCHOOL, true]]),
      publicRoleOptIn: new Map([[SCHOOL, new Set([MEMBER])]]),
    })
    const verdict = verdictFor(NSID.membership, OTHER_SCHOOL, named, policyNoOptIn)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('IN THIS SCHOOL')

    // Both gates, in the right school.
    expect(
      verdictFor(NSID.membership, OTHER_SCHOOL, named, facts(at(OTHER_SCHOOL, { publishRoles: true, optIn: [MEMBER] })))
        .allowed,
    ).toBe(true)
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

  it('allows an opt-in public RSVP to name its host through the event at-uri (the host already published that event)', () => {
    const verdict = verdictFor(NSID.rsvp, MEMBER, { path: 'subject.uri', did: HOST }, facts())
    expect(verdict.allowed).toBe(true)
  })

  it('does not extend the rsvp exemption to any other path in the record', () => {
    expect(verdictFor(NSID.rsvp, MEMBER, { path: 'notSubject', did: HOST }, facts()).allowed).toBe(false)
  })
})
