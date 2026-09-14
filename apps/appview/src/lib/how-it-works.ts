/**
 * `GET /api/school/how-it-works` — a plain-language, printable explanation of the
 * school, rendered from two public sources: the school's own `freeschool.draft.school`
 * record and its CURRENT `freeschool.draft.policy#thresholds`. Nothing here is app-side
 * state; a new reader (or a steward checking what members see) gets the live rules.
 *
 * `renderHowItWorks` is the pure half (no network, no DB) — what `test/how-it-works.test.ts`
 * exercises directly. `buildHowItWorks` is the thin live wiring the route calls.
 */
import type { Thresholds } from '@freeschool/shared'
import { legacySchoolDid } from './schools.js'
import { getRecord } from './pds.js'
import { NSID } from '../lexicons/nsids.js'
import { currentPolicyUri, getThresholds } from './policy.js'

export interface HowItWorksSection {
  heading: string
  body: string
}

export interface HowItWorksPayload {
  title: string
  school: { name: string; region?: string; description?: string }
  sections: HowItWorksSection[]
  lastUpdated: string
  printable: true
}

export interface SchoolFields {
  name?: string
  region?: string
  description?: string
  createdAt?: string
}

/** `pluralForm` defaults to `singular + 's'`; pass it explicitly for irregular nouns
 * ("class" -> "classes", "person" -> "people"). */
function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

export function renderHowItWorks(
  school: SchoolFields | null,
  thresholds: Thresholds,
  policyEffectiveAt?: string | null,
): HowItWorksPayload {
  const name = school?.name?.trim() || 'Free School'
  const hostingOpen = thresholds.hostMinAttended <= 0

  const memberGateText: Record<Thresholds['memberRequires'], string> = {
    none: 'Anyone who signs up is a member from day one.',
    'invite-or-vouch': 'Joining as a member requires an invite, or a vouch from an existing member.',
    'attended-one': 'Joining as a member requires attending at least one class first.',
  }

  return {
    title: `How ${name} works`,
    school: {
      name,
      ...(school?.region ? { region: school.region } : {}),
      ...(school?.description ? { description: school.description } : {}),
    },
    sections: [
      {
        heading: 'What this is',
        body: `${name} is a free, volunteer-run skill-sharing school. Nobody pays and nobody is paid to teach or to learn here; anyone can offer a class, and anyone can come.`,
      },
      {
        heading: 'How to post a class',
        body: hostingOpen
          ? 'Any signed-in member can post a class onto the calendar — hosting is open to everyone from day one.'
          : `You can post a class once you have ${plural(thresholds.hostMinAttended, 'confirmed attendance')} at a class here.`,
      },
      {
        heading: 'How to post a request',
        body: "If you want to learn something nobody has offered yet, post it to the needs board. Once enough people say they're interested, any host can claim it and turn it into a class.",
      },
      {
        heading: 'Who can host',
        body: `${memberGateText[thresholds.memberRequires]} Hosting needs ${plural(thresholds.hostMinAttended, 'confirmed attendance')}; becoming a facilitator (helping curate what is on the calendar) needs ${plural(thresholds.facilitatorMinHosted, 'hosted class', 'hosted classes')} with no upheld complaint against you.`,
      },
      {
        heading: 'How feedback works',
        body: `Feedback on a class is always anonymous — there is no way to trace a comment back to the person who wrote it. A summary is only ever shown once at least ${plural(thresholds.feedbackK, 'person', 'people')} ${thresholds.feedbackK === 1 ? 'has' : 'have'} responded.`,
      },
      {
        heading: 'How moderation works',
        body: `Removing a listing, suspending a role, or voiding an attendance record needs ${plural(thresholds.destructiveActionStewards, 'steward')} to sign off, and every moderation action carries a written reason — there is no silent removal.`,
      },
      {
        heading: 'If this school goes quiet',
        body: 'A steward can hand stewardship to another member at any time through the steward hand-off flow, so the school never depends on one person staying forever. And because this whole project — the app, its record formats, and this page — is free and open source, anyone can also just run their own copy and start a school again from nothing.',
      },
    ],
    lastUpdated: policyEffectiveAt ?? school?.createdAt ?? new Date(0).toISOString(),
    printable: true,
  }
}

export async function buildHowItWorks(schoolDid = legacySchoolDid()): Promise<HowItWorksPayload> {
  if (!schoolDid) return renderHowItWorks(null, (await getThresholds(schoolDid)) as Thresholds)

  const [thresholds, policyUri, school] = await Promise.all([
    getThresholds(schoolDid),
    currentPolicyUri(schoolDid),
    getRecord(schoolDid, NSID.school, 'self'),
  ])

  let policyEffectiveAt: string | null = null
  const rkey = policyUri?.split('/').pop()
  if (rkey) {
    const policy = await getRecord(schoolDid, NSID.policy, rkey)
    const effectiveAt = policy?.value?.effectiveAt
    policyEffectiveAt = typeof effectiveAt === 'string' ? effectiveAt : null
  }

  return renderHowItWorks((school?.value as SchoolFields) ?? null, thresholds, policyEffectiveAt)
}
