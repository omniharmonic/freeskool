/**
 * Task 4: the members-only people directory (`lib/members.ts`), member profiles, and
 * "people with this skill" on skill pages.
 *
 *   - `memberVisible`: `directoryListing || did === viewerDid`.
 *   - `listMembers`: hidden members excluded, `q` matches displayName, `skill` filters by
 *     `fs_skill_claim_index`, cursor pagination.
 *   - `memberProfile`: null when not visible; claims (public + school), badges, hosting
 *     (listed only), resources (author-owned).
 *   - `peopleForSkill`: the `people` block `GET /api/skills/:id` adds for a viewer.
 *   - HTTP: `GET /api/members`, `GET /api/members/:did`, `GET /api/members/:did/avatar`
 *     all `requireViewer` + `noindex`; `GET /api/skills/:id` only gains `people` with a
 *     session; `PUT /api/me` accepts `directoryListing`.
 */
process.env.SCHOOL_DID = 'did:plc:members-test-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'members-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 22).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'members-test-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from 'hono'

const SKILL_A = 'at://did:plc:taxonomy/freeschool.draft.skill/bicycle-repair'
const SKILL_B = 'at://did:plc:taxonomy/freeschool.draft.skill/sourdough'

const ALICE = 'did:plc:members-alice'
const BOB = 'did:plc:members-bob'
const HIDDEN = 'did:plc:members-hidden'
const HOST = 'did:plc:members-host'

const LISTED_EVENT_URI = `at://${HOST}/community.lexicon.calendar.event/listed1`
const UNLISTED_EVENT_URI = `at://${HOST}/community.lexicon.calendar.event/unlisted1`

/** Mutable fake-index fixtures, reset in `beforeEach` below. */
const { eventRecords, resourceRecords, eventConfigRows } = vi.hoisted(() => ({
  eventRecords: [] as Array<{ uri: string; did: string; collection: string; rkey: string; cid: string; record: Record<string, unknown> }>,
  resourceRecords: [] as Array<{ uri: string; did: string; collection: string; rkey: string; cid: string; record: Record<string, unknown> }>,
  eventConfigRows: [] as Array<{ uri: string; did: string; eventUri: string; visibility: string }>,
}))

vi.mock('../src/index/indexer.js', () => ({
  getIndexer: async () => ({
    contrail: {
      async query(short: string) {
        if (short === 'skill') {
          return {
            records: [
              { uri: SKILL_A, did: 'did:plc:taxonomy', collection: 'freeschool.draft.skill', rkey: 'bicycle-repair', cid: 'bafys', record: { id: 'bicycle-repair', label: 'Bicycle repair' } },
              { uri: SKILL_B, did: 'did:plc:taxonomy', collection: 'freeschool.draft.skill', rkey: 'sourdough', cid: 'bafys', record: { id: 'sourdough', label: 'Sourdough' } },
            ],
          }
        }
        if (short === 'event') return { records: eventRecords }
        if (short === 'resource') return { records: resourceRecords }
        return { records: [] }
      },
    },
    db: {
      prepare(sqlText: string) {
        const short = /records_([A-Za-z0-9_]+)/.exec(sqlText)?.[1]
        return {
          bind(arg: string) {
            return {
              all: async () => {
                if (short !== 'eventConfig') return { results: [] }
                const rows = eventConfigRows.filter((r) => r.eventUri === arg)
                return {
                  results: rows.map((r) => ({
                    uri: r.uri,
                    did: r.did,
                    rkey: r.uri.split('/').pop(),
                    cid: 'bafy',
                    record: JSON.stringify({ event: { uri: r.eventUri }, visibility: r.visibility }),
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
import { listMembers, memberProfile, memberVisible, peopleForSkill } from '../src/lib/members.js'
import { createAttestation } from '../src/lib/attestations.js'
import { createApp } from '../src/http/app.js'
import { createSession } from '../src/http/session.js'
import { signSessionId } from '../src/lib/crypto.js'
import { config } from '../src/config.js'
import { appMeta, custodialAccount, member, memberPrefs, skillClaimIndex } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate(
    'fs_member',
    'fs_member_prefs',
    'fs_skill_claim_index',
    'fs_attestation',
    'fs_custodial_account',
    'fs_session',
    'fs_app_meta',
  )
  eventRecords.length = 0
  resourceRecords.length = 0
  eventConfigRows.length = 0
})

afterAll(async () => {
  if (available) await closeTestDb()
})

function fakeContext(): Context {
  return { header: () => undefined } as unknown as Context
}

/** Signs the DID in via the custodial door (this is what writes the `fs_member` row). */
async function signIn(did: string, lastSeenAt?: Date): Promise<string> {
  const id = await createSession(fakeContext(), did, 'custodial')
  if (lastSeenAt) await testDb().update(member).set({ lastSeenAt }).where(eq(member.did, did))
  return `${config().SESSION_COOKIE}=${signSessionId(id)}`
}

async function hide(did: string): Promise<void> {
  await testDb().insert(memberPrefs).values({ did, directoryListing: false, updatedAt: new Date() })
}

async function claimSkill(did: string, skillUri: string, opts: { level?: string; visibility?: 'public' | 'school' } = {}): Promise<void> {
  await testDb()
    .insert(skillClaimIndex)
    .values({ did, skillUri, level: opts.level ?? 'teaching', visibility: opts.visibility ?? 'public' })
}

async function setProfile(did: string, profile: Record<string, unknown>): Promise<void> {
  await testDb()
    .insert(appMeta)
    .values({ key: `profile:${did}`, value: profile, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: profile, updatedAt: new Date() } })
}

async function addCustodial(did: string, handle: string): Promise<void> {
  await testDb().insert(custodialAccount).values({ did, handle, email: `${handle}@example.org`, keyVersion: 'v1' })
}

describe('memberVisible', () => {
  it('true with no prefs row (default listed), true for self regardless, false once hidden for anyone else', async () => {
    if (!available) return
    await signIn(ALICE)
    expect(await memberVisible(ALICE, BOB)).toBe(true)
    await hide(ALICE)
    expect(await memberVisible(ALICE, BOB)).toBe(false)
    expect(await memberVisible(ALICE, ALICE)).toBe(true)
  })
})

describe('listMembers', () => {
  it('hidden members are absent from the list', async () => {
    if (!available) return
    await signIn(ALICE, new Date('2026-01-03T00:00:00Z'))
    await signIn(HIDDEN, new Date('2026-01-02T00:00:00Z'))
    await hide(HIDDEN)
    const { members } = await listMembers({})
    expect(members.map((m) => m.did)).toEqual([ALICE])
  })

  it('q matches displayName, case-insensitively, substring', async () => {
    if (!available) return
    await signIn(ALICE, new Date('2026-01-03T00:00:00Z'))
    await signIn(BOB, new Date('2026-01-02T00:00:00Z'))
    await setProfile(ALICE, { displayName: 'Alice Bikeshop' })
    await setProfile(BOB, { displayName: 'Bob Baker' })
    const { members } = await listMembers({ q: 'bike' })
    expect(members.map((m) => m.did)).toEqual([ALICE])
  })

  it('skill filters to fs_skill_claim_index holders only', async () => {
    if (!available) return
    await signIn(ALICE, new Date('2026-01-03T00:00:00Z'))
    await signIn(BOB, new Date('2026-01-02T00:00:00Z'))
    await claimSkill(ALICE, SKILL_A)
    const { members } = await listMembers({ skill: SKILL_A })
    expect(members.map((m) => m.did)).toEqual([ALICE])
  })

  it('carries role, roleLabel, claimCount and vouchCount', async () => {
    if (!available) return
    await signIn(ALICE, new Date('2026-01-03T00:00:00Z'))
    await claimSkill(ALICE, SKILL_A)
    await createAttestation({ attesterDid: BOB, subjectDid: ALICE, skillUri: SKILL_A })
    const { members } = await listMembers({})
    const alice = members.find((m) => m.did === ALICE)!
    expect(alice.claimCount).toBe(1)
    expect(alice.vouchCount).toBe(1)
    expect(typeof alice.role).toBe('number')
    expect(typeof alice.roleLabel).toBe('string')
  })

  it('paginates lastSeenAt desc, did, with an opaque cursor', async () => {
    if (!available) return
    await signIn(ALICE, new Date('2026-01-03T00:00:00Z'))
    await signIn(BOB, new Date('2026-01-02T00:00:00Z'))
    const first = await listMembers({ limit: 1 })
    expect(first.members.map((m) => m.did)).toEqual([ALICE])
    expect(first.cursor).toBeTruthy()
    const second = await listMembers({ limit: 1, cursor: first.cursor })
    expect(second.members.map((m) => m.did)).toEqual([BOB])
    expect(second.cursor).toBeUndefined()
  })
})

describe('memberProfile', () => {
  it('null when the member does not exist, and when hidden from this viewer', async () => {
    if (!available) return
    expect(await memberProfile('did:plc:nobody', ALICE)).toBeNull()
    await signIn(HIDDEN)
    await hide(HIDDEN)
    expect(await memberProfile(HIDDEN, ALICE)).toBeNull()
    expect(await memberProfile(HIDDEN, HIDDEN)).not.toBeNull()
  })

  it('claims include both public and school visibility, with labels, vouch counts and viewerVouched', async () => {
    if (!available) return
    await signIn(ALICE)
    await claimSkill(ALICE, SKILL_A, { level: 'teaching', visibility: 'public' })
    await claimSkill(ALICE, SKILL_B, { level: 'learning', visibility: 'school' })
    await createAttestation({ attesterDid: BOB, subjectDid: ALICE, skillUri: SKILL_A })

    const profile = await memberProfile(ALICE, BOB)
    expect(profile).not.toBeNull()
    const bySkill = new Map(profile!.claims.map((c) => [c.skillUri, c]))
    expect(bySkill.get(SKILL_A)).toMatchObject({ skillLabel: 'Bicycle repair', level: 'teaching', visibility: 'public', vouchCount: 1, viewerVouched: true })
    expect(bySkill.get(SKILL_B)).toMatchObject({ skillLabel: 'Sourdough', level: 'learning', visibility: 'school', vouchCount: 0, viewerVouched: false })
  })

  it('badges is the same shape as GET /api/me/badges', async () => {
    if (!available) return
    await signIn(ALICE)
    await claimSkill(ALICE, SKILL_A)
    await createAttestation({ attesterDid: BOB, subjectDid: ALICE, skillUri: SKILL_A })
    const profile = await memberProfile(ALICE, BOB)
    expect(profile!.badges).toMatchObject({ counts: { vouched: 1 }, badges: expect.arrayContaining([expect.stringContaining('Vouched for Bicycle repair')]) })
  })

  it('hosting includes a listed upcoming class and excludes an unlisted one', async () => {
    if (!available) return
    await signIn(HOST)
    const future = new Date(Date.now() + 86_400_000).toISOString()
    eventRecords.push(
      { uri: LISTED_EVENT_URI, did: HOST, collection: 'community.lexicon.calendar.event', rkey: 'listed1', cid: 'bafy', record: { name: 'Bike Repair 101', startsAt: future } },
      { uri: UNLISTED_EVENT_URI, did: HOST, collection: 'community.lexicon.calendar.event', rkey: 'unlisted1', cid: 'bafy', record: { name: 'Secret meetup', startsAt: future } },
    )
    eventConfigRows.push({ uri: `at://${HOST}/coop.lexicon.event.config/c1`, did: HOST, eventUri: LISTED_EVENT_URI, visibility: 'listed' })

    const profile = await memberProfile(HOST, ALICE)
    expect(profile!.hosting).toEqual([{ uri: LISTED_EVENT_URI, name: 'Bike Repair 101', startsAt: future }])
  })

  it('resources are limited to this member\'s own', async () => {
    if (!available) return
    await signIn(ALICE)
    await signIn(BOB)
    resourceRecords.push(
      { uri: `at://${ALICE}/freeschool.draft.resource/res1`, did: ALICE, collection: 'freeschool.draft.resource', rkey: 'res1', cid: 'bafy', record: { title: 'Alice notes', skills: [SKILL_A] } },
      { uri: `at://${BOB}/freeschool.draft.resource/res2`, did: BOB, collection: 'freeschool.draft.resource', rkey: 'res2', cid: 'bafy', record: { title: 'Bob notes', skills: [SKILL_A] } },
    )
    const profile = await memberProfile(ALICE, BOB)
    expect(profile!.resources).toEqual([{ id: `at://${ALICE}/freeschool.draft.resource/res1`, title: 'Alice notes' }])
  })
})

describe('peopleForSkill', () => {
  it('excludes hidden members, includes count + capped members with level and vouchCount', async () => {
    if (!available) return
    await signIn(ALICE)
    await signIn(HIDDEN)
    await hide(HIDDEN)
    await addCustodial(ALICE, 'alice-people.test')
    await claimSkill(ALICE, SKILL_A, { level: 'teaching' })
    await claimSkill(HIDDEN, SKILL_A, { level: 'learning' })
    await createAttestation({ attesterDid: BOB, subjectDid: ALICE, skillUri: SKILL_A })

    const people = await peopleForSkill(SKILL_A, BOB)
    expect(people.count).toBe(1)
    expect(people.members).toEqual([expect.objectContaining({ did: ALICE, handle: 'alice-people.test', level: 'teaching', vouchCount: 1 })])
  })
})

describe('HTTP: GET /api/members', () => {
  it('401 without a session', async () => {
    if (!available) return
    const res = await createApp().request('/api/members')
    expect(res.status).toBe(401)
  })

  it('200 with X-Robots-Tag, excludes hidden members, honors q and skill', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)
    await signIn(HIDDEN)
    await hide(HIDDEN)
    await setProfile(ALICE, { displayName: 'Alice Bikeshop' })
    await claimSkill(ALICE, SKILL_A)

    const res = await createApp().request('/api/members', { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
    const body = (await res.json()) as { members: Array<{ did: string }> }
    expect(body.members.map((m) => m.did)).toEqual([ALICE])

    const byQ = await createApp().request('/api/members?q=bike', { headers: { Cookie: cookie } })
    expect(((await byQ.json()) as { members: Array<{ did: string }> }).members.map((m) => m.did)).toEqual([ALICE])

    const bySkill = await createApp().request(`/api/members?skill=${encodeURIComponent(SKILL_A)}`, { headers: { Cookie: cookie } })
    expect(((await bySkill.json()) as { members: Array<{ did: string }> }).members.map((m) => m.did)).toEqual([ALICE])
  })
})

describe('HTTP: GET /api/members/:did', () => {
  it('404 for a hidden member; 200 for the member viewing themselves', async () => {
    if (!available) return
    const viewerCookie = await signIn(ALICE)
    const hiddenCookie = await signIn(HIDDEN)
    await hide(HIDDEN)

    const forbidden = await createApp().request(`/api/members/${encodeURIComponent(HIDDEN)}`, { headers: { Cookie: viewerCookie } })
    expect(forbidden.status).toBe(404)

    const self = await createApp().request(`/api/members/${encodeURIComponent(HIDDEN)}`, { headers: { Cookie: hiddenCookie } })
    expect(self.status).toBe(200)
    expect((await self.json() as { did: string }).did).toBe(HIDDEN)
  })
})

describe('HTTP: GET /api/members/:did/avatar', () => {
  it('404 without an avatar, 200 with the stored bytes and content-type', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)
    const none = await createApp().request(`/api/members/${encodeURIComponent(ALICE)}/avatar`, { headers: { Cookie: cookie } })
    expect(none.status).toBe(404)

    const bytes = Buffer.from('fake-webp-bytes')
    await setProfile(ALICE, { avatar: { data: bytes.toString('base64'), alt: 'me', revision: 'r1' } })
    const res = await createApp().request(`/api/members/${encodeURIComponent(ALICE)}/avatar`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/webp')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  })
})

describe('HTTP: PUT /api/me accepts directoryListing', () => {
  it('toggling it off removes the member from another viewer\'s directory', async () => {
    if (!available) return
    const aliceCookie = await signIn(ALICE)
    const bobCookie = await signIn(BOB)

    const before = await createApp().request('/api/members', { headers: { Cookie: bobCookie } })
    expect(((await before.json()) as { members: Array<{ did: string }> }).members.map((m) => m.did).sort()).toEqual([ALICE, BOB].sort())

    const put = await createApp().request('/api/me', {
      method: 'PUT',
      headers: { Cookie: aliceCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ directoryListing: false }),
    })
    expect(put.status).toBe(200)
    expect((await put.json()) as { directoryListing: boolean }).toMatchObject({ directoryListing: false })

    const after = await createApp().request('/api/members', { headers: { Cookie: bobCookie } })
    expect(((await after.json()) as { members: Array<{ did: string }> }).members.map((m) => m.did)).toEqual([BOB])

    const meRes = await createApp().request('/api/me', { headers: { Cookie: aliceCookie } })
    expect((await meRes.json() as { directoryListing: boolean }).directoryListing).toBe(false)
  })
})

describe('HTTP: GET /api/skills/:id people', () => {
  it('omits people for an anonymous reader, includes it for a signed-in viewer, excludes hidden members', async () => {
    if (!available) return
    const cookie = await signIn(ALICE)
    await signIn(HIDDEN)
    await hide(HIDDEN)
    await claimSkill(ALICE, SKILL_A, { level: 'teaching' })
    await claimSkill(HIDDEN, SKILL_A, { level: 'learning' })

    const anon = await createApp().request(`/api/skills/${encodeURIComponent(SKILL_A)}`)
    expect(anon.status).toBe(200)
    expect((await anon.json()) as Record<string, unknown>).not.toHaveProperty('people')

    const signed = await createApp().request(`/api/skills/${encodeURIComponent(SKILL_A)}`, { headers: { Cookie: cookie } })
    expect(signed.status).toBe(200)
    const body = (await signed.json()) as { people: { count: number; members: Array<{ did: string }> } }
    expect(body.people.count).toBe(1)
    expect(body.people.members.map((m) => m.did)).toEqual([ALICE])
  })
})
