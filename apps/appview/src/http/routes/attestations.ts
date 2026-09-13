/**
 * `/api/attestations` — app-side skill vouching (R9: no public record).
 *
 * POST   { subjectDid, skillUri, contextEventUri? } -> 201 { id }
 * DELETE /:id                                        -> 204 (only the attester)
 *
 * Never indexed by a search engine: every route sets `X-Robots-Tag`, same convention
 * as the rest of `/api/me`.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { AttestationError, createAttestation, removeAttestation } from '../../lib/attestations.js'
import { getDb } from '../../db/index.js'
import { attestation } from '../../db/schema.js'

export const attestations = new Hono<AppEnv>()

attestations.use('*', async (c, next) => {
  c.header('X-Robots-Tag', 'noindex, nofollow')
  await next()
})

const createBody = z.object({
  subjectDid: z.string().startsWith('did:'),
  skillUri: z.string().startsWith('at://'),
  contextEventUri: z.string().startsWith('at://').optional(),
})

attestations.post('/attestations', requireViewer, async (c) => {
  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)
  const viewer = c.var.viewer!
  try {
    const { id } = await createAttestation({
      attesterDid: viewer.did,
      subjectDid: parsed.data.subjectDid,
      skillUri: parsed.data.skillUri,
      contextEventUri: parsed.data.contextEventUri,
    })
    return c.json({ id }, 201)
  } catch (err) {
    if (err instanceof AttestationError) return c.json({ error: err.code, message: err.message }, err.status)
    throw err
  }
})

attestations.delete('/attestations/:id', requireViewer, async (c) => {
  const id = c.req.param('id')
  const viewer = c.var.viewer!
  const removed = await removeAttestation(id, viewer.did)
  if (removed) return c.body(null, 204)
  // Distinguish "not yours" from "not there" — the boolean from `removeAttestation`
  // alone cannot, so one cheap lookup decides which error this is.
  const rows = await getDb().select({ id: attestation.id }).from(attestation).where(eq(attestation.id, id)).limit(1)
  if (rows.length === 0) return c.json({ error: 'NotFound' }, 404)
  return c.json({ error: 'Forbidden' }, 403)
})
