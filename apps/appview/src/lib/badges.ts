/**
 * Plain-language badge sentences, derived ONLY from counts and role — never an average,
 * never a percentage. A derived role/reputation that cannot be explained to the person it
 * applies to is indistinguishable from an arbitrary one (see lib/roles.ts's own doc
 * comment), and the same goes for anything shown back to them as a "badge".
 */
export interface BadgeCounts {
  hosted: number
  attended: number
}

export interface VouchCount {
  label: string
  count: number
}

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`
  // Only ever called with 'class' today; -es is the correct plural, not a generic rule.
  const suffix = word.endsWith('s') || word.endsWith('ss') ? 'es' : 's'
  return `${n} ${word}${suffix}`
}

export function badgeSentences(counts: BadgeCounts, vouches: VouchCount[]): string[] {
  const out: string[] = []
  if (counts.hosted > 0) out.push(`Hosted ${plural(counts.hosted, 'class')}`)
  if (counts.attended > 0) out.push(`Came to ${plural(counts.attended, 'class')}`)
  for (const v of vouches) {
    if (v.count <= 0) continue
    out.push(`Vouched for ${v.label} by ${v.count} ${v.count === 1 ? 'person' : 'people'}`)
  }
  return out
}
