/**
 * ASSUMED shapes for the `coop.lexicon.*` records.
 *
 * These lexicons are not vendored in this repo and `contrail init --prefix` could not
 * resolve them (the upstream catalog reported incomplete indexing — see README).
 * Everything below is therefore a documented assumption with a single chokepoint:
 * if the real lexicons differ, only this file and `src/http/visibility.ts` change.
 *
 * TASK 9 (`docs/interop-audit.md` gap 6/7): these shapes are now ALSO reconstructed as
 * JSON lexicon docs in `packages/lexicons/vendor/coop.lexicon.*.json` (marked ASSUMED,
 * 2026-09-13, matching this file field-for-field), and `apps/appview/test/borrowed-
 * records.test.ts` runs every record our code actually builds through `@atproto/lexicon`
 * against them, so a drift between this file and `lib/events.ts` /
 * `lib/membership-claims.ts` now fails a test instead of shipping silently.
 *
 * That same task cross-checked these assumptions against the closest available
 * secondary source, `docs/research/context/2026-09-12_regenos-building-blocks-handoff.md`
 * (read from `technefoundation/regenOS@c3e34d4`, also NOT canonical) and found real
 * naming divergences — see the per-field notes below, and `packages/lexicons/vendor/
 * README.md`. Gap 7 remains open: only Lucian can say whether our names are fine or need
 * to change.
 */

/** Written alongside the event by its host: the knobs the base lexicon has no room for. */
export interface EventConfig {
  /** strongRef to the community.lexicon.calendar.event */
  event: { uri: string; cid: string }
  /** IANA zone; matches freeschool.draft.series.timezone. */
  timezone?: string
  /** The regenOS handoff note describes `maxAttendees` instead — unconfirmed which
   * name (if either) Lucian's normalized lexicon will use (gap 7). */
  capacity?: number
  /** 'listed' is the only value that reaches the public calendar. No correspondence
   * found in the regenOS note at all. */
  visibility?: 'listed' | 'unlisted' | 'private'
  /** Coarse location shown to everyone for a `listed` event. No correspondence found
   * in the regenOS note at all. */
  neighborhood?: string
  /** The regenOS handoff note describes an `attendance` field with values
   * `open` | `approval` instead (CLAUDE.md's "key corrections" line confirms `attendance`
   * over `attendanceMode`, but not this field's boolean shape) — gap 7. */
  rsvpRequired?: boolean
  /** DID of the school this event is offered under. */
  school?: string
  /** Lowercase kebab tags. Routes the school's curation listing — see lib/events.ts. */
  tags?: string[]
  createdAt?: string
}

/**
 * Written by the SCHOOL (curate-listing / remove-listing) — the curation surface.
 *
 * The regenOS handoff note describes `event.listing` as "Just a strongRef plus
 * createdAt" — our `school`, `status` and `tags` below have no correspondence there at
 * all; they are the whole point of tag-routed curation (gap 7, `docs/research-brief-
 * v0.2.md`: "coop.lexicon.event.listing has zero repos — we are the first mover on
 * tag-routed listings").
 */
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
 *
 * The regenOS handoff note broadly agrees here: `{subject, role: int, addedBy?}`, an
 * open i16 registry with the SAME numeric values (10/20/30/40), labelling rung 20
 * "Builder" where we say "Host" — naming only, not a schema conflict. `school` and
 * `createdAt` below have no correspondence there (gap 7).
 */
export interface Membership {
  subject: string
  /** Open integer registry: 10 member / 20 host / 30 facilitator / 40 steward. */
  role: number
  school?: string
  addedBy?: string
  createdAt?: string
}
