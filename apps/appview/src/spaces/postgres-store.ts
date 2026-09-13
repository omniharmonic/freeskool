/**
 * `SpaceStore` over Postgres — the v1 backing for the Spaces-shaped interface in
 * `@freeschool/spaces-shim`.
 *
 * This is a deliberate line-for-line mirror of `MemorySpaceStore`: the SAME access
 * decisions in the SAME order, so that when the Atproto Spaces alpha stabilizes the
 * feedback / roster / moderation tables migrate mechanically and the tests that pin the
 * semantics (`test/postgres-space-store.test.ts`, which is `spaces-shim`'s own memory
 * suite re-pointed at Postgres) keep passing unchanged.
 *
 * The three tables are `fs_space`, `fs_space_member`, `fs_space_record`.
 */
import { and, eq } from 'drizzle-orm'
import {
  SpaceAccessError,
  type Did,
  type Space,
  type SpacePolicy,
  type SpaceRecord,
  type SpaceRole,
  type SpaceStore,
} from '@freeschool/spaces-shim'
import type { Db } from '../db/index.js'
import { space, spaceMember, spaceRecord } from '../db/schema.js'
import { tid } from '../lib/ids.js'

export class PostgresSpaceStore implements SpaceStore {
  constructor(private readonly db: Db) {}

  async createSpace(input: {
    authority: Did
    spaceType: string
    skey: string
    policy: SpacePolicy
  }): Promise<Space> {
    const uri = `at://${input.authority}/${input.spaceType}/${input.skey}`
    const createdAt = new Date()
    const row: Space = { uri, ...input, createdAt: createdAt.toISOString() }
    await this.db
      .insert(space)
      .values({
        uri,
        authority: input.authority,
        spaceType: input.spaceType,
        skey: input.skey,
        policy: input.policy,
        createdAt,
      })
      .onConflictDoUpdate({ target: space.uri, set: { policy: input.policy } })
    return row
  }

  async getSpace(uri: string): Promise<Space | null> {
    const rows = await this.db.select().from(space).where(eq(space.uri, uri)).limit(1)
    const r = rows[0]
    if (!r) return null
    return {
      uri: r.uri,
      authority: r.authority as Did,
      spaceType: r.spaceType,
      skey: r.skey,
      policy: r.policy as SpacePolicy,
      createdAt: r.createdAt.toISOString(),
    }
  }

  private async requireSpace(uri: string): Promise<Space> {
    const s = await this.getSpace(uri)
    if (!s) throw new SpaceAccessError(`no such space ${uri}`)
    return s
  }

  private async roleOf(s: Space, did: Did): Promise<SpaceRole | 'authority' | null> {
    if (did === s.authority) return 'authority'
    const rows = await this.db
      .select({ role: spaceMember.role })
      .from(spaceMember)
      .where(and(eq(spaceMember.spaceUri, s.uri), eq(spaceMember.did, did)))
      .limit(1)
    const role = rows[0]?.role
    return role === 'member' || role === 'moderator' ? role : null
  }

  /** Identical to MemorySpaceStore.can: 'manage' is authority-only, moderators inherit member rights. */
  private async can(s: Space, did: Did, action: 'read' | 'write' | 'manage'): Promise<boolean> {
    const role = await this.roleOf(s, did)
    if (role === 'authority') return true
    if (!role) return false
    if (action === 'manage') return false
    const allowed = s.policy[action]
    return allowed.includes(role) || (role === 'moderator' && allowed.includes('member'))
  }

  async addMember(spaceUri: string, actor: Did, member: Did, role: SpaceRole): Promise<void> {
    const s = await this.requireSpace(spaceUri)
    if (!(await this.can(s, actor, 'manage'))) {
      throw new SpaceAccessError('only the authority manages membership')
    }
    await this.db
      .insert(spaceMember)
      .values({ spaceUri, did: member, role })
      .onConflictDoUpdate({ target: [spaceMember.spaceUri, spaceMember.did], set: { role } })
  }

  async removeMember(spaceUri: string, actor: Did, member: Did): Promise<void> {
    const s = await this.requireSpace(spaceUri)
    if (!(await this.can(s, actor, 'manage'))) {
      throw new SpaceAccessError('only the authority manages membership')
    }
    await this.db
      .delete(spaceMember)
      .where(and(eq(spaceMember.spaceUri, spaceUri), eq(spaceMember.did, member)))
  }

  async listMembers(spaceUri: string, actor: Did): Promise<Array<{ did: Did; role: SpaceRole }>> {
    const s = await this.requireSpace(spaceUri)
    if (!(await this.can(s, actor, 'read'))) throw new SpaceAccessError('not permitted to read roster')
    const rows = await this.db
      .select({ did: spaceMember.did, role: spaceMember.role })
      .from(spaceMember)
      .where(eq(spaceMember.spaceUri, spaceUri))
    return rows.map((r) => ({ did: r.did as Did, role: r.role as SpaceRole }))
  }

  async putRecord<T>(
    spaceUri: string,
    author: Did,
    collection: string,
    value: T,
    rkey = tid(),
  ): Promise<SpaceRecord<T>> {
    const s = await this.requireSpace(spaceUri)
    if (!(await this.can(s, author, 'write'))) throw new SpaceAccessError('not a member with write access')
    const uri = `${spaceUri}/${author}/${collection}/${rkey}`
    const createdAt = new Date()
    await this.db
      .insert(spaceRecord)
      .values({ uri, spaceUri, author, collection, rkey, value: value as object, createdAt })
      .onConflictDoUpdate({ target: spaceRecord.uri, set: { value: value as object } })
    return { uri, author, collection, rkey, value, createdAt: createdAt.toISOString() }
  }

  async listRecords<T = unknown>(spaceUri: string, viewer: Did, collection: string): Promise<SpaceRecord<T>[]> {
    const s = await this.requireSpace(spaceUri)
    if (await this.can(s, viewer, 'read')) {
      const rows = await this.db
        .select()
        .from(spaceRecord)
        .where(and(eq(spaceRecord.spaceUri, spaceUri), eq(spaceRecord.collection, collection)))
      return rows.map((r) => ({
        uri: r.uri,
        author: r.author as Did,
        collection: r.collection,
        rkey: r.rkey,
        value: r.value as T,
        createdAt: r.createdAt.toISOString(),
      }))
    }
    // A member who is the *subject* of records (e.g. the host) may never read raw rows
    // unless policy says so. Feedback spaces set hostMayRead: false.
    if (!s.policy.hostMayRead) {
      throw new SpaceAccessError('raw rows are not readable by this viewer; use the aggregate')
    }
    throw new SpaceAccessError('not permitted to read')
  }

  async deleteRecord(spaceUri: string, actor: Did, recordUri: string): Promise<void> {
    const s = await this.requireSpace(spaceUri)
    const rows = await this.db
      .select({ author: spaceRecord.author })
      .from(spaceRecord)
      .where(and(eq(spaceRecord.spaceUri, spaceUri), eq(spaceRecord.uri, recordUri)))
      .limit(1)
    const existing = rows[0]
    if (!existing) return
    const isAuthor = existing.author === actor
    if (!isAuthor && !(await this.can(s, actor, 'manage'))) {
      throw new SpaceAccessError('only the author or the authority may delete')
    }
    await this.db.delete(spaceRecord).where(eq(spaceRecord.uri, recordUri))
  }
}

/** The feedback space for one school. Policy: members write, moderators read, host never. */
export const FEEDBACK_SPACE_TYPE = 'freeschool.draft.space.feedback'
export const FEEDBACK_SPACE_POLICY: SpacePolicy = {
  read: ['moderator'],
  write: ['member'],
  hostMayRead: false,
}

export async function ensureFeedbackSpace(
  store: SpaceStore,
  authority: Did,
  skey: string,
): Promise<Space> {
  const uri = `at://${authority}/${FEEDBACK_SPACE_TYPE}/${skey}`
  return (await store.getSpace(uri)) ?? store.createSpace({ authority, spaceType: FEEDBACK_SPACE_TYPE, skey, policy: FEEDBACK_SPACE_POLICY })
}
