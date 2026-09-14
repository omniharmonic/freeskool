/**
 * Our reference PDS, from two angles:
 *
 *  1. ADMIN — `com.atproto.server.createInviteCode` then `createAccount`. This is the
 *     primary door (new Free School identity). The admin password never leaves here.
 *  2. SESSION — an app-password `AtpAgent` per actor. Used for the school DID (behind
 *     `SchoolActorPort`, and nowhere else) and for custodial members, whose password we
 *     hold wrapped.
 */
import { AtpAgent, type AtpSessionData } from '@atproto/api'
import { config } from '../config.js'
import { log } from './logging.js'

export class PdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'PdsError'
  }
}

function adminAuth(): string {
  const pw = config().PDS_ADMIN_PASSWORD
  if (!pw) throw new Error('PDS_ADMIN_PASSWORD is not set')
  return `Basic ${Buffer.from(`admin:${pw}`).toString('base64')}`
}

async function xrpc<T>(
  method: string,
  body: unknown,
  opts: { admin?: boolean; base?: string } = {},
): Promise<T> {
  const base = (opts.base ?? config().PDS_URL).replace(/\/$/, '')
  const res = await fetch(`${base}/xrpc/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(opts.admin ? { authorization: adminAuth() } : {}),
    },
    body: JSON.stringify(body ?? {}),
  })
  const text = await res.text()
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) {
    throw new PdsError(
      typeof json.message === 'string' ? json.message : `PDS ${method} failed`,
      res.status,
      typeof json.error === 'string' ? json.error : undefined,
    )
  }
  return json as T
}

export async function createInviteCode(useCount = 1): Promise<string> {
  const out = await xrpc<{ code: string }>('com.atproto.server.createInviteCode', { useCount }, { admin: true })
  return out.code
}

/**
 * `takeOwnership`'s step 2: rotate a custodial account's PDS password to a fresh random
 * one, admin-side, WITHOUT the member's old password or any session of theirs. This is
 * what lets us hand the member a working password once (`lib/custody.ts#takeOwnership`)
 * without ever routing through (or invalidating) the session-based password-change flow.
 */
export async function updateAccountPassword(did: string, password: string): Promise<void> {
  await xrpc<{ success: boolean }>('com.atproto.admin.updateAccountPassword', { did, password }, { admin: true })
}

export interface AdminAccountSummary {
  did: string
  handle: string
}

/**
 * `custody.ts#signup`'s orphan self-heal: `createAccount` failed because the PDS says
 * the email is already taken, but we hold no `fs_custodial_account` row for it — a prior
 * signup got as far as minting the PDS account and then lost the mail send (or crashed)
 * before we ever recorded it. This is how we find that stranded account back by email,
 * admin-side, so it can be adopted rather than leaving every future attempt 502ing
 * forever against an account nobody can reach.
 */
export async function searchAccountByEmail(email: string): Promise<AdminAccountSummary | null> {
  // `com.atproto.admin.searchAccounts` is guarded by the PDS's *moderator* verifier, which
  // only accepts a service-auth Bearer from a configured mod service — never the Basic
  // admin token we hold ("Unexpected authorization type", verified against pds 0.4).
  // `getAccountInfos` DOES accept the admin token and returns each account's email, so we
  // walk the repo list (public) and look the candidates up in batches. Fine for a school
  // PDS with hundreds of accounts; revisit if it ever holds tens of thousands.
  const wanted = email.trim().toLowerCase()
  const base = config().PDS_URL.replace(/\/$/, '')
  const matches: AdminAccountSummary[] = []
  let cursor: string | undefined
  do {
    const listUrl = new URL('/xrpc/com.atproto.sync.listRepos', base)
    listUrl.searchParams.set('limit', '500')
    if (cursor) listUrl.searchParams.set('cursor', cursor)
    const listRes = await fetch(listUrl)
    const listJson = (await listRes.json().catch(() => ({}))) as { repos?: Array<{ did?: string }>; cursor?: string; error?: string; message?: string }
    if (!listRes.ok) throw new PdsError(listJson.message ?? 'PDS com.atproto.sync.listRepos failed', listRes.status, listJson.error)
    const dids = (listJson.repos ?? []).map((r) => r.did).filter((d): d is string => typeof d === 'string')
    for (let i = 0; i < dids.length; i += 50) {
      const infoUrl = new URL('/xrpc/com.atproto.admin.getAccountInfos', base)
      for (const did of dids.slice(i, i + 50)) infoUrl.searchParams.append('dids', did)
      const infoRes = await fetch(infoUrl, { headers: { authorization: adminAuth() } })
      const infoJson = (await infoRes.json().catch(() => ({}))) as { infos?: Array<{ did?: string; handle?: string; email?: string }>; error?: string; message?: string }
      if (!infoRes.ok) throw new PdsError(infoJson.message ?? 'PDS com.atproto.admin.getAccountInfos failed', infoRes.status, infoJson.error)
      for (const info of infoJson.infos ?? []) {
        if (info.email?.trim().toLowerCase() === wanted && info.did && info.handle) matches.push({ did: info.did, handle: info.handle })
      }
    }
    cursor = listJson.cursor && (listJson.repos?.length ?? 0) > 0 ? listJson.cursor : undefined
  } while (cursor)
  // More than one match means we cannot safely say WHICH account this email's orphan
  // self-heal should adopt — refuse rather than guess.
  if (matches.length > 1) {
    log.warn('admin account lookup returned more than one match for a signup email')
    return null
  }
  return matches[0] ?? null
}

export interface CreatedAccount {
  did: string
  handle: string
  accessJwt: string
  refreshJwt: string
}

export async function createAccount(input: {
  email: string
  handle: string
  password: string
  inviteCode: string
}): Promise<CreatedAccount> {
  return xrpc<CreatedAccount>('com.atproto.server.createAccount', input)
}

/**
 * `null` means "no such handle" — the ONLY thing a caller (e.g. `routes/me.ts`'s
 * handle-availability check) may read as "available". Review round 1 (blocking): the
 * previous version treated ANY non-ok response as "no such handle", so a PDS outage made
 * `GET /api/me/handle/check` answer `available: true`. Now only the PDS's genuine
 * not-found answer (400, in either spelling a real PDS uses) returns `null`; anything
 * else non-2xx — a 5xx, a differently-shaped 400 — throws `PdsError` instead, so the
 * caller can tell "not registered" apart from "could not ask".
 */
export async function resolveHandle(handle: string, base = config().PDS_URL): Promise<string | null> {
  const url = `${base.replace(/\/$/, '')}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  const res = await fetch(url)
  if (res.ok) {
    const json = (await res.json()) as { did?: string }
    return json.did ?? null
  }
  const text = await res.text()
  const json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  const error = typeof json.error === 'string' ? json.error : undefined
  const message = typeof json.message === 'string' ? json.message : undefined
  if (res.status === 400 && (error === 'HandleNotFound' || (error === 'InvalidRequest' && message === 'Unable to resolve handle'))) {
    return null
  }
  throw new PdsError(message ?? 'PDS com.atproto.identity.resolveHandle failed', res.status, error)
}

/** An authenticated agent for one actor. Callers must NOT cache the school's agent. */
export async function agentForAppPassword(
  identifier: string,
  password: string,
  service = config().PDS_URL,
): Promise<{ agent: AtpAgent; session: AtpSessionData }> {
  const agent = new AtpAgent({ service })
  const res = await agent.login({ identifier, password })
  return { agent, session: res.data as unknown as AtpSessionData }
}

export interface PutRecordInput {
  repo: string
  collection: string
  rkey: string
  record: unknown
  swapRecord?: string | null
  validate?: boolean
}

export async function putRecord(agent: AtpAgent, input: PutRecordInput): Promise<{ uri: string; cid: string }> {
  const res = await agent.com.atproto.repo.putRecord({
    repo: input.repo,
    collection: input.collection,
    rkey: input.rkey,
    record: input.record as Record<string, unknown>,
    // Our `freeschool.draft.*` lexicons are not published to the network, so the PDS
    // cannot resolve them; asking it to validate would reject every sidecar.
    validate: input.validate ?? false,
    ...(input.swapRecord === undefined ? {} : { swapRecord: input.swapRecord }),
  })
  return { uri: res.data.uri, cid: res.data.cid }
}

export async function createRecord(
  agent: AtpAgent,
  input: { repo: string; collection: string; rkey?: string; record: unknown },
): Promise<{ uri: string; cid: string }> {
  const res = await agent.com.atproto.repo.createRecord({
    repo: input.repo,
    collection: input.collection,
    ...(input.rkey ? { rkey: input.rkey } : {}),
    record: input.record as Record<string, unknown>,
    validate: false,
  })
  return { uri: res.data.uri, cid: res.data.cid }
}

export async function deleteRecord(
  agent: AtpAgent,
  input: { repo: string; collection: string; rkey: string },
): Promise<void> {
  await agent.com.atproto.repo.deleteRecord(input)
}

export async function getRecord(
  repo: string,
  collection: string,
  rkey: string,
  base = config().PDS_URL,
): Promise<{ uri: string; cid?: string; value: Record<string, unknown> } | null> {
  const url = new URL('/xrpc/com.atproto.repo.getRecord', base)
  url.searchParams.set('repo', repo)
  url.searchParams.set('collection', collection)
  url.searchParams.set('rkey', rkey)
  const res = await fetch(url)
  if (!res.ok) return null
  return (await res.json()) as { uri: string; cid?: string; value: Record<string, unknown> }
}

export async function listRecords(
  repo: string,
  collection: string,
  base = config().PDS_URL,
  limit = 100,
): Promise<Array<{ uri: string; cid: string; value: Record<string, unknown> }>> {
  const url = new URL('/xrpc/com.atproto.repo.listRecords', base)
  url.searchParams.set('repo', repo)
  url.searchParams.set('collection', collection)
  url.searchParams.set('limit', String(limit))
  const res = await fetch(url)
  if (!res.ok) return []
  const json = (await res.json()) as { records?: Array<{ uri: string; cid: string; value: Record<string, unknown> }> }
  return json.records ?? []
}
