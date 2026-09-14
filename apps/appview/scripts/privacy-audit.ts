/**
 * The privacy audit: does any PUBLIC record name a DID its holder did not write?
 *
 *   pnpm --filter @freeschool/appview privacy-audit
 *
 * R9's hard rule (CLAUDE.md, "Privacy defaults"): *no public record may name a DID its
 * holder did not write*. Everything the app collects about other people — RSVPs,
 * attendance, feedback, the roster, moderation reasons — lives app-side behind the
 * Spaces-shaped interface precisely so that rule holds by construction. This script is the
 * check that it actually does, against the real repos on the real PDS, and it is what the
 * smoke test runs last (`scripts/smoke.ts`, step 11).
 *
 * WHAT "NAMES" MEANS. A record names a DID if ANY string anywhere in its value
 * (recursively) is a DID, or is an `at://` URI whose authority is a DID, that is not the
 * repo the record lives in. A DID in one's own repo is self-description and is always fine
 * — `community.lexicon.calendar.event` records naming their own host are the ordinary case
 * (author == subject).
 *
 * THE ONLY EXEMPTIONS, in full:
 *
 *   1. `coop.lexicon.membership` in a SCHOOL's repo may name a member at `subject` when
 *      BOTH consent gates hold **for that school**: that school's policy has
 *      `thresholds.publishRoles === true` AND that member opted in for that school
 *      (`fs_membership.public_role`, written by `PUT /api/me/public-role`). This is the
 *      one place a derived role reaches the protocol — see
 *      `src/lib/membership-claims.ts`, which enforces the same two gates plus
 *      `role >= Host` before writing.
 *
 *      PER SCHOOL, AND THAT MATTERS. Until the federation phase this script read the
 *      GLOBAL `fs_member_prefs.public_role` and the HOME school's `publishRoles` for
 *      every repo it looked at — so a member who opted in on Boulder made Denver's claim
 *      about them look consented, and a claim in a school whose policy has `publishRoles`
 *      off was cleared by a different school's policy. Consent given to one school is not
 *      consent spent in another (MS §10); the claim names the school it belongs to, and
 *      the repo it lives in IS that school, so the repo is what decides which gates apply.
 *   2. `freeschool.draft.moderationAction` in a SCHOOL's repo may name STEWARD DIDs in
 *      `actors[]` — "Stewards who approved", per that lexicon — because a steward consents
 *      by acting, and who approved a removal is the point of the record. Any other field is
 *      not exempt: in particular `subjectDid`, the account acted on, is a violation —
 *      moderation subjects and reasons are never public (CLAUDE.md; plan §3 G, "public
 *      projection shows enum only"). `approvals[].stewardDid` is accepted under the same
 *      rule for any future record that uses that shape.
 *   3. `freeschool.draft.skillAttestation` would be allowed on a recorded app-side DOUBLE
 *      opt-in (attester and subject). `fs_attestation` exists now, but it is the APP-SIDE
 *      vouching feature (`lib/attestations.ts`) — it never writes a `skillAttestation`
 *      record, and there is still no double-opt-in table for the public record itself. So
 *      every `skillAttestation` naming another DID still FAILS here, and the report says
 *      why. Whoever adds a public attestation record adds that consent table with it.
 *   4. A SCHOOL's own DID is never a "named other". A school is a public institutional
 *      actor, not a person: its DID is on every listing it publishes, and the `approval`
 *      lexicon's `proposal` field is explicitly "an app-side proposal id expressed as an
 *      at-uri under the school DID". Treating that as a violation would make sidecar
 *      composition itself one. School DIDs are discovered, not configured: a repo holding a
 *      `freeschool.draft.school` record is a school, so the rule is right on a PDS that
 *      hosts several (which the local one does, one per smoke run).
 *
 *   5. `community.lexicon.calendar.rsvp`'s `subject` strongRef (`{ uri, cid }`) may name the
 *      host at `subject.uri` — an at-uri into `community.lexicon.calendar.event`. That event
 *      is itself a public record the host published; an RSVP pointing at it does not tell a
 *      stranger anything about the host they could not already see by reading the event.
 *      This is the opt-in public-RSVP path (`alsoPublicRecord`, `src/http/routes/rsvp.ts`).
 *
 *   6. The same reasoning, at the exact paths listed in `STRONGREF_EXEMPT_PATHS`, for the
 *      SCHOOL-WRITTEN collections F1 added: a `coop.lexicon.event.listing` names the host's
 *      event, a `freeschool.draft.occurrence` names the host's event and series, a
 *      `freeschool.draft.claim` names the asker's request, a `freeschool.draft.skillClaim`
 *      names the taxonomy authority's skill. Each points at a public record its OWN author
 *      wrote. Narrow on purpose: exact paths, so a NEW field naming somebody on any of these
 *      is a violation until somebody justifies it there.
 *
 * Nothing else is exempt.
 *
 * AND SEPARATELY, FREE TEXT (F1). `reason`, `note`, `description` and `suppliesNote` are
 * scanned for an `@handle`-shaped token or a `did:` prefix, and there is NO exemption for
 * either. A handle is not a DID, so the structural scan cannot see it at all; and a
 * free-text field is never the right place to name somebody, whoever they are — the
 * structural `actors[]` exemption exists precisely so a steward does not have to be named in
 * prose. `freeschool.draft.moderationAction` no longer carries a `reason` at all (F0), which
 * is the main thing this scan was going to find.
 *
 * OUTPUT. One row per (repo, collection) that exists, with counts; then every violation,
 * with the DID truncated to 12 characters (`did:plc:abcd…`) and the offending rkey — a
 * privacy audit that reprints the DIDs it found would be its own violation. Exits 1 if
 * there is any violation, so CI can gate on it.
 *
 * Reads are unauthenticated (`com.atproto.sync.listRepos`,
 * `com.atproto.repo.describeRepo`, `com.atproto.repo.listRecords`) — that is the whole
 * point: this is what a stranger can see.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'
import { config } from '../src/config.js'
import { getDb, closeDb } from '../src/db/index.js'
import { memberPrefs, membership, school as schoolTable } from '../src/db/schema.js'
import { getThresholds } from '../src/lib/policy.js'
import { NSID } from '../src/lexicons/nsids.js'
import { isMain } from '../src/lib/is-main.js'
import { canonicalHostsFor, legacySchoolDid, listSchools } from '../src/lib/schools.js'

/**
 * The collections a stranger could read that could name somebody else.
 *
 * F1 adds the SCHOOL-WRITTEN ones. They were missing for an understandable reason — the
 * school is exempt as an institution, so "the school names the school" is never a violation —
 * but that is not what these records do: a listing and an occurrence both point at a HOST's
 * event, a claim points at an ASKER's request, a skill claim points at the taxonomy
 * AUTHORITY's skill. Every one of those is a DID the record's author did not write, and they
 * were simply not being looked at. They are all allowed, for a reason
 * (`STRONGREF_EXEMPT_PATHS`) — but now the audit proves it each run instead of assuming it,
 * and a NEW field on any of them is a violation by default.
 */
export const AUDITED_COLLECTIONS = [
  NSID.rsvp,
  NSID.attendance,
  NSID.hostFeedback,
  NSID.membership,
  NSID.moderationAction,
  NSID.skillAttestation,
  NSID.approval,
  NSID.eventListing,
  NSID.occurrence,
  NSID.claim,
  NSID.skillClaim,
  NSID.policy,
  NSID.school,
] as const

/**
 * Paths whose value is a strongRef (or at-uri) pointing at a record ITS OWN AUTHOR
 * published — the same reasoning as the RSVP exemption (5): the thing pointed at is already
 * public, written by the person it names, so the pointer tells a stranger nothing they could
 * not read directly. Narrow ON PURPOSE: exact paths, not prefixes, so a new field naming
 * somebody is a violation until somebody justifies it here.
 */
const STRONGREF_EXEMPT_PATHS: Record<string, readonly string[]> = {
  // The school lists a host's event. The listing IS the curation surface; the event is the
  // host's own public record.
  [NSID.eventListing]: ['event.uri', 'event'],
  // The school materializes an occurrence of a host's series: both refs point at records the
  // host (or the school itself) published.
  [NSID.occurrence]: ['event.uri', 'event', 'series.uri', 'series'],
  // A host claims an asker's request, optionally naming the event they made for it.
  [NSID.claim]: ['request.uri', 'request', 'event.uri', 'event'],
  // A member's own claim points at a skill in the taxonomy authority's repo.
  [NSID.skillClaim]: ['skill'],
}

const DID_RE = /did:[a-z0-9]+:[a-zA-Z0-9._:%-]+/
/**
 * #13. An at-uri FIRST, so its authority is attributed to the at-uri rather than reported
 * twice; then any bare DID. Global, and applied with `matchAll` INSIDE the string rather than
 * anchored to the whole of it — which is the bug: `namedDids` only ever matched a field whose
 * ENTIRE value was a DID or an at-uri, so `"ask did:plc:abc about it"`, a `text` field with
 * an at-uri in the middle of a sentence, or any DID embedded in a longer string walked
 * straight past the audit.
 */
const NAMED_DID_RE = new RegExp(`at:\\/\\/(${DID_RE.source})|(${DID_RE.source})`, 'g')

/** Free-text fields a human wrote, where a DID or a handle is not a reference but a mention. */
export const FREE_TEXT_FIELDS: ReadonlySet<string> = new Set(['reason', 'note', 'description', 'suppliesNote'])
/** `@alice.test`, `@dana.bsky.social`. The leading `@` is required: `boulder.test` on its own is a domain. */
const HANDLE_MENTION = /@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}\b/i
const DID_MENTION = /did:[a-z0-9]+:/i

export interface NamedDid {
  /** Dotted path inside the record value, e.g. `approvals.0.stewardDid`. */
  path: string
  did: string
}

/**
 * Every DID named anywhere in a record value, with the path that named it. Exported for
 * the tests: this is the whole definition of "names a DID".
 *
 * #13: the scan is INSIDE each string (`matchAll`), not anchored to the whole of it. A DID
 * mentioned mid-sentence in a `text` or `reason` field is exactly as public as one sitting
 * alone in a `subject` field, and the anchored version could not see it.
 */
export function namedDids(value: unknown, path = ''): NamedDid[] {
  if (typeof value === 'string') {
    const seen = new Set<string>()
    const out: NamedDid[] = []
    for (const m of value.matchAll(NAMED_DID_RE)) {
      // Group 1 is an at-uri's authority; group 2 is a bare DID.
      const did = m[1] ?? m[2]
      if (!did || seen.has(did)) continue
      seen.add(did)
      out.push({ path, did })
    }
    return out
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => namedDids(item, path ? `${path}.${i}` : String(i)))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) => namedDids(v, path ? `${path}.${key}` : key))
  }
  return []
}

export interface TextMention {
  path: string
  kind: 'handle' | 'did'
}

/**
 * F1. THE FREE-TEXT SCAN, which is a different question from `namedDids`.
 *
 * A steward writing "@alice.test kept turning up drunk" in a `reason`, or a host writing
 * "ask did:plc:… first" in a `note`, names a person in a public record just as surely as a
 * `subject` field does — and a HANDLE is not a DID, so the structural scan above cannot see
 * it at all. There is no exemption for any of these: a free-text field is never the right
 * place to name somebody, whoever they are, so even a steward's own handle is flagged (the
 * structural `actors[]` exemption exists precisely so a steward does not need to be named in
 * prose).
 *
 * Only fields a human wrote (`FREE_TEXT_FIELDS`) are scanned, so a structural at-uri in a
 * `subject`/`event`/`skill` field is not double-reported as a mention.
 */
export function textMentions(value: unknown, path = ''): TextMention[] {
  if (typeof value === 'string') {
    const key = path.split('.').pop() ?? ''
    if (!FREE_TEXT_FIELDS.has(key)) return []
    const out: TextMention[] = []
    if (DID_MENTION.test(value)) out.push({ path, kind: 'did' })
    if (HANDLE_MENTION.test(value)) out.push({ path, kind: 'handle' })
    return out
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => textMentions(item, path ? `${path}.${i}` : String(i)))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) => textMentions(v, path ? `${path}.${key}` : key))
  }
  return []
}

export interface ConsentFacts {
  /** Every repo on an audited host that holds a `freeschool.draft.school` record. */
  schoolDids: Set<string>
  /**
   * `thresholds.publishRoles` PER SCHOOL, keyed by the school's DID. A school we host but
   * whose policy we could not read is absent, which reads as `false` — fail closed.
   */
  publishRoles: Map<string, boolean>
  /**
   * Who opted in, PER SCHOOL: `fs_membership.public_role` for that school, plus (for the
   * legacy school alone, mirroring `lib/membership.ts#publicRoleOptIn`) the old global
   * `fs_member_prefs.public_role` for members with no membership row there yet.
   */
  publicRoleOptIn: Map<string, Set<string>>
  /** Always false in v1 — there is no attestation double-opt-in table. See the module doc. */
  attestationConsentTable: boolean
}

export type Verdict = { allowed: true; reason: string } | { allowed: false; reason: string }

/**
 * The exemption rules, as one pure function of (collection, repo, path, named DID) and the
 * consent facts. No network, no database — so the rules are testable and reviewable on
 * their own.
 */
export function verdictFor(
  collection: string,
  repoDid: string,
  named: NamedDid,
  facts: ConsentFacts,
): Verdict {
  const isSchoolRepo = facts.schoolDids.has(repoDid)

  // Exemption 4: the school is an institution, not a person.
  if (facts.schoolDids.has(named.did)) return { allowed: true, reason: 'names a school DID (public institutional actor)' }

  if (collection === NSID.membership && isSchoolRepo && named.path === 'subject') {
    // THE REPO IS THE SCHOOL. Both gates are read for THIS school and no other — see
    // exemption 1 in the module doc for why that distinction is the whole point.
    if (!facts.publishRoles.get(repoDid)) {
      return { allowed: false, reason: 'membership claim but this school’s policy.publishRoles is off' }
    }
    if (!facts.publicRoleOptIn.get(repoDid)?.has(named.did)) {
      return { allowed: false, reason: 'membership claim without the member’s public-role opt-in IN THIS SCHOOL' }
    }
    return { allowed: true, reason: 'this school’s publishRoles + this member’s opt-in here' }
  }

  if ((collection === NSID.approval || collection === NSID.moderationAction) && isSchoolRepo) {
    // `fs_steward` is deliberately NOT consulted: `SchoolActorPort` already refused the
    // write unless the caller was a steward at the time, and a steward who later stands
    // down must not turn a long-settled decision record into a violation.
    if (/^actors\.\d+$/.test(named.path) || /^approvals\.\d+\.stewardDid$/.test(named.path)) {
      return { allowed: true, reason: 'steward consented by acting (actors[])' }
    }
    return { allowed: false, reason: `names a DID outside actors[] (at ${named.path})` }
  }

  // Exemption 5: an RSVP's strongRef subject names the host only through an at-uri to
  // the event the host already published publicly.
  if (collection === NSID.rsvp && named.path === 'subject.uri') {
    return { allowed: true, reason: 'rsvp subject is a strongRef to the host’s own public event' }
  }

  if (collection === NSID.skillAttestation) {
    return facts.attestationConsentTable
      ? { allowed: false, reason: 'attestation without a recorded double opt-in' }
      : { allowed: false, reason: 'attestations have no app-side double-opt-in table in v1' }
  }

  // F1: a strongRef to a record its own author published — the listing/occurrence/claim/
  // skillClaim cases. Exact paths only (see `STRONGREF_EXEMPT_PATHS`).
  if (STRONGREF_EXEMPT_PATHS[collection]?.includes(named.path)) {
    return { allowed: true, reason: `strongRef to a public record its own author wrote (at ${named.path})` }
  }

  return { allowed: false, reason: `no exemption covers ${collection} (at ${named.path})` }
}

export interface AuditCell {
  host: string
  repoDid: string
  collection: string
  count: number
  namedOthers: number
  allowed: number
  violations: number
  /** Records with a handle or a DID mentioned in FREE TEXT (F1). Counted in `violations` too. */
  textMentions: number
}

export interface AuditViolation {
  host: string
  repoDid: string
  collection: string
  rkey: string
  path: string
  namedDid: string
  reason: string
}

export interface AuditReport {
  hosts: string[]
  repos: number
  records: number
  cells: AuditCell[]
  /** Structural namings AND free-text mentions, in one list: the script exits 1 on any. */
  violations: AuditViolation[]
  /** The subset of `violations` that came from MS §10.3's cross-tenant assertions. */
  crossTenant: AuditViolation[]
  /** Which school this report is about, when it was scoped to one. */
  schoolDid?: string
  /** Recorded in the report so a future run can tell why attestations failed. */
  attestationConsentTable: boolean
  /** `thresholds.publishRoles` per school DID — one school's answer is not another's. */
  publishRoles: Record<string, boolean>
}

/** `did:plc:abcd…` — enough to find it with the rkey, not enough to be a copy of it. */
export function shortDid(did: string): string {
  return did.length <= 12 ? did : `${did.slice(0, 12)}…`
}

async function xrpcGet<T>(host: string, method: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(`/xrpc/${method}`, host)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  if (!res.ok) return null
  return (await res.json()) as T
}

async function listRepoDids(host: string): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const page = await xrpcGet<{ repos?: Array<{ did: string; active?: boolean }>; cursor?: string }>(
      host,
      'com.atproto.sync.listRepos',
      { limit: '1000', ...(cursor ? { cursor } : {}) },
    )
    if (!page) break
    for (const repo of page.repos ?? []) {
      if (repo.active === false) continue
      out.push(repo.did)
    }
    cursor = page.cursor
  } while (cursor)
  return out
}

/** `describeRepo` lists a repo's collections, which saves one listRecords per collection. */
async function collectionsOf(host: string, did: string): Promise<string[]> {
  const described = await xrpcGet<{ collections?: string[] }>(host, 'com.atproto.repo.describeRepo', { repo: did })
  return described?.collections ?? []
}

async function allRecords(
  host: string,
  did: string,
  collection: string,
): Promise<Array<{ uri: string; value: Record<string, unknown> }>> {
  const out: Array<{ uri: string; value: Record<string, unknown> }> = []
  let cursor: string | undefined
  do {
    const page = await xrpcGet<{
      records?: Array<{ uri: string; value: Record<string, unknown> }>
      cursor?: string
    }>(host, 'com.atproto.repo.listRecords', {
      repo: did,
      collection,
      limit: '100',
      ...(cursor ? { cursor } : {}),
    })
    if (!page) break
    out.push(...(page.records ?? []))
    cursor = page.cursor
  } while (cursor)
  return out
}

/** Bounded concurrency — 249 local repos should not open 249 sockets at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Both consent gates, PER SCHOOL, for every school whose repo this run might read.
 *
 * FAILS CLOSED, and now per school: a policy we cannot read leaves that school out of
 * `publishRoles` (absent reads as `false`), and a membership table we cannot read leaves
 * every school's opt-in set empty. One school's unreadable policy no longer decides
 * another school's claims either way.
 */
async function consentFacts(schoolDids: Set<string>): Promise<ConsentFacts> {
  const publishRoles = new Map<string, boolean>()
  const publicRoleOptIn = new Map<string, Set<string>>()
  const optInFor = (schoolDid: string) => {
    const existing = publicRoleOptIn.get(schoolDid)
    if (existing) return existing
    const made = new Set<string>()
    publicRoleOptIn.set(schoolDid, made)
    return made
  }

  /**
   * ONLY THE SCHOOLS THIS DEPLOYMENT HOSTS. `schoolDids` is every repo on the PDS holding
   * a `freeschool.draft.school` record — on a dev box, forty abandoned test schools — and
   * `getThresholds` is not a pure read: a miss refreshes the policy from the PDS and
   * WRITES `fs_policy_cache`. Asking it about a school we do not host would have this
   * audit create a row per stranger's school every run, which it did once before this
   * comment existed. A school we do not host is absent from the map, which reads as
   * `publishRoles: false` — fail closed, and honest: we cannot vouch for another
   * deployment's consent gates.
   */
  const ours = new Set((await listSchools().catch(() => [])).map((row) => row.did))
  for (const did of schoolDids) {
    if (!ours.has(did)) continue
    try {
      publishRoles.set(did, (await getThresholds(did)).publishRoles ?? false)
    } catch {
      console.warn(`    !!  could not read ${shortDid(did)}'s policy; treating publishRoles as off`)
    }
  }

  try {
    const rows = await getDb()
      .select({ did: membership.did, schoolDid: membership.schoolDid })
      .from(membership)
      .where(eq(membership.publicRole, true))
    for (const row of rows) optInFor(row.schoolDid).add(row.did)

    /**
     * The legacy school's transition fallback, MIRRORING `lib/membership.ts#publicRoleOptIn`
     * exactly: the old global column counts for the legacy school alone, and only for a
     * member who has no membership row there yet. Reading it any wider is the bug this
     * function was rewritten to fix.
     */
    const legacy = legacySchoolDid()
    if (legacy) {
      const haveRow = new Set(
        (await getDb().select({ did: membership.did }).from(membership).where(eq(membership.schoolDid, legacy))).map(
          (r) => r.did,
        ),
      )
      const prefs = await getDb()
        .select({ did: memberPrefs.did })
        .from(memberPrefs)
        .where(eq(memberPrefs.publicRole, true))
      for (const row of prefs) if (!haveRow.has(row.did)) optInFor(legacy).add(row.did)
    }
  } catch {
    // FAILS CLOSED: with no way to check consent, nothing is exempt, in any school.
    publicRoleOptIn.clear()
    console.warn('    !!  could not read the consent tables; treating every named DID as unconsented')
  }
  return { schoolDids, publishRoles, publicRoleOptIn, attestationConsentTable: false }
}

/**
 * Pass 1 over every host: which repos exist, and which of them hold which audited
 * collections. `describeRepo` answers both in one call per repo, which is what keeps the
 * audit to ~250 requests against the local PDS instead of ~1750.
 */
async function surveyHost(host: string, only?: Set<string>): Promise<Array<{ did: string; collections: string[] }>> {
  const dids = (await listRepoDids(host)).filter((did) => !only || only.has(did))
  return mapLimit(dids, 8, async (did) => ({ did, collections: await collectionsOf(host, did) }))
}

/* ─────────────────── MS §10.3: the two cross-tenant assertions ─────────────────── */

/**
 * The repos a school's audit is ABOUT: the school's own, plus everyone who has ever been
 * a member of it. A leaver is deliberately included — their public records are still
 * theirs, still on this PDS, and still readable by a stranger.
 */
async function reposOfSchool(schoolDid: string): Promise<string[]> {
  const rows = await getDb().select({ did: membership.did }).from(membership).where(eq(membership.schoolDid, schoolDid))
  return [...new Set([schoolDid, ...rows.map((r) => r.did)])]
}

/**
 * ASSERTION 1: no scoped `fs_*` row carries a `school_did` that belongs to no school.
 *
 * MS §10.3 words this as "no scoped row with a NULL `school_did`"; the columns were
 * shipped `NOT NULL DEFAULT ''`, so the value that means "not stamped" is `''` — and the
 * effect is identical, because `lib/school-scope.ts` hands every unstamped row to the
 * LEGACY school. So the assertion is: after `backfill-school` has run, no scoped row is
 * left unstamped, and none names a school that is not in `fs_school`.
 *
 * Only the tables this file can name are checked, and the list is deliberately explicit
 * rather than derived from the drizzle schema: a new scoped table should have to be added
 * here by someone who thought about it.
 */
const SCOPED_TABLES = [
  'fs_membership',
  'fs_attestation',
  'fs_rsvp',
  'fs_attendance',
  'fs_attendance_tally',
  'fs_feedback',
  'fs_moderation_queue',
  'fs_audit',
  'fs_invite',
  'fs_invite_link',
  'fs_notification_feed',
  'fs_newsletter_issue',
  'fs_newsletter_subscription',
  'fs_skill_proposal',
  'fs_steward',
  'fs_policy_cache',
  'fs_peer',
  'fs_event_school',
  'fs_request_rsvp',
] as const

/**
 * ASSERTION 2: no PUBLIC response on a school's own host names a DID whose only
 * membership is in another school.
 *
 * The app is built in process and asked with that school's Host header — the same
 * `withSchool` resolution a browser gets. Only the ANONYMOUS per-school surfaces are
 * probed, because they are the ones a stranger (and therefore another city's member) can
 * reach without a session; the signed-in ones are the tenant-isolation suite's job.
 *
 * School DIDs and the taxonomy authority are never "a member of another school".
 */
const PUBLIC_PROBES = (month: string) => ['/api/calendar', '/api/calendar.ics', `/api/zine/${month}`, '/api/school/how-it-works']

/**
 * Over HTTP, against the RUNNING AppView, with the school's own host forwarded — never by
 * building the app in this process.
 *
 * Building it would make this audit a WRITER: `createApp()`'s first request constructs the
 * indexer, which seeds `fs_peer` from `PEER_PDS_HOSTS` under whatever `SCHOOL_DID` this
 * shell happens to have (`''`, if the operator did not source the env), and every policy
 * read refreshes `fs_policy_cache`. An audit that mutates what it audits is not an audit.
 * Reading it over HTTP is also what the rest of this script already does to the PDS: look
 * at the deployment exactly as a stranger would.
 *
 * `undefined` — rather than "no violations" — when nothing is listening, so the report can
 * say the assertion did not run instead of quietly passing.
 */
async function probePublic(base: string, host: string, path: string): Promise<string | undefined> {
  try {
    const res = await fetch(new URL(path, base), { headers: { 'X-Forwarded-Host': host } })
    return res.ok ? await res.text() : undefined
  } catch {
    return undefined
  }
}

async function crossTenantViolations(schoolDid: string): Promise<AuditViolation[]> {
  const out: AuditViolation[] = []
  const db = getDb()
  const knownSchools = new Set((await listSchools().catch(() => [])).map((row) => row.did))

  /**
   * ASSERTION 1 IS THE LEGACY SCHOOL'S, ONCE — not every school's, three times.
   *
   * An unstamped row (`school_did = ''`) belongs to the LEGACY school and to no other:
   * `lib/school-scope.ts` widens the predicate to include `''` for that school alone. An
   * orphan row naming a school that is not in `fs_school` belongs to nobody, which makes
   * it the deployment's own problem — the same audit. Reporting either under every school
   * in the loop would say the same thing N times and imply Denver had rows it does not.
   */
  const legacy = legacySchoolDid()
  const ownsUnstamped = !legacy || schoolDid === legacy
  for (const table of ownsUnstamped ? SCOPED_TABLES : []) {
    let rows: Array<{ school_did: string; n: number }>
    try {
      const result = await db.execute(
        sql.raw(`select school_did, count(*)::int as n from ${table} group by school_did`),
      )
      rows = (result.rows ?? result) as Array<{ school_did: string; n: number }>
    } catch {
      // A table this deployment has not got (an older migration state). Not a violation.
      continue
    }
    for (const row of rows) {
      const value = row.school_did ?? ''
      if (knownSchools.has(value)) continue
      out.push({
        host: '(app-side)',
        repoDid: schoolDid,
        collection: table,
        rkey: `${row.n} row(s)`,
        path: 'school_did',
        namedDid: value === '' ? '<unstamped>' : value,
        reason:
          value === ''
            ? `${table} still holds unstamped rows — run \`backfill-school\` before a second school exists (MS §10.3)`
            : `${table} names a school_did that is not in fs_school`,
      })
    }
  }

  // ---- assertion 2, which IS per school: this school's own public surfaces.
  const host = (await canonicalHostsFor([schoolDid]).catch(() => new Map<string, string>())).get(schoolDid)
  if (!host) return out
  const base = config().APPVIEW_PUBLIC_URL || 'http://localhost:4000'
  const month = new Date().toISOString().slice(0, 7)
  const authority = config().AUTHORITY_DID
  let probed = 0
  for (const path of PUBLIC_PROBES(month)) {
    const body = await probePublic(base, host, path)
    if (body === undefined) continue
    probed += 1
    const named = [...new Set(namedDids(body).map((n) => n.did))].filter(
      (did) => did !== schoolDid && did !== authority && !knownSchools.has(did),
    )
    if (named.length === 0) continue
    const rows = await db
      .select({ did: membership.did, schoolDid: membership.schoolDid })
      .from(membership)
      .where(inArray(membership.did, named))
    const schoolsOf = new Map<string, Set<string>>()
    for (const row of rows) {
      const set = schoolsOf.get(row.did) ?? new Set<string>()
      set.add(row.schoolDid)
      schoolsOf.set(row.did, set)
    }
    for (const did of named) {
      const belongs = schoolsOf.get(did)
      // No membership row at all is not a cross-tenant leak: it is a pre-tenancy member,
      // or somebody from a peer PDS whose public record we merely index.
      if (!belongs || belongs.size === 0 || belongs.has(schoolDid)) continue
      out.push({
        host: '(app-side)',
        repoDid: schoolDid,
        collection: `GET ${path}`,
        rkey: '-',
        path: 'response body',
        namedDid: did,
        reason: 'a public response on this school’s host names a DID whose only membership is in another school (MS §10.3)',
      })
    }
  }
  if (probed === 0) {
    console.warn(
      `    !!  nothing answered at ${base}: MS §10.3's public-response assertion did not run for ${shortDid(schoolDid)}. ` +
        'Start the AppView (or set APPVIEW_PUBLIC_URL) and re-run.',
    )
  }
  return out
}

export async function runPrivacyAudit(options?: {
  hosts?: string[]
  /**
   * Audit ONE school (MS §10.3). Its own repo plus the repos of everyone who has ever
   * been a member of it, and the two cross-tenant assertions below run for it. Omit it —
   * and the CLI loops every school instead, one report each.
   */
  schoolDid?: string
  /** Audit only these repos. The smoke test scopes itself to the repos its own run wrote. */
  repos?: string[]
}): Promise<AuditReport> {
  const c = config()
  const hosts = [...new Set((options?.hosts ?? [c.PDS_URL, ...c.PEER_PDS_HOSTS]).map((h) => h.replace(/\/$/, '')))]
  const scopedToSchool = Boolean(options?.schoolDid) && !options?.repos
  const explicitRepos = options?.repos ?? (scopedToSchool ? await reposOfSchool(options!.schoolDid!) : undefined)
  const only = explicitRepos ? new Set(explicitRepos) : undefined

  const surveyed = new Map<string, Array<{ did: string; collections: string[] }>>()
  const schoolDids = new Set<string>()
  for (const host of hosts) {
    const repos = await surveyHost(host, only)
    surveyed.set(host, repos)
    for (const repo of repos) if (repo.collections.includes(NSID.school)) schoolDids.add(repo.did)
  }
  // A school named in a scoped run may live outside the scope; keep the configured one.
  if (options?.schoolDid ?? c.SCHOOL_DID) schoolDids.add(options?.schoolDid ?? c.SCHOOL_DID)
  // Every school we HOST is a school whether or not this run read its repo — a scoped run
  // must still know that a DID it meets is an institution, not a person (exemption 4).
  for (const row of await listSchools().catch(() => [])) schoolDids.add(row.did)
  const facts = await consentFacts(schoolDids)

  const cells: AuditCell[] = []
  const violations: AuditViolation[] = []
  let repos = 0
  let records = 0

  for (const host of hosts) {
    const inventory = surveyed.get(host) ?? []
    repos += inventory.length
    await mapLimit(inventory, 8, async ({ did, collections }) => {
      for (const collection of collections) {
        if (!(AUDITED_COLLECTIONS as readonly string[]).includes(collection)) continue
        const found = await allRecords(host, did, collection)
        records += found.length
        const cell: AuditCell = { host, repoDid: did, collection, count: found.length, namedOthers: 0, allowed: 0, violations: 0, textMentions: 0 }
        for (const record of found) {
          const rkey = record.uri.split('/').pop() ?? '?'
          // Author == subject is always fine: a DID in one's own repo is self-description.
          const others = namedDids(record.value).filter((n) => n.did !== did)
          if (others.length > 0) cell.namedOthers += 1
          for (const named of others) {
            const verdict = verdictFor(collection, did, named, facts)
            if (verdict.allowed) {
              cell.allowed += 1
            } else {
              cell.violations += 1
              violations.push({ host, repoDid: did, collection, rkey, path: named.path, namedDid: named.did, reason: verdict.reason })
            }
          }

          // F1: a handle or a DID mentioned in a free-text field. No exemptions — see
          // `textMentions`. The snippet is NEVER reported; an audit that reprints what it
          // found would be its own violation.
          for (const mention of textMentions(record.value)) {
            cell.textMentions += 1
            cell.violations += 1
            violations.push({
              host,
              repoDid: did,
              collection,
              rkey,
              path: mention.path,
              namedDid: '<free text>',
              reason: `free text names a ${mention.kind} (at ${mention.path}) — a public field a human wrote`,
            })
          }
        }
        cells.push(cell)
      }
    })
  }

  /**
   * MS §10.3's two cross-tenant assertions, for the school this run is about.
   *
   * Only for a run that is ACTUALLY about one school — not for `scripts/smoke.ts`, which
   * passes `schoolDid` alongside an explicit `repos` list to narrow the record sweep to
   * the handful of repos its own run just wrote. Both assertions are about the whole
   * deployment (every scoped table; every public response on that school's host), so
   * running them there would judge a throwaway smoke school on the state of the box.
   */
  const crossTenant = scopedToSchool ? await crossTenantViolations(options!.schoolDid!) : []
  violations.push(...crossTenant)

  cells.sort((a, b) => a.collection.localeCompare(b.collection) || a.repoDid.localeCompare(b.repoDid))
  return {
    hosts,
    repos,
    records,
    cells,
    violations,
    crossTenant,
    schoolDid: options?.schoolDid,
    attestationConsentTable: facts.attestationConsentTable,
    publishRoles: Object.fromEntries(facts.publishRoles),
  }
}

/** The table, as printed by the script and by the smoke test. */
export function formatReport(report: AuditReport): string {
  const lines: string[] = []
  const head = ['collection', 'repo', 'count', 'named', 'allowed', 'text', 'viol']
  const rows = report.cells.map((cell) => [
    cell.collection,
    shortDid(cell.repoDid),
    String(cell.count),
    String(cell.namedOthers),
    String(cell.allowed),
    String(cell.textMentions),
    String(cell.violations),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const render = (cols: string[]) => cols.map((col, i) => col.padEnd(widths[i]!)).join('  ')
  lines.push(render(head))
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '))
  if (rows.length === 0) lines.push('(no repo on any audited host holds any of these collections)')
  for (const row of rows) lines.push(render(row))
  lines.push('')
  const textFlagged = report.cells.reduce((n, cell) => n + cell.textMentions, 0)
  lines.push(
    `hosts ${report.hosts.length} · repos ${report.repos} · audited collections ${AUDITED_COLLECTIONS.length} · ` +
      `records ${report.records} · free-text mentions ${textFlagged} · violations ${report.violations.length}`,
  )
  const publishRoles = Object.entries(report.publishRoles)
    .map(([did, on]) => `${shortDid(did)}=${on}`)
    .join(' ')
  lines.push(`policy.publishRoles per school: ${publishRoles || '(none)'} · attestation double-opt-in table: none in v1`)
  if (report.schoolDid) {
    lines.push(
      `cross-tenant assertions (MS §10.3) for ${shortDid(report.schoolDid)}: ` +
        `${report.crossTenant.length === 0 ? 'OK' : `${report.crossTenant.length} failure(s)`}`,
    )
  }
  if (report.violations.length > 0) {
    lines.push('')
    for (const v of report.violations) {
      lines.push(`  VIOLATION  ${v.collection}  repo ${shortDid(v.repoDid)}  rkey ${v.rkey}`)
      lines.push(`             names ${shortDid(v.namedDid)} at "${v.path}" — ${v.reason}`)
    }
  }
  return lines.join('\n')
}

/** `--school=<did>` (or `--school <did>`). Absent means "every school this AppView hosts". */
export function parseSchoolFlag(argv: readonly string[]): string | undefined {
  const flag = argv.find((a) => a === '--school' || a.startsWith('--school='))
  if (!flag) return undefined
  const value = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : (argv[argv.indexOf(flag) + 1] ?? '')
  const did = value.trim()
  if (!did.startsWith('did:')) throw new Error('--school takes a school DID (did:plc:…)')
  return did
}

if (isMain(import.meta.url)) {
  console.log('Free School privacy audit — public records that name somebody else\n')
  const asked = parseSchoolFlag(process.argv.slice(2))
  /**
   * PER SCHOOL, AND IT LOOPS (MS §10.3). Each school gets its own report over its own
   * repos with its own consent gates, because "is this record consented" has a different
   * answer in every city. A deployment with no `fs_school` rows at all falls back to the
   * whole-PDS audit this script has always done.
   */
  const schools = asked ? [asked] : (await listSchools().catch(() => [])).map((row) => row.did)
  /**
   * A scoped run reads only that school's repos, so a repo belonging to NO school — an
   * abandoned test school, a member who was purged from every roster but whose records are
   * still on the PDS — would slip out of the audit entirely. So an unscoped run ends with
   * the whole-PDS sweep this script has always done, after the per-school reports.
   */
  const reports: Array<string | undefined> = schools.length > 0 && !asked ? [...schools, undefined] : schools.length > 0 ? schools : [undefined]
  let total = 0
  for (const schoolDid of reports) {
    console.log(
      schoolDid
        ? `── school ${shortDid(schoolDid)} ${'─'.repeat(40)}\n`
        : `── every repo on every audited host ${'─'.repeat(24)}\n`,
    )
    const report = await runPrivacyAudit(schoolDid ? { schoolDid } : undefined)
    console.log(formatReport(report))
    console.log('')
    total += report.violations.length
  }
  console.log(total === 0 ? 'PRIVACY AUDIT OK' : `PRIVACY AUDIT FAILED — ${total} violation(s)`)
  await closeDb().catch(() => {})
  if (total > 0) process.exitCode = 1
}
