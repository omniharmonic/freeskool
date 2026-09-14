/**
 * `searchAccountByEmail` walks `sync.listRepos` + admin `getAccountInfos` because the
 * PDS's `admin.searchAccounts` rejects the Basic admin token (moderator-only verifier).
 */
process.env.PDS_ADMIN_PASSWORD ??= 'test-admin'
process.env.PDS_URL ??= 'http://pds.test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchAccountByEmail, PdsError } from '../src/lib/pds.js'

const infos = [
  { did: 'did:plc:aaa', handle: 'aaa.test', email: 'Demo+Rosa@freeskool.test' },
  { did: 'did:plc:bbb', handle: 'bbb.test', email: 'other@example.org' },
]

function fakeFetch(opts: { pages?: number; infosStatus?: number } = {}) {
  const pages = opts.pages ?? 1
  return vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('com.atproto.sync.listRepos')) {
      const page = Number(url.searchParams.get('cursor') ?? '0')
      const repos = page === 0 ? infos.map((i) => ({ did: i.did })) : [{ did: 'did:plc:ccc' }]
      const next = page + 1 < pages ? String(page + 1) : undefined
      return new Response(JSON.stringify({ repos, ...(next ? { cursor: next } : {}) }), { status: 200 })
    }
    if (url.pathname.endsWith('com.atproto.admin.getAccountInfos')) {
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Basic /)
      if (opts.infosStatus) return new Response(JSON.stringify({ error: 'InvalidToken', message: 'nope' }), { status: opts.infosStatus })
      const dids = url.searchParams.getAll('dids')
      return new Response(JSON.stringify({ infos: infos.filter((i) => dids.includes(i.did)) }), { status: 200 })
    }
    throw new Error(`unexpected ${url}`)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('searchAccountByEmail', () => {
  it('finds the account by email, case-insensitively, via listRepos + getAccountInfos', async () => {
    vi.stubGlobal('fetch', fakeFetch())
    expect(await searchAccountByEmail('demo+rosa@freeskool.test')).toEqual({ did: 'did:plc:aaa', handle: 'aaa.test' })
  })
  it('returns null when no account holds the email', async () => {
    vi.stubGlobal('fetch', fakeFetch())
    expect(await searchAccountByEmail('nobody@example.org')).toBeNull()
  })
  it('follows the listRepos cursor across pages', async () => {
    const f = fakeFetch({ pages: 2 })
    vi.stubGlobal('fetch', f)
    await searchAccountByEmail('nobody@example.org')
    const listCalls = f.mock.calls.filter(([u]) => String(u).includes('listRepos'))
    expect(listCalls).toHaveLength(2)
  })
  it('surfaces an admin auth failure as PdsError instead of reporting "not found"', async () => {
    vi.stubGlobal('fetch', fakeFetch({ infosStatus: 401 }))
    await expect(searchAccountByEmail('demo+rosa@freeskool.test')).rejects.toBeInstanceOf(PdsError)
  })
})
