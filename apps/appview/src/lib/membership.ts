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
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, type Db } from '../db/index.js'
import { membership, memberPrefs } from '../db/schema.js'
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
    .select({ directoryListing: memberPrefs.directoryListing })
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
      joinedAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: [membership.did, membership.schoolDid],
      // NOT `directoryListing`, NOT `joinedAt`: a returning member's own choices survive.
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
 * "List me in this school's directory" — per membership. Falls back to the member's
 * GLOBAL `fs_member_prefs` row while the two coexist (MS §9 E keeps the old column for
 * one release), and to `true` when neither exists, because the directory is listed-by-
 * default and opt-out (spec §3 R-1).
 */
export async function directoryListing(did: string, schoolDid: string, db: Db = getDb()): Promise<boolean> {
  const rows = await db
    .select({ directoryListing: membership.directoryListing })
    .from(membership)
    .where(and(eq(membership.did, did), eq(membership.schoolDid, schoolDid)))
    .limit(1)
  if (rows.length > 0) return rows[0]!.directoryListing
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
 * Leaving a school (spec ruling 10): the row survives — the member's own public records
 * still make sense — but they drop out of this school's directory and skill pages, and
 * their published role claim is retracted by the caller.
 */
export async function leaveSchool(did: string, schoolDid: string, db: Db = getDb()): Promise<void> {
  await db
    .update(membership)
    .set({ leftAt: new Date() })
    .where(and(eq(membership.did, did), eq(membership.schoolDid, schoolDid)))
}
