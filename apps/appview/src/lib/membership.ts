/**
 * MEMBERSHIP OF ONE SCHOOL — `fs_membership`, the per-school replacement for `fs_member`
 * (MS §2, §4, §9 E).
 *
 * The dividing rule: *what the member wrote about themselves is global; what a school
 * observed, decided, or was told in confidence is per-school.* Identity, profile, skill
 * claims and notification transports stay global. Being ON A ROSTER is not — R9's hardest
 * rule is that a Boulder member has no more right to Denver's roster than a stranger has.
 *
 * `fs_member` survives as the GLOBAL presence row ("this DID has ever signed in here",
 * written by the same chokepoint) because two things still need it: the legacy calendar
 * inclusion path for members who signed in before this table existed, and the custodial
 * identity lifecycle, neither of which is per-school. It is no longer what any roster
 * reads.
 *
 * `directoryListing` lives here, not in `fs_member_prefs`: someone who hides in Boulder
 * because they know people there has said nothing about Denver, and a global switch would
 * carry that decision silently from one social context into another (MS §2).
 *
 * So does `publicRole`, for a harder reason: the record it gates is a PUBLIC
 * `coop.lexicon.membership` that names the school it belongs to, so a global opt-in would
 * let consent given to one school publish a naming in another (R9).
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { member, membership, memberPrefs, steward } from '../db/schema.js'
import { legacySchoolDid } from './schools.js'

export type MembershipDoor = 'custodial' | 'oauth'

/**
 * Record that `did` is a member of `schoolDid`, through `door`. Called on EVERY session
 * creation (`http/session.ts#createSession`) — signing in to a school's host IS joining
 * it, which is what makes the "a Boulder-only member on denver.freeskool.xyz sees the
 * public calendar and a join offer, not a 403" journey work.
 *
 * Idempotent: an existing row keeps its `joinedAt` and its `directoryListing` choice, and
 * only `door`/`lastSeenAt` move. Re-joining a school one has LEFT clears `leftAt` — the
 * member came back.
 */
export async function joinSchool(
  did: string,
  schoolDid: string = legacySchoolDid(),
  door: MembershipDoor = 'custodial',
  db: Db = getDb(),
): Promise<void> {
  if (!schoolDid) return
  const now = new Date()
  // The per-school default for `directoryListing` comes from the member's GLOBAL pref
  // when they have one, so a member who opted out before this table existed is not
  // silently opted back in by their next sign-in. New rows only; see `set` below.
  const [prefs] = await db
    .select({ directoryListing: memberPrefs.directoryListing, publicRole: memberPrefs.publicRole })
    .from(memberPrefs)
    .where(eq(memberPrefs.did, did))
    .limit(1)
  await db
    .insert(membership)
    .values({
      did,
      schoolDid,
      door,
      directoryListing: prefs?.directoryListing ?? true,
      /**
       * NOT inherited across schools. `directoryListing` defaults from the old GLOBAL
       * column because the directory is opt-OUT and a member who already hid must not be
       * un-hidden; `publicRole` is opt-IN and defaults to `false` for a school the member
       * has not yet said anything to — the fallback in `isPublicRoleOptIn` is what lets
       * the LEGACY school keep reading their existing answer.
       */
      publicRole: false,
      joinedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [membership.did, membership.schoolDid],
      // NOT `directoryListing`, NOT `publicRole`, NOT `joinedAt`: a returning member's
      // own choices survive.
      set: { door, lastSeenAt: now, leftAt: null },
    })
}

/** Every school this DID belongs to. The Me screen may list these; no other view may (MS §10.1). */
export async function schoolsFor(did: string, db: Db = getDb()): Promise<string[]> {
  const rows = await db
    .select({ schoolDid: membership.schoolDid })
    .from(membership)
    .where(and(eq(membership.did, did), isNull(membership.leftAt)))
  return rows.map((r) => r.schoolDid)
}

export async function isMemberOf(did: string, schoolDid: string, db: Db = getDb()): Promise<boolean> {
  if (!schoolDid) return false
  const rows = await db
    .select({ did: membership.did })
    .from(membership)
    .where(and(eq(membership.did, did), eq(membership.schoolDid, schoolDid), isNull(membership.leftAt)))
    .limit(1)
  return rows.length > 0
}

/**
 * "List me in this school's directory" — per membership. The old global
 * `fs_member_prefs` row is consulted only for the LEGACY school, and only while it has no
 * membership row yet (MS §9 E keeps the old column for one release, mirroring
 * `publicRoleOptIn` below): a Boulder opt-out must never travel to Denver (MS §2). Falls
 * back to `true` when neither exists, because the directory is listed-by-default and
 * opt-out (spec §3 R-1).
 */
export async function directoryListing(did: string, schoolDid: string, db: Db = getDb()): Promise<boolean> {
  const rows = await db
    .select({ directoryListing: membership.directoryListing })
    .from(membership)
    .where(and(eq(membership.did, did), eq(membership.schoolDid, schoolDid)))
    .limit(1)
  if (rows.length > 0) return rows[0]!.directoryListing
  if (schoolDid !== legacySchoolDid()) return true
  const prefs = await db
    .select({ directoryListing: memberPrefs.directoryListing })
    .from(memberPrefs)
    .where(eq(memberPrefs.did, did))
    .limit(1)
  return prefs[0]?.directoryListing ?? true
}

/** `PUT /api/me` writes BOTH during the transition — see `http/routes/me.ts`. */
export async function setDirectoryListing(
  did: string,
  schoolDid: string,
  listed: boolean,
  db: Db = getDb(),
): Promise<void> {
  if (!schoolDid) return
  const now = new Date()
  await db
    .insert(membership)
    .values({ did, schoolDid, door: 'custodial', directoryListing: listed, joinedAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: [membership.did, membership.schoolDid], set: { directoryListing: listed } })
}

/**
 * "Publish my role in this school" — per membership (see the module doc). The old global
 * `fs_member_prefs.public_role` is consulted only for the LEGACY school, and only while it
 * has no membership row yet: for any other school, silence means no.
 */
export async function publicRoleOptIn(did: string, schoolDid: string, db: Db = getDb()): Promise<boolean> {
  if (!schoolDid) return false
  const rows = await db
    .select({ publicRole: membership.publicRole })
    .from(membership)
    .where(and(eq(membership.did, did), eq(membership.schoolDid, schoolDid)))
    .limit(1)
  if (rows.length > 0) return rows[0]!.publicRole
  if (schoolDid !== legacySchoolDid()) return false
  const prefs = await db
    .select({ publicRole: memberPrefs.publicRole })
    .from(memberPrefs)
    .where(eq(memberPrefs.did, did))
    .limit(1)
  return prefs[0]?.publicRole ?? false
}

/** Writes the per-school answer. `PUT /api/me/public-role` writes the legacy column too. */
export async function setPublicRole(
  did: string,
  schoolDid: string,
  publicRole: boolean,
  db: Db = getDb(),
): Promise<void> {
  if (!schoolDid) return
  const now = new Date()
  await db
    .insert(membership)
    .values({ did, schoolDid, door: 'custodial', publicRole, joinedAt: now, lastSeenAt: now })
    .onConflictDoUpdate({ target: [membership.did, membership.schoolDid], set: { publicRole } })
}

/**
 * LEAVING A SCHOOL (spec ruling 10). Everything this school held about the relationship
 * ends, and one thing deliberately does not:
 *
 *   - `left_at` is stamped, which is what every per-school reader already filters on;
 *   - `directory_listing` goes false, so the member is gone from the people directory
 *     and from skill pages even for a reader that only checks the listing flag;
 *   - `public_role` goes false — the CONSENT, not just the record it produced;
 *   - `fs_steward.suspended_at` is stamped, so a steward who leaves stops being one here;
 *   - the published role claim is retracted BY THE CALLER (`routes/schools.ts`), because
 *     retraction is a PDS write through that school's actor and this module does no I/O
 *     beyond its own tables;
 *   - THE CLASSES STAY. They are `community.lexicon.calendar.event` records in the
 *     member's own repo and they really did happen on this school's calendar; deleting
 *     them is not ours to do and un-listing them would rewrite the city's history.
 *
 * The row itself survives, so re-joining is `joinSchool` clearing `left_at` rather than a
 * new membership with a new `joined_at`. Re-joining restores NOTHING ELSE — not the
 * directory listing, not the public-role opt-in, not the stewardship. Leaving was the
 * stronger statement, and re-publishing someone's name (or handing back a moderation
 * power) because they looked at the site again is exactly the R9 failure mode. The two
 * toggles are one tap each on the Me screen, and stewardship is somebody's decision.
 *
 * Returns false when there was no membership row to end — `routes/schools.ts` turns that
 * into a 404, never a 403 (MS §10: a 403 would confirm the school has a roster to be off).
 */
export async function leaveSchool(did: string, schoolDid: string, db: Db = getDb()): Promise<boolean> {
  if (!schoolDid) return false
  const now = new Date()
  const rows = await db
    .update(membership)
    .set({
      leftAt: now,
      directoryListing: false,
      /**
       * The opt-in dies with the membership (review round 2). The caller retracts the
       * already-published claim, but the CONSENT has to go too: `joinSchool`'s conflict
       * `set` deliberately preserves `public_role` for a returning member, so leaving it
       * true here would let a re-join silently resurrect a public record naming this
       * person as a member of a school — with no fresh opt-in anywhere. R9: consent that
       * outlives the relationship it was given inside is not consent.
       */
      publicRole: false,
    })
    .where(and(eq(membership.did, did), eq(membership.schoolDid, schoolDid), isNull(membership.leftAt)))
    .returning({ did: membership.did })
  if (rows.length === 0) return false

  /**
   * AND THE STEWARDSHIP (review round 2 — blocking). `fs_steward` is read directly by
   * `lib/roles.ts`, so a steward who left kept `requireRole(Steward)` on the school they
   * walked out of, forever. Suspending rather than deleting keeps the appointment's
   * history (who appointed them, when) and matches the column `routes/handoff.ts` already
   * uses; `appointSteward` clears it, so an explicit RE-APPOINTMENT restores the role and
   * merely coming back (`joinSchool`) does not.
   */
  await db
    .update(steward)
    .set({ suspendedAt: now })
    .where(and(eq(steward.did, did), eq(steward.schoolDid, schoolDid), isNull(steward.suspendedAt)))
  return true
}

/**
 * THE FIRST STEWARD, appointed rather than derived — the one role `lib/roles.ts` cannot
 * compute, because every path to it (`POST /api/admin/moderation` with `set-role`, the
 * hand-off flow) already requires a steward. It starts here, and only here:
 * `createSchool` calls it for the founder (MS §8 step 5) and `scripts/appoint-steward.ts`
 * is the operator's second chance, for the usual case where the founder had no DID yet
 * when the school was minted.
 *
 * Idempotent. Also writes the GLOBAL `fs_member` presence row, because `roleOf` wants a
 * steward to be a known member and an appointee may never have had a session.
 *
 * An appointment CLEARS `suspended_at`, which is how a steward who left (and was suspended
 * by `leaveSchool`) gets their role back: somebody appoints them again. Coming back on
 * one's own — `joinSchool` clearing `left_at` — deliberately does not, because regaining
 * stewardship must be a decision somebody made, never a side effect of signing in.
 * `appointedAt` is left alone so a repeat call stays a no-op.
 */
export async function appointSteward(did: string, schoolDid: string, db: Db = getDb()): Promise<void> {
  if (!did.startsWith('did:')) throw new Error('a steward is appointed by DID')
  if (!schoolDid) throw new Error('a steward is a steward OF a school; none was given')
  await db
    .insert(steward)
    .values({ did, schoolDid, appointedAt: new Date() })
    .onConflictDoUpdate({ target: [steward.did, steward.schoolDid], set: { suspendedAt: null } })
  const seenAt = new Date()
  await db
    .insert(member)
    .values({ did, door: 'custodial', firstSeenAt: seenAt, lastSeenAt: seenAt })
    .onConflictDoUpdate({ target: member.did, set: { lastSeenAt: seenAt } })
}
