/**
 * Task 14: the libs `scripts/seed-demo.ts` shares with the HTTP routes, plus the persona
 * data and identicon the seed is built from.
 *
 *   - `lib/profile.ts#saveProfile`      — merge semantics, the avatar re-encode, and the
 *                                         `fs_member_prefs` flag that rides along with it.
 *   - `lib/attendance.ts#recordAttendance` — A5's "the tally follows the transition, not
 *                                         the write": re-saving a sheet must not
 *                                         re-credit anybody, un-ticking takes it back,
 *                                         and a host never attests themselves.
 *   - `scripts/demo-personas.ts`        — twelve distinct personas, stable identicons.
 *
 * The claim/handle/request/resource libs are the same code the route suites already drive
 * end to end (`consent-and-board`, `me-handle`, `me-visibility`, `knowledge`,
 * `request-interest`), so they are covered there rather than mocked a second time here.
 */
process.env.SCHOOL_DID ??= 'did:plc:demo-seed-libs-school'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool_test'
process.env.PDS_URL ??= 'http://localhost:3000'
process.env.PDS_HANDLE_DOMAIN ??= 'test'
process.env.SESSION_SECRET ??= 'demo-seed-libs-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 17).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'demo-seed-libs-pepper'
process.env.APPVIEW_PUBLIC_URL ??= 'http://localhost:4000'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import sharp from 'sharp'

import { closeTestDb, pgAvailable, SKIP_MESSAGE, testDb, truncate } from './helpers/pg.js'
import { loadDirectoryPrefs, loadProfile, saveProfile } from '../src/lib/profile.js'
import { recordAttendance } from '../src/lib/attendance.js'
import { attendance, attendanceTally } from '../src/db/schema.js'
import { DEMO_EMAIL_DOMAIN, PERSONAS, emailFor, identiconSvg } from '../scripts/demo-personas.js'
import { demoClasses, planClassRepair, type ClassRepairState } from '../scripts/seed-demo.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_app_meta', 'fs_member_prefs', 'fs_attendance', 'fs_attendance_tally')
})

afterAll(async () => {
  if (available) await closeTestDb()
})

const ALICE = 'did:plc:demo-seed-alice'
const BOB = 'did:plc:demo-seed-bob'
const HOST = 'did:plc:demo-seed-host'
const EVENT = 'at://did:plc:demo-seed-host/community.lexicon.calendar.event/abc'

/** A 1x1 PNG, as the `{ data, alt }` shape `normalizeImage` accepts. */
async function pngDataUrl(): Promise<string> {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#4a7' } }).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

describe('lib/profile.ts#saveProfile', () => {
  it('writes the named fields and leaves an unnamed one alone on the next save', async () => {
    if (!available) return
    await saveProfile(ALICE, { displayName: 'Amir', bio: 'Bike stand in the garage.' })
    await saveProfile(ALICE, { bio: 'Now with a welding mask.' })

    const profile = await loadProfile(ALICE)
    expect(profile.displayName).toBe('Amir')
    expect(profile.bio).toBe('Now with a welding mask.')
  })

  it('re-encodes an avatar through normalizeImage and gives it a revision', async () => {
    if (!available) return
    const saved = await saveProfile(ALICE, { avatar: { data: await pngDataUrl(), alt: '' } })
    expect(saved.avatar?.revision).toBeTruthy()
    // Stored re-encoded, never as the bytes we were handed (R9: no EXIF, no filename).
    expect(saved.avatar?.data).not.toContain('data:image/png')
    const webp = Buffer.from(saved.avatar!.data, 'base64')
    expect((await sharp(webp).metadata()).format).toBe('webp')
  })

  it('clears the avatar on an explicit null, and only then', async () => {
    if (!available) return
    await saveProfile(ALICE, { avatar: { data: await pngDataUrl(), alt: '' } })
    expect((await saveProfile(ALICE, { bio: 'unrelated edit' })).avatar).toBeTruthy()
    expect((await saveProfile(ALICE, { avatar: null })).avatar).toBeUndefined()
  })

  it('writes directoryListing into fs_member_prefs, not into the profile blob', async () => {
    if (!available) return
    expect((await loadDirectoryPrefs(ALICE)).directoryListing).toBe(true) // default, no row
    const profile = await saveProfile(ALICE, { displayName: 'Amir', directoryListing: false })
    expect(profile).not.toHaveProperty('directoryListing')
    expect((await loadDirectoryPrefs(ALICE)).directoryListing).toBe(false)
  })

  it("does not touch another member's profile", async () => {
    if (!available) return
    await saveProfile(ALICE, { displayName: 'Amir' })
    await saveProfile(BOB, { displayName: 'Maya' })
    expect((await loadProfile(ALICE)).displayName).toBe('Amir')
    expect((await loadProfile(BOB)).displayName).toBe('Maya')
  })
})

describe('lib/attendance.ts#recordAttendance', () => {
  const sheet = (participated = true) => [{ did: ALICE, participated, role: 'attendee' as const }]

  async function tallyFor(did: string): Promise<number> {
    const rows = await testDb().select().from(attendanceTally).where(eq(attendanceTally.did, did)).limit(1)
    return rows[0]?.attendedConfirmed ?? 0
  }

  it('records a row and credits the attendee once', async () => {
    if (!available) return
    const result = await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet() })
    expect(result).toEqual({ recorded: 1, tallyChanged: 1 })
    expect(await tallyFor(ALICE)).toBe(1)
  })

  // A5: the sheet is precisely the screen people re-save.
  it('re-saving the same sheet credits nobody a second time', async () => {
    if (!available) return
    await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet() })
    const again = await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet() })
    expect(again).toEqual({ recorded: 1, tallyChanged: 0 })
    expect(await tallyFor(ALICE)).toBe(1)
  })

  it('un-ticking somebody takes the credit back, floored at zero', async () => {
    if (!available) return
    await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet() })
    const removed = await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet(false) })
    expect(removed).toEqual({ recorded: 0, tallyChanged: -1 })
    expect(await tallyFor(ALICE)).toBe(0)

    // And again: already at zero, nothing further to debit.
    await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet(false) })
    expect(await tallyFor(ALICE)).toBe(0)
  })

  it('never attests the host themselves', async () => {
    if (!available) return
    const result = await recordAttendance({
      eventUri: EVENT,
      hostDid: HOST,
      attendees: [{ did: HOST, participated: true, role: 'co-host' }, ...sheet()],
    })
    expect(result).toEqual({ recorded: 1, tallyChanged: 1 })
    const rows = await testDb()
      .select()
      .from(attendance)
      .where(and(eq(attendance.eventUri, EVENT), eq(attendance.attendeeDid, HOST)))
    expect(rows).toHaveLength(0)
  })

  // R3: a void is a steward decision, not the host's to reverse.
  it('a voided row moves the tally in neither direction on a re-save', async () => {
    if (!available) return
    await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet() })
    await testDb()
      .update(attendance)
      .set({ voidedAt: new Date() })
      .where(and(eq(attendance.eventUri, EVENT), eq(attendance.attendeeDid, ALICE)))

    expect(await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet() })).toEqual({
      recorded: 1,
      tallyChanged: 0,
    })
    expect(await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet(false) })).toEqual({
      recorded: 0,
      tallyChanged: 0,
    })
  })

  it('stores the class start on the row so retention can collapse by age', async () => {
    if (!available) return
    const startsAt = new Date('2026-01-02T18:00:00.000Z')
    await recordAttendance({ eventUri: EVENT, hostDid: HOST, attendees: sheet(), eventStartsAt: startsAt })
    const rows = await testDb().select().from(attendance).where(eq(attendance.eventUri, EVENT))
    expect(rows[0]?.eventStartsAt?.toISOString()).toBe(startsAt.toISOString())
  })
})

describe('scripts/demo-personas.ts', () => {
  it('has twelve members with unique slugs, and one steward', () => {
    expect(PERSONAS).toHaveLength(12)
    expect(new Set(PERSONAS.map((p) => p.slug)).size).toBe(12)
    expect(PERSONAS.filter((p) => p.intent === 'steward')).toHaveLength(1)
    expect(PERSONAS.filter((p) => p.intent === 'host').length).toBeGreaterThanOrEqual(4)
  })

  it('addresses every persona on a reserved test TLD, so demo mail can never leave', () => {
    for (const p of PERSONAS) expect(emailFor(p.slug)).toBe(`demo+${p.slug}@${DEMO_EMAIL_DOMAIN}`)
    expect(DEMO_EMAIL_DOMAIN.endsWith('.test')).toBe(true)
  })

  it('draws a stable identicon per slug, and a different one per slug', () => {
    const amir = identiconSvg('amir')
    expect(identiconSvg('amir')).toBe(amir) // re-running the seed must not churn avatars
    expect(identiconSvg('maya')).not.toBe(amir)
    expect(amir.startsWith('<svg')).toBe(true)
  })

  it('rasterizes to a PNG sharp can read, which is what normalizeImage accepts', async () => {
    const png = await sharp(Buffer.from(identiconSvg('amir'))).png().toBuffer()
    const meta = await sharp(png).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(240)
  })
})

/**
 * A class is four records, not one, so an interrupted run can leave one that EXISTS but
 * has no listing and no series. `planClassRepair` is the per-artifact decision that
 * replaced the old skip-if-the-name-is-taken check.
 */
describe('scripts/seed-demo.ts#planClassRepair', () => {
  const state = (over: Partial<ClassRepairState> = {}): ClassRepairState => ({
    hasOverview: true,
    wantsOverview: true,
    hasListing: true,
    routes: true,
    wantsSeries: false,
    hasSeries: false,
    occurrences: 0,
    ...over,
  })

  it('does nothing for a class that came through a complete run', () => {
    expect(planClassRepair(state({ wantsSeries: true, hasSeries: true, occurrences: 6 }))).toEqual({
      overview: false,
      listing: false,
      series: false,
      materialize: false,
    })
  })

  it('is a no-op for a complete one-off class', () => {
    expect(planClassRepair(state())).toEqual({ overview: false, listing: false, series: false, materialize: false })
  })

  // Task 19c moved the public overview onto the record's own `description`; classes
  // seeded before it have none, and their page reads "no public overview yet".
  it('writes the public overview when the class predates 19c', () => {
    expect(planClassRepair(state({ hasOverview: false })).overview).toBe(true)
  })

  it('leaves an overview that is already there alone, so a second run writes nothing', () => {
    expect(planClassRepair(state({ hasOverview: true })).overview).toBe(false)
  })

  it('writes no overview when the persona definition supplies none', () => {
    expect(planClassRepair(state({ hasOverview: false, wantsOverview: false })).overview).toBe(false)
  })

  // The exact shape the crashed run left behind: the event was written, then
  // `routeListing` threw, so neither the listing nor the series ever happened.
  it('restores the listing and the series when the run died right after the event', () => {
    expect(planClassRepair(state({ hasOverview: false, hasListing: false, wantsSeries: true }))).toEqual({
      overview: true,
      listing: true,
      series: true,
      materialize: true,
    })
  })

  it('materializes a series that exists but never got its occurrences', () => {
    expect(planClassRepair(state({ wantsSeries: true, hasSeries: true, occurrences: 0 }))).toEqual({
      overview: false,
      listing: false,
      series: false,
      materialize: true,
    })
  })

  it('leaves a listing alone once we have one — a steward removal is not ours to undo', () => {
    expect(planClassRepair(state({ hasListing: true, routes: true })).listing).toBe(false)
  })

  it('writes no listing for a class that would not route anyway (unlisted, or untagged)', () => {
    expect(planClassRepair(state({ hasListing: false, routes: false })).listing).toBe(false)
  })

  it('never invents recurrence for a class the persona defines as one-off', () => {
    const plan = planClassRepair(state({ hasListing: false, wantsSeries: false, occurrences: 0 }))
    expect(plan.series).toBe(false)
    expect(plan.materialize).toBe(false)
  })
})

/**
 * Post-19c the class RECORD's `description` is the public overview, and `attendeeNotes` /
 * `meetingLink` are the app-side half revealed after an RSVP. A seeded class with no
 * overview renders "The host hasn't added a public overview yet." on its own page.
 */
describe('scripts/seed-demo.ts demo classes (post-19c fields)', () => {
  it('gives every class a public overview of real length', () => {
    for (const demo of demoClasses()) {
      const description = demo.input.publicOverview?.description ?? ''
      expect(description.length, `${demo.input.name} has no public overview`).toBeGreaterThan(120)
    }
  })

  it('never uses the deprecated pre-19c `description` / `uris` inputs', () => {
    for (const demo of demoClasses()) {
      expect(demo.input.description, `${demo.input.name} still uses the deprecated description`).toBeUndefined()
      expect(demo.input.uris, `${demo.input.name} still uses the deprecated uris`).toBeUndefined()
    }
  })

  it('carries attendee notes on the classes where a meeting point actually matters', () => {
    const withNotes = demoClasses().filter((d) => d.input.attendeeNotes)
    expect(withNotes.length).toBeGreaterThanOrEqual(4)
  })

  it('has exactly one online class, and it is the one with the meeting link', () => {
    const online = demoClasses().filter((d) => d.input.mode?.endsWith('#virtual'))
    expect(online).toHaveLength(1)
    expect(online[0]!.input.meetingLink).toMatch(/^https:\/\//)
    // The link is the app-side, after-RSVP half — never a `uris` entry on the record.
    expect(online[0]!.input.uris).toBeUndefined()
  })
})
