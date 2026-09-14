/**
 * The ONE place the taxonomy authority's PDS session exists in this process.
 *
 * The 745 `freeschool.draft.skill` records live in the taxonomy authority's own repo
 * (seeded by `packages/lexicons/scripts/seed-skills.mjs`). A member's proposal
 * (`POST /api/skills`) and a steward's deprecate/move action
 * (`POST /api/admin/skills/:id/deprecate|move`) both write there AS the authority — so
 * this module owns `AUTHORITY_HANDLE`/`AUTHORITY_PASSWORD` the same way
 * `lib/school-actor.ts` owns `SCHOOL_APP_PASSWORD`: nothing outside it touches the
 * credential or holds the session.
 *
 * The session is a plain `@atproto/api` `AtpAgent` login (app password), cached in
 * module scope and re-established on a 401 / `ExpiredToken` — app-password sessions
 * expire, and `AppPasswordSchoolSession` in `lib/school-actor.ts` is the prior art for
 * that retry shape.
 *
 * Every write goes through `com.atproto.repo.putRecord` with `validate: false`, exactly
 * like the seed script: our `freeschool.draft.*` lexicons are not published to the
 * network, so the PDS cannot resolve them to validate against.
 */
import { AtpAgent } from '@atproto/api'
import { config } from '../config.js'

export interface SkillRecordInput {
  id: string
  label: string
  description?: string
  broader: string[]
  status: 'proposed' | 'canonical' | 'deprecated'
  createdAt: string
}

export interface AuthorityClient {
  putSkillRecord(record: SkillRecordInput): Promise<{ uri: string; cid: string }>
  /** `getRecord` → set `status: 'deprecated'` (+ `replacedBy` when given) → `putRecord`. */
  deprecateSkill(uri: string, replacedBy?: string): Promise<{ uri: string; cid: string }>
  /** `getRecord` → set `broader: [parentUri]` → `putRecord`. */
  moveSkill(uri: string, parentUri: string): Promise<{ uri: string; cid: string }>
}

function isAuthExpired(err: unknown): boolean {
  const e = err as { status?: number; error?: string }
  return e?.status === 400 || e?.status === 401 || e?.error === 'ExpiredToken'
}

function parseAtUri(uri: string): { did: string; collection: string; rkey: string } {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) throw new Error(`not an at-uri: ${uri}`)
  return { did: m[1]!, collection: m[2]!, rkey: m[3]! }
}

const SKILL_COLLECTION = 'freeschool.draft.skill'

class PdsAuthorityClient implements AuthorityClient {
  private agent: AtpAgent | undefined

  private async session(): Promise<AtpAgent> {
    if (this.agent) return this.agent
    const c = config()
    if (!c.AUTHORITY_HANDLE || !c.AUTHORITY_PASSWORD) {
      throw new Error('AUTHORITY_HANDLE / AUTHORITY_PASSWORD are not configured')
    }
    const agent = new AtpAgent({ service: c.PDS_URL })
    await agent.login({ identifier: c.AUTHORITY_HANDLE, password: c.AUTHORITY_PASSWORD })
    this.agent = agent
    return agent
  }

  /**
   * Every PDS call this client makes goes through here (review round 1, should-fix #3:
   * `put` and `getExisting` used to each carry their own copy of this). Get — or
   * establish — the session, run `fn`, and on a 401 / `ExpiredToken` — app-password
   * sessions expire — drop the cached session and retry exactly once with a fresh one.
   */
  private async withRetry<T>(fn: (agent: AtpAgent) => Promise<T>): Promise<T> {
    const run = async () => fn(await this.session())
    try {
      return await run()
    } catch (err) {
      if (isAuthExpired(err)) {
        this.agent = undefined
        return run()
      }
      throw err
    }
  }

  private async put(repo: string, rkey: string, record: unknown): Promise<{ uri: string; cid: string }> {
    return this.withRetry(async (agent) => {
      const res = await agent.com.atproto.repo.putRecord({
        repo,
        collection: SKILL_COLLECTION,
        rkey,
        record: record as Record<string, unknown>,
        validate: false,
      })
      return { uri: res.data.uri, cid: res.data.cid }
    })
  }

  async putSkillRecord(record: SkillRecordInput): Promise<{ uri: string; cid: string }> {
    return this.put(config().AUTHORITY_DID, record.id, {
      $type: SKILL_COLLECTION,
      id: record.id,
      label: record.label,
      ...(record.description ? { description: record.description } : {}),
      broader: record.broader,
      externalIds: {},
      status: record.status,
      createdAt: record.createdAt,
    })
  }

  private async getExisting(uri: string): Promise<{ did: string; rkey: string; value: Record<string, unknown> }> {
    const { did, collection, rkey } = parseAtUri(uri)
    return this.withRetry(async (agent) => {
      const res = await agent.com.atproto.repo.getRecord({ repo: did, collection, rkey })
      return { did, rkey, value: res.data.value as Record<string, unknown> }
    })
  }

  async deprecateSkill(uri: string, replacedBy?: string): Promise<{ uri: string; cid: string }> {
    const { did, rkey, value } = await this.getExisting(uri)
    return this.put(did, rkey, { ...value, status: 'deprecated', ...(replacedBy ? { replacedBy } : {}) })
  }

  async moveSkill(uri: string, parentUri: string): Promise<{ uri: string; cid: string }> {
    const { did, rkey, value } = await this.getExisting(uri)
    return this.put(did, rkey, { ...value, broader: [parentUri] })
  }
}

let client: AuthorityClient | undefined

export function authorityClient(): AuthorityClient {
  return (client ??= new PdsAuthorityClient())
}

/** Tests inject a fake client so routes are testable without a PDS. Pass `undefined`
 * (e.g. in `afterEach`) to fall back to the real `PdsAuthorityClient` again. */
export function setAuthorityClientForTests(c: AuthorityClient | undefined): void {
  client = c
}
