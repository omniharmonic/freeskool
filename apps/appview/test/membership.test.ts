/**
 * `isOwnMember`/`isOwnMemberSet` decide calendar/zine inclusion by AUTHORSHIP
 * (`http/visibility.ts#calendarInclusion`). The regression this pins: membership must be
 * a DURABLE fact, not the OAuth client's own session store — `fs_oauth_session` rows are
 * deleted on token revocation or a failed refresh (`PostgresSessionStore.del` in
 * `http/oauth.ts`), which must NOT make an OAuth-door host's classes vanish.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from 'hono'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { isOwnMember, isOwnMemberSet } from '../src/lib/roles.js'
import { createSession } from '../src/http/session.js'
import { custodialAccount, member, oauthSession, session, steward } from '../src/db/schema.js'

const CUSTODIAL_DID = 'did:plc:custodial-member'
const OAUTH_DID = 'did:plc:oauth-member'
const STEWARD_DID = 'did:plc:a-steward'
const STRANGER_DID = 'did:plc:a-total-stranger'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_member', 'fs_custodial_account', 'fs_steward', 'fs_oauth_session', 'fs_session')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

/** A stand-in Context: `setCookie` only ever calls `c.header(...)` on it. */
function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

describe('isOwnMember / isOwnMemberSet', () => {
  it('a custodial account is ours', async () => {
    if (!available) return
    await testDb().insert(custodialAccount).values({ did: CUSTODIAL_DID, handle: 'x.test', email: 'x@example.org', keyVersion: 'v1' })
    expect(await isOwnMember(CUSTODIAL_DID)).toBe(true)
  })

  it('a steward is ours', async () => {
    if (!available) return
    await testDb().insert(steward).values({ did: STEWARD_DID, schoolDid: 'did:plc:school' })
    expect(await isOwnMember(STEWARD_DID)).toBe(true)
  })

  it('an fs_member row alone is ours', async () => {
    if (!available) return
    await testDb().insert(member).values({ did: OAUTH_DID, door: 'oauth' })
    expect(await isOwnMember(OAUTH_DID)).toBe(true)
  })

  it('a total stranger is not ours', async () => {
    if (!available) return
    expect(await isOwnMember(STRANGER_DID)).toBe(false)
  })

  it('THE FIX: membership survives the fs_oauth_session row being deleted (token revocation)', async () => {
    if (!available) return
    // Simulate: the OAuth door was walked through once (fs_member written by
    // createSession) and the OAuth client's own session store also had a row —
    // then that row is revoked/expired and deleted, as PostgresSessionStore.del does.
    await testDb().insert(member).values({ did: OAUTH_DID, door: 'oauth' })
    await testDb().insert(oauthSession).values({ sub: OAUTH_DID, session: { dummy: true } })
    expect(await isOwnMember(OAUTH_DID)).toBe(true)

    await testDb().delete(oauthSession)
    expect(await isOwnMember(OAUTH_DID)).toBe(true)
  })

  it('isOwnMemberSet batches across custodial/member/steward sources in one call each', async () => {
    if (!available) return
    await testDb().insert(custodialAccount).values({ did: CUSTODIAL_DID, handle: 'y.test', email: 'y@example.org', keyVersion: 'v1' })
    await testDb().insert(member).values({ did: OAUTH_DID, door: 'oauth' })
    await testDb().insert(steward).values({ did: STEWARD_DID, schoolDid: 'did:plc:school' })

    const out = await isOwnMemberSet([CUSTODIAL_DID, OAUTH_DID, STEWARD_DID, STRANGER_DID])
    expect(out.has(CUSTODIAL_DID)).toBe(true)
    expect(out.has(OAUTH_DID)).toBe(true)
    expect(out.has(STEWARD_DID)).toBe(true)
    expect(out.has(STRANGER_DID)).toBe(false)
  })

  it('isOwnMemberSet on an empty array makes no query and returns an empty set', async () => {
    expect((await isOwnMemberSet([])).size).toBe(0)
  })
})

describe('createSession writes a durable fs_member row', () => {
  it('a custodial session creation upserts fs_member', async () => {
    if (!available) return
    await createSession(fakeContext(), CUSTODIAL_DID, 'custodial')
    const rows = await testDb().select().from(member)
    expect(rows.some((r) => r.did === CUSTODIAL_DID && r.door === 'custodial')).toBe(true)
  })

  it('an oauth session creation upserts fs_member, and a second login does not duplicate the row', async () => {
    if (!available) return
    await createSession(fakeContext(), OAUTH_DID, 'oauth')
    await createSession(fakeContext(), OAUTH_DID, 'oauth')
    const rows = await testDb().select().from(member)
    const mine = rows.filter((r) => r.did === OAUTH_DID)
    expect(mine.length).toBe(1)
    expect(mine[0]!.door).toBe('oauth')
  })

  it('also writes the ordinary fs_session row (unchanged behavior)', async () => {
    if (!available) return
    await createSession(fakeContext(), CUSTODIAL_DID, 'custodial')
    const rows = await testDb().select().from(session)
    expect(rows.some((r) => r.did === CUSTODIAL_DID)).toBe(true)
  })
})
