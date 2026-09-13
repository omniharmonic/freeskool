/**
 * Task 3: app-side skill vouching (`fs_attestation`), on top of Task 2's
 * `fs_skill_claim_index`.
 *
 *   - `subjectHoldsSkill`: a claim-index row OR a hosted class teaching the skill.
 *   - `createAttestation`'s three refusals (self-vouch, subject doesn't hold it,
 *     already vouched) and the happy path.
 *   - `removeAttestation` only ever deletes the attester's own row.
 *   - Counts (`vouchCountsFor`, `vouchCountsForMany`) and `viewerVouches`.
 *   - The evidence flip: `roles.ts#evidenceFor`'s `inviteOrVouch` becomes true from a
 *     received vouch alone, with no invite at all.
 *   - The HTTP surface: `POST/DELETE /api/attestations`, `GET /api/me/attestations`
 *     (given + received, with attester handle/displayName/skill-label enrichment), and
 *     the merge of app-side counts into `me.ts`'s `vouchesReceived` (`GET /api/me/badges`).
 */
process.env.SCHOOL_DID = 'did:plc:attestations-test-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'attestations-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 21).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'attestations-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'

const SKILL_A = 'at://did:plc:taxonomy/freeschool.draft.skill/bicycle-repair'
const SKILL_B = 'at://did:plc:taxonomy/freeschool.draft.skill/sourdough'
const EVENT_URI = 'at://did:plc:attestations-host/community.lexicon.calendar.event/class1'

const ATTESTER = 'did:plc:attestations-attester'
const SUBJECT = 'did:plc:attestations-subject'
const HOST = 'did:plc:attestations-host'

/** Rows the fake indexer serves for `skillLevel` sidecars, keyed by the skill they teach. */
const { skillLevelRows } = vi.hoisted(() => ({
  skillLevelRows: [] as Array<{ uri: string; did: string; skill: string; eventUri: string }>,
}))

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({
    contrail: {
      async query(short: string) {
        if (short === 'skill') {
          return {
            records: [
              {
                uri: SKILL_A,
                did: 'did:plc:taxonomy',
                collection: 'freeschool.draft.skill',
                rkey: 'bicycle-repair',
                cid: 'bafys',
                record: { id: 'bicycle-repair', label: 'Bicycle repair' },
              },
              {
                uri: SKILL_B,
                did: 'did:plc:taxonomy',
                collection: 'freeschool.draft.skill',
                rkey: 'sourdough',
                cid: 'bafys',
                record: { id: 'sourdough', label: 'Sourdough' },
              },
            ],
          }
        }
        return { records: [] }
      },
    },
    db: {
      prepare(sql: string) {
        const short = /records_([A-Za-z0-9_]+)/.exec(sql)?.[1]
        return {
          bind(arg: string) {
            return {
              all: async () => {
                if (short !== 'skillLevel') return { results: [] }
                const rows = skillLevelRows.filter((r) => r.skill === arg)
                return {
                  results: rows.map((r) => ({
                    uri: r.uri,
                    did: r.did,
                    rkey: r.uri.split('/').pop(),
                    cid: 'bafy',
                    record: JSON.stringify({ event: { uri: r.eventUri }, level: 3 }),
                    time_us: 1,
                    indexed_at: 1,
                  })),
                }
              },
              first: async () => null,
            }
          },
        }
      },
    },
    async notify() {},
  }),
}))

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import {
  AttestationError,
  createAttestation,
  receivedWithAttesters,
  removeAttestation,
  subjectHoldsSkill,
  viewerVouches,
  vouchCountsFor,
  vouchCountsForMany,
} from '../src/lib/attestations.js'
import { evidenceFor } from '../src/lib/roles.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { custodialAccount, skillClaimIndex } from '../src/db/schema.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_attestation', 'fs_skill_claim_index', 'fs_custodial_account', 'fs_session', 'fs_app_meta')
  skillLevelRows.length = 0
})

afterAll(async () => {
  if (available) await closeTestDb()
})

function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

async function cookieFor(did: string): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

async function claimSkill(did: string, skillUri: string): Promise<void> {
  await testDb().insert(skillClaimIndex).values({ did, skillUri, level: 'teaching', visibility: 'public' })
}

describe('subjectHoldsSkill', () => {
  it('is true from a fs_skill_claim_index row', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    expect(await subjectHoldsSkill(SUBJECT, SKILL_A)).toBe(true)
  })

  it('is true when the subject hosted a class whose skillLevel sidecar names the skill', async () => {
    if (!available) return
    skillLevelRows.push({ uri: `at://${HOST}/freeschool.draft.skillLevel/sl1`, did: HOST, skill: SKILL_B, eventUri: EVENT_URI })
    expect(await subjectHoldsSkill(HOST, SKILL_B)).toBe(true)
  })

  it('is false when neither is true', async () => {
    if (!available) return
    expect(await subjectHoldsSkill(SUBJECT, SKILL_A)).toBe(false)
  })
})

describe('createAttestation', () => {
  it('400 SelfAttestation when attester = subject', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    await expect(
      createAttestation({ attesterDid: SUBJECT, subjectDid: SUBJECT, skillUri: SKILL_A }),
    ).rejects.toMatchObject({ status: 400, code: 'SelfAttestation' })
  })

  it('404 SubjectNotHolding when subjectHoldsSkill is false', async () => {
    if (!available) return
    await expect(
      createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A }),
    ).rejects.toMatchObject({ status: 404, code: 'SubjectNotHolding' })
  })

  it('happy path returns an id and is visible via viewerVouches', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    const { id } = await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A })
    expect(id).toBeTruthy()
    expect(await viewerVouches(ATTESTER, SUBJECT)).toEqual(new Set([SKILL_A]))
  })

  it('409 AlreadyVouched on a repeat vouch for the same (attester, subject, skill)', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A })
    await expect(
      createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A }),
    ).rejects.toMatchObject({ status: 409, code: 'AlreadyVouched' })
  })

  it('AttestationError instances carry their status and code', async () => {
    if (!available) return
    try {
      await createAttestation({ attesterDid: SUBJECT, subjectDid: SUBJECT, skillUri: SKILL_A })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(AttestationError)
    }
  })
})

describe('removeAttestation', () => {
  it('deletes only when called by the vouch\'s own attester', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    const { id } = await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A })
    expect(await removeAttestation(id, 'did:plc:not-the-attester')).toBe(false)
    expect(await viewerVouches(ATTESTER, SUBJECT)).toEqual(new Set([SKILL_A]))
    expect(await removeAttestation(id, ATTESTER)).toBe(true)
    expect(await viewerVouches(ATTESTER, SUBJECT)).toEqual(new Set())
    expect(await removeAttestation(id, ATTESTER)).toBe(false)
  })
})

describe('counts', () => {
  it('vouchCountsFor groups by skill; vouchCountsForMany totals per subject', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    await claimSkill(SUBJECT, SKILL_B)
    await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A })
    await createAttestation({ attesterDid: 'did:plc:another-attester', subjectDid: SUBJECT, skillUri: SKILL_A })
    await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_B })

    const perSkill = await vouchCountsFor(SUBJECT)
    expect(perSkill.get(SKILL_A)).toBe(2)
    expect(perSkill.get(SKILL_B)).toBe(1)

    const totals = await vouchCountsForMany([SUBJECT, 'did:plc:nobody-vouched'])
    expect(totals.get(SUBJECT)).toBe(3)
    expect(totals.has('did:plc:nobody-vouched')).toBe(false)
  })

  it('receivedWithAttesters lists every vouch received, attester included', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    const { id } = await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A })
    const received = await receivedWithAttesters(SUBJECT)
    expect(received).toEqual([expect.objectContaining({ id, attesterDid: ATTESTER, skillUri: SKILL_A })])
  })
})

describe('evidence: inviteOrVouch flips true from a received vouch alone', () => {
  it('no invite, one received vouch -> true', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    expect((await evidenceFor(SUBJECT)).inviteOrVouch).toBe(false)
    await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A })
    expect((await evidenceFor(SUBJECT)).inviteOrVouch).toBe(true)
  })
})

describe('HTTP: POST/DELETE /api/attestations', () => {
  beforeEach(async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
  })

  async function post(cookie: string, body: Record<string, unknown>): Promise<Response> {
    return createApp().request('/api/attestations', {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  it('201 { id } on the happy path, with X-Robots-Tag set', async () => {
    if (!available) return
    const cookie = await cookieFor(ATTESTER)
    const res = await post(cookie, { subjectDid: SUBJECT, skillUri: SKILL_A })
    expect(res.status).toBe(201)
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    expect(((await res.json()) as { id: string }).id).toBeTruthy()
  })

  it('400 SelfAttestation', async () => {
    if (!available) return
    const cookie = await cookieFor(SUBJECT)
    const res = await post(cookie, { subjectDid: SUBJECT, skillUri: SKILL_A })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('SelfAttestation')
  })

  it('404 SubjectNotHolding', async () => {
    if (!available) return
    const cookie = await cookieFor(ATTESTER)
    const res = await post(cookie, { subjectDid: SUBJECT, skillUri: SKILL_B })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('SubjectNotHolding')
  })

  it('409 AlreadyVouched', async () => {
    if (!available) return
    const cookie = await cookieFor(ATTESTER)
    await post(cookie, { subjectDid: SUBJECT, skillUri: SKILL_A })
    const res = await post(cookie, { subjectDid: SUBJECT, skillUri: SKILL_A })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('AlreadyVouched')
  })

  it('401 without a session', async () => {
    if (!available) return
    const res = await createApp().request('/api/attestations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjectDid: SUBJECT, skillUri: SKILL_A }),
    })
    expect(res.status).toBe(401)
  })

  it('DELETE: 204 for the attester, 403 for anyone else, 404 once already gone', async () => {
    if (!available) return
    const cookie = await cookieFor(ATTESTER)
    const created = await post(cookie, { subjectDid: SUBJECT, skillUri: SKILL_A })
    const { id } = (await created.json()) as { id: string }

    const otherCookie = await cookieFor('did:plc:not-the-attester')
    const forbidden = await createApp().request(`/api/attestations/${id}`, {
      method: 'DELETE',
      headers: { Cookie: otherCookie },
    })
    expect(forbidden.status).toBe(403)

    const ok = await createApp().request(`/api/attestations/${id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(ok.status).toBe(204)

    const gone = await createApp().request(`/api/attestations/${id}`, { method: 'DELETE', headers: { Cookie: cookie } })
    expect(gone.status).toBe(404)
  })
})

describe('HTTP: GET /api/me/attestations', () => {
  beforeEach(async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    await testDb().insert(custodialAccount).values([
      { did: ATTESTER, handle: 'att-attester.test', email: 'attester@example.org', keyVersion: 'v1' },
      { did: SUBJECT, handle: 'att-subject.test', email: 'subject@example.org', keyVersion: 'v1' },
    ])
  })

  it('given: what I vouched for', async () => {
    if (!available) return
    const attesterCookie = await cookieFor(ATTESTER)
    await createApp().request('/api/attestations', {
      method: 'POST',
      headers: { Cookie: attesterCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectDid: SUBJECT, skillUri: SKILL_A }),
    })

    const res = await createApp().request('/api/me/attestations', { headers: { Cookie: attesterCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { given: Array<{ subjectDid: string; skillUri: string; id: string; createdAt: string }> }
    expect(body.given).toEqual([expect.objectContaining({ subjectDid: SUBJECT, skillUri: SKILL_A })])
  })

  it('received: attester handle, displayName, and skill label are resolved', async () => {
    if (!available) return
    const attesterCookie = await cookieFor(ATTESTER)
    const subjectCookie = await cookieFor(SUBJECT)

    await createApp().request('/api/me', {
      method: 'PUT',
      headers: { Cookie: attesterCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Att Ester' }),
    })
    await createApp().request('/api/attestations', {
      method: 'POST',
      headers: { Cookie: attesterCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectDid: SUBJECT, skillUri: SKILL_A }),
    })

    const res = await createApp().request('/api/me/attestations', { headers: { Cookie: subjectCookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      received: Array<{
        attesterDid: string
        attesterHandle?: string
        attesterDisplayName?: string
        skillUri: string
        skillLabel: string
      }>
    }
    expect(body.received).toHaveLength(1)
    const r = body.received[0]!
    expect(r.attesterDid).toBe(ATTESTER)
    expect(r.attesterHandle).toBe('att-attester.test')
    expect(r.attesterDisplayName).toBe('Att Ester')
    expect(r.skillLabel).toBe('Bicycle repair')
  })
})

describe('vouchesReceived merges app-side vouches into GET /api/me/badges', () => {
  it('an app-side-only vouch (no protocol skillAttestation) still shows up', async () => {
    if (!available) return
    await claimSkill(SUBJECT, SKILL_A)
    await createAttestation({ attesterDid: ATTESTER, subjectDid: SUBJECT, skillUri: SKILL_A })
    const cookie = await cookieFor(SUBJECT)
    const res = await createApp().request('/api/me/badges', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { counts: { vouched: number }; badges: string[] }
    expect(body.counts.vouched).toBe(1)
    expect(body.badges).toContain('Vouched for Bicycle repair by 1 person')
  })
})
