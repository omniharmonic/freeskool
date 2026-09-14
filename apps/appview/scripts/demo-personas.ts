/**
 * The cast of the local demo school — twelve fictional members, their skills, and the
 * classes, requests, vouches and notes they make between them.
 *
 * DATA ONLY. `scripts/seed-demo.ts` is what writes any of it, and it writes all of it
 * through the same libs the HTTP routes use, so nothing here can drift into a second,
 * quieter way of creating a member.
 *
 * Every person here is invented. The emails are all `@freeskool.test` (a reserved TLD,
 * RFC 6761 — mail can never leave the machine) and the handles are chosen from the same
 * `/welcome` path a real member uses.
 */
import { createHash } from 'node:crypto'

export type PersonaIntent = 'host' | 'learner' | 'facilitator-to-be' | 'steward'

export interface PersonaSkill {
  /** Taxonomy slug from `infra/seed/skills/skills-seed.jsonl`. */
  id: string
  level: 'learning' | 'practicing' | 'proficient' | 'teaching'
  visibility?: 'public' | 'school'
  note?: string
}

export interface Persona {
  slug: string
  displayName: string
  bio: string
  intent: PersonaIntent
  skills: PersonaSkill[]
  /** Wants to learn these — drives the requests they post and the interest they leave. */
  wants?: string[]
}

export const DEMO_EMAIL_DOMAIN = 'freeskool.test'
export const emailFor = (slug: string) => `demo+${slug}@${DEMO_EMAIL_DOMAIN}`

/**
 * Skill slugs, resolved to `at://<AUTHORITY_DID>/freeschool.draft.skill/<id>` at seed
 * time. Every one of these exists in `infra/seed/skills/skills-seed.jsonl`.
 */
export const SKILL = {
  bicycle: 'bicycle-mechanics',
  welding: 'metalwork-welding',
  kimchi: 'make-sauerkraut-and-kimchi',
  sourdough: 'bake-sourdough-bread',
  guitar: 'learn-guitar-chords-and-strumming',
  songCircle: 'lead-a-community-song-circle',
  spanish: 'teach-conversational-spanish',
  facilitation: 'facilitate-a-group-process',
  fermentation: 'ferment-vegetables',
  gardening: 'gardening',
} as const

export const PERSONAS: Persona[] = [
  {
    slug: 'amir',
    displayName: 'Amir',
    bio: 'Keeps a stand and a tub of cone wrenches in the garage. Happiest when somebody else is holding the tools.',
    intent: 'host',
    skills: [
      { id: SKILL.bicycle, level: 'teaching', note: 'Twelve years of Saturday repair tables.' },
      { id: SKILL.welding, level: 'practicing', note: 'Enough to teach a first safe bead, not enough to certify anyone.' },
    ],
  },
  {
    slug: 'maya',
    displayName: 'Maya',
    bio: 'Two crocks on the counter and a starter older than my lease. Fermentation is mostly patience and labels.',
    intent: 'host',
    skills: [
      { id: SKILL.kimchi, level: 'teaching', note: 'Cabbage, salt, time — the rest is preference.' },
      { id: SKILL.sourdough, level: 'proficient' },
    ],
  },
  {
    slug: 'jonah',
    displayName: 'Jonah',
    bio: 'Three chords and a cheap capo will get you through most of a singalong. Bring anything with strings.',
    intent: 'host',
    skills: [
      { id: SKILL.guitar, level: 'teaching' },
      { id: SKILL.songCircle, level: 'practicing' },
    ],
  },
  {
    slug: 'priya',
    displayName: 'Priya',
    bio: 'Conversation practice over agendas. I run the kind of meeting people leave less tired than they arrived.',
    intent: 'host',
    skills: [
      { id: SKILL.spanish, level: 'teaching' },
      { id: SKILL.facilitation, level: 'proficient' },
    ],
  },
  {
    slug: 'rosa',
    displayName: 'Rosa',
    bio: 'New to the neighbourhood and to most of this. Would like a jar of something bubbling by spring.',
    intent: 'learner',
    skills: [{ id: SKILL.fermentation, level: 'learning', visibility: 'school' }],
    wants: [SKILL.fermentation, SKILL.gardening],
  },
  {
    slug: 'theo',
    displayName: 'Theo',
    bio: 'Bought a bike off a porch and have been guessing ever since.',
    intent: 'learner',
    skills: [{ id: SKILL.bicycle, level: 'learning', visibility: 'school' }],
    wants: [SKILL.bicycle],
  },
  {
    slug: 'lina',
    displayName: 'Lina',
    bio: 'Learning Spanish for my neighbours, not for a certificate.',
    intent: 'learner',
    skills: [{ id: SKILL.spanish, level: 'learning', visibility: 'school' }],
    wants: [SKILL.spanish],
  },
  {
    slug: 'sam',
    displayName: 'Sam',
    bio: 'Here for the bread. Staying for the people who bring the bread.',
    intent: 'learner',
    skills: [{ id: SKILL.sourdough, level: 'learning', visibility: 'school' }],
    wants: [SKILL.sourdough],
  },
  {
    slug: 'noor',
    displayName: 'Noor',
    bio: 'Wants a plot, a plan and somebody to tell me when to plant the garlic.',
    intent: 'learner',
    skills: [{ id: SKILL.gardening, level: 'learning', visibility: 'school' }],
    wants: [SKILL.gardening],
  },
  {
    slug: 'eli',
    displayName: 'Eli',
    bio: 'Ran two mending evenings last winter. Slowly working out that this counts as teaching.',
    intent: 'facilitator-to-be',
    skills: [
      { id: SKILL.facilitation, level: 'practicing' },
      { id: SKILL.gardening, level: 'practicing' },
    ],
  },
  {
    slug: 'ines',
    displayName: 'Inés',
    bio: 'Good at getting a room to agree what it is actually deciding.',
    intent: 'facilitator-to-be',
    skills: [
      { id: SKILL.facilitation, level: 'practicing' },
      { id: SKILL.spanish, level: 'proficient' },
    ],
  },
  {
    slug: 'steward',
    displayName: 'Ada',
    bio: 'Holds the keys to the room and the minutes of why. Ask me about the policy, not the rules.',
    intent: 'steward',
    skills: [{ id: SKILL.facilitation, level: 'teaching' }],
  },
]

/** Everyone who teaches, in listing order. */
export const HOSTS = PERSONAS.filter((p) => p.intent === 'host').map((p) => p.slug)
export const LEARNERS = PERSONAS.filter((p) => p.intent === 'learner').map((p) => p.slug)

/* ------------------------------------------------------------------------- *
 * Identicons
 * ------------------------------------------------------------------------- */

/**
 * A deterministic 5x5 mirrored identicon for a slug, as an SVG string.
 *
 * Deterministic on purpose: re-running the seed must not churn every avatar (and so every
 * `revision`, and so every cached avatar URL). The hash is the only input, so the same
 * slug always draws the same badge.
 *
 * SVG rather than a pixel buffer because it is trivially readable in a diff and `sharp`
 * rasterizes it for us; `lib/images.ts#normalizeImage` only accepts JPEG/PNG/WebP data
 * URLs, so `seed-demo.ts` converts before it hands one over.
 */
export function identiconSvg(slug: string, size = 240): string {
  const hash = createHash('sha256').update(slug).digest()
  // A calm, mid-saturation hue per slug — never near-white, never neon.
  const hue = (hash[0]! * 360) / 256
  const fg = `hsl(${hue.toFixed(0)} 46% 42%)`
  const bg = `hsl(${hue.toFixed(0)} 24% 94%)`
  const cell = size / 5

  const rects: string[] = []
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 5; row++) {
      // One bit per (col,row) out of the digest, mirrored onto columns 3 and 4.
      if ((hash[col * 5 + row + 1]! & 1) === 0) continue
      for (const x of col === 2 ? [2] : [col, 4 - col]) {
        rects.push(`<rect x="${(x * cell).toFixed(2)}" y="${(row * cell).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}"/>`)
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="${bg}"/>`,
    `<g fill="${fg}">${rects.join('')}</g>`,
    `</svg>`,
  ].join('')
}
