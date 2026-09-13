/**
 * Handle generation: `<word><word><3 digits>.<domain>` — e.g. `calmotter417.test`.
 *
 * NEVER derived from the email (R9): the handle is public forever, and an email-derived
 * handle is a permanent, unrevocable disclosure. The word list is deliberately bland and
 * place/nature-flavoured; the PDS also rejects handles containing a slur, and
 * `mintAccount` retries on rejection.
 */
import { randomInt } from 'node:crypto'

const FIRST = [
  'calm', 'quiet', 'bright', 'open', 'warm', 'clear', 'kind', 'plain', 'steady', 'fresh',
  'wide', 'still', 'early', 'easy', 'free', 'glad', 'soft', 'true', 'newly', 'good',
]

const SECOND = [
  'otter', 'maple', 'creek', 'meadow', 'finch', 'cedar', 'willow', 'heron', 'aspen', 'wren',
  'birch', 'sparrow', 'clover', 'juniper', 'alder', 'thrush', 'laurel', 'plover', 'sorrel', 'sedge',
]

export function generateHandle(domain: string): string {
  const a = FIRST[randomInt(FIRST.length)]!
  const b = SECOND[randomInt(SECOND.length)]!
  const n = String(randomInt(100, 1000))
  return `${a}${b}${n}.${domain.replace(/^\./, '')}`
}

/** Total space, for the "is this collision-prone?" question: 20 x 20 x 900 = 360 000. */
export const HANDLE_SPACE = FIRST.length * SECOND.length * 900
