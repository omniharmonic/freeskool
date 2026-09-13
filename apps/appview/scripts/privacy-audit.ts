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
 *      BOTH consent gates hold: the school policy has `thresholds.publishRoles === true`
 *      AND that member opted in app-side (`fs_member_prefs.public_role`, written by
 *      `PUT /api/me/public-role`). This is the one place a derived role reaches the
 *      protocol — see `src/lib/membership-claims.ts`, which enforces the same two gates
 *      plus `role >= Host` before writing.
 *   2. `freeschool.draft.moderationAction` in a SCHOOL's repo may name STEWARD DIDs in
 *      `actors[]` — "Stewards who approved", per that lexicon — because a steward consents
 *      by acting, and who approved a removal is the point of the record. Any other field is
 *      not exempt: in particular `subjectDid`, the account acted on, is a violation —
 *      moderation subjects and reasons are never public (CLAUDE.md; plan §3 G, "public
 *      projection shows enum only"). `approvals[].stewardDid` is accepted under the same
 *      rule for any future record that uses that shape.
 *   3. `freeschool.draft.skillAttestation` would be allowed on a recorded app-side DOUBLE
 *      opt-in (attester and subject). **No such table exists in v1** — nothing in the
 *      AppView writes an attestation at all (see the Task 2 deferral "nothing writes
 *      skillAttestation yet") — so every attestation naming another DID FAILS here, and the
 *      report says why. Whoever adds attestations adds the consent table with them.
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
 * Nothing else is exempt.
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
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { getDb, closeDb } from '../src/db/index.js'
import { memberPrefs } from '../src/db/schema.js'
import { getThresholds } from '../src/lib/policy.js'
import { NSID } from '../src/lexicons/nsids.js'
import { isMain } from '../src/lib/is-main.js'

/** The collections a stranger could read that could name somebody else. */
export const AUDITED_COLLECTIONS = [
  NSID.rsvp,
  NSID.attendance,
  NSID.hostFeedback,
  NSID.membership,
  NSID.moderationAction,
  NSID.skillAttestation,
  NSID.approval,
] as const

const DID_EXACT = /^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/
const AT_URI_DID = /^at:\/\/(did:[a-z0-9]+:[a-zA-Z0-9._:%-]+)(\/|$)/

export interface NamedDid {
  /** Dotted path inside the record value, e.g. `approvals.0.stewardDid`. */
  path: string
  did: string
}

/**
 * Every DID named anywhere in a record value, with the path that named it. Exported for
 * the tests: this is the whole definition of "names a DID".
 */
export function namedDids(value: unknown, path = ''): NamedDid[] {
  if (typeof value === 'string') {
    if (DID_EXACT.test(value)) return [{ path, did: value }]
    const uri = AT_URI_DID.exec(value)
    return uri ? [{ path, did: uri[1]! }] : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => namedDids(item, path ? `${path}.${i}` : String(i)))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, v]) => namedDids(v, path ? `${path}.${key}` : key))
  }
  return []
}

export interface ConsentFacts {
  /** Every repo on an audited host that holds a `freeschool.draft.school` record. */
  schoolDids: Set<string>
  /** The school policy's `thresholds.publishRoles` (the home school's; see `runPrivacyAudit`). */
  publishRoles: boolean
  /** DIDs with `fs_member_prefs.public_role = true`. */
  publicRoleOptIn: Set<string>
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
    if (!facts.publishRoles) return { allowed: false, reason: 'membership claim but policy.publishRoles is off' }
    if (!facts.publicRoleOptIn.has(named.did)) {
      return { allowed: false, reason: 'membership claim without the member’s public-role opt-in' }
    }
    return { allowed: true, reason: 'publishRoles + member opt-in' }
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

  return { allowed: false, reason: `no exemption covers ${collection}` }
}

export interface AuditCell {
  host: string
  repoDid: string
  collection: string
  count: number
  namedOthers: number
  allowed: number
  violations: number
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
  violations: AuditViolation[]
  /** Recorded in the report so a future run can tell why attestations failed. */
  attestationConsentTable: boolean
  publishRoles: boolean
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

async function consentFacts(schoolDid: string, schoolDids: Set<string>): Promise<ConsentFacts> {
  let publishRoles = false
  const publicRoleOptIn = new Set<string>()
  try {
    if (schoolDid) publishRoles = (await getThresholds(schoolDid)).publishRoles ?? false
    const prefs = await getDb().select({ did: memberPrefs.did }).from(memberPrefs).where(eq(memberPrefs.publicRole, true))
    for (const row of prefs) publicRoleOptIn.add(row.did)
  } catch {
    // FAILS CLOSED: with no way to check consent, nothing is exempt.
    publishRoles = false
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

export async function runPrivacyAudit(options?: {
  hosts?: string[]
  schoolDid?: string
  /** Audit only these repos. The smoke test scopes itself to the repos its own run wrote. */
  repos?: string[]
}): Promise<AuditReport> {
  const c = config()
  const hosts = [...new Set((options?.hosts ?? [c.PDS_URL, ...c.PEER_PDS_HOSTS]).map((h) => h.replace(/\/$/, '')))]
  const only = options?.repos ? new Set(options.repos) : undefined

  const surveyed = new Map<string, Array<{ did: string; collections: string[] }>>()
  const schoolDids = new Set<string>()
  for (const host of hosts) {
    const repos = await surveyHost(host, only)
    surveyed.set(host, repos)
    for (const repo of repos) if (repo.collections.includes(NSID.school)) schoolDids.add(repo.did)
  }
  // A school named in a scoped run may live outside the scope; keep the configured one.
  if (options?.schoolDid ?? c.SCHOOL_DID) schoolDids.add(options?.schoolDid ?? c.SCHOOL_DID)
  const facts = await consentFacts(options?.schoolDid ?? c.SCHOOL_DID, schoolDids)

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
        const cell: AuditCell = { host, repoDid: did, collection, count: found.length, namedOthers: 0, allowed: 0, violations: 0 }
        for (const record of found) {
          const others = namedDids(record.value).filter((n) => n.did !== did)
          if (others.length > 0) cell.namedOthers += 1
          for (const named of others) {
            const verdict = verdictFor(collection, did, named, facts)
            if (verdict.allowed) {
              cell.allowed += 1
            } else {
              cell.violations += 1
              violations.push({
                host,
                repoDid: did,
                collection,
                rkey: record.uri.split('/').pop() ?? '?',
                path: named.path,
                namedDid: named.did,
                reason: verdict.reason,
              })
            }
          }
        }
        cells.push(cell)
      }
    })
  }

  cells.sort((a, b) => a.collection.localeCompare(b.collection) || a.repoDid.localeCompare(b.repoDid))
  return {
    hosts,
    repos,
    records,
    cells,
    violations,
    attestationConsentTable: facts.attestationConsentTable,
    publishRoles: facts.publishRoles,
  }
}

/** The table, as printed by the script and by the smoke test. */
export function formatReport(report: AuditReport): string {
  const lines: string[] = []
  const head = ['collection', 'repo', 'count', 'named', 'allowed', 'viol']
  const rows = report.cells.map((cell) => [
    cell.collection,
    shortDid(cell.repoDid),
    String(cell.count),
    String(cell.namedOthers),
    String(cell.allowed),
    String(cell.violations),
  ])
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)))
  const render = (cols: string[]) => cols.map((col, i) => col.padEnd(widths[i]!)).join('  ')
  lines.push(render(head))
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '))
  if (rows.length === 0) lines.push('(no repo on any audited host holds any of these collections)')
  for (const row of rows) lines.push(render(row))
  lines.push('')
  lines.push(
    `hosts ${report.hosts.length} · repos ${report.repos} · audited collections ${AUDITED_COLLECTIONS.length} · ` +
      `records ${report.records} · violations ${report.violations.length}`,
  )
  lines.push(`policy.publishRoles=${report.publishRoles} · attestation double-opt-in table: none in v1`)
  if (report.violations.length > 0) {
    lines.push('')
    for (const v of report.violations) {
      lines.push(`  VIOLATION  ${v.collection}  repo ${shortDid(v.repoDid)}  rkey ${v.rkey}`)
      lines.push(`             names ${shortDid(v.namedDid)} at "${v.path}" — ${v.reason}`)
    }
  }
  return lines.join('\n')
}

if (isMain(import.meta.url)) {
  console.log('Free School privacy audit — public records that name somebody else\n')
  const report = await runPrivacyAudit()
  console.log(formatReport(report))
  console.log(
    report.violations.length === 0
      ? '\nPRIVACY AUDIT OK'
      : `\nPRIVACY AUDIT FAILED — ${report.violations.length} violation(s)`,
  )
  await closeDb().catch(() => {})
  if (report.violations.length > 0) process.exitCode = 1
}
