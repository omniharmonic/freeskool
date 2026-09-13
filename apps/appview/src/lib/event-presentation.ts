/** App-side presentation, like materials. Never extend a borrowed protocol record. */
import { eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '../db/index.js'
import { appMeta } from '../db/schema.js'
import { type StoredImage } from './images.js'

export interface PublicOverview { description: string; audience?: string; accessibility?: string }
export interface EventPresentation { publicOverview?: PublicOverview; cover?: StoredImage; venueNeeded?: boolean }
type PresentationSummary = { publicOverview?: PublicOverview; cover?: Omit<StoredImage, 'data'>; venueNeeded?: boolean }
const key = (uri: string) => `event-presentation:${uri}`
export async function getPresentations(uris: string[]): Promise<Map<string, PresentationSummary>> {
  if (!uris.length) return new Map()
  // Calendar/zine responses only need URLs and captions, never hundreds of image blobs.
  const rows = await getDb().select({ key: appMeta.key,
    value: sql<PresentationSummary>`${appMeta.value} #- '{cover,data}'`,
  }).from(appMeta).where(inArray(appMeta.key, uris.map(key)))
  return new Map(rows.map(r => [r.key.slice('event-presentation:'.length), r.value]))
}
export async function getPresentation(uri: string): Promise<EventPresentation> {
  const [row] = await getDb().select().from(appMeta).where(eq(appMeta.key, key(uri)))
  return (row?.value as EventPresentation | undefined) ?? {}
}
export async function savePresentation(uri: string, value: EventPresentation): Promise<void> {
  await getDb().insert(appMeta).values({ key: key(uri), value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } })
}
export function presentationFields(uri: string, value?: PresentationSummary) {
  return {
    ...(value?.publicOverview ? { publicOverview: value.publicOverview } : {}),
    ...(value?.venueNeeded !== undefined ? { venueNeeded: value.venueNeeded } : {}),
    ...(value?.cover ? { cover: { url: `/api/events/${encodeURIComponent(uri)}/image?v=${value.cover.revision}`, alt: value.cover.alt } } : {}),
  }
}
