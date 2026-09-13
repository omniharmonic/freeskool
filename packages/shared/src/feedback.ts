/**
 * k-anonymous aggregation of hostFeedback rows. The host only ever sees this output.
 * Rows are never returned; authorship and free text never leave the store.
 */
export type Aspect = 'knowledge' | 'teaching' | 'experience'

export interface FeedbackRow {
  author: string
  direction: 'positive' | 'negative'
  aspects?: Partial<Record<Aspect, number>>
  text?: string
}

export interface FeedbackAggregate {
  released: boolean
  /** total rows (safe to show: "3 people left feedback" reveals nothing about content) */
  count: number
  positive?: number
  negative?: number
  aspects?: Partial<Record<Aspect, { mean: number; n: number }>>
}

export function aggregateFeedback(rows: FeedbackRow[], k: number): FeedbackAggregate {
  const distinctAuthors = new Set(rows.map((r) => r.author)).size
  if (distinctAuthors < k) return { released: false, count: rows.length }
  const out: FeedbackAggregate = { released: true, count: rows.length, positive: 0, negative: 0 }
  const sums: Record<Aspect, { sum: number; n: number }> = {
    knowledge: { sum: 0, n: 0 }, teaching: { sum: 0, n: 0 }, experience: { sum: 0, n: 0 },
  }
  for (const r of rows) {
    if (r.direction === 'positive') out.positive!++
    else out.negative!++
    for (const a of Object.keys(sums) as Aspect[]) {
      const v = r.aspects?.[a]
      if (typeof v === 'number') { sums[a].sum += v; sums[a].n++ }
    }
  }
  const aspects: FeedbackAggregate['aspects'] = {}
  for (const a of Object.keys(sums) as Aspect[]) {
    if (sums[a].n > 0) aspects[a] = { mean: Math.round((sums[a].sum / sums[a].n) * 100) / 100, n: sums[a].n }
  }
  if (Object.keys(aspects).length) out.aspects = aspects
  return out
}
