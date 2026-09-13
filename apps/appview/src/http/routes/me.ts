/**
 * `/api/me/*`
 *
 *   GET /            my derived role, the evidence behind it, and my own RSVPs
 *   PUT /skill-claims  write `freeschool.draft.skillClaim` records into MY OWN repo
 *
 * `visibility` on a skill claim: 'public' writes the record to the repo (it is a public
 * claim about oneself, which is the point); 'school' keeps it app-side so it informs
 * matching and the request queue without broadcasting it. The protocol has no way to
 * express a private record in v1, so 'school' genuinely means "not written".
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { evidenceFor, roleOf } from '../../lib/roles.js'
import { myRsvps } from '../../lib/rsvp.js'
import { actorAgent, NoActorCredentialError } from '../../lib/actor-agent.js'
import { NSID } from '../../lexicons/nsids.js'
import { tid } from '../../lib/ids.js'
import { getIndexer } from '../../index/indexer.js'
import { getDb } from '../../db/index.js'
import { appMeta } from '../../db/schema.js'
import { getThresholds } from '../../lib/policy.js'

export const me = new Hono<AppEnv>()

me.use('*', requireViewer)

me.get('/', async (c) => {
  const did = c.var.viewer!.did
  const [role, evidence, thresholds, rsvps] = await Promise.all([
    roleOf(did),
    evidenceFor(did),
    getThresholds(),
    myRsvps(did),
  ])
  return c.json({
    did,
    role,
    // Showing the evidence is deliberate: a derived role that cannot be explained to the
    // person it applies to is indistinguishable from an arbitrary one.
    evidence,
    thresholds,
    rsvps: rsvps.map((r) => ({ eventUri: r.eventUri, status: r.status, alsoPublicRecord: r.alsoPublicRecord })),
  })
})

const claimsBody = z.object({
  claims: z
    .array(
      z.object({
        skill: z.string().startsWith('at://'),
        level: z.enum(['learning', 'practicing', 'proficient', 'teaching']),
        note: z.string().max(2560).optional(),
        visibility: z.enum(['public', 'school']).default('public'),
      }),
    )
    .max(200),
})

const APP_SIDE_CLAIMS_KEY = (did: string) => `skill-claims:${did}`

me.put('/skill-claims', async (c) => {
  const parsed = claimsBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  const now = new Date().toISOString()

  const published: Array<{ uri: string; skill: string; level: string }> = []
  const appSide: Array<{ skill: string; level: string; note?: string }> = []

  const toPublish = parsed.data.claims.filter((x) => x.visibility === 'public')
  if (toPublish.length > 0) {
    try {
      const agent = await actorAgent(viewer)
      for (const claim of toPublish) {
        const res = await agent.com.atproto.repo.putRecord({
          repo: viewer.did,
          collection: NSID.skillClaim,
          // Deterministic-ish: one claim per skill, so re-stating a level updates rather
          // than accumulating. The rkey is derived from the skill's rkey.
          rkey: (claim.skill.split('/').pop() ?? tid()).slice(0, 15),
          record: {
            $type: NSID.skillClaim,
            skill: claim.skill,
            level: claim.level,
            ...(claim.note ? { note: claim.note } : {}),
            createdAt: now,
          } as Record<string, unknown>,
          validate: false,
        })
        published.push({ uri: res.data.uri, skill: claim.skill, level: claim.level })
      }
      const indexer = await getIndexer()
      await indexer.notify(published.map((p) => p.uri)).catch(() => {})
    } catch (err) {
      if (err instanceof NoActorCredentialError) return c.json({ error: 'ReauthRequired' }, 401)
      throw err
    }
  }

  for (const claim of parsed.data.claims) {
    if (claim.visibility === 'school') {
      appSide.push({ skill: claim.skill, level: claim.level, ...(claim.note ? { note: claim.note } : {}) })
    }
  }
  await getDb()
    .insert(appMeta)
    .values({ key: APP_SIDE_CLAIMS_KEY(viewer.did), value: appSide, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: appSide, updatedAt: new Date() } })

  return c.json({ published, keptAppSide: appSide.length })
})

me.get('/skill-claims', async (c) => {
  const viewer = c.var.viewer!
  const indexer = await getIndexer()
  const res = await indexer.contrail.query('skillClaim', { did: viewer.did, limit: 200 }, indexer.db)
  const rows = await getDb()
    .select()
    .from(appMeta)
    .where(and(eq(appMeta.key, APP_SIDE_CLAIMS_KEY(viewer.did))))
    .limit(1)
  return c.json({
    public: res.records.map((r) => ({ uri: r.uri, value: JSON.parse(r.record ?? '{}') })),
    school: rows[0]?.value ?? [],
  })
})
