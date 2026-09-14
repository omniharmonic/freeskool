/**
 * ONE-OFF REPAIR (task 19c) — move attendee notes and meeting links OFF the public record.
 *
 *   pnpm --filter @freeschool/appview migrate-event-notes -- --dry-run
 *   pnpm --filter @freeschool/appview migrate-event-notes
 *
 * WHAT WENT WRONG. Until 19c the class form offered the host two fields it described as
 * private — "Extra notes for people attending. Shown after RSVP on this school's pages."
 * and a meeting link "available to attendees after they RSVP" — and then wrote both into
 * `community.lexicon.calendar.event`'s `description` and `uris`, in the HOST'S OWN
 * world-readable repo. Meanwhile the text the host wrote FOR the public
 * (`publicOverview.description`) lived only app-side, so a peer AppView or a calendar
 * client saw a class with no description at all. Both halves are the same bug.
 *
 * WHAT THIS DOES, per indexed event record whose author has a custodial credential:
 *
 *   record.description  ->  fs_event_extra.attendee_notes   (if that column is empty)
 *   record.uris[0].uri  ->  fs_event_extra.meeting_link     (if it looks like a link, below)
 *   record.description  <-  publicOverview.description      (rewritten through the host's
 *   record.uris          -  dropped                          own agent, `actorAgent`)
 *
 * THE MEETING-LINK HEURISTIC, documented because it is a judgement call: `uris[0].uri` is
 * taken as the meeting link when it parses as an `https:` (or `http:`) URL. The named
 * services — zoom, meet.google, jitsi, teams, whereby, meet.jit.si — are the intended
 * case, but the field only ever had one producer (the class form's "Meeting link" input),
 * so ANY http(s) URL there is a meeting link by provenance; the host names are used only
 * to report how many were the obvious kind. A non-http URI (`mailto:`, an AT-URI, a bare
 * word) is left ALONE on the record: it did not come from that input and we should not
 * guess. Everything after `uris[0]` was never writable by our form either, so it is
 * carried nowhere and simply dropped with the rest of the array — the counts say how
 * many records had more than one.
 *
 * WHICH EVENTS. Only ones where the app-side presentation HAS a `publicOverview.
 * description` and the record's `description` differs from it: that pair is what makes
 * "the record's description is really the attendee notes" a fact rather than a guess. A
 * record whose description already equals the overview is already repaired.
 *
 * WHOSE. `actorAgent` with a custodial credential — the SAME write path the host's own
 * edit uses, so the record stays authored by its host. An OAuth-door host's session
 * cannot be refreshed from a script (`client.restore` needs their live session and may
 * need them to re-consent), and neither can the school's own repo, which authors
 * materialized occurrences. Both are COUNTED and skipped, never rewritten as somebody
 * else. Re-run after those hosts sign in, or let their next class edit repair it —
 * `updateEventAsHost` now rewrites `description` from the overview and drops `uris` on
 * every save.
 *
 * IDEMPOTENT: a second run finds nothing to do, because the first run made every record's
 * description equal its overview. Prints COUNTS ONLY — never a DID, a handle, or the text
 * of anybody's notes (R9).
 */
import { eq } from 'drizzle-orm'
import { closeDb, getDb } from '../src/db/index.js'
import { custodialAccount } from '../src/db/schema.js'
import { runMigrations } from '../src/db/migrate.js'
import { isMain } from '../src/lib/is-main.js'
import { getIndexer } from '../src/index/indexer.js'
import { listCollection, parseAtUri } from '../src/index/queries.js'
import { getPresentation } from '../src/lib/event-presentation.js'
import { getEventExtra, setEventExtra } from '../src/lib/event-extra.js'
import { actorAgent } from '../src/lib/actor-agent.js'
import { putInActorRepo } from '../src/lib/events.js'
import { NSID } from '../src/lexicons/nsids.js'
import { describeError, log } from '../src/lib/logging.js'

/** Reported separately only so the operator can see the obvious cases were found. */
const KNOWN_MEETING_HOSTS = ['zoom.', 'meet.google.', 'jit.si', 'jitsi', 'teams.microsoft.', 'whereby.']

export function looksLikeMeetingLink(uri: string | undefined): boolean {
  if (!uri) return false
  try {
    return ['http:', 'https:'].includes(new URL(uri).protocol)
  } catch {
    return false
  }
}

export function isKnownMeetingHost(uri: string): boolean {
  try {
    const host = new URL(uri).hostname.toLowerCase()
    return KNOWN_MEETING_HOSTS.some((h) => host.includes(h))
  } catch {
    return false
  }
}

export interface MigrationCounts {
  /** Event records walked in the index. */
  scanned: number
  /** Records that carry a legacy description and/or a legacy meeting link. */
  affected: number
  /** Records actually rewritten (0 on a dry run). */
  repaired: number
  /** Notes moved into `fs_event_extra.attendee_notes`. */
  notesMoved: number
  /** Links moved into `fs_event_extra.meeting_link`. */
  linksMoved: number
  /** Of those, on a host we recognise (zoom/meet/jitsi/teams/whereby). */
  linksOnKnownHosts: number
  /** `uris` entries beyond the first, which our form never wrote and which are dropped. */
  extraUrisDropped: number
  /** Affected, but the author has no custodial credential (OAuth door, or the school). */
  skippedNoCredential: number
  /** Affected, credential present, but the PDS write failed. */
  failed: number
}

export async function migrateEventNotes(options: { dryRun?: boolean; limit?: number } = {}): Promise<MigrationCounts> {
  const counts: MigrationCounts = {
    scanned: 0,
    affected: 0,
    repaired: 0,
    notesMoved: 0,
    linksMoved: 0,
    linksOnKnownHosts: 0,
    extraUrisDropped: 0,
    skippedNoCredential: 0,
    failed: 0,
  }
  const indexer = await getIndexer()
  const { records } = await listCollection<Record<string, unknown>>(indexer, 'event', { limit: options.limit ?? 5000 })
  const db = getDb()
  const custodial = new Map<string, boolean>()

  for (const row of records) {
    counts.scanned++
    const recordDescription = typeof row.value.description === 'string' ? row.value.description.trim() : ''
    const uris = Array.isArray(row.value.uris) ? (row.value.uris as Array<{ uri?: string; name?: string }>) : []
    const legacyLink = looksLikeMeetingLink(uris[0]?.uri) ? uris[0]!.uri!.trim() : ''

    const presentation = await getPresentation(row.uri)
    const overview = presentation.publicOverview?.description?.trim() ?? ''
    // The pair that makes this a legacy record rather than a guess (see the doc above).
    const legacyNotes = overview && recordDescription && recordDescription !== overview ? recordDescription : ''
    if (!legacyNotes && !legacyLink) continue
    counts.affected++
    if (uris.length > 1) counts.extraUrisDropped += uris.length - 1

    const did = row.did
    if (!custodial.has(did)) {
      const held = await db.select({ did: custodialAccount.did }).from(custodialAccount).where(eq(custodialAccount.did, did)).limit(1)
      custodial.set(did, held.length > 0)
    }
    if (!custodial.get(did)) {
      counts.skippedNoCredential++
      continue
    }

    const extra = await getEventExtra(row.uri)
    const attendeeNotes = extra.attendeeNotes ?? (legacyNotes || undefined)
    const meetingLink = extra.meetingLink ?? (legacyLink || undefined)
    if (legacyNotes && !extra.attendeeNotes) counts.notesMoved++
    if (legacyLink && !extra.meetingLink) {
      counts.linksMoved++
      if (isKnownMeetingHost(legacyLink)) counts.linksOnKnownHosts++
    }
    if (options.dryRun) continue

    const parts = parseAtUri(row.uri)
    if (!parts) {
      counts.failed++
      continue
    }
    try {
      // The host's own agent, exactly as `updateEventAsHost` does it: the repair must
      // never change who authored the class.
      const agent = await actorAgent({ did, kind: 'custodial', sessionId: 'migrate-event-notes' })
      const { uris: _dropped, description: _legacy, ...carried } = row.value
      await putInActorRepo(agent, did, NSID.event, parts.rkey, {
        ...carried,
        ...(overview ? { description: overview } : {}),
      })
      // Spread the existing `extra` FIRST, then overrides: `setEventExtra` clears anything
      // absent from its argument, and `cancelReason` (added by migration 0010, after this
      // script) is not this repair's to forget — same reasoning as `lib/events.ts:587`.
      await setEventExtra(row.uri, {
        ...extra,
        ...(attendeeNotes ? { attendeeNotes } : {}),
        ...(meetingLink ? { meetingLink } : {}),
      })
      counts.repaired++
    } catch (err) {
      // Never a DID or a handle in the log line.
      log.warn('could not repair an event record; leaving it as it is', { detail: describeError(err) })
      counts.failed++
    }
  }

  if (!options.dryRun && counts.repaired > 0) {
    await indexer.notify(records.map((r) => r.uri)).catch(() => {
      /* the periodic backfill will pick the rewritten records up */
    })
  }
  return counts
}

if (isMain(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run')
  await runMigrations().catch(() => {})
  const counts = await migrateEventNotes({ dryRun })
  console.log(
    `${dryRun ? '[dry run] ' : ''}event notes migration: ` +
      Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(' '),
  )
  if (counts.skippedNoCredential > 0) {
    console.log(
      `${counts.skippedNoCredential} record(s) belong to a repo we cannot write from a script ` +
        `(an OAuth-door host, or the school's own materialized occurrences). Re-run after those ` +
        `hosts sign in; their next class edit also repairs the record on its own.`,
    )
  }
  await closeDb()
}
