/**
 * Every NSID the AppView reads or writes, in one place.
 *
 * `community.lexicon.*` are the BORROWED records (never modified, never extended).
 * `freeschool.draft.*` are our sidecars (packages/lexicons).
 * `coop.lexicon.*` are the cooperative-events records we compose with. Their schemas
 * are NOT in this repo and were not resolvable from the lexicon registry at build
 * time (see README "Divergences"), so `src/lexicons/coop.ts` documents the minimal
 * field shape we depend on. Nothing validates them at ingest.
 */
export const NSID = {
  event: 'community.lexicon.calendar.event',
  rsvp: 'community.lexicon.calendar.rsvp',

  skillLevel: 'freeschool.draft.skillLevel',
  series: 'freeschool.draft.series',
  occurrence: 'freeschool.draft.occurrence',
  request: 'freeschool.draft.request',
  claim: 'freeschool.draft.claim',
  resource: 'freeschool.draft.resource',
  course: 'freeschool.draft.course',
  policy: 'freeschool.draft.policy',
  school: 'freeschool.draft.school',
  skill: 'freeschool.draft.skill',
  skillClaim: 'freeschool.draft.skillClaim',
  skillAttestation: 'freeschool.draft.skillAttestation',
  moderationAction: 'freeschool.draft.moderationAction',
  approval: 'freeschool.draft.approval',

  eventConfig: 'coop.lexicon.event.config',
  eventListing: 'coop.lexicon.event.listing',
  membership: 'coop.lexicon.membership',
} as const

export type NsidKey = keyof typeof NSID
