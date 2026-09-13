/**
 * Publishing a member's DERIVED role as a PUBLIC record — the ONE place a derived role
 * ever reaches the protocol (everywhere else, per CLAUDE.md, "roles are derived, never
 * minted or scored").
 *
 * THREE independent gates, ALL required, checked in this order so the default case
 * (everything off) costs nothing beyond one already-warm policy-cache read:
 *
 *   (a) the school's policy has `thresholds.publishRoles === true` — a steward's
 *       choice, OFF by default (`freeschool.draft.policy#thresholds`)
 *   (b) the subject has explicitly opted in (`fs_member_prefs.public_role`), OFF by
 *       default — R9: no public record may name a DID its holder did not choose to
 *   (c) the role is Host (20) or above — a bare learner's membership is never
 *       published, only a public-facing host/facilitator/steward role
 *
 * When all three hold, this writes `coop.lexicon.membership {subject, role, school,
 * addedBy}` as the school, through `SchoolActorPort` (never any other way — R3
 * invariant 1). The caller is the SUBJECT themselves: they are consenting to their own
 * already-qualifying role being named, not asking the school to grant anything, which
 * is why `publish-role-claim` sits at Host in `packages/school-actor`'s MIN_ROLE, not
 * Steward.
 *
 * Called from the role re-derivation path (`lib/roles.ts#bumpTally`, and the opt-in
 * toggle itself) — NOT from every `roleOf()` call, which would turn a read into a write
 * on every authorization check.
 *
 * RKEY IS DETERMINISTIC, derived from `(schoolDid, subjectDid)` alone (never `tid()`):
 * this is called once per attested attendee and once per hosted event, so a `tid()`
 * rkey would write a fresh, identical-looking public record every single time. A
 * deterministic rkey makes every call an upsert into the SAME record slot — "two
 * derivations yield one record" — and is also what makes retraction possible at all:
 * `retractRoleClaim` recomputes the same rkey to delete exactly that slot, both when a
 * member opts back out (`setPublicRoleOptIn(did, false)`) and when the role itself
 * drops back below Host (the `role < Role.Host` branch of `publishRoleClaim`).
 *
 * UPDATING an existing claim (e.g. Host -> Facilitator) reads the current record's CID
 * first and passes it as `swapRecord`, so the write is a compare-and-swap rather than
 * an unconditional overwrite — see `fetchExistingCid`.
 */
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { Did } from '@freeschool/school-actor'
import { getDb } from '../db/index.js'
import { memberPrefs } from '../db/schema.js'
import { getThresholds } from './policy.js'
import { schoolActor } from './school-actor.js'
import { getRecord } from './pds.js'
import { config } from '../config.js'
import { NSID } from '../lexicons/nsids.js'
import { describeError, log } from './logging.js'

const B32 = '234567abcdefghijklmnopqrstuvwxyz'

/**
 * Deterministic: the same (schoolDid, subjectDid) always derives the same rkey. The
 * `\0` separator is the escape sequence, not a literal NUL byte in the source file —
 * git (and most text tooling) treats a raw NUL as binary content.
 */
export function membershipClaimRkey(schoolDid: string, subjectDid: string): string {
  const digest = createHash('sha256').update(`${schoolDid}\0${subjectDid}`).digest()
  let out = ''
  for (let i = 0; i < 13; i++) out += B32[digest[i]! & 31]
  return out
}

export async function isPublicRoleOptIn(did: string): Promise<boolean> {
  const rows = await getDb().select({ publicRole: memberPrefs.publicRole }).from(memberPrefs).where(eq(memberPrefs.did, did)).limit(1)
  return rows[0]?.publicRole ?? false
}

/**
 * When turning the opt-in OFF, also retracts any already-published claim — a claim
 * that outlives the consent behind it is exactly what R9 forbids. Turning it ON does
 * NOT publish by itself: that still waits for the next role re-derivation (or the
 * caller may follow up with `publishRoleClaim` using the subject's current role, as
 * `http/routes/me.ts#PUT /public-role` does).
 */
export async function setPublicRoleOptIn(did: string, publicRole: boolean, schoolDid = config().SCHOOL_DID): Promise<void> {
  await getDb()
    .insert(memberPrefs)
    .values({ did, publicRole, updatedAt: new Date() })
    .onConflictDoUpdate({ target: memberPrefs.did, set: { publicRole, updatedAt: new Date() } })
  if (!publicRole && schoolDid) {
    await retractRoleClaim(schoolDid as Did, did as Did)
  }
}

export type PublishReason = 'role-too-low' | 'policy-off' | 'not-opted-in' | 'published' | 'error'

export interface PublishResult {
  published: boolean
  reason: PublishReason
  uri?: string
}

/**
 * Best-effort: deleting a record that never existed is not an error worth surfacing
 * (a member who never qualified, or never opted in, has nothing to retract), so every
 * failure is swallowed after a warning log. Never throws.
 */
export async function retractRoleClaim(schoolDid: Did, subjectDid: Did): Promise<void> {
  try {
    await schoolActor().deleteRecordAsSchool({
      schoolDid,
      callerDid: subjectDid,
      scope: NSID.membership,
      action: 'retract-role-claim',
      collection: NSID.membership,
      rkey: membershipClaimRkey(schoolDid, subjectDid),
      audit: { reason: 'retracting a role claim: opted out, or role dropped below Host' },
    })
  } catch (err) {
    log.warn('retractRoleClaim failed (likely nothing to retract)', { detail: describeError(err) })
  }
}

/**
 * The current CID of a claim at its deterministic rkey, or `undefined` if none exists
 * yet. Used to make a republish a compare-and-swap (`swapRecord`) rather than an
 * unconditional overwrite — and, just as importantly, NOT an unconditional
 * `swapRecord: null`, which would assert "must not already exist" and fail every
 * update (`packages/school-actor`'s `putRecordAsSchool` only sends `swapRecord` at all
 * when the caller passes one).
 */
async function fetchExistingCid(schoolDid: Did, subjectDid: Did): Promise<string | undefined> {
  try {
    const existing = await getRecord(schoolDid, NSID.membership, membershipClaimRkey(schoolDid, subjectDid))
    return existing?.cid
  } catch (err) {
    log.warn('fetchExistingCid failed; publishing without a swapRecord', { detail: describeError(err) })
    return undefined
  }
}

export interface PublishRoleClaimDeps {
  /** Overridable in tests: avoids a real PDS round-trip via `getRecord`. */
  fetchExistingCid?: (schoolDid: Did, subjectDid: Did) => Promise<string | undefined>
}

export async function publishRoleClaim(
  schoolDid: Did,
  subjectDid: Did,
  role: Role,
  deps: PublishRoleClaimDeps = {},
): Promise<PublishResult> {
  if (role < Role.Host) {
    // The role may have just DROPPED below Host — retract any existing claim. Only
    // worth attempting when the subject could plausibly have one (they opted in at
    // some point); skips the call entirely for the common case of a member who never
    // opted in at all.
    if (await isPublicRoleOptIn(subjectDid)) {
      await retractRoleClaim(schoolDid, subjectDid)
    }
    return { published: false, reason: 'role-too-low' }
  }

  // (a) the policy cache is already warm almost always (roleOf() just read it too).
  const thresholds = await getThresholds(schoolDid)
  if (!thresholds.publishRoles) return { published: false, reason: 'policy-off' }

  // (b) the subject's own, explicit choice.
  if (!(await isPublicRoleOptIn(subjectDid))) return { published: false, reason: 'not-opted-in' }

  try {
    const rkey = membershipClaimRkey(schoolDid, subjectDid)
    const existingCid = await (deps.fetchExistingCid ?? fetchExistingCid)(schoolDid, subjectDid)
    const res = await schoolActor().putRecordAsSchool({
      schoolDid,
      // The subject is the caller: they already qualify (role >= Host, just checked),
      // and they are the one who opted in. No steward involvement needed to publish a
      // claim about oneself that the policy already allows and one consented to.
      callerDid: subjectDid,
      scope: NSID.membership,
      action: 'publish-role-claim',
      collection: NSID.membership,
      // DETERMINISTIC — see module doc. The same slot every time means a re-derivation
      // (another hosted event, another attested attendance) updates the one existing
      // record instead of writing a duplicate.
      rkey,
      // CAS against whatever is there right now (or omitted entirely for a first
      // publish) — never an unconditional `null`, which would reject every update.
      ...(existingCid !== undefined ? { swapRecord: existingCid } : {}),
      record: {
        $type: NSID.membership,
        subject: subjectDid,
        role,
        school: schoolDid,
        addedBy: schoolDid,
        createdAt: new Date().toISOString(),
      },
      audit: { reason: 'member opted in to publishing an already-qualifying role claim', approvals: [] },
    })
    return { published: true, reason: 'published', uri: res.uri }
  } catch (err) {
    log.warn('publishRoleClaim failed', { detail: describeError(err) })
    return { published: false, reason: 'error' }
  }
}
