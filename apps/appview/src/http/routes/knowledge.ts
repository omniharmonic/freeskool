/** Public, author-owned knowledge records; practitioner profiles are explicitly opt-in. */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import { requireRole, requireViewer, type AppEnv } from '../session.js'
import { getIndexer } from '../../index/indexer.js'
import {
  getRecordByUri,
  listCollection,
  parseAtUri,
} from '../../index/queries.js'
import { actorAgent } from '../../lib/actor-agent.js'
import { NSID } from '../../lexicons/nsids.js'
import { tid } from '../../lib/ids.js'
import { getDb } from '../../db/index.js'
import { appMeta, membership } from '../../db/schema.js'
import { currentSchool } from '../school-context.js'
import { PROFILE_KEY, type Profile } from './me.js'
import { loadEvent } from './events.js'

export const knowledge = new Hono<AppEnv>()
export const resourceInput = z
  .object({
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(1000).optional(),
    skills: z.array(z.string().startsWith('at://')).min(1).max(8),
    uri: z
      .string()
      .url()
      .refine(
        (value) => ['http:', 'https:'].includes(new URL(value).protocol),
        'Use an HTTP or HTTPS link',
      )
      .optional(),
    license: z.string().trim().max(40).optional(),
    event: z
      .object({ uri: z.string().startsWith('at://'), cid: z.string() })
      .optional(),
  })
  .strict()

const publicClaim = z.object({
  skill: z.string().startsWith('at://'),
  level: z.enum(['learning', 'practicing', 'proficient', 'teaching']),
  note: z.string().max(2560).optional(),
})

async function profileFor(did: string) {
  const [row] = await getDb()
    .select()
    .from(appMeta)
    .where(eq(appMeta.key, PROFILE_KEY(did)))
  const profile = row?.value as Profile | undefined
  return profile?.publicListing ? profile : undefined
}
async function publicSummaries(dids: string[]) {
  if (!dids.length) return new Map<string, Profile>()
  const rows = await getDb()
    .select({
      key: appMeta.key,
      value: sql<Profile>`${appMeta.value} - 'avatar'`,
    })
    .from(appMeta)
    .where(inArray(appMeta.key, dids.map(PROFILE_KEY)))
  return new Map(
    rows
      .filter((r) => r.value.publicListing)
      .map((r) => [r.key.slice('profile:'.length), r.value]),
  )
}
/** Narrows `dids` to the ones with a current (non-left) `fs_membership` row in `schoolDid`. */
async function didsInSchool(dids: string[], schoolDid: string): Promise<string[]> {
  if (dids.length === 0) return []
  const rows = await getDb()
    .select({ did: membership.did })
    .from(membership)
    .where(and(inArray(membership.did, dids), eq(membership.schoolDid, schoolDid), isNull(membership.leftAt)))
  return rows.map((r) => r.did)
}
/** Exported for `lib/members.ts`'s member-profile "resources" list (author-owned, public-visible only). */
export async function resources(
  options: { author?: string; owner?: string; id?: string } = {},
) {
  const indexer = await getIndexer()
  const single = options.id
    ? await getRecordByUri(indexer, 'resource', options.id)
    : undefined
  const { records } = options.id
    ? { records: single ? [single] : [] }
    : await listCollection(indexer, 'resource', {
        limit: 1000,
        ...(options.author ? { did: options.author } : {}),
      })
  const hidden = await getDb()
    .select()
    .from(appMeta)
    .where(
      sql`${appMeta.key} like 'resource-hidden:%' OR ${appMeta.key} like 'resource-deleted:%'`,
    )
  const excluded = new Set(
    hidden
      .filter((r) => r.value === true && r.key.startsWith('resource-hidden:'))
      .map((r) => r.key.slice('resource-hidden:'.length)),
  )
  const deleted = new Set(
    hidden
      .filter((r) => r.value === true && r.key.startsWith('resource-deleted:'))
      .map((r) => r.key.slice('resource-deleted:'.length)),
  )
  const profiles = await publicSummaries([
    ...new Set(records.map((r) => r.did)),
  ])
  const result = []
  for (const record of records) {
    if (
      deleted.has(record.uri) ||
      (options.author && record.did !== options.author)
    )
      continue
    const isOwner = options.owner === record.did
    if (excluded.has(record.uri) && !isOwner) continue
    const parsed = resourceInput.safeParse({
      title: record.value.title,
      description: record.value.description,
      skills: record.value.skills,
      uri: record.value.uri,
      license: record.value.license,
      event: record.value.event,
    })
    if (!parsed.success) continue
    // Public resources must not become a back door to private class identifiers.
    const unlistedClass = Boolean(
      parsed.data.event && !(await loadEvent(parsed.data.event.uri))?.listed,
    )
    if (unlistedClass && !isOwner) continue
    const profile = profiles.get(record.did)
    result.push({
      id: record.uri,
      authorDid: record.did,
      authorName: profile?.displayName || 'Community contributor',
      authorHasProfile: Boolean(profile),
      ...parsed.data,
      ...(isOwner && (excluded.has(record.uri) || unlistedClass)
        ? {
            libraryStatus: excluded.has(record.uri)
              ? ('moderated' as const)
              : ('class-unlisted' as const),
          }
        : {}),
      createdAt:
        typeof record.value.createdAt === 'string'
          ? record.value.createdAt
          : undefined,
    })
  }
  return result
}
knowledge.get('/resources', async (c) => {
  const skill = c.req.query('skill'),
    author = c.req.query('author'),
    event = c.req.query('event')
  return c.json({
    resources: (await resources()).filter(
      (r) =>
        (!skill || r.skills.includes(skill)) &&
        (!author || r.authorDid === author) &&
        (!event || r.event?.uri === event),
    ),
  })
})
knowledge.get('/my-resources', requireViewer, async (c) =>
  c.json({
    resources: await resources({
      author: c.var.viewer!.did,
      owner: c.var.viewer!.did,
    }),
  }),
)
knowledge.get('/resources/:id', async (c) => {
  const resource = (
    await resources({ id: c.req.param('id'), owner: c.var.viewer?.did })
  )[0]
  return resource ? c.json(resource) : c.json({ error: 'NotFound' }, 404)
})
async function writeResource(c: Context<AppEnv>, editId?: string) {
  const viewer = c.var.viewer!
  if (viewer.kind === 'oauth')
    return c.json(
      {
        error: 'PublicTogglesLocked',
        message:
          'Publishing public resources is not enabled for this sign-in method yet.',
      },
      403,
    )
  const parsed = resourceInput.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success)
    return c.json(
      {
        error: 'InvalidRequest',
        message: 'Add a title, at least one skill, and a valid link or a note.',
      },
      400,
    )
  if (!parsed.data.description && !parsed.data.uri)
    return c.json(
      {
        error: 'InvalidRequest',
        message: 'Add a note or a link to the resource.',
      },
      400,
    )
  const indexer = await getIndexer()
  const prior = editId
    ? await getRecordByUri(indexer, 'resource', editId)
    : undefined
  if (editId) {
    const [deleted] = await getDb()
      .select()
      .from(appMeta)
      .where(eq(appMeta.key, `resource-deleted:${editId}`))
    if (deleted?.value === true) return c.json({ error: 'NotFound' }, 404)
  }
  if (
    editId &&
    (!prior ||
      prior.did !== viewer.did ||
      parseAtUri(editId)?.collection !== NSID.resource)
  )
    return c.json({ error: 'PermissionDenied' }, 403)
  for (const uri of parsed.data.skills)
    if (!(await getRecordByUri(indexer, 'skill', uri)))
      return c.json({ error: 'InvalidSkill' }, 400)
  if (parsed.data.event) {
    const event = await loadEvent(parsed.data.event.uri)
    const sameClass =
      (prior?.value.event as { uri?: string } | undefined)?.uri ===
      parsed.data.event.uri
    if (!event || event.hostDid !== viewer.did || (!event.listed && !sameClass))
      return c.json(
        {
          error: 'InvalidEvent',
          message: 'Only attach your own publicly listed class.',
        },
        400,
      )
    const record = await getRecordByUri(indexer, 'event', parsed.data.event.uri)
    if (!record?.cid) return c.json({ error: 'InvalidEvent' }, 400)
    parsed.data.event.cid = record.cid
  }
  const agent = await actorAgent(viewer)
  const result = await agent.com.atproto.repo.putRecord({
    repo: viewer.did,
    collection: NSID.resource,
    rkey: prior?.rkey ?? tid(),
    record: {
      $type: NSID.resource,
      ...parsed.data,
      ...(prior?.value.file ? { file: prior.value.file } : {}),
      createdAt: prior?.value.createdAt ?? new Date().toISOString(),
    },
  })
  await indexer.notify(result.data.uri)
  return c.json({ id: result.data.uri }, editId ? 200 : 201)
}
knowledge.post('/resources', requireViewer, requireRole(Role.Host), (c) =>
  writeResource(c),
)
knowledge.put('/resources/:id', requireViewer, (c) =>
  writeResource(c, c.req.param('id')),
)
knowledge.delete('/resources/:id', requireViewer, async (c) => {
  const id = c.req.param('id'),
    parts = parseAtUri(id),
    viewer = c.var.viewer!
  if (!parts || parts.collection !== NSID.resource || parts.did !== viewer.did)
    return c.json({ error: 'PermissionDenied' }, 403)
  const agent = await actorAgent(viewer)
  await agent.com.atproto.repo.deleteRecord({
    repo: viewer.did,
    collection: NSID.resource,
    rkey: parts.rkey,
  })
  // A separate tombstone keeps author deletion distinct from reversible school moderation.
  await getDb()
    .insert(appMeta)
    .values({
      key: `resource-deleted:${id}`,
      value: true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: true, updatedAt: new Date() },
    })
  await (await getIndexer()).notify(id).catch(() => undefined)
  return c.json({ ok: true })
})
knowledge.get('/profiles/:did', async (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow')
  const did = c.req.param('did'),
    profile = await profileFor(did)
  if (!profile) return c.json({ error: 'NotFound' }, 404)
  const indexer = await getIndexer()
  const claims = await listCollection(indexer, 'skillClaim', {
    did,
    limit: 100,
  })
  return c.json({
    did,
    displayName: profile.displayName || 'Community contributor',
    bio: profile.bio || '',
    ...(profile.avatar
      ? {
          avatarUrl: `/api/profiles/${encodeURIComponent(did)}/avatar?v=${profile.avatar.revision}`,
        }
      : {}),
    claims: claims.records
      .filter((r) => r.did === did)
      .flatMap((r) => {
        const parsed = publicClaim.safeParse(r.value)
        return parsed.success ? [parsed.data] : []
      }),
    resources: (await resources()).filter((r) => r.authorDid === did),
  })
})
knowledge.get('/profiles/:did/avatar', async (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow')
  const profile = await profileFor(c.req.param('did'))
  if (!profile?.avatar) return c.json({ error: 'NotFound' }, 404)
  c.header('Content-Type', 'image/webp')
  return c.body(new Uint8Array(Buffer.from(profile.avatar.data, 'base64')))
})
/**
 * Who publicly claims this skill. INTEROP GAP 10: this used to scan the first 1000
 * `skillClaim` records in the whole index and filter them in memory, so the list
 * silently went wrong (and then empty) once claims outgrew that window. `skillClaim`
 * declares `skill` queryable in the projection, so the index answers the question
 * directly — the same `filters:` push-down `me.ts` uses for attestations.
 *
 * The `publicListing` opt-in join below is unchanged: an indexed claim is a public
 * record, but appearing in a directory is a separate, explicit choice (R9).
 *
 * SCOPED TO THE VIEWER'S SCHOOL (MS §10: "who claims welding" is answered only within
 * the viewer's school, not globally). The route itself stays public — no session is
 * required — but `currentSchool(c)` still resolves from the request's host, so a
 * Boulder host answers only with Boulder members and a Denver host only with Denver's.
 * Membership, not authorship: `fs_membership` is the roster MS §10 means here, the same
 * table `lib/members.ts#inSchool` reads for the members-only directory.
 */
knowledge.get('/practitioners', async (c) => {
  c.header('X-Robots-Tag', 'noindex, nofollow')
  const skill = c.req.query('skill')
  if (!skill) return c.json({ profiles: [] })
  const { records } = await listCollection(await getIndexer(), 'skillClaim', {
    filters: { skill },
    limit: 1000,
  })
  const valid = records.filter(
    (r) => publicClaim.safeParse(r.value).success && r.value.skill === skill,
  )
  const candidates = [...new Set(valid.map((r) => r.did))]
  const dids = await didsInSchool(candidates, currentSchool(c).did)
  const summaries = await publicSummaries(dids)
  const profiles = []
  for (const did of dids) {
    const p = summaries.get(did)
    if (p)
      profiles.push({
        did,
        displayName: p.displayName || 'Community contributor',
        bio: p.bio || '',
        level: valid.find((r) => r.did === did)?.value.level,
      })
  }
  return c.json({ profiles })
})
