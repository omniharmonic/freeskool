/**
 * `/api/schools` — the school lifecycle (MS §8, spec rulings 1, 7 and 10).
 *
 *   GET  /api/schools            public: every school this AppView hosts
 *   POST /api/schools            operator only, `X-Operator-Token`
 *   POST /api/schools/:did/leave a member leaving one of their schools
 *
 * WHAT THE LIST DOES NOT SAY (ruling 7). Name, city, and the host you can visit. No
 * member count, no class count, no steward, no "most active" — "nothing about school B is
 * served to a member of school A except public records", and a roster size is not a public
 * record. A directory of cities is a public fact; how many people are in each one is not.
 *
 * WHO MAY CREATE ONE (ruling 1). `SCHOOL_CREATION=closed`: an operator, holding
 * `OPERATOR_TOKEN`, and nobody else. There is no self-serve door in this phase, because a
 * name minted under `freeskool.xyz` is a reputational surface for every other city on it.
 * `invite` and `open` are the values MS §8 anticipates and this route answers 501 for
 * them: refusing loudly is better than a gate that silently reads as closed.
 *
 * WHY THE TOKEN IS NOT IN `config()`. It is read from `process.env` at the moment of the
 * request rather than at boot: rotating it is then a restart of nothing, and an operator
 * token that lives in the config object is one `GET /health` away from being printed.
 */
import { Hono } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { AppEnv } from '../session.js'
import { requireViewer } from '../session.js'
import { createSchool, listPublicSchools, SchoolCreationError } from '../../lib/schools.js'
import { isMemberOf, leaveSchool } from '../../lib/membership.js'
import { retractRoleClaim } from '../../lib/membership-claims.js'
import type { Did } from '@freeschool/school-actor'
import { describeError, log } from '../../lib/logging.js'

export const schools = new Hono<AppEnv>()

/** `closed` (ruling 1) unless an operator has deliberately said otherwise. */
function creationMode(): string {
  return (process.env.SCHOOL_CREATION ?? 'closed').trim().toLowerCase()
}

/**
 * Constant-time, and false whenever no token is configured: a deployment that never set
 * `OPERATOR_TOKEN` must not be one empty header away from letting anyone mint a city.
 */
function isOperator(presented: string | undefined): boolean {
  const expected = process.env.OPERATOR_TOKEN ?? ''
  if (!expected || !presented) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // `timingSafeEqual` throws on a length mismatch, which would itself be an oracle.
  if (a.length !== b.length) {
    timingSafeEqual(b, b)
    return false
  }
  return timingSafeEqual(a, b)
}

schools.get('/schools', async (c) => {
  return c.json({ schools: await listPublicSchools() })
})

const createBody = z.object({
  label: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  city: z.string().trim().max(120).optional(),
  handleDomain: z.string().trim().max(253).optional(),
  founderDid: z.string().startsWith('did:').max(255).optional(),
})

schools.post('/schools', async (c) => {
  const mode = creationMode()
  if (mode !== 'closed') {
    // `invite` and `open` are MS §8's other two gates. Neither is built, and answering
    // 403 for them would read as "closed", which is a different and wrong answer.
    return c.json({ error: 'NotImplemented', message: `SCHOOL_CREATION=${mode} is not implemented` }, 501)
  }
  if (!isOperator(c.req.header('x-operator-token'))) {
    return c.json({ error: 'Forbidden', message: 'school creation is closed' }, 403)
  }

  const parsed = createBody.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) return c.json({ error: 'InvalidRequest' }, 400)

  try {
    const created = await createSchool({ ...parsed.data, operator: 'operator-token' })
    // DELIBERATELY NOT `appPassword`: the credential is wrapped into
    // `fs_school_credential` and never leaves this process (R3 invariant 1).
    return c.json(
      {
        did: created.did,
        label: created.label,
        name: created.name,
        city: created.city,
        handle: created.handle,
        host: created.host,
      },
      201,
    )
  } catch (err) {
    if (err instanceof SchoolCreationError) {
      return c.json({ error: err.code, message: err.message }, err.status)
    }
    log.warn('school creation failed', { detail: describeError(err) })
    return c.json({ error: 'SchoolCreationFailed', message: 'could not create the school' }, 502)
  }
})

/**
 * LEAVING (ruling 10). The member says so about themselves for one school; no steward is
 * involved and no other school hears about it.
 *
 * 404 and never 403 for a school one is not a member of — including a school that does
 * not exist — because the two must be indistinguishable (MS §10): a 403 on
 * `denver.freeskool.xyz` would tell a stranger that Denver has a roster they are not on.
 */
schools.post('/schools/:did/leave', requireViewer, async (c) => {
  const viewer = c.var.viewer!
  const schoolDid = c.req.param('did')
  if (!(await isMemberOf(viewer.did, schoolDid))) return c.json({ error: 'NotFound' }, 404)

  await leaveSchool(viewer.did, schoolDid)
  // The published `coop.lexicon.membership` claim, if there is one: a public record that
  // names a member of a school they have left is exactly what R9 forbids. Best-effort by
  // construction (`retractRoleClaim` never throws) — the app-side leave has already
  // happened and must not be undone by a PDS that is slow.
  await retractRoleClaim(schoolDid as Did, viewer.did as Did)
  return c.json({ left: true })
})
