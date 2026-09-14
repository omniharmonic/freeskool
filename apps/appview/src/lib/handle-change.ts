/**
 * Choosing a handle (Task 6), factored out of `http/routes/me.ts`'s `PUT /api/me/handle`
 * so the route and `scripts/seed-demo.ts` take the SAME path: normalize → validate →
 * rate-limit → `com.atproto.identity.updateHandle` → `fs_custodial_account` →
 * `fs_app_meta` handle cache → record the change.
 *
 * Returns a result rather than throwing, so the HTTP route is a `switch` over statuses
 * and the seed can simply look at `ok`.
 *
 * `handle:<did>` in `fs_app_meta` is the same best-effort cache `lib/bsky-profile.ts`'s
 * `cacheHandle` writes and `routes/me.ts#handlesForDids` reads as its last resort — kept
 * in the same shape (`{ handle, resolvedAt }`) so either writer can update it.
 */
import { XRPCError } from '@atproto/api'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { appMeta, custodialAccount } from '../db/schema.js'
import { config } from '../config.js'
import type { Viewer } from '../http/session.js'
import { actorAgent } from './actor-agent.js'
import { isValidChosenHandle, normalizeHandlePrefix } from './handles.js'
import { PdsError, resolveHandle } from './pds.js'

export const HANDLE_CACHE_KEY = (did: string) => `handle:${did}`
const HANDLE_CHANGES_KEY = (did: string) => `handle-changes:${did}`
export const HANDLE_CHANGE_LIMIT = 3
export const HANDLE_CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000

/** Taken locally (another custodial member holds it) OR resolvable on the network. */
export async function isHandleTaken(fullHandle: string): Promise<boolean> {
  const rows = await getDb()
    .select({ did: custodialAccount.did })
    .from(custodialAccount)
    .where(eq(custodialAccount.handle, fullHandle))
    .limit(1)
  if (rows.length > 0) return true
  return (await resolveHandle(fullHandle)) != null
}

/** Recent (within the last 24h) handle-change timestamps for `did`, oldest first. */
async function recentHandleChanges(did: string): Promise<string[]> {
  const rows = await getDb().select({ value: appMeta.value }).from(appMeta).where(eq(appMeta.key, HANDLE_CHANGES_KEY(did))).limit(1)
  const all = Array.isArray(rows[0]?.value) ? (rows[0]!.value as string[]) : []
  const cutoff = Date.now() - HANDLE_CHANGE_WINDOW_MS
  return all.filter((iso) => new Date(iso).getTime() > cutoff)
}

async function recordHandleChange(did: string, recent: string[]): Promise<void> {
  const value = [...recent, new Date().toISOString()]
  await getDb()
    .insert(appMeta)
    .values({ key: HANDLE_CHANGES_KEY(did), value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } })
}

export type SetChosenHandleResult =
  | { ok: true; handle: string }
  | {
      ok: false
      status: 400 | 403 | 409 | 429 | 502
      error: 'NotCustodial' | 'InvalidHandle' | 'HandleTaken' | 'TooManyHandleChanges' | 'PdsUnavailable'
      reason?: 'invalid' | 'reserved'
      message?: string
    }

export async function setChosenHandle(viewer: Viewer, rawPrefix: string): Promise<SetChosenHandleResult> {
  if (viewer.kind !== 'custodial') return { ok: false, status: 403, error: 'NotCustodial' }

  const prefix = normalizeHandlePrefix(rawPrefix)
  const format = isValidChosenHandle(prefix)
  if (!format.ok) return { ok: false, status: 400, error: 'InvalidHandle', reason: format.reason }

  const recent = await recentHandleChanges(viewer.did)
  if (recent.length >= HANDLE_CHANGE_LIMIT) {
    return {
      ok: false,
      status: 429,
      error: 'TooManyHandleChanges',
      message: `at most ${HANDLE_CHANGE_LIMIT} handle changes per day`,
    }
  }

  const fullHandle = `${prefix}.${config().handleDomain}`

  try {
    const agent = await actorAgent(viewer)
    await agent.com.atproto.identity.updateHandle({ handle: fullHandle })
  } catch (err) {
    if (err instanceof XRPCError && err.error === 'HandleNotAvailable') return { ok: false, status: 409, error: 'HandleTaken' }
    if (err instanceof XRPCError && err.error === 'InvalidHandle') return { ok: false, status: 400, error: 'InvalidHandle' }
    // Defensive, matching the check endpoint's mapping: a PdsError here means the PDS
    // could not be reached/answered at all, never that the handle is unavailable.
    if (err instanceof PdsError) return { ok: false, status: 502, error: 'PdsUnavailable' }
    throw err
  }

  const now = new Date()
  await getDb().update(custodialAccount).set({ handle: fullHandle }).where(eq(custodialAccount.did, viewer.did))
  const cached = { handle: fullHandle, resolvedAt: now.toISOString() }
  await getDb()
    .insert(appMeta)
    .values({ key: HANDLE_CACHE_KEY(viewer.did), value: cached, updatedAt: now })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: cached, updatedAt: now } })
  await recordHandleChange(viewer.did, recent)

  return { ok: true, handle: fullHandle }
}
