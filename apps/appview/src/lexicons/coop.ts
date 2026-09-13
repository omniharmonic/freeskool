/**
 * ASSUMED shapes for the `coop.lexicon.*` records.
 *
 * These lexicons are not vendored in this repo and `contrail init --prefix` could not
 * resolve them (the upstream catalog reported incomplete indexing — see README).
 * Everything below is therefore a documented assumption with a single chokepoint:
 * if the real lexicons differ, only this file and `src/http/visibility.ts` change.
 */

/** Written alongside the event by its host: the knobs the base lexicon has no room for. */
export interface EventConfig {
  /** strongRef to the community.lexicon.calendar.event */
  event: { uri: string; cid: string }
  /** IANA zone; matches freeschool.draft.series.timezone. */
  timezone?: string
  capacity?: number
  /** 'listed' is the only value that reaches the public calendar. */
  visibility?: 'listed' | 'unlisted' | 'private'
  /** Coarse location shown to everyone for a `listed` event. */
  neighborhood?: string
  rsvpRequired?: boolean
  /** DID of the school this event is offered under. */
  school?: string
  /** Lowercase kebab tags. Routes the school's curation listing — see lib/events.ts. */
  tags?: string[]
  createdAt?: string
}

/** Written by the SCHOOL (curate-listing / remove-listing) — the curation surface. */
export interface EventListing {
  event: { uri: string; cid: string }
  school: string
  status?: 'listed' | 'removed'
  tags?: string[]
  createdAt?: string
}

/**
 * Written by the school after deriveRole(); the protocol only ever sees this claim.
 * Gated by `lib/membership-claims.ts#publishRoleClaim` — written only when the policy
 * allows it AND the subject opted in AND role >= Host. `addedBy` is always the school
 * DID itself in v1 (never a steward's personal DID).
 */
export interface Membership {
  subject: string
  /** Open integer registry: 10 member / 20 host / 30 facilitator / 40 steward. */
  role: number
  school?: string
  addedBy?: string
  createdAt?: string
}
