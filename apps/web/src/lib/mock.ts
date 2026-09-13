/**
 * Mock data for the front-end shell.
 *
 * Types are shaped after `community.lexicon.calendar.event` plus our
 * `freeschool.draft.*` sidecars (skill, skillClaim, skillAttestation, request,
 * resource). Nothing here names a DID that the DID holder did not write: RSVP
 * and attendance are counts, not rosters (R9 privacy default).
 */

export type SkillLevel = 1 | 2 | 3;

export interface SkillRef {
  id: string;
  label: string;
}

export interface EventLocation {
  name: string;
  locality: string;
}

export interface HostRef {
  did: string;
  handle: string;
  displayName: string;
  /** Attestation counts, never a score. Two people vouching is two people. */
  attestations: number;
  hostedCount: number;
}

export interface FreeSchoolEvent {
  uri: string;
  name: string;
  description: string;
  startsAt: string;
  endsAt: string;
  locations: EventLocation[];
  host: HostRef;
  skill: SkillRef;
  level: SkillLevel;
  rsvpCount: number;
  capacity?: number;
  materials: string[];
  /** Hidden by default; stewards opt in per class. */
  suppliesNote?: string;
  ink: 'pink' | 'blue' | 'green' | 'amber';
}

export interface Skill {
  id: string;
  label: string;
  description: string;
  /** `broader` mirrors the SKOS-ish field on freeschool.draft.skill. */
  broader: string[];
  practitionerCount: number;
  upcomingCount: number;
  tier: 'A' | 'B';
}

export interface SkillResource {
  uri: string;
  title: string;
  kind: 'zine' | 'link' | 'tool-library' | 'book';
  note: string;
}

export interface LearningRequest {
  uri: string;
  title: string;
  description: string;
  skill: SkillRef;
  threshold: number;
  rsvpCount: number;
  status: 'open' | 'claimed' | 'scheduled';
  claimedBy?: string;
}

export interface SkillClaim {
  skill: SkillRef;
  level: SkillLevel;
  attestations: number;
}

export interface Profile {
  did: string;
  handle: string;
  displayName: string;
  bio: string;
  skillClaims: SkillClaim[];
  attendedCount: number;
  hostedCount: number;
  /** Derived labels, not points. Plain language, earned by doing the thing. */
  badges: string[];
}

export const LEVEL_LABEL: Record<SkillLevel, string> = {
  1: 'First time welcome',
  2: 'Some practice helps',
  3: 'Bring your own project',
};

// ── taxonomy ──────────────────────────────────────────────────────────────

export const domains = [
  {
    id: 'hands',
    label: 'Hands & making',
    blurb: 'Things that end with something in your hands.',
    areas: ['food-fermentation', 'repair', 'textiles'],
  },
  {
    id: 'land',
    label: 'Land & weather',
    blurb: 'The Front Range, up close.',
    areas: ['growing', 'water'],
  },
  {
    id: 'together',
    label: 'Getting along',
    blurb: 'Skills for rooms with other people in them.',
    areas: ['language', 'care'],
  },
] as const;

export const areas: Record<string, { label: string; skills: string[] }> = {
  'food-fermentation': { label: 'Food & fermentation', skills: ['sourdough', 'kraut', 'pressure-canning'] },
  repair: { label: 'Repair', skills: ['bike-drivetrain', 'small-engine', 'darning'] },
  textiles: { label: 'Textiles', skills: ['darning', 'patternmaking'] },
  growing: { label: 'Growing', skills: ['seed-saving', 'dry-garden'] },
  water: { label: 'Water', skills: ['greywater', 'creek-reading'] },
  language: { label: 'Language', skills: ['spanish-table'] },
  care: { label: 'Care & conflict', skills: ['de-escalation', 'death-doula'] },
};

export const skills: Skill[] = [
  { id: 'sourdough', label: 'Sourdough', description: 'Keeping a starter alive and turning it into bread you would choose over store bread. Flour, water, salt, time, and a little nerve.', broader: ['food-fermentation'], practitionerCount: 34, upcomingCount: 3, tier: 'A' },
  { id: 'kraut', label: 'Kraut & pickles', description: 'Lacto-fermentation without a recipe: salt percentages, what a healthy crock smells like, and when to stop worrying.', broader: ['food-fermentation'], practitionerCount: 19, upcomingCount: 1, tier: 'A' },
  { id: 'pressure-canning', label: 'Pressure canning', description: 'The one kind of preserving where the details are not optional. Low-acid foods, tested recipes, reading a dial gauge.', broader: ['food-fermentation'], practitionerCount: 7, upcomingCount: 1, tier: 'A' },
  { id: 'bike-drivetrain', label: 'Bike drivetrains', description: 'Chains, cassettes, derailleurs. Diagnose a skip by ear, index a rear mech, and know when a chain has eaten your cogs.', broader: ['repair'], practitionerCount: 28, upcomingCount: 2, tier: 'A' },
  { id: 'small-engine', label: 'Small engines', description: 'Two-stroke and four-stroke: carburettor cleaning, spark, compression, and the order to check them in.', broader: ['repair'], practitionerCount: 11, upcomingCount: 0, tier: 'A' },
  { id: 'darning', label: 'Visible mending', description: 'Darning, sashiko, patching. Repairs you are glad people can see.', broader: ['repair', 'textiles'], practitionerCount: 41, upcomingCount: 2, tier: 'A' },
  { id: 'patternmaking', label: 'Patternmaking', description: 'Drafting a block to your own measurements, then cutting cloth with confidence.', broader: ['textiles'], practitionerCount: 9, upcomingCount: 0, tier: 'A' },
  { id: 'seed-saving', label: 'Seed saving', description: 'Which plants come true, how to isolate the ones that do not, drying and storing for the next season.', broader: ['growing'], practitionerCount: 23, upcomingCount: 1, tier: 'A' },
  { id: 'dry-garden', label: 'Dryland gardening', description: 'Growing food in 15 inches of annual rain without irrigating a lawn-shaped hole in your budget.', broader: ['growing'], practitionerCount: 31, upcomingCount: 1, tier: 'A' },
  { id: 'greywater', label: 'Greywater', description: 'Laundry-to-landscape and what Colorado law actually allows. Plumbing that is legal and keeps a tree alive.', broader: ['water'], practitionerCount: 6, upcomingCount: 0, tier: 'A' },
  { id: 'creek-reading', label: 'Reading a creek', description: 'Boulder Creek through a year: flow, sediment, macroinvertebrates, and what a healthy riffle looks like.', broader: ['water'], practitionerCount: 14, upcomingCount: 1, tier: 'A' },
  { id: 'spanish-table', label: 'Spanish conversation', description: 'A table where the only rule is you keep going. Beginners and fluent speakers in the same room on purpose.', broader: ['language'], practitionerCount: 48, upcomingCount: 4, tier: 'A' },
  { id: 'de-escalation', label: 'De-escalation', description: 'Staying useful when a situation gets loud. Practised in pairs, out loud, which is the only way it sticks.', broader: ['care'], practitionerCount: 22, upcomingCount: 1, tier: 'B' },
  { id: 'death-doula', label: 'Sitting with dying', description: 'Practical and emotional companionship at the end of a life. Held gently, with a facilitator present.', broader: ['care'], practitionerCount: 5, upcomingCount: 1, tier: 'B' },
];

export const resources: Record<string, SkillResource[]> = {
  sourdough: [
    { uri: 'at://did:plc:fsboulder/freeschool.draft.resource/3kz1', title: 'Starter troubleshooting, one page', kind: 'zine', note: 'Photocopy it and tape it inside a cupboard door.' },
    { uri: 'at://did:plc:fsboulder/freeschool.draft.resource/3kz2', title: 'Scales at the Tool Library', kind: 'tool-library', note: 'Two gram scales and a banneton, free for a week.' },
  ],
  'bike-drivetrain': [
    { uri: 'at://did:plc:fsboulder/freeschool.draft.resource/3kz3', title: 'Community Cycles open shop hours', kind: 'link', note: 'Stands and tools, Wednesday evenings.' },
  ],
};

// ── events ────────────────────────────────────────────────────────────────

/** Anchored to a fixed month so the shell looks the same every run. */
const MONTH = '2026-09';
const at = (day: number, time: string) => `${MONTH}-${String(day).padStart(2, '0')}T${time}:00-06:00`;

const hosts: Record<string, HostRef> = {
  ana: { did: 'did:plc:ana7x2qkd', handle: 'ana.fs.boulder', displayName: 'Ana Delgado', attestations: 12, hostedCount: 9 },
  theo: { did: 'did:plc:theo4m9r', handle: 'theo.fs.boulder', displayName: 'Theo Ruiz', attestations: 7, hostedCount: 4 },
  may: { did: 'did:plc:may2b8vz', handle: 'maylin.fs.boulder', displayName: 'May-Lin Ortega', attestations: 21, hostedCount: 17 },
  ruth: { did: 'did:plc:ruth6kq', handle: 'ruth.fs.boulder', displayName: 'Ruth Abernathy', attestations: 4, hostedCount: 2 },
  sam: { did: 'did:plc:sam9wwp', handle: 'sam.fs.boulder', displayName: 'Sam Pike', attestations: 15, hostedCount: 11 },
};

export const events: FreeSchoolEvent[] = [
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1a',
    name: 'Sourdough from a jar of flour',
    description:
      'Start a culture from nothing but flour and tap water, then take a piece of a living one home. We bake two loaves so you see what the dough should feel like at every stage, and you leave with a jar, a schedule, and permission to kill the first one.',
    startsAt: at(17, '18:30'),
    endsAt: at(17, '21:00'),
    locations: [{ name: 'Sanitas Kitchen, side door', locality: 'Boulder' }],
    host: hosts.ana!,
    skill: { id: 'sourdough', label: 'Sourdough' },
    level: 1,
    rsvpCount: 9,
    capacity: 12,
    materials: ['A clean pint jar with a lid', 'Two kitchen towels', 'Five pounds of bread flour if you can spare it'],
    suppliesNote: 'Flour is covered by the supplies fund. If you want to chip in, the jar by the door is how.',
    ink: 'pink',
  },
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1b',
    name: 'Your chain is skipping and here is why',
    description:
      'Bring the bike that annoys you. We work through diagnosis out loud — chain wear, cassette teeth, hanger alignment, cable stretch — and then you fix it yourself with someone standing next to you.',
    startsAt: at(17, '17:00'),
    endsAt: at(17, '19:00'),
    locations: [{ name: 'Community Cycles, back lot', locality: 'Boulder' }],
    host: hosts.theo!,
    skill: { id: 'bike-drivetrain', label: 'Bike drivetrains' },
    level: 2,
    rsvpCount: 6,
    capacity: 8,
    materials: ['Your bike', 'Degreaser if you own some'],
    ink: 'blue',
  },
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1c',
    name: 'Mesa de conversación',
    description:
      'Spanish at every level at one long table. Absolute beginners sit next to fluent speakers on purpose. No textbook, no drills, no correcting people mid-sentence.',
    startsAt: at(18, '19:00'),
    endsAt: at(18, '20:30'),
    locations: [{ name: 'Carnegie Library, front room', locality: 'Boulder' }],
    host: hosts.may!,
    skill: { id: 'spanish-table', label: 'Spanish conversation' },
    level: 1,
    rsvpCount: 17,
    materials: [],
    ink: 'green',
  },
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1d',
    name: 'Darning a heel that keeps going',
    description:
      'One sock, one darning egg, one hour. We cover stocking-web darn and the faster woven patch, and talk about which wools are worth the trouble.',
    startsAt: at(20, '10:30'),
    endsAt: at(20, '12:00'),
    locations: [{ name: 'North Boulder Rec, craft room', locality: 'Boulder' }],
    host: hosts.ruth!,
    skill: { id: 'darning', label: 'Visible mending' },
    level: 1,
    rsvpCount: 11,
    capacity: 14,
    materials: ['A holey sock you actually like', 'Darning needles are provided'],
    ink: 'amber',
  },
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1e',
    name: 'Saving tomato and squash seed',
    description:
      'Which of your plants will come true next year and which will surprise you. Fermenting tomato seed, hand-pollinating squash, and labelling in a way you will still understand in March.',
    startsAt: at(20, '14:00'),
    endsAt: at(20, '16:00'),
    locations: [{ name: 'Growing Gardens, hoop house 2', locality: 'Boulder' }],
    host: hosts.sam!,
    skill: { id: 'seed-saving', label: 'Seed saving' },
    level: 2,
    rsvpCount: 8,
    capacity: 16,
    materials: ['Ripe fruit from a plant you like', 'Paper envelopes'],
    ink: 'green',
  },
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1f',
    name: 'Pressure canning, done by the book',
    description:
      'The one kind of preserving where improvising is genuinely dangerous. Tested recipes, dial-gauge checks, altitude adjustment for 5,430 feet, and why your grandmother got away with it.',
    startsAt: at(24, '18:00'),
    endsAt: at(24, '21:00'),
    locations: [{ name: 'Sanitas Kitchen, side door', locality: 'Boulder' }],
    host: hosts.ana!,
    skill: { id: 'pressure-canning', label: 'Pressure canning' },
    level: 3,
    rsvpCount: 5,
    capacity: 6,
    materials: ['Your canner, if you have one', 'Four clean pint jars with new lids'],
    ink: 'pink',
  },
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1g',
    name: 'Staying useful when it gets loud',
    description:
      'Practised in pairs, out loud, with a facilitator in the room. We run three scenarios from real Boulder situations and debrief each one. You can sit out any round.',
    startsAt: at(27, '13:00'),
    endsAt: at(27, '16:00'),
    locations: [{ name: 'Friends Meeting House', locality: 'Boulder' }],
    host: hosts.may!,
    skill: { id: 'de-escalation', label: 'De-escalation' },
    level: 2,
    rsvpCount: 14,
    capacity: 20,
    materials: [],
    ink: 'blue',
  },
  {
    uri: 'at://did:plc:fsboulder/community.lexicon.calendar.event/3l1h',
    name: 'Reading Boulder Creek in low water',
    description:
      'Late-season flow is when the creek tells you the most. Riffles, sediment, macroinvertebrate sampling, and what the last decade of September has looked like.',
    startsAt: at(28, '09:00'),
    endsAt: at(28, '11:30'),
    locations: [{ name: 'Eben G. Fine Park, east shelter', locality: 'Boulder' }],
    host: hosts.sam!,
    skill: { id: 'creek-reading', label: 'Reading a creek' },
    level: 1,
    rsvpCount: 12,
    materials: ['Shoes you can get wet', 'A hand lens if you have one'],
    ink: 'amber',
  },
];

// ── requests ──────────────────────────────────────────────────────────────

export const requests: LearningRequest[] = [
  {
    uri: 'at://did:plc:fsboulder/freeschool.draft.request/3m1a',
    title: 'Someone teach me to sharpen things properly',
    description:
      'Kitchen knives, chisels, a scythe I inherited. I have watched the videos and I am still making things duller. I would rather stand next to a person.',
    skill: { id: 'repair', label: 'Repair' },
    threshold: 6,
    rsvpCount: 5,
    status: 'open',
  },
  {
    uri: 'at://did:plc:fsboulder/freeschool.draft.request/3m1b',
    title: 'Patching a canvas tent without making it worse',
    description: 'An old wall tent with three tears and some mildew. Wanting to learn the repair rather than pay for it.',
    skill: { id: 'darning', label: 'Visible mending' },
    threshold: 5,
    rsvpCount: 5,
    status: 'claimed',
    claimedBy: 'Ruth Abernathy',
  },
  {
    uri: 'at://did:plc:fsboulder/freeschool.draft.request/3m1c',
    title: 'How does water law actually work here',
    description:
      'Not legal advice — just enough understanding to read a ditch agreement and know what questions to ask before I plant anything.',
    skill: { id: 'greywater', label: 'Greywater' },
    threshold: 8,
    rsvpCount: 3,
    status: 'open',
  },
  {
    uri: 'at://did:plc:fsboulder/freeschool.draft.request/3m1d',
    title: 'Bread but gluten-free and not sad',
    description: 'Coeliac household. Every loaf I bake is a brick. Would love a session from someone who has solved this.',
    skill: { id: 'sourdough', label: 'Sourdough' },
    threshold: 6,
    rsvpCount: 2,
    status: 'open',
  },
  {
    uri: 'at://did:plc:fsboulder/freeschool.draft.request/3m1e',
    title: 'Winter bike commuting that does not hurt',
    description: 'Studded tyres, layers, and route choices for ice. Scheduled for the first week of November.',
    skill: { id: 'bike-drivetrain', label: 'Bike drivetrains' },
    threshold: 4,
    rsvpCount: 9,
    status: 'scheduled',
    claimedBy: 'Theo Ruiz',
  },
];

// ── the signed-in person ──────────────────────────────────────────────────

export const profile: Profile = {
  did: 'did:plc:wren3h7k',
  handle: 'wren.fs.boulder',
  displayName: 'Wren Halloway',
  bio: 'Mending pile, sourdough jar, one bike in pieces. North Boulder.',
  skillClaims: [
    { skill: { id: 'darning', label: 'Visible mending' }, level: 2, attestations: 4 },
    { skill: { id: 'sourdough', label: 'Sourdough' }, level: 1, attestations: 2 },
    { skill: { id: 'spanish-table', label: 'Spanish conversation' }, level: 1, attestations: 0 },
  ],
  attendedCount: 11,
  hostedCount: 2,
  badges: ['Came back after the first time', 'Has hosted', 'Brought a friend'],
};

export const school = {
  name: 'Free School Boulder',
  locality: 'Boulder',
  monthLabel: 'September 2026',
  motto: "everybody's a teacher, everybody's a student",
} as const;
