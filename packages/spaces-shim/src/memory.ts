import { SpaceAccessError, type Did, type Space, type SpacePolicy, type SpaceRecord, type SpaceRole, type SpaceStore } from './types.js'

const tid = () => Date.now().toString(32) + Math.random().toString(32).slice(2, 8)

export class MemorySpaceStore implements SpaceStore {
  private spaces = new Map<string, Space>()
  private members = new Map<string, Map<Did, SpaceRole>>()
  private records = new Map<string, SpaceRecord[]>()

  async createSpace(input: { authority: Did; spaceType: string; skey: string; policy: SpacePolicy }): Promise<Space> {
    const uri = `at://${input.authority}/${input.spaceType}/${input.skey}`
    const space: Space = { uri, ...input, createdAt: new Date().toISOString() }
    this.spaces.set(uri, space)
    this.members.set(uri, new Map())
    this.records.set(uri, [])
    return space
  }
  async getSpace(uri: string) { return this.spaces.get(uri) ?? null }

  private space(uri: string): Space {
    const s = this.spaces.get(uri)
    if (!s) throw new SpaceAccessError(`no such space ${uri}`)
    return s
  }
  private roleOf(uri: string, did: Did): SpaceRole | 'authority' | null {
    const s = this.space(uri)
    if (did === s.authority) return 'authority'
    return this.members.get(uri)?.get(did) ?? null
  }
  private can(uri: string, did: Did, action: 'read' | 'write' | 'manage'): boolean {
    const role = this.roleOf(uri, did)
    if (role === 'authority') return true
    if (!role) return false
    if (action === 'manage') return false
    const allowed = this.space(uri).policy[action]
    return allowed.includes(role) || (role === 'moderator' && allowed.includes('member'))
  }

  async addMember(spaceUri: string, actor: Did, member: Did, role: SpaceRole) {
    if (!this.can(spaceUri, actor, 'manage')) throw new SpaceAccessError('only the authority manages membership')
    this.members.get(spaceUri)!.set(member, role)
  }
  async removeMember(spaceUri: string, actor: Did, member: Did) {
    if (!this.can(spaceUri, actor, 'manage')) throw new SpaceAccessError('only the authority manages membership')
    this.members.get(spaceUri)!.delete(member)
  }
  async listMembers(spaceUri: string, actor: Did) {
    if (!this.can(spaceUri, actor, 'read')) throw new SpaceAccessError('not permitted to read roster')
    return [...this.members.get(spaceUri)!.entries()].map(([did, role]) => ({ did, role }))
  }
  async putRecord<T>(spaceUri: string, author: Did, collection: string, value: T, rkey = tid()): Promise<SpaceRecord<T>> {
    if (!this.can(spaceUri, author, 'write')) throw new SpaceAccessError('not a member with write access')
    const rec: SpaceRecord<T> = { uri: `${spaceUri}/${author}/${collection}/${rkey}`, author, collection, rkey, value, createdAt: new Date().toISOString() }
    this.records.get(spaceUri)!.push(rec)
    return rec
  }
  async listRecords<T = unknown>(spaceUri: string, viewer: Did, collection: string): Promise<SpaceRecord<T>[]> {
    const s = this.space(spaceUri)
    const rows = this.records.get(spaceUri)!.filter((r) => r.collection === collection) as SpaceRecord<T>[]
    if (this.can(spaceUri, viewer, 'read')) return rows
    // A member who is the *subject* of records (e.g. the host) may never read raw rows unless policy says so.
    if (!s.policy.hostMayRead) throw new SpaceAccessError('raw rows are not readable by this viewer; use the aggregate')
    throw new SpaceAccessError('not permitted to read')
  }
  async deleteRecord(spaceUri: string, actor: Did, recordUri: string) {
    const rows = this.records.get(spaceUri)!
    const i = rows.findIndex((r) => r.uri === recordUri)
    if (i < 0) return
    const isAuthor = rows[i]!.author === actor
    if (!isAuthor && !this.can(spaceUri, actor, 'manage')) throw new SpaceAccessError('only the author or the authority may delete')
    rows.splice(i, 1)
  }
}
