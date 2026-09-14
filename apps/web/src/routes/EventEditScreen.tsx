import { ImagePicker } from '../components/ImagePicker';
import type { ImageInput } from '../lib/types';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { LoadingState } from '../components/PageState';
import { Screen } from '../components/Screen';
import { Button, SectionHeading } from '../components/bits';
import { SessionGate } from '../components/SessionGate';
import { SkillMultiPicker } from '../components/SkillPicker';
import { flattenSkills } from '../lib/skills';
import { api } from '../lib/api';
import { useEvent, useMe, useSkillTree, useCreateEventMutation, useUpdateEventMutation } from '../lib/queries';
import {
  NO_RECURRENCE,
  WEEKDAY_CODES,
  WEEKDAY_LABEL,
  buildRecurrence,
  previewOccurrences,
  type RecurrenceFreq,
  type RecurrenceState,
  type WeekdayCode,
} from '../lib/recurrence';
import type { CreateEventInput, SkillLevelRef } from '../lib/types';

/**
 * `/events/new` (create) and `/events/$id/edit` (edit an existing class) — one
 * screen, one component; which mode it is in comes from whether the route
 * matched `$id` (`useParams({ strict: false })`, since the same component is
 * registered on both routes in `router.tsx`).
 *
 * RECURRENCE ON EDIT: the AppView rejects any `PUT /api/events/:id` body that
 * carries `series` outright (400 `SeriesEditNotSupported` —
 * `apps/appview/src/lib/events.ts`'s `updateEventAsHost`). There is no
 * "this and following" edit path on the backend, so this screen never offers
 * one: on create the recurrence editor is live; on edit it is a read-only
 * notice, and `onSubmit` never sends `series` at all. Every edit is
 * necessarily "this one only" — it is a plain PUT on the one event the URI
 * names.
 */

const field =
  'mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2';
const labelText = 'block text-caption text-ink-soft';
const chipButton = 'border-[1.5px] border-ink px-3 py-1.5 text-caption font-medium';

const SUGGESTED_TAGS = ['skillshare', 'free-school'];
/**
 * A sourdough class is also a fermentation class; a bike clinic is also "run a
 * community workshop". The API has always taken an array of
 * `freeschool.draft.skillLevel` sidecars (`CreateEventInput.skills`) — this is
 * the ceiling the EDITOR puts on it, so the "What you'll learn" shelf on a
 * class stays a handful of real answers rather than a tag cloud.
 */
const MAX_SKILLS = 3;
const DEPTH_LABEL = ['New to it', 'Some practice', 'Go deeper'] as const;
const TAG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const RECURRENCE_LOCKED_COPY =
  "Recurrence can't be changed after a class is published yet. To reshape a series, cancel it and post a new one.";

const previewFormat = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/** `datetime-local`'s value has no offset — `new Date()` parses it as wall
 * time in the browser's own zone, which is exactly what we want to send. */
function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const parsed = new Date(local);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** The inverse, for prefilling the edit form from an ISO timestamp. */
function isoToLocal(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function EventEditScreen() {
  return (
    <SessionGate screen prompt="Sign in to post or edit a class.">
      <EventEditForm />
    </SessionGate>
  );
}

function EventEditForm() {
  const params = useParams({ strict: false }) as { id?: string };
  const eventUri = params.id;
  const isEdit = Boolean(eventUri);
  const navigate = useNavigate();

  const { data: me } = useMe();
  const { data: existing, isPending: loadingExisting } = useEvent(eventUri);
  const { data: skillTree } = useSkillTree();
  const createMutation = useCreateEventMutation();
  const updateMutation = useUpdateEventMutation();

  const timezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  const [name, setName] = useState('');
  const [attendeeNotes, setAttendeeNotes] = useState('');
  const [overview, setOverview] = useState('');
  const [audience, setAudience] = useState('');
  const [accessibility, setAccessibility] = useState('');
  const [materials, setMaterials] = useState<string[]>([]);
  const [materialDraft, setMaterialDraft] = useState('');
  const [suppliesNote, setSuppliesNote] = useState('');
  /** Up to `MAX_SKILLS`, each with its own depth. Order is the order chosen. */
  const [skills, setSkills] = useState<Array<{ skill: string; level: 1 | 2 | 3 }>>([]);
  const [startLocal, setStartLocal] = useState('');
  const [endLocal, setEndLocal] = useState('');
  const [visibility, setVisibility] = useState<'listed' | 'unlisted' | 'private'>('listed');
  // On edit, `GET /api/events/:id` never returns the raw `visibility` enum
  // (see `projectEvent` in `apps/appview/src/http/visibility.ts` — it only
  // ever derives `locationRedacted`), so there is nothing to prefill and no
  // way to know what the host's current setting even is. `visibility`'s
  // default above is therefore meaningless until the host actually picks a
  // radio; `onSubmit` must not send it otherwise, or editing any OTHER field
  // would silently re-publish a private/unlisted class as listed.
  const [visibilityTouched, setVisibilityTouched] = useState(false);
  const [mode, setMode] = useState('community.lexicon.calendar.event#inperson');
  const [meetingLink, setMeetingLink] = useState('');
  const [prerequisites, setPrerequisites] = useState('');
  const [venueNeeded, setVenueNeeded] = useState(false);
  const [locationName, setLocationName] = useState('');
  const [street, setStreet] = useState('');
  const [locality, setLocality] = useState('');
  const [region, setRegion] = useState('');
  const [postalCode, setPostalCode] = useState('');
  const [neighborhood, setNeighborhood] = useState('');
  const [capacity, setCapacity] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);
  const [recurrence, setRecurrence] = useState<RecurrenceState>(NO_RECURRENCE);
  const [publishedEvent, setPublishedEvent] = useState<string>();
  const [cover, setCover] = useState<ImageInput | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // `/events/new?request=<id>` — claiming a needs-board request
  // (`RequestsScreen.tsx`) lands here to post the class that satisfies it.
  // There is no `GET /api/requests/:id`, only the list, so this re-fetches it
  // and finds the one request by URI; `enabled` keeps that fetch from firing
  // at all on a plain `/events/new` visit or on the edit route.
  const requestId = !isEdit ? (new URLSearchParams(window.location.search).get('request') ?? undefined) : undefined;
  const { data: prefillRequests } = useQuery({
    queryKey: ['request-prefill', requestId],
    queryFn: () => api.requests.list(),
    enabled: Boolean(requestId),
  });
  const prefillRequest = prefillRequests?.requests.find((r) => r.uri === requestId);

  useEffect(() => {
    if (!prefillRequest) return;
    setName((prev) => prev || prefillRequest.title);
    if (prefillRequest.skill) {
      setSkills((prev) => (prev.length > 0 ? prev : [{ skill: prefillRequest.skill!, level: 2 }]));
    }
  }, [prefillRequest]);

  // Prefill once the existing class loads. Only ever runs for the edit route
  // (`existing` stays undefined on `/events/new`, where `useEvent` is disabled).
  useEffect(() => {
    if (!existing) return;
    setName(existing.name ?? '');
    setAttendeeNotes(existing.attendeeNotes ?? '');
    setOverview(existing.publicOverview?.description ?? '');
    setAudience(existing.publicOverview?.audience ?? '');
    setAccessibility(existing.publicOverview?.accessibility ?? '');
    setMaterials(existing.materials ?? []);
    setSuppliesNote(existing.suppliesNote ?? '');
    setStartLocal(isoToLocal(existing.startsAt));
    setEndLocal(isoToLocal(existing.endsAt));
    setVenueNeeded(Boolean(existing.venueNeeded));
    setMode(existing.mode ?? 'community.lexicon.calendar.event#inperson');
    setMeetingLink(existing.meetingLink ?? '');
    setNeighborhood(existing.neighborhood ?? '');
    setTags(existing.tags ?? []);
    // The raw enum (Task 12) — present only for the host/a steward, which an
    // edit-screen viewer always is. Sets the STATE so a later touch starts
    // from the real current value; `visibilityTouched` stays false, so the
    // touched-only submit rule (below) is unaffected.
    if (existing.visibility) setVisibility(existing.visibility);
    const loc = existing.locations?.[0];
    if (loc) {
      setLocationName(typeof loc.name === 'string' ? loc.name : '');
      setStreet(typeof loc.street === 'string' ? loc.street : '');
      setLocality(typeof loc.locality === 'string' ? loc.locality : '');
      setRegion(typeof loc.region === 'string' ? loc.region : '');
      setPostalCode(typeof loc.postalCode === 'string' ? loc.postalCode : '');
    }
    // `GET /api/events/:id` returns `skills` as the raw `freeschool.draft.skillLevel`
    // sidecar values — `{ skill, level, prerequisites? }` each (`loadEvent` in
    // `apps/appview/src/lib/events.ts`). A class written before this editor could
    // attach more than one may already carry several; take them all, up to the
    // editor's own ceiling.
    setSkills((existing.skills ?? []).slice(0, MAX_SKILLS).map((s) => ({ skill: s.skill, level: s.level })));
    // One shared "before learners come" note, kept on the FIRST skill — see
    // `onSubmit`.
    setPrerequisites(existing.skills?.find((s) => s.prerequisites)?.prerequisites ?? '');
  }, [existing]);

  const startsAtIso = localToIso(startLocal);
  const previewDates = useMemo(() => {
    if (!startsAtIso || recurrence.freq === 'none') return [];
    try {
      return previewOccurrences(recurrence, startsAtIso, timezone, 4);
    } catch {
      return [];
    }
  }, [recurrence, startsAtIso, timezone]);

  const flatSkills = useMemo(() => flattenSkills(skillTree?.skills ?? []), [skillTree]);
  const skillUris = useMemo(() => skills.map((s) => s.skill), [skills]);
  const atSkillCeiling = skills.length >= MAX_SKILLS;

  /** The multi-picker hands back the whole list; keep each row's own depth. */
  const onSkillsChange = (uris: string[]) => {
    setSkills((prev) =>
      uris
        .slice(0, MAX_SKILLS)
        .map((uri) => prev.find((row) => row.skill === uri) ?? { skill: uri, level: 2 as const }),
    );
  };

  const setSkillLevel = (uri: string, level: 1 | 2 | 3) => {
    setSkills((prev) => prev.map((row) => (row.skill === uri ? { ...row, level } : row)));
  };

  /** The chip and the depth row name the same skill; the taxonomy label when
   * we have it, the raw uri for a skill proposed this session. */
  const labelFor = (uri: string) => flatSkills.find((s) => s.uri === uri)?.label ?? uri;

  // A host can be looking for a room in a known neighborhood. Clear the exact
  // address while preserving the public area; venueNeeded is stored explicitly.
  const onVenueNeededChange = (checked: boolean) => {
    setVenueNeeded(checked);
    if (checked) {
      setLocationName('');
      setStreet('');
      setLocality('');
      setRegion('');
      setPostalCode('');
    }
  };

  // ≤20 items, ≤120 chars each — `createBody.materials` on the server
  // (`apps/appview/src/http/routes/events.ts`); the input's own `maxLength`
  // enforces the per-item limit, this enforces the list-length one.
  const addMaterial = () => {
    const item = materialDraft.trim();
    if (!item || materials.length >= 20) return;
    setMaterials((prev) => [...prev, item]);
    setMaterialDraft('');
  };

  const addTag = (raw: string) => {
    const tag = raw.trim().toLowerCase();
    if (!tag) return;
    if (!TAG_PATTERN.test(tag)) {
      setTagError('Tags are lowercase words separated by dashes, like "skillshare".');
      return;
    }
    setTagError(null);
    setTags((prev) => (prev.includes(tag) ? prev : [...prev, tag]));
    setTagDraft('');
  };

  const selectFreq = (freq: RecurrenceFreq) => {
    setRecurrence((prev) => {
      if (freq === 'none') return NO_RECURRENCE;
      const hasEnd = prev.count !== undefined || prev.until !== undefined;
      return { ...prev, freq, count: hasEnd ? prev.count : 8 };
    });
  };

  const toggleWeekday = (code: WeekdayCode) => {
    setRecurrence((prev) => ({
      ...prev,
      byDay: prev.byDay.includes(code) ? prev.byDay.filter((c) => c !== code) : [...prev.byDay, code],
    }));
  };

  const onSubmit = async (submitEvent: React.FormEvent) => {
    submitEvent.preventDefault();
    setError(null);

    const startsAt = localToIso(startLocal);
    if (!name.trim() || !startsAt) return;
    const endsAt = localToIso(endLocal);
    if (endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      setError('The end time must be after the start time.'); return;
    }

    const locations = venueNeeded
      ? undefined
      : (() => {
          const loc: Record<string, string> = {};
          if (locationName.trim()) loc.name = locationName.trim();
          if (street.trim()) loc.street = street.trim();
          if (locality.trim()) loc.locality = locality.trim();
          if (region.trim()) loc.region = region.trim();
          if (postalCode.trim()) loc.postalCode = postalCode.trim();
          return Object.keys(loc).length > 0 ? [loc] : undefined;
        })();

    const capacityNum = capacity.trim() ? Number(capacity) : undefined;

    // `updateEventAsHost` (`apps/appview/src/lib/events.ts`) treats an ABSENT
    // key as "leave unchanged" but an EXPLICIT empty value as "clear it" —
    // so on edit, `attendeeNotes`/`meetingLink`/`neighborhood`/`tags`/`skills`/
    // `locations`/`materials`/`suppliesNote` must always be sent (even empty),
    // or a host can never remove a note, neighbourhood, tag, skill, material, or
    // flip a class to venue-needed. On create there is nothing to clear, so
    // the condition below reduces to exactly the old "only send it if it has
    // content" behaviour. `visibility` is the one exception — see
    // `visibilityTouched` above.
    const body: CreateEventInput = {
      name: name.trim(),
      venueNeeded: mode.endsWith('#virtual') ? false : venueNeeded,
      mode,
      ...(isEdit || meetingLink.trim() ? { meetingLink: meetingLink.trim() } : {}),
      ...(cover !== undefined ? { cover } : {}),
      publicOverview: { description: overview.trim(), audience: audience.trim(), accessibility: accessibility.trim() },
      ...(isEdit || attendeeNotes.trim() ? { attendeeNotes: attendeeNotes.trim() } : {}),
      startsAt,
      ...(endsAt ? { endsAt } : {}),
      timezone,
      ...(typeof capacityNum === 'number' && !Number.isNaN(capacityNum) ? { capacity: capacityNum } : {}),
      ...(!isEdit || visibilityTouched ? { visibility } : {}),
      ...(isEdit || neighborhood.trim() ? { neighborhood: neighborhood.trim() } : {}),
      ...(isEdit || tags.length > 0 ? { tags } : {}),
      // One sidecar per chosen skill, in the order the host chose them. The
      // shared "before learners come" note rides the FIRST one — the lexicon
      // puts `prerequisites` on the skill level, but asking a host to write one
      // per skill is more form than the note is worth.
      ...(isEdit || skills.length > 0
        ? {
            skills: skills.map((row, i): SkillLevelRef => ({
              ...row,
              ...(i === 0 && prerequisites.trim() ? { prerequisites: prerequisites.trim() } : {}),
            })),
          }
        : {}),
      ...(isEdit || locations ? { locations: locations ?? [] } : {}),
      ...(isEdit || materials.length > 0 ? { materials } : {}),
      ...(isEdit || suppliesNote.trim() ? { suppliesNote: suppliesNote.trim() } : {}),
    };

    setSubmitting(true);
    try {
      if (isEdit && eventUri) {
        // `series` is never part of `body` — see this file's doc comment.
        const updated = await updateMutation.mutateAsync({ id: eventUri, body });
        void navigate({ to: '/events/$id', params: { id: updated.event.uri } });
      } else {
        let series;
        try {
          series = buildRecurrence(recurrence, startsAt, timezone);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not build the recurrence rule.');
          setSubmitting(false);
          return;
        }
        const uri = publishedEvent ?? (await createMutation.mutateAsync(series ? { ...body, series } : body)).event.uri;
        setPublishedEvent(uri);
        if (requestId) {
          try { await api.requests.claim(requestId, { eventUri: uri }); }
          catch { setError('Your class is published. We couldn’t connect it to the request. Submit again to retry the connection without posting another class.'); return; }
        }
        void navigate({ to: '/events/$id', params: { id: uri } });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong posting this class.');
    } finally {
      setSubmitting(false);
    }
  };

  if (isEdit && loadingExisting) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x"><LoadingState label="Opening your class…" /></div>
      </Screen>
    );
  }

  if (isEdit && existing && existing.viewerRelation !== 'host') {
    return (
      <Screen title="Can't edit this class" back>
        <div className="safe-x">
          <p className="text-body text-ink-soft">Only the host of a class may edit it.</p>
          <div className="mt-4">
            <Link to="/events/$id" params={{ id: eventUri! }} className="text-body text-blue underline">
              Back to the class
            </Link>
          </div>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={isEdit ? 'Edit class' : 'Post a class'} layout="form" standfirst="A clear invitation is a good beginning. Say what you’ll share, who it’s for, and what people should bring." back>
      <nav className="safe-x editor-nav" aria-label="Class form sections"><a href="#class-about">The invitation</a><a href="#class-when">When</a><a href="#class-where">Where</a><a href="#class-materials">What to bring</a><a href="#class-recurrence">Repeat</a></nav>
      <form className="safe-x class-editor pb-4" onSubmit={(e) => void onSubmit(e)}>
        <div className="editor-opening" id="class-about">
          <label className="block">
            <span className={labelText}>Class title</span>
            <input
              className={field}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Sourdough basics"
              required
              maxLength={300}
            />
          </label>
          <p className="mt-5 text-caption text-ink-soft">The following overview is the class as the world sees it — it is published with the class and travels to other calendars. Keep addresses, door codes and meeting links out of it; there are attendee-only fields below for those.</p>
          <label className="mt-4 block"><span className={labelText}>About this class</span>
            <textarea className={`${field} min-h-[150px]`} value={overview} onChange={e => setOverview(e.target.value)} maxLength={6000} placeholder="What will you explore together? What will people learn, make, or take home?" />
          </label>
          <label className="mt-4 block"><span className={labelText}>Who it’s for</span>
            <textarea className={field} value={audience} onChange={e => setAudience(e.target.value)} maxLength={1000} placeholder="Experience level, prerequisites, and anything newcomers should know." />
          </label>
          <label className="mt-4 block"><span className={labelText}>Access &amp; comfort</span>
            <textarea className={field} value={accessibility} onChange={e => setAccessibility(e.target.value)} maxLength={1000} placeholder="Step-free access, seating, languages, noise, or sensory considerations. Share what you know." />
          </label>
          <label className="mt-4 block">
            <span className={labelText}>Notes for attendees (optional)</span>
            <textarea
              className={`${field} min-h-[88px] resize-none`}
              value={attendeeNotes}
              onChange={(e) => setAttendeeNotes(e.target.value)}
              placeholder="Come to the side door; the gate code is on the fence."
              maxLength={20000}
            />
            <span className="text-caption text-ink-soft">Only people who RSVP see this.</span>
          </label>
        </div>

        <ImagePicker value={cover} existingUrl={existing?.cover?.url} onChange={setCover} />

        <div id="class-skill">
          <SectionHeading>Skills</SectionHeading>
          <div className="safe-x -mx-4">
            <span className={labelText}>Skills this class shares (up to {MAX_SKILLS})</span>
            <p className="mb-2 mt-1 text-caption text-ink-soft">
              Pick the closest ones. Depth is what a newcomer should expect.
            </p>
            <SkillMultiPicker
              skills={flatSkills}
              values={skillUris}
              onChange={onSkillsChange}
              allowPropose
              placeholder="Start typing a skill, or leave blank"
              hint="No specific skill is fine — leave this blank."
            />
            {atSkillCeiling ? (
              <p className="mt-1.5 text-caption text-ink-faint">
                Three skills is the most a class can carry — remove one to swap it.
              </p>
            ) : null}
            {skills.map((row) => {
              const skillLabel = labelFor(row.skill);
              return (
                <div className="mt-3" key={row.skill}>
                  <span className={labelText}>Depth — {skillLabel}</span>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2">
                    {([1, 2, 3] as const).map((n) => (
                      <button
                        key={n}
                        type="button"
                        aria-pressed={row.level === n}
                        aria-label={`Level ${n} for ${skillLabel}`}
                        onClick={() => setSkillLevel(row.skill, n)}
                        className="level-choice border border-rule px-3 text-caption"
                        style={{ background: n === row.level ? 'var(--c-ink)' : 'transparent', color: n === row.level ? 'var(--c-paper-2)' : 'var(--c-ink)' }}
                      >{DEPTH_LABEL[n - 1]}</button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div id="class-when">
          <label className="block mb-6"><span className={labelText}>Before learners come (optional)</span><textarea className={field} maxLength={256} value={prerequisites} onChange={e=>setPrerequisites(e.target.value)} placeholder="Any prior experience, tools, or preparation for this skill"/><span className="text-caption text-ink-soft">Shown publicly alongside the skills above.</span></label>
          <SectionHeading>When</SectionHeading>
          <div className="safe-x -mx-4 date-fields grid grid-cols-2 gap-3">
            <label className="block">
              <span className={labelText}>Starts</span>
              <input
                type="datetime-local"
                className={field}
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                required
              />
            </label>
            <label className="block">
              <span className={labelText}>Ends</span>
              <input
                type="datetime-local"
                className={field}
                value={endLocal}
                onChange={(e) => setEndLocal(e.target.value)}
              />
            </label>
          </div>
          <p className="mt-1.5 text-caption text-ink-faint">Times use your device's timezone ({timezone}).</p>
        </div>

        <div id="class-where">
          <SectionHeading>Where</SectionHeading>
          <label className="block mb-4"><span className={labelText}>How we’ll meet</span><select aria-label="How we’ll meet" className={field} value={mode} onChange={e=>setMode(e.target.value)}><option value="community.lexicon.calendar.event#inperson">In person</option><option value="community.lexicon.calendar.event#virtual">Online</option><option value="community.lexicon.calendar.event#hybrid">In person + online</option></select></label>
          <label className="block mb-5"><span className={labelText}>Meeting link (optional)</span><input type="url" pattern="https?://.*" className={field} value={meetingLink} onChange={e=>setMeetingLink(e.target.value)} placeholder="https://…"/><span className="text-caption text-ink-soft">Only people who RSVP see this.</span></label>
          <div className="safe-x -mx-4">
            <label className="flex items-center gap-2.5" hidden={mode.endsWith('#virtual')}>
              <input
                type="checkbox"
                checked={venueNeeded}
                onChange={(e) => onVenueNeededChange(e.target.checked)}
                aria-label="Venue needed — we don't have a room for this yet"
              />
              <span className="text-body">Venue needed — we don't have a room for this yet</span>
            </label>

            {venueNeeded ? (
              <p className="mt-2 text-caption text-ink-faint">
                Address fields are off while venue needed is checked. You can still suggest a neighbourhood.
              </p>
            ) : null}
            <div className="mt-3 space-y-3" hidden={mode.endsWith('#virtual')}>
              <label className="block">
                <span className={labelText}>Place name</span>
                <input
                  className={field}
                  value={locationName}
                  onChange={(e) => setLocationName(e.target.value)}
                  placeholder="Sanitas Kitchen"
                  disabled={venueNeeded}
                />
              </label>
              <label className="block">
                <span className={labelText}>Street</span>
                <input
                  className={field}
                  value={street}
                  onChange={(e) => setStreet(e.target.value)}
                  disabled={venueNeeded}
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className={labelText}>Town or city</span>
                  <input
                    className={field}
                    value={locality}
                    onChange={(e) => setLocality(e.target.value)}
                    disabled={venueNeeded}
                  />
                </label>
                <label className="block">
                  <span className={labelText}>Region</span>
                  <input
                    className={field}
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                    disabled={venueNeeded}
                  />
                </label>
              </div>
              <label className="block">
                <span className={labelText}>Postal code</span>
                <input
                  className={field}
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  disabled={venueNeeded}
                />
              </label>
            </div>

            <label className="mt-3 block">
              <span className={labelText}>Neighbourhood (shown publicly, e.g. "North Boulder")</span>
              <input
                className={field}
                value={neighborhood}
                onChange={(e) => setNeighborhood(e.target.value)}
              />
            </label>

            <fieldset className="mt-4">
              <legend className={labelText}>Who can find this class</legend>
              {isEdit && !visibilityTouched ? (
                <p className="mt-1 text-caption text-ink-faint">
                  Current visibility is kept unless you change it.
                </p>
              ) : null}
              <div className="mt-1.5 space-y-2">
                <VisibilityOption
                  value="listed"
                  current={visibility}
                  preselected={!isEdit || visibilityTouched}
                  onSelect={(v) => {
                    setVisibility(v);
                    setVisibilityTouched(true);
                  }}
                  title="Listed"
                  detail="Title, time and neighbourhood are public; the exact address goes to people who RSVP."
                />
                <VisibilityOption
                  value="unlisted"
                  current={visibility}
                  preselected={!isEdit || visibilityTouched}
                  onSelect={(v) => {
                    setVisibility(v);
                    setVisibilityTouched(true);
                  }}
                  title="Unlisted"
                  detail="Only people with the link."
                />
                <VisibilityOption
                  value="private"
                  current={visibility}
                  preselected={!isEdit || visibilityTouched}
                  onSelect={(v) => {
                    setVisibility(v);
                    setVisibilityTouched(true);
                  }}
                  title="Private"
                  detail="Only you and the school's stewards."
                />
              </div>
            </fieldset>
          </div>
        </div>

        <div>
          <SectionHeading>Capacity</SectionHeading>
          <div className="safe-x -mx-4">
            <label className="block max-w-[160px]">
              <span className={labelText}>Capacity (optional)</span>
              <input
                type="number"
                min={1}
                className={field}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
              />
            </label>
            {capacity.trim() ? (
              <p className="mt-1.5 max-w-[48ch] text-caption text-ink-faint">
                Once {capacity.trim()} {Number(capacity.trim()) === 1 ? 'person is' : 'people are'} going, anyone
                else who RSVPs joins a waitlist and moves up automatically as spots open.
              </p>
            ) : null}
          </div>
        </div>

        <div id="class-materials">
          <SectionHeading>Materials &amp; supplies</SectionHeading>
          <div className="safe-x -mx-4 space-y-3">
            <div>
              <span className={labelText}>What to bring</span>
              <div className="mt-1.5 flex gap-2">
                <input
                  className={field}
                  aria-label="What to bring"
                  value={materialDraft}
                  onChange={(e) => setMaterialDraft(e.target.value)}
                  placeholder="A mixing bowl"
                  maxLength={120}
                />
                <Button
                  type="button"
                  variant="quiet"
                  ink="ink"
                  onClick={addMaterial}
                  disabled={materials.length >= 20}
                >
                  Add
                </Button>
              </div>
              {materials.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {materials.map((m, i) => (
                    <li key={`${m}-${i}`} className="flex items-center justify-between gap-2 text-body">
                      <span>{m}</span>
                      <button
                        type="button"
                        className="text-caption text-ink-faint"
                        onClick={() => setMaterials((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <label className="block">
              <span className={labelText}>Supplies note (optional)</span>
              <textarea
                className={`${field} min-h-[64px] resize-none`}
                value={suppliesNote}
                onChange={(e) => setSuppliesNote(e.target.value)}
                maxLength={300}
              />
            </label>
          </div>
        </div>

        <div id="class-tags">
          <SectionHeading>Tags</SectionHeading>
          <div className="safe-x -mx-4">
            <div className="flex flex-wrap gap-2">
              {SUGGESTED_TAGS.map((t) => (
                <button key={t} type="button" className={chipButton} onClick={() => addTag(t)}>
                  + {t}
                </button>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                className={field}
                aria-label="Add a tag"
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                placeholder="another-tag"
              />
              <Button type="button" variant="quiet" ink="ink" onClick={() => addTag(tagDraft)}>
                Add
              </Button>
            </div>
            {tagError ? <p className="mt-1.5 text-caption text-pink">{tagError}</p> : null}
            {tags.length > 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {tags.map((t) => (
                  <li key={t} className="inline-flex items-center gap-1.5 border-[1.5px] border-ink px-2.5 py-1 text-caption">
                    {t}
                    <button type="button" onClick={() => setTags((prev) => prev.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <div id="class-recurrence">
          <SectionHeading>Recurrence</SectionHeading>
          <div className="safe-x -mx-4">
            {isEdit ? (
              <p className="text-body text-ink-soft">{RECURRENCE_LOCKED_COPY}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {(['none', 'weekly', 'biweekly', 'monthly'] as RecurrenceFreq[]).map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={recurrence.freq === f}
                      onClick={() => selectFreq(f)}
                      className={chipButton}
                      style={{
                        background: recurrence.freq === f ? 'var(--c-ink)' : 'transparent',
                        color: recurrence.freq === f ? 'var(--c-paper-2)' : 'var(--c-ink)',
                      }}
                    >
                      {f === 'none' ? 'One time' : f === 'weekly' ? 'Weekly' : f === 'biweekly' ? 'Every 2 weeks' : 'Monthly'}
                    </button>
                  ))}
                </div>

                {recurrence.freq === 'weekly' || recurrence.freq === 'biweekly' ? (
                  <div className="mt-3">
                    <span className={labelText}>Which day(s)?</span>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {WEEKDAY_CODES.map((code) => {
                        const active = recurrence.byDay.includes(code);
                        return (
                          <button
                            key={code}
                            type="button"
                            aria-pressed={active}
                            onClick={() => toggleWeekday(code)}
                            className={chipButton}
                            style={{
                              background: active ? 'var(--c-blue)' : 'transparent',
                              color: active ? 'var(--c-paper-2)' : 'var(--c-ink)',
                            }}
                          >
                            {WEEKDAY_LABEL[code]}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {recurrence.freq !== 'none' ? (
                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-caption">
                      <input
                        type="radio"
                        name="recurrence-end"
                        checked={recurrence.until === undefined}
                        onChange={() => setRecurrence((r) => ({ ...r, until: undefined, count: r.count ?? 8 }))}
                      />
                      After
                      <input
                        type="number"
                        min={1}
                        className="w-16 border-[1.5px] border-ink px-2 py-1"
                        value={recurrence.count ?? 8}
                        onChange={(e) =>
                          setRecurrence((r) => ({ ...r, count: Math.max(1, Number(e.target.value) || 1), until: undefined }))
                        }
                      />
                      classes
                    </label>
                    <label className="flex items-center gap-2 text-caption">
                      <input
                        type="radio"
                        name="recurrence-end"
                        checked={recurrence.until !== undefined}
                        onChange={() => setRecurrence((r) => ({ ...r, count: undefined, until: r.until ?? '' }))}
                      />
                      Until
                      <input
                        type="date"
                        className="border-[1.5px] border-ink px-2 py-1"
                        value={recurrence.until ?? ''}
                        onChange={(e) => setRecurrence((r) => ({ ...r, until: e.target.value, count: undefined }))}
                      />
                    </label>
                  </div>
                ) : null}

                {previewDates.length > 0 ? (
                  <p className="mt-3 text-caption text-ink-soft">
                    Next classes: {previewDates.map((d) => previewFormat.format(d)).join(' · ')}
                  </p>
                ) : null}
              </>
            )}
          </div>
        </div>

        {error ? <p className="text-body text-pink">{error}</p> : null}
        {me && me.role < 20 ? (
          <p className="text-caption text-ink-soft">
            Hosting is unlocked by attending a few classes — if you're not there yet, posting will be refused.
          </p>
        ) : null}

        <div className="editor-publish"><p>{isEdit ? "Changes are shared with people looking at this class." : "Your class will appear according to the visibility you chose. You can edit the details after posting."}</p><Button type="submit" wide disabled={submitting}>
          {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Post this class'}
        </Button></div>
      </form>
    </Screen>
  );
}

function VisibilityOption({
  value,
  current,
  preselected,
  onSelect,
  title,
  detail,
}: {
  value: 'listed' | 'unlisted' | 'private';
  current: 'listed' | 'unlisted' | 'private';
  /** False shows the radio group with NOTHING checked — the edit screen's
   * "nothing was actively chosen yet" state (see `visibilityTouched`). */
  preselected: boolean;
  onSelect: (v: 'listed' | 'unlisted' | 'private') => void;
  title: string;
  detail: string;
}) {
  return (
    <label className="visibility-choice flex items-start gap-2.5">
      <input
        type="radio"
        name="visibility"
        className="mt-1"
        checked={preselected && current === value}
        onChange={() => onSelect(value)}
      />
      <span>
        <span className="block text-body font-medium">{title}</span>
        <span className="block text-caption text-ink-soft">{detail}</span>
      </span>
    </label>
  );
}
