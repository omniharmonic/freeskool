/**
 * What is this viewer to this event? The answer decides whether they see the address.
 *
 * Checked in order of strength, and entirely from app-side tables plus the event's own
 * author DID — no public record anywhere says "these people are coming".
 */
import { and, eq, isNull } from 'drizzle-orm'
import { Role } from '@freeschool/shared'
import { getDb } from '../db/index.js'
import { attendance, rsvp } from '../db/schema.js'
import { roleOf } from '../lib/roles.js'
import type { Viewer } from './session.js'
import type { ViewerRelation } from './visibility.js'

export async function viewerRelation(
  viewer: Viewer,
  eventUri: string,
  hostDid: string,
): Promise<ViewerRelation> {
  if (viewer.did === hostDid) return 'host'
  const db = getDb()
  const [att, rs, role] = await Promise.all([
    db
      .select({ id: attendance.id })
      .from(attendance)
      .where(
        and(
          eq(attendance.eventUri, eventUri),
          eq(attendance.attendeeDid, viewer.did),
          eq(attendance.participated, true),
          isNull(attendance.voidedAt),
        ),
      )
      .limit(1),
    db
      .select({ status: rsvp.status })
      .from(rsvp)
      .where(and(eq(rsvp.eventUri, eventUri), eq(rsvp.did, viewer.did)))
      .limit(1),
    roleOf(viewer.did),
  ])
  if (att.length > 0) return 'attendee'
  if (rs[0] && rs[0].status !== 'notgoing') return 'rsvp'
  if (role >= Role.Steward) return 'steward'
  return 'public'
}
