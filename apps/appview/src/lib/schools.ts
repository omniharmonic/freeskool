/**
 * The school registry: one row per school this AppView hosts (`fs_school`), the hosts
 * that resolve to it (`fs_school_domain`), and the wrapped app password it acts with
 * (`fs_school_credential`).
 *
 * v1 has exactly one school — Boulder — and it is configured in the environment
 * (`SCHOOL_DID`, `SCHOOL_HANDLE`, `SCHOOL_APP_PASSWORD`), not in the database. This
 * module is the bridge: `ensureLegacySchoolRow()` puts that env-configured school into
 * the table at every boot, so from Task 3 onwards the TABLE is what code reads and the
 * env vars are only the legacy fallback. `legacySchoolDid()` is the single place that
 * still reads `config().SCHOOL_DID`, so Appendix A's read sites have exactly one thing
 * left to point at.
 *
 * Nothing here changes behaviour on its own: with `MULTI_SCHOOL=0` the one row this
 * writes is the school every request already meant.
 */
import { and, eq, inArray, ne } from 'drizzle-orm'
import { AtpAgent } from '@atproto/api'
import { defaultThresholds } from '@freeschool/shared'
import { getDb, type Db } from '../db/index.js'
import { member, school, schoolCredential, schoolDomain } from '../db/schema.js'
import { config } from '../config.js'
import { randomPassword, wrapSecret } from './crypto.js'
import { HANDLE_PREFIX_RE, RESERVED_LABELS } from './handles.js'
import { tid } from './ids.js'
import { createAccount, createInviteCode, resolveHandle } from './pds.js'
import { seedSkillTiers } from './skill-tiers.js'
import { NSID } from '../lexicons/nsids.js'
import { describeError, log } from './logging.js'

export type School = typeof school.$inferSelect
export type SchoolDomain = typeof schoolDomain.$inferSelect

/** The env-configured school. `''` when this deployment has not been bootstrapped yet. */
export function legacySchoolDid(): string {
  return config().SCHOOL_DID
}

export async function getSchool(did: string, db: Db = getDb()): Promise<School | undefined> {
  if (!did) return undefined
  const [row] = await db.select().from(school).where(eq(school.did, did)).limit(1)
  return row
}

/** Every school this AppView hosts, oldest first. Public-safe fields only — see MS §8. */
export async function listSchools(db: Db = getDb()): Promise<School[]> {
  return db.select().from(school).orderBy(school.createdAt)
}

/**
 * Host → school. The `Host` header is case-insensitive and may carry a port; both are
 * normalised away before the lookup, so `Boulder.Freeskool.xyz:443` finds the row
 * written as `boulder.freeskool.xyz`.
 */
export async function schoolByHost(host: string, db: Db = getDb()): Promise<School | undefined> {
  const normalized = normalizeHost(host)
  if (!normalized) return undefined
  const [row] = await db
    .select({ school })
    .from(schoolDomain)
    .innerJoin(school, eq(school.did, schoolDomain.schoolDid))
    .where(eq(schoolDomain.host, normalized))
    .limit(1)
  return row?.school
}

/**
 * DID → the host that school is SERVED FROM, for many schools at once (one pair of
 * queries, not N): what `POST /api/auth/switch-school` hands the PWA to navigate to, and
 * what `GET /api/auth/me` lists beside each school.
 *
 * The rule itself lives in `canonicalHostFor` below — canonical row, else any alias, else
 * the host the school WOULD be served from. A school that is missing from the map has no
 * row in `fs_school`; a school that is present always has a non-empty host, because a
 * picker entry that cannot name where to go is a dead button.
 */
export async function canonicalHostsFor(schoolDids: string[], db: Db = getDb()): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (schoolDids.length === 0) return out
  const [rows, domains] = await Promise.all([
    db.select().from(school).where(inArray(school.did, schoolDids)),
    db.select().from(schoolDomain).where(inArray(schoolDomain.schoolDid, schoolDids)),
  ])
  for (const row of rows) out.set(row.did, canonicalHostFor(row, domains))
  return out
}

/** `canonicalHostsFor` for one school; `''` when there is no such school. */
export async function schoolHostFor(schoolDid: string, db: Db = getDb()): Promise<string> {
  if (!schoolDid) return ''
  return (await canonicalHostsFor([schoolDid], db)).get(schoolDid) ?? ''
}

export function normalizeHost(host: string): string {
  const trimmed = (host ?? '').trim().toLowerCase()
  if (!trimmed) return ''
  // Strip a port, but not the colons of a bracketed IPv6 literal.
  if (trimmed.startsWith('[')) return trimmed.replace(/\]:\d+$/, ']')
  return trimmed.replace(/:\d+$/, '')
}

/**
 * The subdomain label the legacy school is (or would be) served from: the first label of
 * its handle, `boulder` in `boulder.freeskool.xyz`. This is the value the reserved-label
 * list protects and the one `<label>.<suffix>` alias is built from.
 */
export function legacySchoolLabel(handle = config().SCHOOL_HANDLE): string {
  const first = normalizeHost(handle).split('.')[0] ?? ''
  return /^[a-z0-9][a-z0-9-]*$/.test(first) ? first : 'school'
}

/**
 * The host this deployment is served from — the canonical domain of the legacy school.
 * Taken from `webPublicUrl` rather than a new env var, because that URL is already the
 * one invite links, the OAuth client id and the newsletter are built from.
 */
export function legacyCanonicalHost(): string {
  try {
    return normalizeHost(new URL(config().webPublicUrl).hostname)
  } catch {
    return ''
  }
}

/**
 * Both hosts the legacy school answers on: the apex it is served from today (canonical —
 * "the apex IS Boulder, for now", MS §9 B) and the `<label>.<apex>` subdomain the
 * federation phase moves it to (alias). Deduplicated, so a deployment already served
 * from `boulder.freeskool.xyz` gets one row, not two.
 */
export function legacySchoolHosts(): { host: string; kind: 'canonical' | 'alias' }[] {
  const canonical = legacyCanonicalHost()
  if (!canonical) return []
  const out: { host: string; kind: 'canonical' | 'alias' }[] = [{ host: canonical, kind: 'canonical' }]
  const alias = `${legacySchoolLabel()}.${canonical}`
  if (alias !== canonical && !canonical.startsWith(`${legacySchoolLabel()}.`)) {
    out.push({ host: alias, kind: 'alias' })
  }
  return out
}

export interface EnsureLegacySchoolOptions {
  name?: string
  city?: string
}

/**
 * Put the env-configured school into `fs_school` (and its hosts into `fs_school_domain`)
 * if it is not already there. Called at boot right after the migrations, and by
 * `scripts/backfill-school.ts`.
 *
 * Idempotent by construction: every write is `ON CONFLICT DO NOTHING`, so a second run —
 * or a row a steward has since edited — is left exactly as it is. Returns the DID it
 * ensured, or `undefined` when `SCHOOL_DID` is unset (a deployment that has not run
 * `create-school` yet: nothing to do, and no reason to fail the boot).
 */
export async function ensureLegacySchoolRow(
  options: EnsureLegacySchoolOptions = {},
  db: Db = getDb(),
): Promise<string | undefined> {
  const did = legacySchoolDid()
  if (!did) return undefined
  const label = legacySchoolLabel()
  await db
    .insert(school)
    .values({
      did,
      label,
      name: options.name || defaultSchoolName(label),
      city: options.city || null,
      handle: config().SCHOOL_HANDLE || label,
      creationState: 'active',
    })
    .onConflictDoNothing()

  const hosts = legacySchoolHosts()
  if (hosts.length > 0) {
    await db
      .insert(schoolDomain)
      .values(hosts.map((h) => ({ host: h.host, schoolDid: did, kind: h.kind })))
      .onConflictDoNothing()
  }
  return did
}

function defaultSchoolName(label: string): string {
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} Free School`
}

/* ─────────────────────────────── creating a school ────────────────────────────── */

/**
 * ONBOARDING A NEW CITY (MS §8, spec ruling 1).
 *
 * `scripts/create-school.ts` used to be the whole flow; this is that flow as a library
 * so the script and `POST /api/schools` run the SAME code. The gate is the caller's:
 * ruling 1 is `SCHOOL_CREATION=closed`, so the only two callers are an operator on the
 * host and an operator-token request.
 *
 * The steps, in order, are MS §8's:
 *
 *   1. the label is checked against `RESERVED_LABELS`, against every school already on
 *      this deployment, and against every host already routed here;
 *   2. the account is minted on the shared PDS with an invite code, handle
 *      `<label>.<PDS_HANDLE_DOMAIN>` (ruling 3 moves that domain to
 *      `freeskool.directory`; nothing here cares which domain it is);
 *   3. an app password is minted — it is what the AppView holds, never the account
 *      password — and wrapped into `fs_school_credential` under `CUSTODY_KEYS`;
 *   4. the policy record, then the school record pointing at it, are written with the
 *      school's OWN session. This is the one documented exception to `SchoolActorPort`
 *      (CLAUDE.md): the port authorizes against a policy record that does not exist yet,
 *      and bootstrap is the only moment that is true;
 *   5. the founder becomes the school's first steward, and a member of it;
 *   6. `<label>.<SCHOOL_DOMAIN_SUFFIX>` is written canonical, so the edge answers for it
 *      on the next request with no reload and no deploy;
 *   7. skill tiers are seeded (they are global, so this is a no-op after the first city).
 *
 * NOT IDEMPOTENT BY DEFAULT: a second call for a label that already exists is
 * `SchoolExists` (409), because "create" arriving twice over HTTP is a mistake, not an
 * instruction. The script's documented re-run — "reuses that DID and only creates a
 * fresh app password" — is the `accountPassword` option, which is never set from HTTP.
 */
/** `http/app.ts#onError` renders `status`/`code`; `routes/schools.ts` relies on it. */
export class SchoolCreationError extends Error {
  constructor(
    readonly code: 'SchoolExists' | 'InvalidLabel' | 'ReservedLabel',
    message: string,
    readonly status: 400 | 409 = code === 'SchoolExists' ? 409 : 400,
  ) {
    super(message)
    this.name = 'SchoolCreationError'
  }
}

/**
 * `boulder` and `denver` are in `RESERVED_LABELS` precisely BECAUSE they are cities that
 * will exist (`lib/handles.ts` says so in as many words): the list stops a MEMBER taking
 * a label the edge may hand to a school, and a school taking it is the thing it is being
 * held for. Refusing them here would make `createSchool({ label: 'denver' })` — the
 * worked example in MS §8 and in this phase's own acceptance criteria — impossible.
 *
 * Every other entry is infrastructure (`admin`, `pds`, `api`, `www`…) and is refused: a
 * school on `api.freeskool.xyz` would shadow a name the deployment itself answers for.
 * Whether a city label is FREE is the duplicate check's business, two lines below.
 */
const CITY_LABELS_HELD_FOR_SCHOOLS: ReadonlySet<string> = new Set(['boulder', 'denver'])

/** The labels no school may take. See the note above for why it is not the whole list. */
export function reservedForSchoolCreation(): ReadonlySet<string> {
  return new Set(RESERVED_LABELS.filter((l) => !CITY_LABELS_HELD_FOR_SCHOOLS.has(l)))
}

/** The school's own bootstrap session — only `createSchool` ever holds one. */
export interface SchoolBootstrapSession {
  createAppPassword(name: string): Promise<string>
  putRecord(input: {
    repo: string
    collection: string
    rkey: string
    record: Record<string, unknown>
  }): Promise<{ uri: string; cid: string }>
}

/**
 * The PDS operations school creation needs, as a seam. The default implementation is the
 * real `lib/pds.ts`; `test/schools-lifecycle.test.ts` passes a fake, because a unit test
 * must never mint a real DID on the production PLC (CLAUDE.md: dev accounts mint real DIDs).
 */
export interface SchoolBootstrapPds {
  resolveHandle(handle: string): Promise<string | null>
  createInviteCode(): Promise<string>
  createAccount(input: { email: string; handle: string; password: string; inviteCode: string }): Promise<{ did: string }>
  login(identifier: string, password: string): Promise<SchoolBootstrapSession>
}

export function livePds(service = config().PDS_URL): SchoolBootstrapPds {
  return {
    resolveHandle: (handle) => resolveHandle(handle, service),
    createInviteCode: () => createInviteCode(1),
    createAccount: (input) => createAccount(input),
    async login(identifier, password) {
      const agent = new AtpAgent({ service })
      await agent.login({ identifier, password })
      return {
        async createAppPassword(name) {
          const res = await agent.com.atproto.server.createAppPassword({ name })
          return res.data.password
        },
        async putRecord({ repo, collection, rkey, record }) {
          const res = await agent.com.atproto.repo.putRecord({ repo, collection, rkey, record, validate: false })
          return { uri: res.data.uri, cid: res.data.cid }
        },
      }
    },
  }
}

/**
 * Process-wide override, the same seam `setSchoolActor` is: when set, EVERY creation uses
 * it. Tests and scripts only — `POST /api/schools` has nowhere to pass a `pds` of its own,
 * and a route that could would be a route that could be told which PDS to mint on.
 */
let bootstrapPds: SchoolBootstrapPds | undefined

export function setSchoolBootstrapPds(p: SchoolBootstrapPds | undefined): void {
  bootstrapPds = p
}

export interface CreateSchoolInput {
  /** The subdomain label: `denver`. Lowercased and trimmed before anything looks at it. */
  label: string
  name: string
  /** Human region — `'Denver, Colorado'`. Stored as `fs_school.city`, published as `region`. */
  city?: string
  /** Defaults to `PDS_HANDLE_DOMAIN`. Ruling 4 refuses per-school domains in this phase. */
  handleDomain?: string
  /** The founder: first steward and first member. Optional — the operator may appoint later. */
  founderDid?: string
  /** Who authorized this creation, for the log line and `created_by_did`. Never public. */
  operator: string
  email?: string
  /**
   * ADOPT an account that already exists instead of refusing (the script's
   * `SCHOOL_ACCOUNT_PASSWORD` path). Never set from HTTP — `POST /api/schools` is
   * create-only on purpose.
   */
  accountPassword?: string
  pds?: SchoolBootstrapPds
  db?: Db
  /** Off in tests that do not care; the seed is global and idempotent. */
  seedTiers?: boolean
}

export interface CreateSchoolResult {
  did: string
  label: string
  name: string
  city: string | null
  handle: string
  /** The canonical host written to `fs_school_domain`. */
  host: string
  /** The app password we now hold. Printed by the script; NEVER returned over HTTP. */
  appPassword: string
  schoolUri: string
  policyUri: string
  /** True when an existing PDS account was adopted rather than minted. */
  reused: boolean
}

/** The default policy text, with this school's name substituted (MS §8 "Policy defaults"). */
export function defaultPolicyText(): string {
  return `Free School is free. Anyone can teach, anyone can learn, nobody pays.

If you say you are part of Free School, you are part of Free School. Hosting is open from
day one: you do not need permission, a credential, or a vouch to offer a class.

What we ask:
  - Say what you actually know. "I am still learning this too" is a fine thing to write.
  - Show up, or tell people you cannot.
  - Do not use a class to sell, recruit, or proselytise.
  - Somebody's home is not a public address. Share a location only with people who are coming.

Stewards can remove a listing from the calendar, and two of them must agree to do it. They
cannot edit or delete anything in your repository — what you wrote stays yours.`
}

export async function createSchool(input: CreateSchoolInput): Promise<CreateSchoolResult> {
  const c = config()
  const db = input.db ?? getDb()
  const pds = input.pds ?? bootstrapPds ?? livePds()
  const label = input.label.trim().toLowerCase()

  if (!HANDLE_PREFIX_RE.test(label)) {
    throw new SchoolCreationError(
      'InvalidLabel',
      'a school label is 1 character, or 3-20 characters of a-z, 0-9 and - (not at either end)',
    )
  }
  if (reservedForSchoolCreation().has(label)) {
    throw new SchoolCreationError('ReservedLabel', `"${label}" is reserved`)
  }

  const name = input.name.trim()
  if (!name) throw new SchoolCreationError('InvalidLabel', 'a school needs a name')

  const handleDomain = (input.handleDomain ?? c.handleDomain).trim().toLowerCase().replace(/^\./, '')
  const handle = `${label}.${handleDomain}`
  const host = `${label}.${c.schoolDomainSuffix}`
  const adopting = Boolean(input.accountPassword)

  const [taken] = await db.select().from(school).where(eq(school.label, label)).limit(1)
  if (taken && !adopting) {
    throw new SchoolCreationError('SchoolExists', `a school already exists at "${label}"`)
  }
  // A host routed to a DIFFERENT school is a collision even when the label is free —
  // `fs_school_domain.host` is the primary key, and whoever owns it owns that origin.
  const [hostTaken] = await db
    .select({ schoolDid: schoolDomain.schoolDid })
    .from(schoolDomain)
    .where(and(eq(schoolDomain.host, host), taken ? ne(schoolDomain.schoolDid, taken.did) : undefined))
    .limit(1)
  if (hostTaken && !taken) throw new SchoolCreationError('SchoolExists', `${host} already serves a school`)

  /* the identity */
  let did = await pds.resolveHandle(handle)
  const reused = Boolean(did)
  if (did && !adopting) {
    throw new SchoolCreationError('SchoolExists', `${handle} is already registered on the PDS`)
  }
  let accountPassword = input.accountPassword ?? ''
  if (!did) {
    accountPassword = randomPassword(24)
    const account = await pds.createAccount({
      // The PDS rejects unroutable email domains, so the default is a real reserved one.
      email: input.email ?? `${handle.replace(/\./g, '-')}@example.org`,
      handle,
      password: accountPassword,
      inviteCode: await pds.createInviteCode(),
    })
    did = account.did
  }

  const session = await pds.login(handle, accountPassword)
  const appPassword = await session.createAppPassword(`appview-${Date.now()}`)

  /* the founding records — the one documented exception to `SchoolActorPort` */
  const now = new Date().toISOString()
  const policyRkey = tid()
  const policy = await session.putRecord({
    repo: did,
    collection: NSID.policy,
    rkey: policyRkey,
    record: {
      $type: NSID.policy,
      title: `${name} — how this works`,
      text: defaultPolicyText(),
      version: '1',
      effectiveAt: now,
      thresholds: defaultThresholds,
      createdAt: now,
    },
  })
  const record = await session.putRecord({
    repo: did,
    collection: NSID.school,
    rkey: 'self',
    record: {
      $type: NSID.school,
      name,
      description: 'A free, open skill-sharing school. Anyone can teach, anyone can learn.',
      region: input.city ?? '',
      policy: policy.uri,
      handleDomain,
      peers: [],
      tags: ['skillshare', 'free-school'],
      createdAt: now,
    },
  })

  /* the rows */
  const at = new Date()
  await db
    .insert(school)
    .values({
      did,
      label,
      name,
      city: input.city ?? null,
      handle,
      pdsUrl: c.PDS_URL,
      custody: 'app',
      createdByDid: input.founderDid ?? (input.operator.startsWith('did:') ? input.operator : null),
      creationState: 'active',
    })
    .onConflictDoUpdate({
      target: school.did,
      set: { label, name, city: input.city ?? null, handle, pdsUrl: c.PDS_URL, creationState: 'active' },
    })

  await db
    .insert(schoolDomain)
    // Minted under our own suffix, so it is verified the moment it is written — there is
    // nobody else's DNS to check.
    .values({ host, schoolDid: did, kind: 'canonical', verifiedAt: at })
    .onConflictDoNothing()

  const wrapped = wrapSecret(appPassword)
  await db
    .insert(schoolCredential)
    .values({
      schoolDid: did,
      identifier: handle,
      keyVersion: wrapped.keyVersion,
      appPasswordWrapped: wrapped.blob,
      rotatedAt: at,
    })
    .onConflictDoUpdate({
      target: schoolCredential.schoolDid,
      set: {
        identifier: handle,
        keyVersion: wrapped.keyVersion,
        appPasswordWrapped: wrapped.blob,
        rotatedAt: at,
        lastErrorAt: null,
      },
    })

  // The school DID is an `isOwnMember` fact too, and it never goes through
  // `createSession` (a school is never a browser session).
  await db
    .insert(member)
    .values({ did, door: 'custodial', firstSeenAt: at, lastSeenAt: at })
    .onConflictDoUpdate({ target: member.did, set: { lastSeenAt: at } })
    .catch((err) => log.warn('could not record the school as fs_member', { detail: describeError(err) }))

  /**
   * Dynamic, so the static import graph keeps its one-way edges: `school-actors.ts` and
   * `membership.ts` both import THIS module, and importing them back at the top would
   * make two cycles for the sake of three calls made once per city.
   */
  const { appointSteward, joinSchool } = await import('./membership.js')
  if (input.founderDid) {
    // MS §8 step 5: the person who created the school is its first steward. The gate in
    // ruling 1 (operator only) is what makes that safe.
    await appointSteward(input.founderDid, did, db)
    await joinSchool(input.founderDid, did, 'custodial', db)
  }

  const { actorFor, evictSchoolActor } = await import('./school-actors.js')
  // A port may already be cached for this DID from a failed earlier attempt; and priming
  // costs nothing (building a port touches neither the database nor the PDS).
  evictSchoolActor(did)
  await actorFor(did)

  if (input.seedTiers !== false) {
    await seedSkillTiers().catch((err) =>
      log.warn('skill-tier seed failed during school creation', { detail: describeError(err) }),
    )
  }

  // Never the DID, never the label of a school that is not public yet — R9.
  log.info('school created', { operator: input.operator, reused })

  return {
    did,
    label,
    name,
    city: input.city ?? null,
    handle,
    host,
    appPassword,
    schoolUri: record.uri,
    policyUri: policy.uri,
    reused,
  }
}

/* ──────────────────────────── the public school list ──────────────────────────── */

/**
 * What `GET /api/schools` serves. Ruling 7 is why there are NO COUNTS here: "nothing
 * about school B is served to a member of school A except public records", and "42
 * members" is not a public record — it is a fact about a roster that R9 keeps private.
 * A name, a city and the host you can visit is the whole of it.
 */
export interface PublicSchool {
  did: string
  label: string
  name: string
  city: string | null
  host: string
}

export async function listPublicSchools(db: Db = getDb()): Promise<PublicSchool[]> {
  const rows = await db.select().from(school).where(eq(school.creationState, 'active')).orderBy(school.createdAt)
  if (rows.length === 0) return []
  // One query for every school's hosts, rather than one lookup per row.
  const domains = await db.select().from(schoolDomain)
  return rows.map((s) => ({
    did: s.did,
    label: s.label,
    name: s.name,
    city: s.city,
    host: canonicalHostFor(s, domains),
  }))
}

/**
 * A school's front door: its canonical host, else any alias it answers on, else the host
 * MS §8 step 6 provisions for it (`<label>.<SCHOOL_DOMAIN_SUFFIX>`). The fallback is what
 * keeps the legacy school — whose `fs_school_domain` rows may predate the alias — and
 * every unit suite that seeds a school but no domain from getting a dead link.
 *
 * Synchronous and pure: `canonicalHostsFor` above is the batched, I/O half.
 */
export function canonicalHostFor(s: Pick<School, 'did' | 'label'>, domains: SchoolDomain[]): string {
  const mine = domains.filter((d) => d.schoolDid === s.did)
  const suffix = config().schoolDomainSuffix
  return (
    mine.find((d) => d.kind === 'canonical')?.host ??
    mine[0]?.host ??
    (s.label && suffix ? `${s.label}.${suffix}` : '')
  )
}
