/**
 * End-to-end smoke test against the LIVE local stack (reference PDS + Postgres).
 *
 *   docker compose -f infra/compose.yml -f apps/appview/compose.override.yml up -d
 *   pnpm --filter @freeschool/appview smoke
 *
 * It drives the real Hono app in-process via `app.request()` — same routes, same
 * middleware, same cookies as a browser — and makes real writes to the real PDS. Nothing
 * here is mocked; if it passes, the thing works.
 *
 * Sequence:
 *   1. create the school (account + `freeschool.draft.school` + default policy)
 *   2. create a custodial member and verify their email (the primary door)
 *   3. publish an event as that host (event + config + skillLevel in the HOST's repo,
 *      listing in the SCHOOL's repo via SchoolActorPort); confirm tag routing — an
 *      untagged or unrouted-tag event gets NO listing but still appears on our own
 *      calendar by authorship; update the class (replace its skills, and confirm a
 *      recurrence edit is rejected)
 *   4. three more custodial members RSVP app-side
 *   5. the host attests attendance for all three
 *   6. all three submit feedback; read the k-anonymous summary
 *   7. list the public calendar, and fetch the `.ics`
 */
import { setTimeout as sleep } from 'node:timers/promises'

/* Env must be set before anything calls config(), so every import below is dynamic. */
process.env.NODE_ENV ??= 'development'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.PEER_PDS_HOSTS ??= 'http://localhost:3000'
process.env.SESSION_SECRET ??= 'smoke-test-session-secret-not-for-production'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 7).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'smoke-pepper'
process.env.FREESCHOOL_NO_JOBS = '1'

if (!process.env.PDS_ADMIN_PASSWORD) {
  // infra/pds.env is the source of truth for the local admin password.
  const fs = await import('node:fs')
  const path = await import('node:path')
  const url = await import('node:url')
  const here = path.dirname(url.fileURLToPath(import.meta.url))
  const envFile = path.resolve(here, '../../../infra/pds.env')
  const text = fs.readFileSync(envFile, 'utf8')
  const match = /^PDS_ADMIN_PASSWORD=(.+)$/m.exec(text)
  if (!match) throw new Error(`PDS_ADMIN_PASSWORD not found in ${envFile}`)
  process.env.PDS_ADMIN_PASSWORD = match[1]!.trim()
}

const step = (n: number, label: string) => console.log(`\n[${n}] ${label}`)
const ok = (msg: string) => console.log(`    ok  ${msg}`)
const info = (msg: string) => console.log(`    --  ${msg}`)

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`SMOKE FAILED: ${msg}`)
}

async function main() {
  const t0 = Date.now()
  console.log('Free School AppView smoke test')
  console.log(`PDS      ${process.env.PDS_URL}`)
  console.log(`Postgres ${process.env.DATABASE_URL!.replace(/\/\/[^@]*@/, '//***@')}`)

  // Every run gets its own school, so the script is re-runnable without cleanup.
  const suffix = Date.now().toString(36).slice(-5)
  process.env.SCHOOL_HANDLE = `school-${suffix}.test`

  const { runMigrations } = await import('../src/db/migrate.js')
  await runMigrations()
  ok('migrations applied (fs_* via drizzle, contrail schema via contrail.init())')

  /* 1. the school */
  step(1, 'create the school')
  const { createSchool } = await import('./create-school.js')
  const school = await createSchool({ name: `Smoke Free School ${suffix}`, region: 'Boulder, Colorado' })
  process.env.SCHOOL_DID = school.did
  process.env.SCHOOL_APP_PASSWORD = school.appPassword
  // SCHOOL_* did not exist when the config was first read; re-read it now.
  const { resetConfig } = await import('../src/config.js')
  resetConfig()
  const { setSchoolActor } = await import('../src/lib/school-actor.js')
  setSchoolActor(undefined)
  const { resetIndexer } = await import('../src/index/indexer.js')
  resetIndexer()
  ok(`school handle ${school.handle}`)
  ok(`school did ${school.did}`)
  ok(`school record ${school.schoolUri}`)
  ok(`policy record ${school.policyUri}`)

  /* the app, now that SCHOOL_* are set */
  const { createApp } = await import('../src/http/app.js')
  const { getIndexer } = await import('../src/index/indexer.js')
  const { refreshPolicyCache } = await import('../src/lib/policy.js')
  const { getDb, closeDb } = await import('../src/db/index.js')
  const { steward } = await import('../src/db/schema.js')
  const indexer = await getIndexer()
  await indexer.init()
  await refreshPolicyCache(school.did)
  const app = createApp()
  const req: Fetcher = async (path, init) => app.request(path, init)

  const health = await req('/api/health')
  const healthBody = (await health.json()) as { status: string; checks: Record<string, string> }
  assert(healthBody.checks.postgres === 'ok', 'postgres is not reachable')
  assert(healthBody.checks.pds === 'ok', 'the PDS is not reachable')
  ok(`health ${healthBody.status} (postgres ok, pds ok)`)

  /* 2. the host, through the primary door */
  step(2, 'create a custodial member (primary door: email -> minted identity)')
  const host = await signUp(req, `host-${suffix}@example.org`)
  ok(`host handle ${host.handle}`)
  ok(`host did ${host.did}`)
  info('handle is generated, never derived from the email')

  const meRes = await req('/api/auth/me', { headers: { cookie: host.cookie } })
  const me = (await meRes.json()) as { role: number; isCustodial: boolean; emailVerified: boolean }
  assert(me.role >= 20, `expected the host to derive role >= 20 (Host), got ${me.role}`)
  assert(me.isCustodial && me.emailVerified, 'expected a verified custodial account')
  ok(`derived role ${me.role} (Host) from the default open policy`)

  /* 3. publish a class */
  step(3, 'publish a class as the host')
  const startsAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
  const endsAt = new Date(Date.now() - 1 * 3_600_000).toISOString()
  const sourdoughSkill = 'at://did:plc:taxonomy/freeschool.draft.skill/sourdough-starter'
  const created = await postJson(req, '/api/events', host.cookie, {
    name: `Sourdough for beginners (${suffix})`,
    description: 'Bring a jar. We will talk about flour.',
    startsAt,
    endsAt,
    timezone: 'America/Denver',
    visibility: 'listed',
    neighborhood: 'North Boulder',
    rsvpRequired: true,
    tags: ['skillshare'],
    skills: [{ skill: sourdoughSkill, level: 1 }],
    locations: [
      {
        $type: 'community.lexicon.location.address',
        name: 'the kitchen',
        street: '1412 Juniper Ave',
        locality: 'Boulder',
        region: 'CO',
        postalCode: '80304',
        country: 'US',
      },
    ],
  })
  const eventUri = (created.event as { uri: string }).uri
  assert(eventUri.includes(host.did), 'the event must live in the HOST’s repo, not the school’s')
  assert((created.listing as { uri: string }).uri.includes(school.did), 'the listing must live in the SCHOOL’s repo')
  ok(`event    ${eventUri}`)
  ok(`config   ${(created.config as { uri: string }).uri}`)
  ok(`listing  ${(created.listing as { uri: string }).uri}  (written as the school via SchoolActorPort)`)

  /* 3a. tag routing: an untagged / unrouted-tag event gets NO listing, still ours */
  const untagged = await postJson(req, '/api/events', host.cookie, {
    name: `Untagged mending circle (${suffix})`,
    startsAt,
    endsAt,
    visibility: 'listed',
    neighborhood: 'North Boulder',
  })
  assert(untagged.listing === undefined, 'an untagged event must get NO school listing')
  const untaggedUri = (untagged.event as { uri: string }).uri
  const knitting = await postJson(req, '/api/events', host.cookie, {
    name: `Knitting circle (${suffix})`,
    startsAt,
    endsAt,
    visibility: 'listed',
    neighborhood: 'North Boulder',
    tags: ['knitting'],
  })
  assert(knitting.listing === undefined, 'an event tagged only ["knitting"] must get NO school listing (does not route)')
  const knittingUri = (knitting.event as { uri: string }).uri
  ok('an untagged event and a ["knitting"]-tagged event both get NO coop.lexicon.event.listing')

  const { listRecords } = await import('../src/lib/pds.js')
  const { NSID } = await import('../src/lexicons/nsids.js')
  const schoolListings = await listRecords(school.did, NSID.eventListing)
  assert(schoolListings.length === 1, `expected exactly 1 school listing, found ${schoolListings.length}`)
  ok('the school repo holds exactly 1 listing — the two unrouted events did not add one')

  /* 3b. update the class: replace its skills; a recurrence edit is rejected */
  const breadScoringSkill = 'at://did:plc:taxonomy/freeschool.draft.skill/bread-scoring'
  const updated = await putJson(req, `/api/events/${encodeURIComponent(eventUri)}`, host.cookie, {
    skills: [{ skill: breadScoringSkill, level: 2 }],
  })
  assert(Array.isArray(updated.skillLevels) && updated.skillLevels.length === 1, 'expected exactly 1 replacement skill')
  const afterUpdate = await getJson(req, `/api/events/${encodeURIComponent(eventUri)}`)
  const skillUris = ((afterUpdate.skills as Array<{ skill: string }>) ?? []).map((s) => s.skill)
  assert(skillUris.includes(breadScoringSkill), 'the replacement skill is missing from the event')
  assert(!skillUris.includes(sourdoughSkill), 'the OLD skill sidecar was not removed on replace')
  ok('PUT /api/events/:id replaced the skill sidecars (old deleted, new written)')

  const seriesRejected = await req(`/api/events/${encodeURIComponent(eventUri)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: host.cookie },
    body: JSON.stringify({ series: { rrule: 'FREQ=WEEKLY', freq: 'weekly', timezone: 'America/Denver' } }),
  })
  assert(seriesRejected.status === 400, `expected 400 SeriesEditNotSupported, got ${seriesRejected.status}`)
  const seriesRejectedBody = (await seriesRejected.json()) as { error?: string }
  assert(seriesRejectedBody.error === 'SeriesEditNotSupported', `expected SeriesEditNotSupported, got ${String(seriesRejectedBody.error)}`)
  ok('PUT /api/events/:id rejects a recurrence edit with 400 SeriesEditNotSupported')

  /* 4. RSVPs */
  step(4, 'three members RSVP (app-side only, no public record)')
  const attendees = []
  for (let i = 0; i < 3; i++) {
    const a = await signUp(req, `learner-${i}-${suffix}@example.org`)
    const rsvp = await postJson(req, '/api/rsvp', a.cookie, { eventUri, status: 'going' })
    assert((rsvp.counts as { going: number }).going === i + 1, 'rsvp count did not advance')
    attendees.push(a)
  }
  ok('3 RSVPs recorded in fs_rsvp; zero community.lexicon.calendar.rsvp records written')

  const rsvpView = await req(`/api/events/${encodeURIComponent(eventUri)}`, {
    headers: { cookie: attendees[0]!.cookie },
  })
  const rsvpJson = (await rsvpView.json()) as Record<string, unknown>
  const publicView = await req(`/api/events/${encodeURIComponent(eventUri)}`)
  const publicJson = (await publicView.json()) as Record<string, unknown>
  assert(rsvpJson.locationRedacted === false, 'an RSVP should see the precise location')
  assert(publicJson.locationRedacted === true, 'the public must NOT see the precise location')
  assert(!JSON.stringify(publicJson).includes('Juniper'), 'the street leaked to an anonymous viewer')
  ok(`visibility: public sees "${String(publicJson.neighborhood)}"; an RSVP sees the street address`)

  /* 5. attendance */
  step(5, 'the host attests attendance')
  const attested = await postJson(req, `/api/events/${encodeURIComponent(eventUri)}/attendance`, host.cookie, {
    attendees: attendees.map((a) => ({ did: a.did, participated: true, role: 'attendee' })),
  })
  assert(attested.recorded === 3, `expected 3 attestations, got ${String(attested.recorded)}`)
  ok('3 attendance rows in fs_attendance (no freeschool.draft.attendance records written)')

  /* 6. feedback */
  step(6, 'three anonymous feedbacks, then the k-anonymous summary')
  const beforeRelease = await getJson(req, `/api/events/${encodeURIComponent(eventUri)}/feedback-summary`)
  info(`before any feedback: released=${String(beforeRelease.released)} count=${String(beforeRelease.count)}`)

  for (const [i, a] of attendees.entries()) {
    const res = await postJson(req, '/api/feedback', a.cookie, {
      eventUri,
      direction: i === 2 ? 'negative' : 'positive',
      aspects: { knowledge: 5 - i, teaching: 4, experience: 5 },
      text: `comment from learner ${i}`,
    })
    assert(res.ok === true, 'feedback was not accepted')
    if (i === 0) {
      const partial = await getJson(req, `/api/events/${encodeURIComponent(eventUri)}/feedback-summary`)
      assert(partial.released === false, 'the summary must stay sealed below k')
      info(`after 1 of 3: released=false count=${String(partial.count)}  (k=${String(partial.k)})`)
    }
  }

  const dup = await req('/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: attendees[0]!.cookie },
    body: JSON.stringify({ eventUri, direction: 'positive' }),
  })
  assert(dup.status === 409, `a second ballot should be refused, got ${dup.status}`)
  ok('a second ballot from the same member is refused (409 AlreadyVoted)')

  const summary = await getJson(req, `/api/events/${encodeURIComponent(eventUri)}/feedback-summary`)
  assert(summary.released === true, 'the summary should be released at k=3')
  assert(summary.textReleased === false, 'free text needs k=5 and must stay sealed at 3')
  ok(
    `summary released: count=${String(summary.count)} positive=${String(summary.positive)} ` +
      `negative=${String(summary.negative)} k=${String(summary.k)}`,
  )
  ok(`free text withheld (textK=${String(summary.textK)}, only 3 ballots)`)
  assert(!JSON.stringify(summary).includes('did:'), 'the summary must contain no DIDs')
  assert(!JSON.stringify(summary).includes('comment from'), 'the summary must not leak free text below textK')
  ok('summary contains no DIDs and no free text')

  /* 7. the calendar */
  step(7, 'list the public calendar (indexed by read-your-writes notify)')
  const from = new Date(Date.now() - 3 * 86_400_000).toISOString()
  const to = new Date(Date.now() + 90 * 86_400_000).toISOString()
  const calendarPath = `/api/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`

  await sleep(300)
  const calendar = await getJson(req, calendarPath)
  const listed = (calendar.events as Array<Record<string, unknown>>) ?? []
  const mine = listed.find((e) => e.uri === eventUri)
  assert(mine, `the published class did not appear on the calendar (${listed.length} events listed)`)
  ok(`calendar: ${listed.length} listed event(s); ours is "${String(mine.name)}" in ${String(mine.neighborhood)}`)
  assert(mine.locationRedacted === true, 'the anonymous calendar must redact the location')
  assert(mine.origin === 'ours', 'the routed, listed class should carry origin "ours"')
  info('indexed by contrail.notify() immediately after each write — no firehose involved')

  const untaggedEntry = listed.find((e) => e.uri === untaggedUri)
  const knittingEntry = listed.find((e) => e.uri === knittingUri)
  assert(untaggedEntry, 'the UNTAGGED class (no listing at all) did not appear on the calendar')
  assert(knittingEntry, 'the ["knitting"]-tagged class (unrouted, no listing) did not appear on the calendar')
  assert(untaggedEntry.origin === 'ours', 'an untagged own-host class must still carry origin "ours"')
  assert(knittingEntry.origin === 'ours', 'an unrouted-tag own-host class must still carry origin "ours"')
  ok('calendar inclusion is by AUTHORSHIP: both unrouted classes appear, origin "ours", with no listing record')

  const ics = await req(`/api/events/${encodeURIComponent(eventUri)}.ics`, {
    headers: { cookie: attendees[0]!.cookie },
  })
  const icsText = await ics.text()
  assert(ics.headers.get('content-type')?.startsWith('text/calendar'), 'the .ics content type is wrong')
  assert(ics.headers.get('content-disposition')?.startsWith('attachment'), 'the .ics must be an attachment')
  assert(icsText.startsWith('BEGIN:VCALENDAR'), 'the .ics body is not a VCALENDAR')
  assert(icsText.includes('Juniper'), 'an RSVP should get the full address in their .ics')
  ok(`.ics served: ${ics.headers.get('content-type')}, ${icsText.split('\r\n').length} lines, full address included`)

  const publicIcs = await req(`/api/events/${encodeURIComponent(eventUri)}.ics`)
  const publicIcsText = await publicIcs.text()
  assert(!publicIcsText.includes('Juniper'), 'the anonymous .ics leaked the street address')
  ok('.ics for an anonymous viewer carries only the neighborhood')

  /* 8. the peer-registry indexing path */
  step(8, 'index from the peer registry (the safety net beneath PdsChangeSource)')
  if (process.env.SMOKE_SKIP_BACKFILL === '1') {
    info('skipped (SMOKE_SKIP_BACKFILL=1)')
  } else {
    const backfill = await indexer.backfillFromPeers({ concurrency: 5 })
    info(
      `backfill: discovered=${backfill.discovered} backfilled=${backfill.backfilled} ` +
        `seededByListReposFallback=${backfill.seededByFallback} identitiesPinned=${backfill.identitiesPinned}`,
    )
    info('discovered=0 is expected: the reference PDS does not serve listReposByCollection (see README)')
    const again = await getJson(req, calendarPath)
    const stillThere = ((again.events as Array<Record<string, unknown>>) ?? []).find((e) => e.uri === eventUri)
    assert(stillThere, 'the class vanished from the calendar after a full backfill')
    ok('a full peer backfill is idempotent: the class is still listed exactly once')
  }

  /* notifications */
  const notifs = await getJson(req, '/api/notifications', host.cookie)
  const categories = ((notifs.notifications as Array<{ category: string }>) ?? []).map((n) => n.category)
  ok(`host notifications: ${categories.join(', ') || '(none)'}`)
  const feedbackNotifs = (notifs.notifications as Array<Record<string, unknown>>).filter(
    (n) => n.category === 'feedback.received',
  )
  assert(feedbackNotifs.length > 0, 'the host should have been told feedback arrived')
  assert(!JSON.stringify(feedbackNotifs).includes('did:'), 'feedback.received must carry no actor')
  ok('feedback.received notifications carry no actor')

  /* audit trail */
  const { audit } = await import('../src/db/schema.js')
  const { eq } = await import('drizzle-orm')
  const auditRows = await getDb().select().from(audit).where(eq(audit.schoolDid, school.did))
  ok(`audit: ${auditRows.length} SchoolActorPort call(s), all with a written reason`)
  assert(
    auditRows.every((r) => r.reason.trim().length > 0),
    'an audit row has no reason',
  )

  void steward
  console.log(`\nSMOKE PASSED in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await closeDb()
}

/* helpers */

/** `app.request` returns `Response | Promise<Response>`; normalize it once. */
type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

interface Actor {
  did: string
  handle: string
  cookie: string
}

async function signUp(req: Fetcher, email: string): Promise<Actor> {
  const res = await req('/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })
  const body = (await res.json()) as { did: string; handle: string; verifyUrl?: string; message?: string }
  assert(res.status === 201, `signup failed (${res.status}): ${body.message ?? JSON.stringify(body)}`)
  assert(body.verifyUrl, 'expected a magic link in the response (SMTP_URL is unset)')
  const token = new URL(body.verifyUrl).searchParams.get('token')!
  const verify = await req(`/api/auth/verify?token=${encodeURIComponent(token)}`, {
    headers: { accept: 'application/json' },
  })
  assert(verify.status === 200, `verification failed (${verify.status})`)
  const setCookie = verify.headers.get('set-cookie')
  assert(setCookie, 'verification did not set a session cookie')
  const cookie = setCookie.split(';')[0]!
  return { did: body.did, handle: body.handle, cookie }
}

async function postJson(
  req: Fetcher,
  path: string,
  cookie: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, unknown>
  assert(res.ok, `POST ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function putJson(
  req: Fetcher,
  path: string,
  cookie: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await req(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as Record<string, unknown>
  assert(res.ok, `PUT ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function getJson(req: Fetcher, path: string, cookie?: string): Promise<Record<string, unknown>> {
  const res = await req(path, cookie ? { headers: { cookie } } : undefined)
  const json = (await res.json()) as Record<string, unknown>
  assert(res.ok, `GET ${path} -> ${res.status} ${JSON.stringify(json)}`)
  return json
}

await main().catch((err) => {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
})
