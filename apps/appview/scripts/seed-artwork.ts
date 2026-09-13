/** Local-only design fixtures. Run with local AppView env loaded and ARTWORK_HOST_DID set. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { eq } from 'drizzle-orm'
import { config } from '../src/config.js'
import { getDb, closeDb } from '../src/db/index.js'
import { appMeta } from '../src/db/schema.js'
import { createEventAsHost, updateEventAsHost } from '../src/lib/events.js'

const c = config()
const local = (value: string) => ['localhost', '127.0.0.1'].includes(new URL(value).hostname)
if (c.NODE_ENV === 'production' || !local(c.DATABASE_URL) || !local(c.PDS_URL) || !local(c.APPVIEW_PUBLIC_URL)) throw new Error('Artwork fixtures only run against local development services')
const did = process.env.ARTWORK_HOST_DID
if (!did) throw new Error('Set ARTWORK_HOST_DID to an existing local test host')
const folder = new URL('../../../fixtures/artwork/', import.meta.url)
const fixtures = [
  { name: 'Grow together: mushroom workshop', file: 'mushroom-flyer', alt: 'Yellow and forest-green mushroom workshop flyer reading Grow Together', area: 'Community garden', tag: 'ecology' },
  { name: 'Keep your bicycle rolling', file: 'repair-photo', alt: 'Neighbors repairing a red bicycle together in a sunny courtyard', area: 'The repair courtyard', tag: 'repair' },
  { name: 'Seeds for the next season', file: 'botanical-square', alt: 'Hand-painted nasturtium leaves, orange flowers, blue seed packets and hands planting a seedling', area: 'Neighborhood greenhouse', tag: 'gardening' },
  { name: 'A kitchen full of cultures', file: 'rough-phone-photo', alt: 'Grainy evening kitchen snapshot of red cabbage fermenting in jars', area: 'Community kitchen', tag: 'food' },
  { name: 'Small photo, big fermentation energy', file: 'rough-phone-photo', tiny: true, alt: 'A deliberately compressed 240-pixel snapshot of homemade fermentation jars', area: 'Community kitchen', tag: 'food' },
  { name: 'Bring a skill. Meet a neighbor.', area: 'Around the neighborhood', tag: 'skill-sharing' },
]
const details = JSON.parse(await readFile(new URL('details.json', folder), 'utf8'))
const links: {name:string;url:string;image:string}[] = []
try {
  for (const [i, fixture] of fixtures.entries()) {
    const key = `design-artwork-fixture:v1:${i}`
    const [existing] = await getDb().select().from(appMeta).where(eq(appMeta.key, key))
    let uri = (existing?.value as {uri?:string} | undefined)?.uri
    const starts = new Date(); starts.setUTCDate(starts.getUTCDate() + 1); starts.setUTCHours(15 + i, 0, 0, 0)
    if (uri && process.env.ARTWORK_REFRESH_DATES === '1') await updateEventAsHost({ did, kind: 'custodial', sessionId: 'local-artwork-fixture' }, uri, { startsAt: starts.toISOString(), endsAt: new Date(starts.getTime()+7200000).toISOString() })
    if (uri && process.env.ARTWORK_REFRESH_DETAILS === '1') await updateEventAsHost({ did, kind: 'custodial', sessionId: 'local-artwork-fixture' }, uri, details[i])
    if (!uri) {
      let cover
      if (fixture.file) {
        const original = await readFile(new URL(`${fixture.file}.png`, folder))
        const processed = await sharp(original).resize({ width: fixture.tiny ? 240 : 2400, withoutEnlargement: true }).webp({ quality: fixture.tiny ? 22 : 84 }).toBuffer()
        await writeFile(new URL(`${fixture.file}${fixture.tiny ? '-240px' : ''}.webp`, folder), processed)
        cover = { data: `data:image/webp;base64,${processed.toString('base64')}`, alt: fixture.alt! }
      }
      const result = await createEventAsHost({did, kind:'custodial', sessionId:'local-artwork-fixture'}, {
        name: fixture.name, description: 'DESIGN DEMO — this is a test event, not a real gathering. The artwork is AI-generated to evaluate portrait, landscape, square and imperfect images in the Free School design system.',
        startsAt: starts.toISOString(), endsAt: new Date(starts.getTime()+7200000).toISOString(),
        timezone: 'America/Denver', neighborhood: fixture.area, visibility: 'listed', capacity: 12,
        tags: ['design-demo', fixture.tag], cover, ...details[i],
      })
      uri = result.event.uri
      await getDb().insert(appMeta).values({ key, value: { uri }, updatedAt: new Date() })
    }
    links.push({name:fixture.name,url:`http://localhost:5173/events/${encodeURIComponent(uri)}`,image:fixture.tiny?'240px compressed':fixture.file??'No image fallback'})
    console.log(`Ready: ${fixture.name}`)
  }
  await writeFile(new URL('events.json', folder), JSON.stringify(links, null, 2)+'\n')
  console.log(`Saved fixture links to ${fileURLToPath(new URL('events.json', folder))}`)
} finally { await closeDb() }
