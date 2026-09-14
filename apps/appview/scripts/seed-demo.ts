/**
 * Populate a LOCAL school with a believable community, so the whole product can be
 * evaluated end to end and the Playwright persona journeys have members to be.
 *
 *   set -a; . ./.env; set +a
 *   pnpm --filter @freeschool/appview seed:demo
 *
 * EVERYTHING HERE GOES THROUGH THE SAME CODE PATHS A REAL MEMBER HITS. `signup()` mints a
 * real account on the reference PDS; `saveProfile`, `setChosenHandle`, `setSkillClaims`,
 * `createEventAsHost`, `upsertRsvp`, `recordAttendance`, `createRequest`,
 * `toggleInterest`, `createAttestation` and `createResource` are the same functions the
 * HTTP routes call. There is no second, quieter way to create a member in this file, on
 * purpose: a seed that takes shortcuts is a seed that stops proving anything.
 *
 * IDEMPOTENT. Re-running reuses every existing account (an email the PDS already knows
 * resends nothing new and hands back the same DID), skips any class already on the
 * calendar under the same name and host, and leaves claims/RSVPs/interest/vouches to
 * their own upserts. The one visible cost of a re-run is a fresh verification token per
 * member, which is what makes the Playwright helper's magic-link sign-in work.
 *
 * PRIVACY (R9). This script prints COUNTS and the output path, never a DID, an email or a
 * handle. `.demo-users.json` does hold them — it is the Playwright fixture — and is
 * gitignored.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import type { Context } from 'hono'

import { config } from '../src/config.js'
import { closeDb, getDb } from '../src/db/index.js'
import { runMigrations } from '../src/db/migrate.js'
import { session } from '../src/db/schema.js'
import { isMain } from '../src/lib/is-main.js'
import { createSession } from '../src/http/session.js'
import type { Viewer } from '../src/http/session.js'
import { signup, verifyEmailToken } from '../src/lib/custody.js'
import { saveProfile } from '../src/lib/profile.js'
import { setChosenHandle } from '../src/lib/handle-change.js'
import { setSkillClaims } from '../src/lib/skill-claims.js'
import { createEventAsHost, putInActorRepo, routeListing, type CreateEventInput } from '../src/lib/events.js'
import { actorAgent } from '../src/lib/actor-agent.js'
import { schoolDid } from '../src/lib/school-actor.js'
import { NSID } from '../src/lexicons/nsids.js'
import { tid } from '../src/lib/ids.js'
import type { EventListing } from '../src/lexicons/coop.js'
import type { Did } from '@freeschool/school-actor'
import { recordAttendance } from '../src/lib/attendance.js'
import { upsertRsvp } from '../src/lib/rsvp.js'
import { createRequest } from '../src/lib/requests.js'
import { toggleInterest, isInterested } from '../src/lib/request-rsvp.js'
import { createAttestation, AttestationError } from '../src/lib/attestations.js'
import { createResource } from '../src/lib/resources.js'
import { materializeSeries, type SeriesRecord } from '../src/jobs/materialize-series.js'
import { getIndexer } from '../src/index/indexer.js'
import { getRecordByUri, listCollection, sidecarsForEvent } from '../src/index/queries.js'
import { seriesOccurrence } from '../src/db/schema.js'
import { getThresholds } from '../src/lib/policy.js'
import { appointSteward } from './appoint-steward.js'
import { PERSONAS, SKILL, emailFor, identiconSvg, type Persona } from './demo-personas.js'

/** Where the Playwright helper (`apps/web/e2e/personas.ts`) reads the cast back out. */
export const DEMO_USERS_PATH = fileURLToPath(new URL('../.demo-users.json', import.meta.url))

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface DemoUser {
  slug: string
  did: string
  handle: string
  email: string
  displayName: string
  intent: Persona['intent']
}

export interface SeedCounts {
  members: number
  claims: number
  classes: number
  occurrences: number
  rsvps: number
  attendances: number
  requests: number
  interests: number
  vouches: number
  notes: number
  stewards: number
  /** Artifacts a previous half-finished run lost, put back on this one. */
  repairs: number
}

/* ------------------------------------------------------------------------- *
 * Guard
 * ------------------------------------------------------------------------- */

/**
 * REFUSE ANYWHERE THAT IS NOT A LOCAL DEVELOPMENT STACK. Two independent checks, because
 * either one alone is a foot-gun: production is production, and a non-private PDS host is
 * somebody's real server full of real people — this script would mint twelve accounts on
 * it and post classes as them.
 */
export function assertLocalOnly(c = config()): void {
  if (c.isProd) {
    throw new Error('seed:demo refuses to run with NODE_ENV=production — this writes twelve real accounts')
  }
  const host = new URL(c.PDS_URL).hostname
  if (!c.ALLOWED_PRIVATE_PDS_HOSTS.includes(host)) {
    throw new Error(
      `seed:demo refuses to run against PDS host "${host}": it is not in ALLOWED_PRIVATE_PDS_HOSTS ` +
        `(${c.ALLOWED_PRIVATE_PDS_HOSTS.join(', ')}). Point PDS_URL at the local reference PDS.`,
    )
  }
}

/* ------------------------------------------------------------------------- *
 * Members
 * ------------------------------------------------------------------------- */

const skillUri = (id: string) => `at://${config().AUTHORITY_DID}/freeschool.draft.skill/${id}`

/** `createSession` wants a Hono context only to set a cookie nobody here will read. */
const headlessContext = () => ({ header: () => undefined }) as unknown as Context

/**
 * The primary door, start to finish: `signup()` (which resends rather than duplicates for
 * a known email), then the verification token straight out of the returned `verifyUrl` —
 * `DEV_MAIL_LOG` is set locally and SMTP is not, so `signup` hands the link back instead
 * of only writing it to the mail sink.
 *
 * Then a real session, because `fs_member` — what the members directory lists from — is
 * written by `createSession` and nowhere else. The session row is deleted again at the
 * end of the run; the durable membership fact it created is the point and stays.
 */
async function signUpPersona(persona: Persona): Promise<{ viewer: Viewer; did: string; handle: string }> {
  const email = emailFor(persona.slug)
  const result = await signup({ email })
  if (!result.verifyUrl) {
    throw new Error('signup did not return a verifyUrl — is SMTP_URL set? seed:demo needs the dev mail path')
  }
  const token = new URL(result.verifyUrl).searchParams.get('token')
  if (!token) throw new Error('could not read the verification token out of the signup result')
  const { did } = await verifyEmailToken(token)
  const sessionId = await createSession(headlessContext(), did, 'custodial')
  return { viewer: { did, kind: 'custodial', sessionId }, did, handle: result.handle }
}

/** A deterministic identicon, rasterized to the PNG data URL `normalizeImage` accepts. */
async function avatarFor(slug: string): Promise<{ data: string; alt: string }> {
  const png = await sharp(Buffer.from(identiconSvg(slug))).png().toBuffer()
  return { data: `data:image/png;base64,${png.toString('base64')}`, alt: '' }
}

/* ------------------------------------------------------------------------- *
 * Classes
 * ------------------------------------------------------------------------- */

interface DemoClass {
  /** Which persona hosts it. */
  host: string
  input: CreateEventInput
  /** Slugs who RSVP `going`. */
  going?: string[]
  /** Slugs the host later checks off as having taken part. */
  attended?: string[]
}

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

/**
 * Nine classes, chosen to exercise every shape the calendar can render: three recurring
 * series, two that still need a venue, two in the past with attendance already taken (the
 * evidence `eli` and `ines` need to derive into hosts), one unlisted and one
 * neighbourhood-only.
 *
 * `tags: ['skillshare']` is what makes the school write its own curation listing — see
 * `lib/events.ts#routeListing`. The unlisted and private ones deliberately carry it too,
 * so the test is that VISIBILITY suppresses the listing, not that a missing tag did.
 */
function demoClasses(): DemoClass[] {
  return [
    {
      host: 'amir',
      input: {
        name: 'Saturday bike repair table',
        description: 'Bring the bike and the problem. We will find the tool between us.',
        startsAt: at(3 * DAY),
        endsAt: at(3 * DAY + 3 * HOUR),
        neighborhood: 'Whittier',
        timezone: 'America/Denver',
        capacity: 8,
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.bicycle), level: 1 }],
        materials: ['A bike', 'Closed-toe shoes'],
        suppliesNote: 'Tools, stands and degreaser are all provided.',
        series: { rrule: 'FREQ=WEEKLY;BYDAY=SA', freq: 'weekly', byDay: ['SA'], timezone: 'America/Denver', count: 6 },
      },
      going: ['theo', 'rosa', 'sam'],
    },
    {
      host: 'maya',
      input: {
        name: 'Kimchi from one cabbage',
        description: 'Salt, time and a jar you already own. Leave with something bubbling.',
        startsAt: at(5 * DAY),
        endsAt: at(5 * DAY + 2 * HOUR),
        neighborhood: 'Goss-Grove',
        timezone: 'America/Denver',
        capacity: 10,
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.kimchi), level: 1 }],
        materials: ['A clean quart jar'],
      },
      going: ['rosa', 'noor', 'lina'],
    },
    {
      host: 'maya',
      input: {
        name: 'Sourdough, slowly',
        description: 'A starter to take home and four weeks of company while you learn its moods.',
        startsAt: at(7 * DAY),
        endsAt: at(7 * DAY + 2 * HOUR),
        timezone: 'America/Denver',
        venueNeeded: true,
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.sourdough), level: 1 }],
        series: { rrule: 'FREQ=WEEKLY;BYDAY=TU', freq: 'weekly', byDay: ['TU'], timezone: 'America/Denver', count: 4 },
      },
      going: ['sam', 'rosa'],
    },
    {
      host: 'jonah',
      input: {
        name: 'Three chords and a singalong',
        description: 'If you can hold a shape for four beats you can play with us.',
        startsAt: at(4 * DAY),
        endsAt: at(4 * DAY + 2 * HOUR),
        neighborhood: 'Martin Acres',
        timezone: 'America/Denver',
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.guitar), level: 1 }],
      },
      going: ['lina', 'eli'],
    },
    {
      host: 'jonah',
      input: {
        name: 'Monthly song circle',
        description: 'No lead, no setlist. Bring one song you half know.',
        startsAt: at(10 * DAY),
        endsAt: at(10 * DAY + 2 * HOUR),
        timezone: 'America/Denver',
        venueNeeded: true,
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.songCircle), level: 1 }],
        series: { rrule: 'FREQ=MONTHLY', freq: 'monthly', timezone: 'America/Denver', count: 4 },
      },
      going: ['eli', 'ines'],
    },
    {
      host: 'priya',
      input: {
        name: 'Spanish conversation hour',
        description: 'Half an hour of listening, half an hour of trying. No textbooks.',
        startsAt: at(2 * DAY),
        endsAt: at(2 * DAY + HOUR),
        neighborhood: 'North Boulder',
        timezone: 'America/Denver',
        capacity: 6,
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.spanish), level: 1 }],
      },
      going: ['lina', 'rosa', 'ines'],
    },
    {
      host: 'priya',
      input: {
        name: 'Facilitation practice (members only)',
        description: 'A closed session for people who already run meetings here.',
        startsAt: at(6 * DAY),
        endsAt: at(6 * DAY + 2 * HOUR),
        timezone: 'America/Denver',
        visibility: 'unlisted',
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.facilitation), level: 2 }],
      },
      going: ['eli', 'ines'],
    },
    // The two in the PAST, with attendance — this is the evidence that derives `eli` and
    // `ines` towards hosting, and gives the badges on `/me` something to say.
    {
      host: 'eli',
      input: {
        name: 'Mending evening',
        description: 'Darning, patches and the small repairs that keep a coat going.',
        startsAt: at(-21 * DAY),
        endsAt: at(-21 * DAY + 2 * HOUR),
        neighborhood: 'Whittier',
        timezone: 'America/Denver',
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.facilitation), level: 1 }],
      },
      going: ['rosa', 'noor', 'sam'],
      attended: ['rosa', 'noor', 'sam'],
    },
    {
      host: 'ines',
      input: {
        name: 'How we decide things here',
        description: 'A walk through the school’s own policy, and how to change it.',
        startsAt: at(-10 * DAY),
        endsAt: at(-10 * DAY + 90 * 60_000),
        timezone: 'America/Denver',
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.facilitation), level: 2 }],
      },
      going: ['theo', 'lina', 'eli'],
      attended: ['theo', 'lina', 'eli'],
    },
  ]
}

/** Six things the neighbourhood has asked for, with who else wants them. */
const DEMO_REQUESTS: Array<{ asker: string; title: string; description: string; skill?: string; threshold?: number; interested: string[] }> = [
  {
    asker: 'rosa',
    title: 'Someone teach me to keep a garden alive past July',
    description: 'I have a plot and a lot of optimism. I would like a plan and a calendar.',
    skill: SKILL.gardening,
    threshold: 3,
    interested: ['noor', 'sam', 'theo'],
  },
  {
    asker: 'theo',
    title: 'Basic bike maintenance for someone who owns no tools',
    description: 'I can patch a tube badly. I would like to patch one well.',
    skill: SKILL.bicycle,
    threshold: 2,
    interested: ['rosa', 'sam'],
  },
  {
    asker: 'noor',
    title: 'Fermenting vegetables without poisoning anyone',
    description: 'Mostly I want to know what safe looks and smells like.',
    skill: SKILL.fermentation,
    threshold: 3,
    interested: ['rosa', 'sam', 'lina'],
  },
  {
    asker: 'lina',
    title: 'A Spanish conversation group that meets in the evening',
    description: 'The daytime one is lovely and I am always at work.',
    skill: SKILL.spanish,
    interested: ['ines', 'rosa'],
  },
  {
    asker: 'sam',
    title: 'Welding, from someone who will not let me lose a finger',
    description: 'Safety first, then a bead. I have no equipment at all.',
    skill: SKILL.welding,
    threshold: 4,
    interested: ['theo', 'eli'],
  },
  {
    asker: 'eli',
    title: 'How to facilitate a meeting that ends on time',
    description: 'Ours run long and everyone is too polite to say so.',
    skill: SKILL.facilitation,
    threshold: 2,
    interested: ['ines', 'noor', 'lina'],
  },
]

/** Ten vouches, each one for a skill its subject actually claims or teaches. */
const DEMO_VOUCHES: Array<{ from: string; to: string; skill: string }> = [
  { from: 'theo', to: 'amir', skill: SKILL.bicycle },
  { from: 'rosa', to: 'amir', skill: SKILL.bicycle },
  { from: 'sam', to: 'maya', skill: SKILL.sourdough },
  { from: 'rosa', to: 'maya', skill: SKILL.kimchi },
  { from: 'noor', to: 'maya', skill: SKILL.kimchi },
  { from: 'lina', to: 'jonah', skill: SKILL.guitar },
  { from: 'eli', to: 'jonah', skill: SKILL.songCircle },
  { from: 'lina', to: 'priya', skill: SKILL.spanish },
  { from: 'ines', to: 'priya', skill: SKILL.facilitation },
  { from: 'noor', to: 'eli', skill: SKILL.facilitation },
]

/** Five field notes, each by a host, each linked to a skill they teach. */
const DEMO_NOTES: Array<{ author: string; title: string; description: string; skills: string[]; license?: string }> = [
  {
    author: 'amir',
    title: 'What to check before you replace anything',
    description:
      'Nine times out of ten it is the cable, the pads or the air. Spin the wheel, squeeze the brake, press the tyre. Most of what looks like a broken bike is a bike nobody has looked at closely.',
    skills: [SKILL.bicycle],
    license: 'CC0',
  },
  {
    author: 'maya',
    title: 'Salt by weight, not by spoon',
    description:
      'Two percent of the vegetable’s weight, every time. A cheap kitchen scale removes every other guess from the process, and the jar will tell you the rest.',
    skills: [SKILL.kimchi, SKILL.fermentation],
    license: 'CC0',
  },
  {
    author: 'maya',
    title: 'Keeping a starter alive through a busy month',
    description:
      'It will not die as easily as you fear. Cold slows it down; a week in the fridge is a pause, not an ending. Feed it twice before you bake and judge it by smell.',
    skills: [SKILL.sourdough],
    license: 'CC0',
  },
  {
    author: 'jonah',
    title: 'Four shapes and a capo',
    description:
      'G, C, D and E minor will carry most of a singalong. The capo moves all four into whatever key the room can actually sing in, which matters more than the shapes do.',
    skills: [SKILL.guitar, SKILL.songCircle],
    license: 'CC0',
  },
  {
    author: 'priya',
    title: 'Ask the room what it is deciding',
    description:
      'Most meetings run long because two people are answering different questions. Name the decision out loud, write it where everyone can see it, and the conversation shortens itself.',
    skills: [SKILL.facilitation],
    license: 'CC0',
  },
]

/* ------------------------------------------------------------------------- *
 * The run
 * ------------------------------------------------------------------------- */

/**
 * A class is not one record but four: the event, its config, the school's curation
 * listing, and (for a recurring one) a `freeschool.draft.series` plus the occurrences the
 * materializer writes from it. A run that dies part-way through `createEventAsHost` — the
 * hosting bar left raised by a crashed `pnpm e2e` is the way this actually happens — can
 * therefore leave a class that EXISTS but has no listing and no series, and a
 * skip-if-the-name-is-taken check would then leave it that way forever.
 *
 * So the decision is per-ARTIFACT, not per-class. Pure, so the four cases are testable
 * without a PDS, an indexer or a database.
 */
export interface ClassRepairState {
  /** Does OUR school already have a curation listing for this event? */
  hasListing: boolean
  /** Would a fresh class with these tags/visibility get one at all? */
  routes: boolean
  /** Does the persona's definition ask for recurrence? */
  wantsSeries: boolean
  /** Is there already a `freeschool.draft.series` pointing at this event? */
  hasSeries: boolean
  /** How many occurrences `fs_series_occurrence` holds for that series. */
  occurrences: number
}

export interface ClassRepairPlan {
  listing: boolean
  series: boolean
  materialize: boolean
}

export function planClassRepair(state: ClassRepairState): ClassRepairPlan {
  const series = state.wantsSeries && !state.hasSeries
  return {
    // Only ever CREATE a missing one. A listing our school does have is left alone —
    // including one a steward has since removed, which is not ours to recreate.
    listing: state.routes && !state.hasListing,
    series,
    // A series with zero occurrences never got materialized (or was just now recreated);
    // one that already has them is left alone, so a second run writes nothing.
    materialize: state.wantsSeries && (series || state.occurrences === 0),
  }
}

/** The `freeschool.draft.series` record body, shared by the create and repair paths. */
function seriesRecordFor(demo: DemoClass, firstEvent: { uri: string; cid: string }): SeriesRecord {
  const series = demo.input.series!
  return {
    firstEvent,
    rrule: series.rrule,
    freq: series.freq,
    interval: series.interval ?? 1,
    ...(series.byDay?.length ? { byDay: series.byDay } : {}),
    ...(series.until ? { until: series.until } : {}),
    ...(series.count ? { count: series.count } : {}),
    ...(series.exdates?.length ? { exdates: series.exdates } : {}),
    timezone: series.timezone,
    materializeAhead: series.materializeAhead ?? 90,
  }
}

/** The host's own `freeschool.draft.series` pointing at this event, if they wrote one. */
async function existingSeriesUri(hostDid: string, eventUri: string): Promise<string | undefined> {
  try {
    const indexer = await getIndexer()
    const { records } = await listCollection<{ firstEvent?: { uri?: string } }>(indexer, 'series', {
      did: hostDid,
      limit: 200,
    })
    return records.find((r) => r.value.firstEvent?.uri === eventUri)?.uri
  } catch {
    return undefined
  }
}

async function occurrenceCount(seriesUri: string): Promise<number> {
  const rows = await getDb().select({ rkey: seriesOccurrence.occurrenceRkey }).from(seriesOccurrence).where(eq(seriesOccurrence.seriesUri, seriesUri))
  return rows.length
}

/** Does our school already hold a curation listing for this event? */
async function hasOurListing(eventUri: string): Promise<boolean> {
  try {
    const indexer = await getIndexer()
    const rows = await sidecarsForEvent<EventListing>(indexer, 'eventListing', eventUri)
    return rows.some((r) => r.value.school === schoolDid())
  } catch {
    // Cannot prove it is missing, so do not write a second one.
    return true
  }
}

/**
 * Put back whatever a half-finished earlier run lost, using the SAME calls a fresh class
 * makes (`routeListing`, the series `putRecord`, `materializeSeries`) rather than a
 * repair-only path that could drift from them. Returns what it actually did, so a second
 * run reports zeroes.
 */
async function repairClass(
  viewer: Viewer,
  demo: DemoClass,
  eventUri: string,
): Promise<{ occurrences: number; repairs: number }> {
  const indexer = await getIndexer()
  const record = await getRecordByUri(indexer, 'event', eventUri)
  if (!record?.cid) return { occurrences: 0, repairs: 0 }
  const firstEvent = { uri: eventUri, cid: record.cid }

  const wantsSeries = Boolean(demo.input.series)
  const seriesUri = wantsSeries ? await existingSeriesUri(viewer.did, eventUri) : undefined
  const plan = planClassRepair({
    hasListing: await hasOurListing(eventUri),
    // `routeListing` makes the real decision (it also checks the school's own routing
    // tags); this only asks whether a listing is possible in principle.
    routes: (demo.input.visibility ?? 'listed') === 'listed' && (demo.input.tags?.length ?? 0) > 0,
    wantsSeries,
    hasSeries: Boolean(seriesUri),
    occurrences: seriesUri ? await occurrenceCount(seriesUri) : 0,
  })

  let occurrences = 0
  let repairs = 0
  const notify: string[] = []

  if (plan.listing) {
    const listing = await routeListing({
      event: firstEvent,
      name: demo.input.name,
      tags: demo.input.tags ?? [],
      visibility: demo.input.visibility,
      callerDid: viewer.did as Did,
      auditReason: `restored the listing for "${demo.input.name}" after an interrupted seed run`,
    })
    if (listing) {
      notify.push(listing.uri)
      repairs++
    }
  }

  let uri = seriesUri
  if (plan.series) {
    const written = await putInActorRepo(await actorAgent(viewer), viewer.did, NSID.series, tid(), {
      $type: NSID.series,
      ...seriesRecordFor(demo, firstEvent),
      createdAt: new Date().toISOString(),
    })
    uri = written.uri
    notify.push(written.uri)
    repairs++
  }

  if (notify.length > 0) await indexer.notify(notify).catch(() => {})

  if (plan.materialize && uri) {
    const res = await materializeSeries(uri, viewer.did, seriesRecordFor(demo, firstEvent))
    occurrences += res.written
  }

  return { occurrences, repairs }
}

/** Already on the calendar under this name and host? (Idempotence, per the brief.) */
async function existingClassUri(hostDid: string, name: string): Promise<string | undefined> {
  try {
    const indexer = await getIndexer()
    const { records } = await listCollection<{ name?: string }>(indexer, 'event', { did: hostDid, limit: 200 })
    return records.find((r) => r.value.name === name)?.uri
  } catch {
    return undefined
  }
}

async function existingRequestUri(askerDid: string, title: string): Promise<string | undefined> {
  try {
    const indexer = await getIndexer()
    const { records } = await listCollection<{ title?: string }>(indexer, 'request', { did: askerDid, limit: 200 })
    return records.find((r) => r.value.title === title)?.uri
  } catch {
    return undefined
  }
}

async function existingNoteUri(authorDid: string, title: string): Promise<string | undefined> {
  try {
    const indexer = await getIndexer()
    const { records } = await listCollection<{ title?: string }>(indexer, 'resource', { did: authorDid, limit: 200 })
    return records.find((r) => r.value.title === title)?.uri
  } catch {
    return undefined
  }
}

/**
 * The seed's hosts must actually be allowed to host, and that is the SCHOOL'S decision,
 * not this script's — so check it and say so, rather than quietly rewriting somebody's
 * governance record. The usual cause locally is a crashed `pnpm e2e`: `mvp.spec.ts` raises
 * the hosting bar to 5 mid-test and puts it back in a `finally`, so a run killed in
 * between leaves the school there. The fix is one steward action on `/admin/policy`.
 */
export async function assertHostsCanHost(): Promise<void> {
  const t = await getThresholds()
  if (t.hostMinAttended > 0) {
    throw new Error(
      `seed:demo needs the school's hosting bar at 0 attended classes; it is ${t.hostMinAttended}. ` +
        'Open /admin/policy as a steward and set "Classes attended before someone can host" to 0 ' +
        '(a crashed `pnpm e2e` run is the usual cause — it raises the bar to 5 and restores it in a finally).',
    )
  }
  if (t.memberRequires === 'attended-one') {
    throw new Error(
      'seed:demo needs the school to admit members without a prior attended class; ' +
        'set "memberRequires" to "none" or "invite-or-vouch" on /admin/policy.',
    )
  }
}

export async function seedDemo(): Promise<{ counts: SeedCounts; users: DemoUser[] }> {
  assertLocalOnly()
  await assertHostsCanHost()
  const counts: SeedCounts = {
    members: 0,
    claims: 0,
    classes: 0,
    occurrences: 0,
    rsvps: 0,
    attendances: 0,
    requests: 0,
    interests: 0,
    vouches: 0,
    notes: 0,
    stewards: 0,
    repairs: 0,
  }

  // 1. MEMBERS — the primary door, profile, chosen handle.
  const viewers = new Map<string, Viewer>()
  const users: DemoUser[] = []
  for (const persona of PERSONAS) {
    const { viewer, did } = await signUpPersona(persona)
    viewers.set(persona.slug, viewer)

    await saveProfile(did, {
      displayName: persona.displayName,
      bio: persona.bio,
      publicListing: true,
      directoryListing: true,
      avatar: await avatarFor(persona.slug),
    })

    // The same `/welcome` path a member uses. A re-run finds the handle already theirs;
    // the PDS answers `HandleNotAvailable` for a handle they already hold, so a failure
    // here is never fatal — we keep whatever handle they have.
    const chosen = await setChosenHandle(viewer, persona.slug)
    const handle = chosen.ok ? chosen.handle : `${persona.slug}.${config().handleDomain}`

    users.push({
      slug: persona.slug,
      did,
      handle,
      email: emailFor(persona.slug),
      displayName: persona.displayName,
      intent: persona.intent,
    })
    counts.members++
  }

  const viewerFor = (slug: string): Viewer => {
    const v = viewers.get(slug)
    if (!v) throw new Error(`no seeded viewer for "${slug}"`)
    return v
  }
  const didFor = (slug: string) => viewerFor(slug).did

  // 2. CLAIMS — the whole set per member, through the same lib `PUT /skill-claims` uses.
  for (const persona of PERSONAS) {
    if (persona.skills.length === 0) continue
    const result = await setSkillClaims(viewerFor(persona.slug), {
      claims: persona.skills.map((s) => ({
        skill: skillUri(s.id),
        level: s.level,
        ...(s.note ? { note: s.note } : {}),
        visibility: s.visibility ?? 'public',
      })),
      // A demo school teaches ordinary things, but the taxonomy may not be indexed on a
      // fresh box, and `resolveSkillTier` fails CLOSED to Tier B when it cannot look a
      // skill up. Confirming here is the same explicit consent the UI asks a member for.
      confirmTierB: true,
    })
    if (result.ok) counts.claims += persona.skills.length
  }

  // 3. CLASSES — in the HOST's own repo, with the school's curation listing on top.
  const classUris = new Map<string, string>()
  for (const demo of demoClasses()) {
    const viewer = viewerFor(demo.host)
    const already = await existingClassUri(viewer.did, demo.input.name)
    if (already) {
      classUris.set(demo.input.name, already)
      // The class is here, but an interrupted run may have died before its listing or its
      // series ever got written — repair per artifact rather than skipping wholesale.
      const repaired = await repairClass(viewer, demo, already)
      counts.occurrences += repaired.occurrences
      counts.repairs += repaired.repairs
      continue
    }
    const created = await createEventAsHost(viewer, demo.input)
    classUris.set(demo.input.name, created.event.uri)
    counts.classes++

    // Occurrences: the materializer is a pg-boss job, so with FREESCHOOL_NO_JOBS=1 (or
    // simply before the next daily run) a recurring class would show exactly one date.
    // Run it here so the calendar is honest the moment the seed finishes.
    if (created.series) {
      const res = await materializeSeries(
        created.series.uri,
        viewer.did,
        seriesRecordFor(demo, { uri: created.event.uri, cid: created.event.cid }),
      )
      counts.occurrences += res.written
    }
  }

  // 4. RSVPs.
  for (const demo of demoClasses()) {
    const eventUri = classUris.get(demo.input.name)
    if (!eventUri) continue
    for (const slug of demo.going ?? []) {
      await upsertRsvp({ eventUri, did: didFor(slug), status: 'going' })
      counts.rsvps++
    }
  }

  // 5. ATTENDANCE on the two past classes — the host attests, nobody else can.
  for (const demo of demoClasses()) {
    if (!demo.attended?.length) continue
    const eventUri = classUris.get(demo.input.name)
    if (!eventUri) continue
    const result = await recordAttendance({
      eventUri,
      hostDid: didFor(demo.host),
      attendees: demo.attended.map((slug) => ({ did: didFor(slug), participated: true, role: 'attendee' as const })),
      eventStartsAt: new Date(demo.input.startsAt),
    })
    counts.attendances += result.recorded
  }

  // 6. REQUESTS + interest.
  for (const req of DEMO_REQUESTS) {
    const viewer = viewerFor(req.asker)
    let uri = await existingRequestUri(viewer.did, req.title)
    if (!uri) {
      const created = await createRequest(viewer, {
        title: req.title,
        description: req.description,
        ...(req.skill ? { skill: skillUri(req.skill) } : {}),
        ...(req.threshold ? { threshold: req.threshold } : {}),
      })
      uri = created.uri
      counts.requests++
    }
    for (const slug of req.interested) {
      // `toggleInterest` is a TOGGLE: check first, or a re-run un-interests everybody.
      if (await isInterested(uri, didFor(slug))) continue
      await toggleInterest(uri, didFor(slug))
      counts.interests++
    }
  }

  // 7. VOUCHES — app-side only (R9), and only for a skill the subject actually holds.
  for (const vouch of DEMO_VOUCHES) {
    try {
      await createAttestation({
        attesterDid: didFor(vouch.from),
        subjectDid: didFor(vouch.to),
        skillUri: skillUri(vouch.skill),
      })
      counts.vouches++
    } catch (err) {
      // `AlreadyVouched` on a re-run is the idempotent case, not a failure.
      if (!(err instanceof AttestationError)) throw err
    }
  }

  // 8. NOTES — public, author-owned knowledge records.
  for (const note of DEMO_NOTES) {
    const viewer = viewerFor(note.author)
    if (await existingNoteUri(viewer.did, note.title)) continue
    await createResource(viewer, {
      title: note.title,
      description: note.description,
      skills: note.skills.map(skillUri),
      ...(note.license ? { license: note.license } : {}),
    })
    counts.notes++
  }

  // 9. STEWARD — the one role that cannot be derived from records.
  await appointSteward(didFor('steward'))
  counts.stewards++

  // 10. The fixture the Playwright personas read.
  await writeFile(DEMO_USERS_PATH, `${JSON.stringify(users, null, 2)}\n`, 'utf8')

  // The sessions were only ever needed so `fs_member` exists (the directory lists from
  // it) and so every write above had a real viewer. Clean them up; membership is durable.
  for (const viewer of viewers.values()) {
    await getDb().delete(session).where(eq(session.id, viewer.sessionId))
  }

  return { counts, users }
}

if (isMain(import.meta.url)) {
  await runMigrations().catch(() => {})
  const { counts } = await seedDemo()
  // COUNTS AND THE PATH ONLY — never a DID, an email or a handle (R9).
  console.log('Demo school seeded:')
  for (const [what, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(4)}  ${what}`)
  console.log(`\nPlaywright fixture: ${DEMO_USERS_PATH}`)
  await closeDb()
}
