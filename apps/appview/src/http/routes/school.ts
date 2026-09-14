/**
 * `/api/school/*` — public, no session required.
 *
 *   GET /how-it-works   a plain-language, printable explanation of the school,
 *                        rendered live from its school record + current policy
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import { buildHowItWorks } from '../../lib/how-it-works.js'
import { currentSchool } from '../school-context.js'

export const school = new Hono<AppEnv>()

school.get('/school/how-it-works', async (c) => {
  return c.json(await buildHowItWorks(currentSchool(c).did))
})
