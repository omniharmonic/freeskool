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
import { createEventAsHost, putInActorRepo, routeListing, updateEventAsHost, type CreateEventInput } from '../src/lib/events.js'
import { getPresentation } from '../src/lib/event-presentation.js'
import { actorAgent } from '../src/lib/actor-agent.js'
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
import { getThresholds, refreshPolicyCache } from '../src/lib/policy.js'
import { appointSteward } from './appoint-steward.js'
import {
  BOULDER,
  DEMO_SCHOOLS,
  DEMO_SCHOOL_HOSTS,
  DENVER,
  DENVER_PERSONAS,
  IN_BOTH_SCHOOLS,
  PERSONAS,
  SKILL,
  emailFor,
  identiconSvg,
  type DemoSchool,
  type Persona,
} from './demo-personas.js'
import { createSchool, legacySchoolDid, legacySchoolHosts, listSchools, type School } from '../src/lib/schools.js'
import { setDirectoryListing } from '../src/lib/membership.js'
import { actorFor } from '../src/lib/school-actors.js'
import { getRecord } from '../src/lib/pds.js'
import { school, schoolDomain } from '../src/db/schema.js'

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
  /** The school this persona signed up in — their home city, and the host to sign in on. */
  school: DemoSchool
  /** EVERY school they belong to. Only `maya` has two, and that is the whole point. */
  schools: DemoSchool[]
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
  /** Schools this run seeded (1, or 2 with `--schools boulder,denver`). */
  schools: number
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
async function signUpPersona(persona: Persona, schoolDid: string): Promise<{ viewer: Viewer; did: string; handle: string }> {
  const email = emailFor(persona.slug)
  /**
   * `schoolDid` ON THE DOOR TOO, not only on the session. `signup()` records the invite
   * that IS this member's admission evidence (`fs_invite.school_did`), and evidence is
   * per school — a Denver persona whose invite landed in Boulder would derive a role
   * there off a door they never walked through.
   */
  const result = await signup({ email, schoolDid })
  if (!result.verifyUrl) {
    throw new Error('signup did not return a verifyUrl — is SMTP_URL set? seed:demo needs the dev mail path')
  }
  const token = new URL(result.verifyUrl).searchParams.get('token')
  if (!token) throw new Error('could not read the verification token out of the signup result')
  const { did } = await verifyEmailToken(token)
  // `schoolDid` is what signing in on that city's host does: `createSession` writes the
  // global `fs_member` row AND `fs_membership` for THIS school (MS §4). Passing it
  // explicitly is the headless equivalent of the Host header.
  const sessionId = await createSession(headlessContext(), did, 'custodial', { schoolDid })
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

export interface DemoClass {
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
export function demoClasses(): DemoClass[] {
  return [
    {
      host: 'amir',
      input: {
        name: 'Saturday bike repair table',
        publicOverview: {
          description:
            'Bring the bike and the problem — a brake that rubs, a chain that skips, a wheel that will not true — and we will work through it together on a proper stand. You do the wrenching; I hover and explain what the tool is actually doing. Most weeks somebody arrives certain their bike is finished and rides it home.',
          audience: 'Complete beginners welcome. No tools of your own needed.',
          accessibility: 'Flat ground-floor garage, wide doorway, seating available.',
        },
        attendeeNotes: 'Come down the alley to the open garage door — the house number is hard to read from the street. If the gate is latched, text me and I will come out.',
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
        publicOverview: {
          description:
            'We salt, rinse, mix a paste and pack a jar, start to finish, in about two hours. You leave with a full jar of your own and a clear sense of why each step is there — which is what lets you stop following recipes. I will bring more cabbage than we need, so nobody has to share.',
          audience: 'Anyone who has never fermented anything. Children welcome with an adult.',
        },
        attendeeNotes: 'Kitchen is up one flight at the back of the building; the front buzzer is broken, so use the side door.',
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
        publicOverview: {
          description:
            'Four weeks, one evening a week, and a starter you take home after the first. We bake together, compare what everyone\u2019s week produced, and work out what the dough was telling you. The point is to stop measuring and start reading — by week four most people have given up the timer.',
          audience: 'For people who have tried sourdough alone and found it went strange on them.',
        },
        attendeeNotes: 'We are still looking for a kitchen with an oven big enough — I will email everyone the address as soon as it is settled.',
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
        publicOverview: {
          description:
            'G, C and D will carry most of a room, and we will spend the first half getting them clean and the second half actually playing something. Bring any guitar, however cheap or badly tuned — I have spare picks and a capo or two. If you can hold a shape for four beats you can play with us.',
          audience: 'Absolute beginners, and anyone who learned once and stopped.',
        },
        startsAt: at(4 * DAY),
        endsAt: at(4 * DAY + 2 * HOUR),
        neighborhood: 'Martin Acres',
        timezone: 'America/Denver',
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.guitar), level: 1 }],
        materials: ['A guitar, if you have one'],
      },
      going: ['lina', 'eli'],
    },
    {
      host: 'jonah',
      input: {
        name: 'Monthly song circle',
        publicOverview: {
          description:
            'No lead, no setlist, no audience — we sit in a ring and take turns starting something. Bring one song you half know and let the room carry the rest of it. Listeners are as welcome as players, and nobody is ever made to take a turn.',
          audience: 'Any instrument, any voice, any level. Come alone; you will not stay a stranger.',
        },
        attendeeNotes: 'Room details go out the week before — we rotate between a few front rooms depending on who has space.',
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
    // The one that meets online — so the "meeting link, revealed after you RSVP" gate has
    // something real behind it.
    {
      host: 'priya',
      input: {
        name: 'Spanish conversation hour',
        publicOverview: {
          description:
            'An hour of actual talking, online: half spent listening to each other and half spent trying, with me steering gently and translating only when we are properly stuck. No textbook, no grammar drills, no homework. Come with something you did this week that you would like to be able to describe.',
          audience: 'Anyone past the first few hundred words who needs practice more than instruction.',
          accessibility: 'Online, captions on, and the recording is never kept.',
        },
        attendeeNotes: 'The room opens ten minutes early if you want to test your microphone. If you drop out, just rejoin — it happens to all of us.',
        meetingLink: 'https://meet.jit.si/freeskool-demo-spanish-hour',
        mode: 'community.lexicon.calendar.event#virtual',
        startsAt: at(2 * DAY),
        endsAt: at(2 * DAY + HOUR),
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
        publicOverview: {
          description:
            'A closed session for people who already run meetings here. We each bring a moment that went badly, replay it with the room, and try a different move. Expect to be in the hot seat once and in the circle the rest of the time.',
          audience: 'Members who have facilitated at least one gathering for this school.',
        },
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
        publicOverview: {
          description:
            'Darning, patches, a dropped hem and the small repairs that keep a coat going another winter. Bring the thing you have been meaning to fix for a year. We supply needles, thread, scrap fabric and the company that makes it bearable.',
          audience: 'No sewing experience assumed. Machines available but not required.',
        },
        attendeeNotes: 'Side entrance off the parking lot — the main door locks at six.',
        startsAt: at(-21 * DAY),
        endsAt: at(-21 * DAY + 2 * HOUR),
        neighborhood: 'Whittier',
        timezone: 'America/Denver',
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.facilitation), level: 1 }],
        materials: ['Something that needs mending'],
      },
      going: ['rosa', 'noor', 'sam'],
      attended: ['rosa', 'noor', 'sam'],
    },
    {
      host: 'ines',
      input: {
        name: 'How we decide things here',
        publicOverview: {
          description:
            'A walk through this school\u2019s own policy record — who may host, how a role is derived rather than granted, what a steward can and cannot do — and then the part that matters: how you change any of it. Bring a rule you think is wrong and we will look up where it actually lives.',
          audience: 'Anyone who has joined and wants to know what they have joined.',
        },
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
 * Task 19c added a fifth: the class record's own `description` is now the PUBLIC
 * overview, so a class seeded before that change has none and its page reads "The host
 * hasn't added a public overview yet."
 *
 * So the decision is per-ARTIFACT, not per-class. Pure, so every case is testable without
 * a PDS, an indexer or a database.
 */
export interface ClassRepairState {
  /** Does the app-side presentation already carry a `publicOverview.description`? */
  hasOverview: boolean
  /** Does the persona's definition supply one to write? */
  wantsOverview: boolean
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
  /** Write the public overview through `updateEventAsHost`, the host's own edit path. */
  overview: boolean
  listing: boolean
  series: boolean
  materialize: boolean
}

export function planClassRepair(state: ClassRepairState): ClassRepairPlan {
  const series = state.wantsSeries && !state.hasSeries
  return {
    overview: state.wantsOverview && !state.hasOverview,
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

/** Does THIS school already hold a curation listing for this event? */
async function hasOurListing(eventUri: string, forSchool: string): Promise<boolean> {
  try {
    const indexer = await getIndexer()
    const rows = await sidecarsForEvent<EventListing>(indexer, 'eventListing', eventUri)
    return rows.some((r) => r.value.school === forSchool)
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
  schoolDid: string,
): Promise<{ occurrences: number; repairs: number }> {
  const indexer = await getIndexer()
  const record = await getRecordByUri(indexer, 'event', eventUri)
  if (!record?.cid) return { occurrences: 0, repairs: 0 }
  const firstEvent = { uri: eventUri, cid: record.cid }

  const wantsSeries = Boolean(demo.input.series)
  const seriesUri = wantsSeries ? await existingSeriesUri(viewer.did, eventUri) : undefined
  const presentation = await getPresentation(eventUri)
  const plan = planClassRepair({
    hasOverview: Boolean(presentation.publicOverview?.description),
    wantsOverview: Boolean(demo.input.publicOverview?.description),
    hasListing: await hasOurListing(eventUri, schoolDid),
    // `routeListing` makes the real decision (it also checks the school's own routing
    // tags); this only asks whether a listing is possible in principle.
    routes: (demo.input.visibility ?? 'listed') === 'listed' && (demo.input.tags?.length ?? 0) > 0,
    wantsSeries,
    hasSeries: Boolean(seriesUri),
    occurrences: seriesUri ? await occurrenceCount(seriesUri) : 0,
  })

  let occurrences = 0
  let repairs = 0
  let listed = false
  const notify: string[] = []

  /**
   * The host's own edit path, so the overview lands on the RECORD (19c) exactly as it
   * would if they had opened the class and typed it. `updateEventAsHost` re-runs tag
   * routing as part of that, so it may write the missing curation listing too — which is
   * why its result is checked before `routeListing` is considered below, rather than both
   * firing and leaving two listings behind.
   */
  if (plan.overview) {
    const updated = await updateEventAsHost(
      viewer,
      eventUri,
      {
        publicOverview: demo.input.publicOverview,
        ...(demo.input.attendeeNotes ? { attendeeNotes: demo.input.attendeeNotes } : {}),
        ...(demo.input.meetingLink ? { meetingLink: demo.input.meetingLink } : {}),
      },
      schoolDid,
    )
    notify.push(updated.event.uri)
    if (updated.listing) {
      notify.push(updated.listing.uri)
      listed = true
    }
    repairs++
  }

  if (plan.listing && !listed) {
    const listing = await routeListing({
      event: firstEvent,
      name: demo.input.name,
      tags: demo.input.tags ?? [],
      visibility: demo.input.visibility,
      callerDid: viewer.did as Did,
      schoolDid,
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

/* ------------------------------------------------------------------------- *
 * A second city (federation phase)
 * ------------------------------------------------------------------------- */

/**
 * `--schools boulder,denver`. `boulder` is always the env-configured school of this
 * stack; it is implied, so `--schools denver` still seeds the Boulder cast first (Maya
 * has to exist in Boulder before she can be the same person in Denver).
 */
export function parseSchools(argv: readonly string[]): DemoSchool[] {
  const flag = argv.find((a) => a === '--schools' || a.startsWith('--schools='))
  if (!flag) return ['boulder']
  const raw = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : (argv[argv.indexOf(flag) + 1] ?? '')
  const asked = raw
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean)
  for (const label of asked) {
    if (!(DEMO_SCHOOLS as readonly string[]).includes(label)) {
      throw new Error(`unknown demo school "${label}" — known: ${DEMO_SCHOOLS.join(', ')}`)
    }
  }
  // Always Boulder first, and only ever each school once.
  return [...new Set<DemoSchool>(['boulder', ...(asked as DemoSchool[])])]
}

/**
 * The hosts a demo school answers on locally.
 *
 * DELIBERATELY AN UPSERT, not `ON CONFLICT DO NOTHING` like `ensureLegacySchoolRow`:
 * a dev box accumulates schools (a Task-5 verification run, an old e2e school), and the
 * FIRST of them to claim `localhost` keeps it forever under do-nothing — so `localhost`
 * can end up naming a school nobody is using while the real one is unreachable at the
 * apex. The demo seed refuses to run outside a local stack (`assertLocalOnly`), so
 * re-pointing dev hostnames is safe here and nowhere else.
 */
async function ensureDemoHosts(schoolDid: string, label: DemoSchool): Promise<void> {
  if (label === 'boulder') {
    /**
     * The demo school IS Boulder, in `fs_school` as well as in its own published record.
     * `ensureLegacySchoolRow` writes the row `ON CONFLICT DO NOTHING`, so a box whose
     * school was created by an old e2e run keeps that run's name forever — and because
     * the calendar masthead prefers the ROW's name when signed in and the RECORD's when
     * signed out, the same page reads "E2e-86269 Free School" to a member and "Boulder
     * Free School" to a stranger. Name it once, here, where the demo's identity is
     * decided anyway.
     */
    await getDb()
      .update(school)
      .set({ name: BOULDER.name, city: BOULDER.city })
      .where(eq(school.did, schoolDid))
  }
  const rows: Array<{ host: string; kind: 'canonical' | 'alias' }> = [
    { host: DEMO_SCHOOL_HOSTS[label], kind: label === 'boulder' ? 'alias' : 'canonical' },
  ]
  // Boulder is the legacy school, so it also keeps the apex and whatever
  // `ensureLegacySchoolRow` derives from `WEB_PUBLIC_URL` — `localhost` in dev, which is
  // what `e2e/mvp.spec.ts` and `e2e/personas.spec.ts` browse, and therefore the one that
  // stays CANONICAL for Boulder.
  if (label === 'boulder') rows.push(...legacySchoolHosts())

  /**
   * EXACTLY ONE CANONICAL HOST PER SCHOOL, and locally it must be a host that resolves.
   *
   * `createSchool` writes `<label>.<SCHOOL_DOMAIN_SUFFIX>` — `denver.freeskool.xyz` — as
   * canonical, because that is what a real deployment serves. On a dev box nothing
   * answers there, and `canonicalHostFor` (what `POST /api/auth/switch-school` and
   * `/schools` hand the browser) picks a canonical row, so the school switcher would send
   * a developer to the production hostname of a school that only exists on their laptop.
   * Demote whatever this school had before writing the demo's own hosts.
   */
  await getDb().update(schoolDomain).set({ kind: 'alias' }).where(eq(schoolDomain.schoolDid, schoolDid))
  for (const row of rows) {
    await getDb()
      .insert(schoolDomain)
      .values({ host: row.host, schoolDid, kind: row.kind })
      .onConflictDoUpdate({ target: schoolDomain.host, set: { schoolDid, kind: row.kind } })
  }
}

/** Denver, created through the real `createSchool` — or the one a previous run made. */
async function ensureDenverSchool(): Promise<School> {
  const existing = (await listSchools()).find((row) => row.label === DENVER.label)
  if (existing) return existing
  const created = await createSchool({
    label: DENVER.label,
    name: DENVER.name,
    city: DENVER.city,
    operator: 'seed:demo',
    // No `founderDid`: Denver's steward signs up through the ordinary door below and is
    // appointed afterwards, so nothing here invents a member.
    seedTiers: false,
  })
  const row = await listSchools().then((rows) => rows.find((r) => r.did === created.did))
  if (!row) throw new Error('createSchool returned a DID with no fs_school row')
  return row
}

/**
 * Denver's hosting bar, written as a REAL policy record through the school actor — the
 * same two writes `PUT /api/admin/policy` makes (re-point the school record, then write
 * the policy it names), so the seed cannot produce a policy state the product cannot.
 *
 * Idempotent: a re-run finds the bar already where it wants it and writes nothing.
 */
async function setDenverHostingBar(denverDid: string, stewardDid: string): Promise<boolean> {
  const thresholds = await getThresholds(denverDid)
  if (thresholds.hostMinAttended === DENVER.hostMinAttended) return false

  const actor = await actorFor(denverDid)
  const schoolRecord = await getRecord(denverDid, NSID.school, 'self')
  if (!schoolRecord) throw new Error(`Denver has no ${NSID.school} record to re-point`)
  const currentPolicyRkey = (schoolRecord.value?.policy as string | undefined)?.split('/').pop()
  const currentPolicy = currentPolicyRkey ? await getRecord(denverDid, NSID.policy, currentPolicyRkey) : null

  const now = new Date().toISOString()
  const rkey = tid()
  const policyUri = `at://${denverDid}/${NSID.policy}/${rkey}`
  const audit = {
    reason: 'seed:demo — Denver asks for one attended class before hosting, so a member of both cities has a different role in each',
    approvals: [],
  }
  const caller = stewardDid as Did
  await actor.putRecordAsSchool({
    schoolDid: denverDid as Did,
    callerDid: caller,
    scope: NSID.school,
    action: 'write-policy',
    collection: NSID.school,
    rkey: 'self',
    record: { ...schoolRecord.value, policy: policyUri },
    audit,
  })
  await actor.putRecordAsSchool({
    schoolDid: denverDid as Did,
    callerDid: caller,
    scope: NSID.policy,
    action: 'write-policy',
    collection: NSID.policy,
    rkey,
    record: {
      $type: NSID.policy,
      title: (currentPolicy?.value?.title as string | undefined) ?? `${DENVER.name} policy`,
      text: (currentPolicy?.value?.text as string | undefined) ?? 'Free School is free.',
      version: '2',
      effectiveAt: now,
      thresholds: { ...thresholds, hostMinAttended: DENVER.hostMinAttended },
      createdAt: now,
    },
    audit,
  })
  await refreshPolicyCache(denverDid)
  return true
}

/** Two Denver classes, both hosted by Denver's own steward. */
function denverClasses(): DemoClass[] {
  return [
    {
      host: 'wren',
      input: {
        name: 'Seed swap and starts',
        publicOverview: {
          description:
            'Bring whatever is rattling around in an envelope in your drawer and take home something you have never grown. We label, we swap, and we write down who is planting what so the block is not all growing zucchini in July.',
          audience: 'Anyone with a pot, a plot or a windowsill.',
        },
        attendeeNotes: 'The gate off the alley is the one that opens; the front path is under repair.',
        startsAt: at(4 * DAY),
        endsAt: at(4 * DAY + 2 * HOUR),
        neighborhood: 'Baker',
        timezone: 'America/Denver',
        capacity: 20,
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.gardening), level: 1 }],
        materials: ['Seeds, if you have them'],
      },
      going: ['maya'],
    },
    {
      host: 'wren',
      input: {
        name: 'How a meeting ends on time',
        publicOverview: {
          description:
            'One evening on the small mechanics that stop a two-hour meeting: naming the decision, timing the round, and writing the minute while everyone is still in the room. We practise on a real agenda somebody brings.',
          audience: 'Anyone who runs, or is about to run, a gathering here.',
        },
        startsAt: at(9 * DAY),
        endsAt: at(9 * DAY + 90 * 60_000),
        timezone: 'America/Denver',
        tags: ['skillshare', 'demo'],
        skills: [{ skill: skillUri(SKILL.facilitation), level: 1 }],
      },
    },
  ]
}

/** One thing Denver has asked for. Maya asks it; Denver's steward says they want it too. */
const DENVER_REQUESTS: Array<{ asker: string; title: string; description: string; skill?: string; threshold?: number; interested: string[] }> = [
  {
    asker: 'maya',
    title: 'A winter kraut evening somewhere on this side of the hill',
    description: 'I teach this up in Boulder and would happily do it here if a kitchen turns up.',
    skill: SKILL.fermentation,
    threshold: 2,
    interested: ['wren'],
  },
]

/**
 * Denver's vouches for Maya — DIFFERENT people, for a DIFFERENT skill, from the ones she
 * has in Boulder. MS §10: a vouch made in Denver is invisible in Boulder and vice versa,
 * and this is the fixture that lets a test see that.
 */
const DENVER_VOUCHES: Array<{ from: string; to: string; skill: string }> = [
  { from: 'wren', to: 'maya', skill: SKILL.kimchi },
]

/**
 * THE SECOND CITY. Everything here goes through the same libs the Boulder section uses,
 * with `denver.did` where Boulder passed `boulderDid` — that symmetry IS the test: a
 * school is a parameter, not a deployment.
 *
 * What the fixture is FOR, in order:
 *   - Maya is the same DID in both cities, with the same profile and the same claims
 *     (global, MS §2) and a different vouch, a different RSVP and a different derived
 *     role in each (per school, MS §4);
 *   - Wren is Denver's steward and nothing at all in Boulder — the "a Denver steward has
 *     no steward power on Boulder" acceptance criterion needs a person to be;
 *   - every Boulder-only persona (theo, rosa, …) is someone Denver must never see.
 */
async function seedDenver(ctx: {
  counts: SeedCounts
  users: DemoUser[]
  viewers: Map<string, Viewer>
  viewerFor: (slug: string) => Viewer
}): Promise<void> {
  const { counts, users, viewers, viewerFor } = ctx
  const denver = await ensureDenverSchool()

  await ensureDemoHosts(denver.did, 'denver')

  // 1. Denver's own cast, through the ordinary door, joining DENVER.
  for (const persona of DENVER_PERSONAS) {
    const { viewer, did } = await signUpPersona(persona, denver.did)
    viewers.set(persona.slug, viewer)
    // The school, explicitly — see the note on the Boulder call above.
    await saveProfile(
      did,
      {
        displayName: persona.displayName,
        bio: persona.bio,
        publicListing: true,
        directoryListing: true,
        avatar: await avatarFor(persona.slug),
      },
      denver.did,
    )
    const chosen = await setChosenHandle(viewer, persona.slug)
    const handle = chosen.ok ? chosen.handle : `${persona.slug}.${config().handleDomain}`
    users.push({
      slug: persona.slug,
      did,
      handle,
      email: emailFor(persona.slug),
      displayName: persona.displayName,
      intent: persona.intent,
      school: 'denver',
      schools: ['denver'],
    })
    counts.members++
    const result = await setSkillClaims(viewer, {
      claims: persona.skills.map((skill) => ({
        skill: skillUri(skill.id),
        level: skill.level,
        ...(skill.note ? { note: skill.note } : {}),
        visibility: skill.visibility ?? 'public',
      })),
      confirmTierB: true,
    })
    if (result.ok) counts.claims += persona.skills.length
  }

  // 2. Denver's steward. `appointSteward` clears `suspended_at`, so a re-run is a no-op.
  const wren = viewerFor('wren')
  await appointSteward(wren.did, denver.did)
  counts.stewards++

  // 3. Denver's policy: one attended class before hosting. This is the ONLY difference
  //    between the two schools' rules, and it is what makes Maya a Host in Boulder and a
  //    Member in Denver off identical evidence.
  await setDenverHostingBar(denver.did, wren.did)

  // 4. The people who belong to BOTH. A second session on Denver's host is exactly what a
  //    member does when they follow a link to the other city and sign in: `createSession`
  //    writes `fs_membership` for that school and nothing else changes about them.
  for (const slug of IN_BOTH_SCHOOLS) {
    const home = users.find((u) => u.slug === slug)
    if (!home) throw new Error(`"${slug}" belongs in both schools but was never seeded in Boulder`)
    const sessionId = await createSession(headlessContext(), home.did, 'custodial', { schoolDid: denver.did })
    await getDb().delete(session).where(eq(session.id, sessionId))
    /**
     * ...and listed in Denver's directory. `joinSchool` deliberately does NOT re-list a
     * RETURNING member (leaving was the stronger statement — `lib/membership.ts`), so
     * without this a seed re-run after the e2e "leaving Denver" journey would leave Maya
     * invisible there and the next run would assert against a different fixture. A demo
     * seed's job is a known starting state; a real member's own choice is never touched
     * by anything but their own toggle.
     */
    await setDirectoryListing(home.did, denver.did, true)
    if (!home.schools.includes('denver')) home.schools.push('denver')
  }
  const didFor = (slug: string) => {
    const seeded = users.find((u) => u.slug === slug)
    if (!seeded) throw new Error(`no seeded persona "${slug}"`)
    return seeded.did
  }

  // 5. Denver's classes, on Denver's calendar, in Wren's own repo.
  const classUris = new Map<string, string>()
  for (const demo of denverClasses()) {
    const viewer = viewerFor(demo.host)
    const already = await existingClassUri(viewer.did, demo.input.name)
    if (already) {
      classUris.set(demo.input.name, already)
      const repaired = await repairClass(viewer, demo, already, denver.did)
      counts.occurrences += repaired.occurrences
      counts.repairs += repaired.repairs
      continue
    }
    const created = await createEventAsHost(viewer, demo.input, denver.did)
    classUris.set(demo.input.name, created.event.uri)
    counts.classes++
  }

  // 6. RSVPs — Maya is coming to a Denver class she does not teach.
  for (const demo of denverClasses()) {
    const eventUri = classUris.get(demo.input.name)
    if (!eventUri) continue
    for (const slug of demo.going ?? []) {
      await upsertRsvp({ eventUri, did: didFor(slug), status: 'going', schoolDid: denver.did })
      counts.rsvps++
    }
  }

  // 7. Denver's needs board.
  for (const req of DENVER_REQUESTS) {
    const viewer = viewerFor(req.asker)
    let uri = await existingRequestUri(viewer.did, req.title)
    if (!uri) {
      const created = await createRequest(
        viewer,
        {
          title: req.title,
          description: req.description,
          ...(req.skill ? { skill: skillUri(req.skill) } : {}),
          ...(req.threshold ? { threshold: req.threshold } : {}),
        },
        { schoolDid: denver.did },
      )
      uri = created.uri
      counts.requests++
    }
    for (const slug of req.interested) {
      if (await isInterested(uri, didFor(slug), denver.did)) continue
      await toggleInterest(uri, didFor(slug), denver.did)
      counts.interests++
    }
  }

  // 8. Denver's vouches — different people, different skill, invisible in Boulder.
  for (const vouch of DENVER_VOUCHES) {
    try {
      await createAttestation({
        attesterDid: didFor(vouch.from),
        subjectDid: didFor(vouch.to),
        skillUri: skillUri(vouch.skill),
        schoolDid: denver.did,
      })
      counts.vouches++
    } catch (err) {
      if (!(err instanceof AttestationError)) throw err
    }
  }
}

export async function seedDemo(options: { schools?: DemoSchool[] } = {}): Promise<{ counts: SeedCounts; users: DemoUser[] }> {
  assertLocalOnly()
  await assertHostsCanHost()
  const schools = options.schools ?? ['boulder']
  const boulderDid = legacySchoolDid()
  if (!boulderDid) throw new Error('seed:demo needs SCHOOL_DID — run `pnpm --filter @freeschool/appview create-school` first')
  await ensureDemoHosts(boulderDid, 'boulder')
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
    schools: 1,
    repairs: 0,
  }

  // 1. MEMBERS — the primary door, profile, chosen handle.
  const viewers = new Map<string, Viewer>()
  const users: DemoUser[] = []
  for (const persona of PERSONAS) {
    const { viewer, did } = await signUpPersona(persona, boulderDid)
    viewers.set(persona.slug, viewer)

    /**
     * THE SCHOOL IS NOT OPTIONAL HERE. `saveProfile`'s `schoolDid` defaults to the legacy
     * school, and `directoryListing` is written through `setDirectoryListing`, which
     * UPSERTS `fs_membership` — so a profile saved without naming the school makes the
     * member a member of Boulder. (Found by this task's two-school seed: Denver's steward
     * appeared in Boulder's directory. `PUT /api/me` always passed `currentSchool(c)`, so
     * the product was never wrong; the script was.)
     */
    await saveProfile(
      did,
      {
        displayName: persona.displayName,
        bio: persona.bio,
        publicListing: true,
        directoryListing: true,
        avatar: await avatarFor(persona.slug),
      },
      boulderDid,
    )

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
      school: 'boulder',
      schools: ['boulder'],
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
      const repaired = await repairClass(viewer, demo, already, boulderDid)
      counts.occurrences += repaired.occurrences
      counts.repairs += repaired.repairs
      continue
    }
    const created = await createEventAsHost(viewer, demo.input, boulderDid)
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
      await upsertRsvp({ eventUri, did: didFor(slug), status: 'going', schoolDid: boulderDid })
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
      schoolDid: boulderDid,
    })
    counts.attendances += result.recorded
  }

  // 6. REQUESTS + interest.
  for (const req of DEMO_REQUESTS) {
    const viewer = viewerFor(req.asker)
    let uri = await existingRequestUri(viewer.did, req.title)
    if (!uri) {
      const created = await createRequest(
        viewer,
        {
          title: req.title,
          description: req.description,
          ...(req.skill ? { skill: skillUri(req.skill) } : {}),
          ...(req.threshold ? { threshold: req.threshold } : {}),
        },
        { schoolDid: boulderDid },
      )
      uri = created.uri
      counts.requests++
    }
    for (const slug of req.interested) {
      // `toggleInterest` is a TOGGLE: check first, or a re-run un-interests everybody.
      if (await isInterested(uri, didFor(slug), boulderDid)) continue
      await toggleInterest(uri, didFor(slug), boulderDid)
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
        schoolDid: boulderDid,
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
  await appointSteward(didFor('steward'), boulderDid)
  counts.stewards++

  // 9b. A SECOND CITY, when asked for.
  if (schools.includes('denver')) {
    await seedDenver({ counts, users, viewers, viewerFor })
    counts.schools++
  }

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
  const { counts } = await seedDemo({ schools: parseSchools(process.argv.slice(2)) })
  // COUNTS AND THE PATH ONLY — never a DID, an email or a handle (R9).
  console.log('Demo school seeded:')
  for (const [what, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(4)}  ${what}`)
  console.log(`\nPlaywright fixture: ${DEMO_USERS_PATH}`)
  await closeDb()
}
