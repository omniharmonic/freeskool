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

export async function resolveHandle(handle: string, base = config().PDS_URL): Promise<string | null> {
  const url = `${base.replace(/\/$/, '')}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = (await res.json()) as { did?: string }
  return json.did ?? null
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
