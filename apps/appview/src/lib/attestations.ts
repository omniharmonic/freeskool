/**
 * Skill vouching — app-side only (R9: no public record names a DID its holder did not
 * write). A member "vouches" that another member holds a skill; `fs_attestation` rows
 * are the record of truth, never a protocol record.
 *
 * `subjectHoldsSkill` is the gate on `createAttestation`: a vouch only makes sense
 * against a skill the subject already claims (`fs_skill_claim_index`) OR visibly
 * demonstrates by hosting a class that teaches it (`freeschool.draft.skillLevel`
 * sidecar -> `resolveHostDid`).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { attestation, skillClaimIndex } from '../db/schema.js'
import { rowId } from './ids.js'
import { getIndexer } from '../index/indexer.js'
import { sidecarsForEvent } from '../index/queries.js'
import { resolveHostDid } from './events.js'

export class AttestationError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404 | 409,
    public code: string,
  ) {
    super(message)
    this.name = 'AttestationError'
  }
}

/**
 * A row in `fs_skill_claim_index` for (subjectDid, skillUri), OR the subject hosted an
 * event whose `freeschool.draft.skillLevel` sidecar names this skill (via
 * `resolveHostDid`, the same host-resolution a materialized series occurrence uses).
 */
export async function subjectHoldsSkill(subjectDid: string, skillUri: string): Promise<boolean> {
  const claimed = await getDb()
    .select({ did: skillClaimIndex.did })
    .from(skillClaimIndex)
    .where(and(eq(skillClaimIndex.did, subjectDid), eq(skillClaimIndex.skillUri, skillUri)))
    .limit(1)
  if (claimed.length > 0) return true

  const indexer = await getIndexer()
  const levels = await sidecarsForEvent<{ event?: { uri: string } }>(indexer, 'skillLevel', skillUri, 'skill')
  for (const level of levels) {
    const eventUri = level.value.event?.uri
    if (!eventUri) continue
    const hostDid = await resolveHostDid(eventUri, level.did)
    if (hostDid === subjectDid) return true
  }
  return false
}

export async function createAttestation(input: {
  attesterDid: string
  subjectDid: string
  skillUri: string
  contextEventUri?: string
}): Promise<{ id: string }> {
  const { attesterDid, subjectDid, skillUri, contextEventUri } = input

  if (attesterDid === subjectDid) {
    throw new AttestationError('cannot vouch for your own skill', 400, 'SelfAttestation')
  }
  if (!(await subjectHoldsSkill(subjectDid, skillUri))) {
    throw new AttestationError('the subject does not hold this skill', 404, 'SubjectNotHolding')
  }

  // One statement, not check-then-insert: two concurrent vouches for the same
  // (attester, subject, skill) must yield one row and one 409, never a raw unique
  // violation surfacing as a 500. The unique index is the arbiter.
  const id = rowId()
  const inserted = await getDb()
    .insert(attestation)
    .values({ id, attesterDid, subjectDid, skillUri, contextEventUri: contextEventUri ?? null })
    .onConflictDoNothing({ target: [attestation.attesterDid, attestation.subjectDid, attestation.skillUri] })
    .returning({ id: attestation.id })
  if (inserted.length === 0) {
    throw new AttestationError('already vouched for this skill', 409, 'AlreadyVouched')
  }
  return { id }
}

/** True only when THIS attester's own vouch was deleted — never anyone else's. */
export async function removeAttestation(id: string, attesterDid: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(attestation)
    .where(and(eq(attestation.id, id), eq(attestation.attesterDid, attesterDid)))
    .returning({ id: attestation.id })
  return deleted.length > 0
}

/** Vouch counts for one subject, by skill. */
export async function vouchCountsFor(subjectDid: string): Promise<Map<string, number>> {
  const rows = await getDb()
    .select({ skillUri: attestation.skillUri, n: sql<number>`count(*)::int` })
    .from(attestation)
    .where(eq(attestation.subjectDid, subjectDid))
    .groupBy(attestation.skillUri)
  return new Map(rows.map((r) => [r.skillUri, r.n]))
}

/** Total vouch count per subject, batched for a directory listing. */
export async function vouchCountsForMany(subjectDids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(subjectDids)]
  if (unique.length === 0) return new Map()
  const rows = await getDb()
    .select({ subjectDid: attestation.subjectDid, n: sql<number>`count(*)::int` })
    .from(attestation)
    .where(inArray(attestation.subjectDid, unique))
    .groupBy(attestation.subjectDid)
  return new Map(rows.map((r) => [r.subjectDid, r.n]))
}

/** Vouch counts for ONE skill, across a batch of subjects — the members directory's "people with this skill" list. */
export async function vouchCountsForSkill(skillUri: string, subjectDids: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(subjectDids)]
  if (unique.length === 0) return new Map()
  const rows = await getDb()
    .select({ subjectDid: attestation.subjectDid, n: sql<number>`count(*)::int` })
    .from(attestation)
    .where(and(eq(attestation.skillUri, skillUri), inArray(attestation.subjectDid, unique)))
    .groupBy(attestation.subjectDid)
  return new Map(rows.map((r) => [r.subjectDid, r.n]))
}

/** Which skills has THIS attester already vouched THIS subject for? For the "vouched" UI toggle. */
export async function viewerVouches(attesterDid: string, subjectDid: string): Promise<Set<string>> {
  const rows = await getDb()
    .select({ skillUri: attestation.skillUri })
    .from(attestation)
    .where(and(eq(attestation.attesterDid, attesterDid), eq(attestation.subjectDid, subjectDid)))
  return new Set(rows.map((r) => r.skillUri))
}

/** Every vouch received by a subject, attester included — raw rows for `GET /api/me/attestations`. */
export async function receivedWithAttesters(
  subjectDid: string,
): Promise<Array<{ skillUri: string; attesterDid: string; id: string; createdAt: string }>> {
  const rows = await getDb()
    .select({
      id: attestation.id,
      attesterDid: attestation.attesterDid,
      skillUri: attestation.skillUri,
      createdAt: attestation.createdAt,
    })
    .from(attestation)
    .where(eq(attestation.subjectDid, subjectDid))
    .orderBy(desc(attestation.createdAt))
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}
