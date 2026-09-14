/**
 * Task 1 (federation): `GET /internal/tls-check?domain=` — the on-demand TLS gate.
 *
 * Caddy asks this before it will ask Let's Encrypt for a certificate for a name it has
 * never seen. It must answer from KNOWN NAMES and never from a pattern: a gate that says
 * yes to `*.freeskool.xyz` burns the 50-certificates-per-registered-domain-per-week
 * ceiling the first time a bot dials random SNIs at the box (MS §3).
 *
 * Three answers, in order: `www`, a school host (a known label under
 * `SCHOOL_DOMAIN_SUFFIX`, or any host in `fs_school_domain`), and otherwise whatever the
 * PDS says about the handle it issued. A PDS that does not
 * answer is a NO, never a yes — an unanswered check must not mint a certificate.
 *
 * The second rule asks TWO closed sets, config then table, because a city created through
 * `POST /api/schools` exists only in `fs_school_domain` — answering from the env alone
 * would mean no new city could be served until somebody edited `SCHOOL_LABELS` and
 * redeployed, which is exactly what MS §8 step 6 promises it does not take.
 *
 * The third rule spans EVERY handle domain this deployment serves, not one: ruling 3
 * moves member handles from `freeskool.xyz` to `freeskool.directory`, and a handle that
 * has not been rewritten yet must keep renewing its certificate throughout.
 *
 * The domain never reaches a log line (R9): the ask carries the name of a member's handle
 * host, and a certificate log is a membership list.
 */
process.env.WEB_PUBLIC_URL ??= 'https://freeskool.test'
process.env.APPVIEW_PUBLIC_URL ??= 'https://freeskool.test'
process.env.PDS_URL ??= 'http://pds.test'
process.env.PDS_HANDLE_DOMAIN ??= 'freeskool.test'
/** The domain this deployment is moving OFF (federation ruling 3) — see the tests below. */
process.env.PDS_LEGACY_HANDLE_DOMAIN ??= 'old.test'
process.env.SCHOOL_DOMAIN_SUFFIX ??= 'freeskool.test'
process.env.SCHOOL_LABELS ??= 'boulder'
process.env.SCHOOL_HANDLE ??= 'denver.freeskool.test'
process.env.SESSION_SECRET ??= 'tls-check-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 5).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'tls-check-test-pepper'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../src/http/routes/internal.js'
import { createApp } from '../src/http/app.js'
import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { school, schoolDomain } from '../src/db/schema.js'

/** A PDS that vouches for exactly these names and 404s everything else. */
function fakePds(known: string[], opts: { status?: number; throws?: boolean } = {}) {
  return vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(url.pathname).toBe('/tls-check')
    // A check that hangs must not hang Caddy's handshake.
    expect(init?.signal).toBeDefined()
    if (opts.throws) throw new Error('connect ECONNREFUSED')
    if (opts.status) return new Response('', { status: opts.status })
    const domain = url.searchParams.get('domain') ?? ''
    return known.includes(domain)
      ? new Response('', { status: 200 })
      : new Response(JSON.stringify({ error: 'not a registered handle' }), { status: 404 })
  })
}

async function ask(domain: string | null) {
  const query = domain === null ? '' : `?domain=${encodeURIComponent(domain)}`
  return internal.request(`/internal/tls-check${query}`)
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = []
/** Only the `fs_school_domain` cases need a database; everything else answers from config. */
let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

afterAll(async () => {
  if (available) await closeTestDb()
})

beforeEach(() => {
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const spy of consoleSpies) spy.mockRestore()
})

describe('GET /internal/tls-check', () => {
  it('says yes to www on the web host, without asking the PDS', async () => {
    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask('www.freeskool.test')).status).toBe(200)
    expect(pds).not.toHaveBeenCalled()
  })

  it('says yes to a known school label under the school domain suffix, without asking the PDS', async () => {
    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask('boulder.freeskool.test')).status).toBe(200)
    expect(pds).not.toHaveBeenCalled()
  })

  it('says yes to the legacy school whose label comes from SCHOOL_HANDLE', async () => {
    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask('denver.freeskool.test')).status).toBe(200)
    expect(pds).not.toHaveBeenCalled()
  })

  it('normalizes case and a trailing dot before matching', async () => {
    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask('Boulder.FreeSkool.test.')).status).toBe(200)
    expect(pds).not.toHaveBeenCalled()
  })

  it('defers a member handle host to the PDS and passes its yes on', async () => {
    vi.stubGlobal('fetch', fakePds(['calmotter417.freeskool.test']))
    expect((await ask('calmotter417.freeskool.test')).status).toBe(200)
  })

  it('says no when the PDS does not know the name', async () => {
    vi.stubGlobal('fetch', fakePds(['calmotter417.freeskool.test']))
    expect((await ask('nobody.freeskool.test')).status).toBe(403)
  })

  it('says no when the PDS is unreachable, so a failed check never mints a certificate', async () => {
    vi.stubGlobal('fetch', fakePds([], { throws: true }))
    expect((await ask('calmotter417.freeskool.test')).status).toBe(403)
  })

  it('says no when the PDS answers with an error status', async () => {
    vi.stubGlobal('fetch', fakePds([], { status: 500 }))
    expect((await ask('calmotter417.freeskool.test')).status).toBe(403)
  })

  it('says no to a missing or empty domain, without asking the PDS', async () => {
    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask(null)).status).toBe(403)
    expect((await ask('')).status).toBe(403)
    expect(pds).not.toHaveBeenCalled()
  })

  it('says no to a deeper name under the suffix: a school host and a handle host are both one label', async () => {
    // `a.boulder.freeskool.test` is not the Boulder school, and the PDS issues no such handle.
    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask('a.boulder.freeskool.test')).status).toBe(403)
    expect(pds).not.toHaveBeenCalled()
  })

  it('defers a handle host under the LEGACY handle domain too, for the length of the migration', async () => {
    // A member whose DID document still says `calmotter417.old.test` must keep renewing:
    // the day the gate stops vouching for the old domain is the day they stop resolving.
    vi.stubGlobal('fetch', fakePds(['calmotter417.old.test']))
    expect((await ask('calmotter417.old.test')).status).toBe(200)
  })

  it('still asks the PDS about the legacy domain rather than assuming: an unknown name is no', async () => {
    vi.stubGlobal('fetch', fakePds(['calmotter417.old.test']))
    expect((await ask('nobody.old.test')).status).toBe(403)
  })

  it('says yes to a school that exists only in fs_school_domain, without asking the PDS', async () => {
    if (!available) return
    await truncate('fs_school', 'fs_school_domain')
    await testDb()
      .insert(school)
      .values({ did: 'did:plc:tls-runtime', label: 'aurora', name: 'Aurora Free School', handle: 'aurora.test' })
    await testDb()
      .insert(schoolDomain)
      .values({ host: 'aurora.freeskool.test', schoolDid: 'did:plc:tls-runtime', kind: 'canonical' })

    // `aurora` is NOT in SCHOOL_LABELS: a city created through `POST /api/schools` must be
    // servable the moment its row exists, without an env edit and a redeploy.
    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask('aurora.freeskool.test')).status).toBe(200)
    expect(pds).not.toHaveBeenCalled()
  })

  it('says yes to a city\u2019s own domain, which no pattern under our suffix could match', async () => {
    if (!available) return
    await truncate('fs_school', 'fs_school_domain')
    await testDb()
      .insert(school)
      .values({ did: 'did:plc:tls-custom', label: 'aurora', name: 'Aurora Free School', handle: 'aurora.test' })
    await testDb()
      .insert(schoolDomain)
      .values({ host: 'aurorafreeskool.org', schoolDid: 'did:plc:tls-custom', kind: 'alias' })

    const pds = fakePds([])
    vi.stubGlobal('fetch', pds)
    expect((await ask('aurorafreeskool.org')).status).toBe(200)
    expect(pds).not.toHaveBeenCalled()
  })

  it('says no to a host under the suffix that no school has claimed', async () => {
    if (!available) return
    await truncate('fs_school', 'fs_school_domain')
    // In neither SCHOOL_LABELS nor fs_school_domain, and the PDS does not know it either.
    vi.stubGlobal('fetch', fakePds([]))
    expect((await ask('aurora.freeskool.test')).status).toBe(403)
  })

  it('says no to a name outside both the web host and the school suffix', async () => {
    vi.stubGlobal('fetch', fakePds(['evil.example']))
    // Even a PDS that said yes cannot get a certificate for a name this stack does not own.
    expect((await ask('evil.example')).status).toBe(403)
  })

  it('never logs the domain', async () => {
    vi.stubGlobal('fetch', fakePds([], { throws: true }))
    await ask('calmotter417.freeskool.test')
    await ask('www.freeskool.test')
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
  })

  it('is mounted on the app outside /api, where only Caddy\'s container-local ask can reach it', async () => {
    vi.stubGlobal('fetch', fakePds([]))
    const app = createApp()
    expect((await app.request('/internal/tls-check?domain=www.freeskool.test')).status).toBe(200)
    // And nowhere under /api, which is the only prefix (with the OAuth documents) the
    // edge proxies to the AppView from a public host.
    expect((await app.request('/api/internal/tls-check?domain=www.freeskool.test')).status).not.toBe(200)
  })

  it('answers with an empty body: the ask is a status code, not a page', async () => {
    vi.stubGlobal('fetch', fakePds([]))
    expect(await (await ask('www.freeskool.test')).text()).toBe('')
    expect(await (await ask('nobody.freeskool.test')).text()).toBe('')
  })
})
