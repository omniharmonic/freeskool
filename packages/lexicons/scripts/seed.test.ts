import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const seedPath = fileURLToPath(new URL('../../../infra/seed/skills/skills-seed.jsonl', import.meta.url))
const statsPath = fileURLToPath(new URL('../../../infra/seed/skills/stats.json', import.meta.url))

type SeedRow = {
  $type: string
  id: string
  label: string
  description?: string
  broader?: string[]
  externalIds?: Record<string, string>
  status: string
  createdAt: string
  _provenance?: { level?: string; domain?: string; descriptionSource?: string }
}

const lines = readFileSync(seedPath, 'utf8').trim().split('\n')
const rows: SeedRow[] = lines.map((line, i) => {
  try {
    return JSON.parse(line)
  } catch (e) {
    throw new Error(`line ${i + 1} is not valid JSON: ${(e as Error).message}`)
  }
})
const byId = new Map(rows.map((r) => [r.id, r]))
const levelOf = (r: SeedRow) => r._provenance?.level ?? (r.broader?.length ? 'skill' : 'domain')

describe('skills-seed.jsonl', () => {
  it('is one freeschool.draft.skill record per line', () => {
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.$type).toBe('freeschool.draft.skill')
  })

  it('has unique ids', () => {
    const seen = new Set<string>()
    const dupes: string[] = []
    for (const r of rows) {
      if (seen.has(r.id)) dupes.push(r.id)
      seen.add(r.id)
    }
    expect(dupes).toEqual([])
  })

  it('uses kebab-case slugs as ids, within the lexicon maxLength', () => {
    for (const r of rows) {
      expect(r.id, `${r.id} is not kebab-case`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(r.id.length, `${r.id} exceeds 64 chars`).toBeLessThanOrEqual(64)
    }
  })

  it('has no duplicate labels', () => {
    const seen = new Map<string, string>()
    const dupes: string[] = []
    for (const r of rows) {
      const key = r.label.trim().toLowerCase()
      if (seen.has(key)) dupes.push(`${r.id} duplicates ${seen.get(key)} ("${r.label}")`)
      seen.set(key, r.id)
    }
    expect(dupes).toEqual([])
  })

  it('has a label, status and createdAt on every record', () => {
    for (const r of rows) {
      expect(r.label, `${r.id} has no label`).toBeTruthy()
      expect(r.label.length, `${r.id} label too long`).toBeLessThanOrEqual(80)
      expect(['canonical', 'proposed', 'deprecated'], `${r.id} status`).toContain(r.status)
      expect(r.createdAt, `${r.id} createdAt`).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
      expect(Number.isNaN(Date.parse(r.createdAt)), `${r.id} createdAt unparseable`).toBe(false)
    }
  })

  it('has a one-sentence description of at most 300 characters on every record', () => {
    for (const r of rows) {
      expect(r.description, `${r.id} has no description`).toBeTruthy()
      expect(r.description!.length, `${r.id} description is ${r.description!.length} chars`).toBeLessThanOrEqual(300)
    }
  })

  it('resolves every broader id to another record in the file', () => {
    const dangling: string[] = []
    for (const r of rows) {
      for (const b of r.broader ?? []) if (!byId.has(b)) dangling.push(`${r.id} -> ${b}`)
    }
    expect(dangling).toEqual([])
  })

  it('is a three-level tree: domains have no parent, areas sit under a domain, skills under an area', () => {
    for (const r of rows) {
      const level = levelOf(r)
      if (level === 'domain') {
        expect(r.broader ?? [], `${r.id} is a domain with a parent`).toEqual([])
        continue
      }
      expect((r.broader ?? []).length, `${r.id} has no parent`).toBeGreaterThan(0)
      for (const b of r.broader ?? []) {
        const parent = byId.get(b)!
        expect(levelOf(parent), `${r.id} (${level}) hangs off ${b} (${levelOf(parent)})`).toBe(
          level === 'area' ? 'domain' : 'area',
        )
      }
    }
  })

  it('has no cycles in broader', () => {
    for (const r of rows) {
      const seen = new Set<string>([r.id])
      let cur: SeedRow | undefined = r
      while (cur?.broader?.length) {
        const next: SeedRow | undefined = byId.get(cur.broader[0])
        if (!next) break
        expect(seen.has(next.id), `cycle through ${next.id}`).toBe(false)
        seen.add(next.id)
        cur = next
      }
    }
  })

  it('keeps records grouped by domain then area, as the seeder and the printed zine expect', () => {
    const domainOrder: string[] = []
    const areaOrder: string[] = []
    let domain: string | null = null
    let area: string | null = null
    for (const r of rows) {
      const level = levelOf(r)
      if (level === 'domain') {
        expect(domainOrder, `domain ${r.id} appears twice`).not.toContain(r.id)
        domainOrder.push(r.id)
        domain = r.id
        area = null
      } else if (level === 'area') {
        expect(r.broader?.[0], `area ${r.id} is not under the preceding domain`).toBe(domain)
        expect(areaOrder, `area ${r.id} appears twice`).not.toContain(r.id)
        areaOrder.push(r.id)
        area = r.id
      } else {
        expect(r.broader?.[0], `skill ${r.id} is not under the preceding area`).toBe(area)
      }
    }
  })

  it('only carries externalIds the lexicon knows about', () => {
    for (const r of rows) {
      for (const k of Object.keys(r.externalIds ?? {})) {
        expect(['esco', 'wikidata', 'onet'], `${r.id} externalIds.${k}`).toContain(k)
      }
      const wd = r.externalIds?.wikidata
      if (wd) expect(wd, `${r.id} wikidata qid`).toMatch(/^Q\d+$/)
      const esco = r.externalIds?.esco
      if (esco) expect(esco, `${r.id} esco uri`).toMatch(/^https?:\/\//)
    }
  })

  it('records provenance for every node', () => {
    for (const r of rows) {
      expect(r._provenance, `${r.id} has no _provenance`).toBeTruthy()
      expect(['domain', 'area', 'skill'], `${r.id} provenance level`).toContain(r._provenance!.level)
      expect(r._provenance!.descriptionSource, `${r.id} descriptionSource`).toBeTruthy()
    }
  })

  it('matches the totals recorded in stats.json', () => {
    const stats = JSON.parse(readFileSync(statsPath, 'utf8'))
    const count = (level: string) => rows.filter((r) => levelOf(r) === level).length
    expect(stats.totals.nodes).toBe(rows.length)
    expect(stats.totals.domains).toBe(count('domain'))
    expect(stats.totals.areas).toBe(count('area'))
    expect(stats.totals.skills).toBe(count('skill'))
    expect(stats.totals.statusCanonical).toBe(rows.filter((r) => r.status === 'canonical').length)
    expect(stats.totals.statusProposed).toBe(rows.filter((r) => r.status === 'proposed').length)
    for (const [domain, d] of Object.entries<any>(stats.byDomain)) {
      const inDomain = rows.filter((r) => r._provenance?.domain === domain)
      expect(d.nodes, `${domain} nodes`).toBe(inDomain.length)
      expect(d.areas, `${domain} areas`).toBe(inDomain.filter((r) => levelOf(r) === 'area').length)
      expect(d.skills, `${domain} skills`).toBe(inDomain.filter((r) => levelOf(r) === 'skill').length)
    }
  })
})
