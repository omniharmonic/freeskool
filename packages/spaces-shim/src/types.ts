/**
 * A Spaces-shaped interface. v1 implements it over Postgres (app-side), so that when the
 * Atproto Spaces alpha stabilizes the same calls are backed by the alpha SDK and the
 * feedback/roster/moderation tables migrate into real spaces mechanically.
 *
 * Address shape follows the alpha: at://{authority}/{spaceType}/{skey}/{authorDid}/{collection}/{rkey}
 */
export type Did = `did:${string}`
export type SpaceRole = 'member' | 'moderator'

export interface SpacePolicy {
  /** roles that may read any record in the space (authority always can) */
  read: SpaceRole[]
  /** roles that may write records into the space */
  write: SpaceRole[]
  /** whether a record's *subject* (e.g. the host named in hostFeedback) may read it. Feedback: false. */
  hostMayRead: boolean
}

export interface Space {
  uri: string
  authority: Did
  spaceType: string
  skey: string
  policy: SpacePolicy
  createdAt: string
}

export interface SpaceRecord<T = unknown> {
  uri: string
  author: Did
  collection: string
  rkey: string
  value: T
  createdAt: string
}

export class SpaceAccessError extends Error {
  constructor(msg: string) { super(msg); this.name = 'SpaceAccessError' }
}

export interface SpaceStore {
  createSpace(input: { authority: Did; spaceType: string; skey: string; policy: SpacePolicy }): Promise<Space>
  getSpace(uri: string): Promise<Space | null>
  addMember(spaceUri: string, actor: Did, member: Did, role: SpaceRole): Promise<void>
  removeMember(spaceUri: string, actor: Did, member: Did): Promise<void>
  listMembers(spaceUri: string, actor: Did): Promise<Array<{ did: Did; role: SpaceRole }>>
  putRecord<T>(spaceUri: string, author: Did, collection: string, value: T, rkey?: string): Promise<SpaceRecord<T>>
  listRecords<T = unknown>(spaceUri: string, viewer: Did, collection: string): Promise<SpaceRecord<T>[]>
  deleteRecord(spaceUri: string, actor: Did, recordUri: string): Promise<void>
}
