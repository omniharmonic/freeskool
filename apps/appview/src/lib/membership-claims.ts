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
 */
import { eq } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import type { Did } from '@freeschool/school-actor'
import { getDb } from '../db/index.js'
import { memberPrefs } from '../db/schema.js'
import { getThresholds } from './policy.js'
import { schoolActor } from './school-actor.js'
import { NSID } from '../lexicons/nsids.js'
import { tid } from './ids.js'
import { log } from './logging.js'

export async function isPublicRoleOptIn(did: string): Promise<boolean> {
  const rows = await getDb().select({ publicRole: memberPrefs.publicRole }).from(memberPrefs).where(eq(memberPrefs.did, did)).limit(1)
  return rows[0]?.publicRole ?? false
}

export async function setPublicRoleOptIn(did: string, publicRole: boolean): Promise<void> {
  await getDb()
    .insert(memberPrefs)
    .values({ did, publicRole, updatedAt: new Date() })
    .onConflictDoUpdate({ target: memberPrefs.did, set: { publicRole, updatedAt: new Date() } })
}

export type PublishReason = 'role-too-low' | 'policy-off' | 'not-opted-in' | 'published' | 'error'

export interface PublishResult {
  published: boolean
  reason: PublishReason
  uri?: string
}

export async function publishRoleClaim(schoolDid: Did, subjectDid: Did, role: Role): Promise<PublishResult> {
  // (c) cheapest check first: no DB/network at all for anyone below Host.
  if (role < Role.Host) return { published: false, reason: 'role-too-low' }

  // (a) the policy cache is already warm almost always (roleOf() just read it too).
  const thresholds = await getThresholds(schoolDid)
  if (!thresholds.publishRoles) return { published: false, reason: 'policy-off' }

  // (b) the subject's own, explicit choice.
  if (!(await isPublicRoleOptIn(subjectDid))) return { published: false, reason: 'not-opted-in' }

  try {
    const res = await schoolActor().putRecordAsSchool({
      schoolDid,
      // The subject is the caller: they already qualify (role >= Host, just checked),
      // and they are the one who opted in. No steward involvement needed to publish a
      // claim about oneself that the policy already allows and one consented to.
      callerDid: subjectDid,
      scope: NSID.membership,
      action: 'publish-role-claim',
      collection: NSID.membership,
      rkey: tid(),
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
    log.warn('publishRoleClaim failed', { detail: String(err) })
    return { published: false, reason: 'error' }
  }
}
