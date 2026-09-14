/**
 * Task 6: choosing a handle (the `/welcome` screen's server side — Task 11 consumes
 * this) and the onboarding flag.
 *
 *   - `GET /api/me/handle/check?handle=<prefix>` — format/reserved (pure, already
 *     covered by `test/handles.test.ts`) plus `taken`, checked against both
 *     `fs_custodial_account` and the PDS.
 *   - `PUT /api/me/handle { handle }` — custodial only (403 `NotCustodial` for an
 *     OAuth-door viewer); calls `agent.com.atproto.identity.updateHandle` through
 *     `actorAgent`; maps the PDS's `HandleNotAvailable`/`InvalidHandle` to 409/400;
 *     rate-limited to 3 changes per DID per 24h (429 `TooManyHandleChanges`).
 *   - `POST /api/me/onboarded` — idempotent; `GET /api/auth/me` and `GET /api/me` both
 *     reflect it.
 */
process.env.SCHOOL_DID = 'did:plc:me-handle-test-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'me-handle-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 31).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'me-handle-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'
import { XRPCError } from '@atproto/api'

/** Full handles the fake PDS considers already registered — set per test. */
const { pdsState } = vi.hoisted(() => ({
  pdsState: { taken: new Set<string>(), updateError: undefined as 'HandleNotAvailable' | 'InvalidHandle' | undefined },
}))

vi.mock('../src/lib/pds.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/pds.js')>('../src/lib/pds.js')
  return {
    ...actual,
    async resolveHandle(handle: string) {
      return pdsState.taken.has(handle) ? 'did:plc:someone-else' : null
    },
  }
})

/** Calls the fake agent recorded, so the happy path can assert what was sent to the PDS. */
const { agentCalls } = vi.hoisted(() => ({ agentCalls: [] as string[] }))

vi.mock('../src/lib/actor-agent.js', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/actor-agent.js')>('../src/lib/actor-agent.js')
  return {
    ...actual,
    async actorAgent() {
      return {
        com: {
          atproto: {
            identity: {
              async updateHandle(input: { handle: string }) {
                agentCalls.push(input.handle)
                if (pdsState.updateError) {
                  throw new XRPCError(400, pdsState.updateError, 'rejected by the PDS')
                }
                return { success: true }
              },
            },
          },
        },
      }
    },
  }
})

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { appMeta, custodialAccount } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_member', 'fs_member_prefs', 'fs_custodial_account', 'fs_session', 'fs_app_meta')
  pdsState.taken.clear()
  pdsState.updateError = undefined
  agentCalls.length = 0
})

afterAll(async () => {
  if (available) await closeTestDb()
})

function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function signIn(did: string, kind: 'custodial' | 'oauth' = 'custodial'): Promise<string> {
  const id = await createSession(fakeContext(), did, kind)
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

async function addCustodial(did: string, handle: string): Promise<void> {
  await testDb().insert(custodialAccount).values({ did, handle, email: `${handle}@example.org`, keyVersion: 'v1' })
}

const ALICE = 'did:plc:me-handle-alice'
const BOB = 'did:plc:me-handle-bob'

describe('GET /api/me/handle/check', () => {
  it('401s with no session', async () => {
    if (!available) return
    const res = await createApp().request('/api/me/handle/check?handle=calmotter')
    expect(res.status).toBe(401)
  })

  it('reports invalid for a malformed prefix, without touching the PDS or the DB', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle/check?handle=CalmOtter', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ available: false, reason: 'invalid' })
  })

  it('reports reserved for a reserved prefix', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle/check?handle=admin', { headers: { Cookie: cookie } })
    expect(await res.json()).toEqual({ available: false, reason: 'reserved' })
  })

  it('reports taken when fs_custodial_account already holds the handle', async () => {
    if (!available) return
    await addCustodial(BOB, 'calmotter.test')
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle/check?handle=calmotter', { headers: { Cookie: cookie } })
    expect(await res.json()).toEqual({ available: false, reason: 'taken' })
  })

  it('reports taken when the PDS resolves the handle (no local row)', async () => {
    if (!available) return
    pdsState.taken.add('brightwren.test')
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle/check?handle=brightwren', { headers: { Cookie: cookie } })
    expect(await res.json()).toEqual({ available: false, reason: 'taken' })
  })

  it('reports available for a well-formed, unclaimed prefix', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle/check?handle=brandnewhandle', { headers: { Cookie: cookie } })
    expect(await res.json()).toEqual({ available: true })
  })
})

describe('PUT /api/me/handle', () => {
  it('403 NotCustodial for an OAuth-door viewer', async () => {
    if (!available) return
    const cookie = await signIn(ALICE, 'oauth')
    const res = await createApp().request('/api/me/handle', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'newhandle' }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'NotCustodial' })
    expect(agentCalls).toEqual([])
  })

  it('400 InvalidHandle for a malformed or reserved prefix, without calling the PDS', async () => {
    if (!available) return
    await addCustodial(ALICE, 'oldhandle.test')
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'admin' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'InvalidHandle' })
    expect(agentCalls).toEqual([])
  })

  it('happy path: updates the PDS, fs_custodial_account, and the handle cache', async () => {
    if (!available) return
    await addCustodial(ALICE, 'oldhandle.test')
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'brandnewhandle' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ handle: 'brandnewhandle.test' })
    expect(agentCalls).toEqual(['brandnewhandle.test'])

    const rows = await testDb().select().from(custodialAccount).where(eq(custodialAccount.did, ALICE)).limit(1)
    expect(rows[0]?.handle).toBe('brandnewhandle.test')

    const cacheRows = await testDb().select().from(appMeta).where(eq(appMeta.key, `handle:${ALICE}`)).limit(1)
    expect((cacheRows[0]?.value as { handle?: string } | undefined)?.handle).toBe('brandnewhandle.test')
  })

  it('409 HandleTaken when the PDS rejects with HandleNotAvailable', async () => {
    if (!available) return
    await addCustodial(ALICE, 'oldhandle.test')
    pdsState.updateError = 'HandleNotAvailable'
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'takenhandle' }),
    })
    expect(res.status).toBe(409)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'HandleTaken' })

    const rows = await testDb().select().from(custodialAccount).where(eq(custodialAccount.did, ALICE)).limit(1)
    expect(rows[0]?.handle).toBe('oldhandle.test')
  })

  it('400 InvalidHandle when the PDS rejects with InvalidHandle', async () => {
    if (!available) return
    await addCustodial(ALICE, 'oldhandle.test')
    pdsState.updateError = 'InvalidHandle'
    const cookie = await signIn(ALICE)
    const res = await createApp().request('/api/me/handle', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'somehandle' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'InvalidHandle' })
  })

  it('429 TooManyHandleChanges on the 4th change within 24h', async () => {
    if (!available) return
    await addCustodial(ALICE, 'oldhandle.test')
    const cookie = await signIn(ALICE)
    for (const prefix of ['firsthandle', 'secondhandle', 'thirdhandle']) {
      const ok = await createApp().request('/api/me/handle', {
        method: 'PUT',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ handle: prefix }),
      })
      expect(ok.status).toBe(200)
    }
    const fourth = await createApp().request('/api/me/handle', {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'fourthhandle' }),
    })
    expect(fourth.status).toBe(429)
    expect((await fourth.json()) as { error: string }).toMatchObject({ error: 'TooManyHandleChanges' })
  })
})

describe('POST /api/me/onboarded', () => {
  it('sets onboardedAt and is idempotent', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)

    const meBefore = await createApp().request('/api/me', { headers: { Cookie: cookie } })
    expect(((await meBefore.json()) as { onboarded: boolean }).onboarded).toBe(false)

    const first = await createApp().request('/api/me/onboarded', { method: 'POST', headers: { Cookie: cookie } })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ onboarded: true })

    const second = await createApp().request('/api/me/onboarded', { method: 'POST', headers: { Cookie: cookie } })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ onboarded: true })

    const meAfter = await createApp().request('/api/me', { headers: { Cookie: cookie } })
    expect(((await meAfter.json()) as { onboarded: boolean }).onboarded).toBe(true)
  })
})

describe('GET /api/auth/me', () => {
  it('includes onboarded, consistent with GET /api/me', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)

    const before = await createApp().request('/api/auth/me', { headers: { Cookie: cookie } })
    expect(((await before.json()) as { onboarded: boolean }).onboarded).toBe(false)

    await createApp().request('/api/me/onboarded', { method: 'POST', headers: { Cookie: cookie } })

    const after = await createApp().request('/api/auth/me', { headers: { Cookie: cookie } })
    expect(((await after.json()) as { onboarded: boolean }).onboarded).toBe(true)
  })
})
