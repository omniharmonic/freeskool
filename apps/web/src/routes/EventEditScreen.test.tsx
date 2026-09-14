import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const EVENT_URI = 'at://did:plc:host1/community.lexicon.calendar.event/abc123';

const navigateSpy = vi.fn();
let paramsReturn: Record<string, string> = {};

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => paramsReturn),
  useNavigate: vi.fn(() => navigateSpy),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, code: string | undefined, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
    }
  }
  return {
    api: {
      events: { get: vi.fn(), create: vi.fn(), update: vi.fn() },
      auth: { me: vi.fn() },
      skills: { tree: vi.fn() },
      requests: { list: vi.fn(), claim: vi.fn() },
    },
    ApiError,
  };
});

const { api } = await import('../lib/api');
const { EventEditScreen } = await import('./EventEditScreen');

function node(id: string, label: string) {
  return {
    uri: `at://did:plc:school/freeschool.draft.skill/${id}`,
    id,
    label,
    status: 'canonical',
    tier: 'A' as const,
    alsoUnder: [],
    children: [],
  };
}

const BREAD = 'at://did:plc:school/freeschool.draft.skill/bread';
const FERMENT = 'at://did:plc:school/freeschool.draft.skill/ferment';
const WORKSHOP = 'at://did:plc:school/freeschool.draft.skill/workshop';
const REPAIR = 'at://did:plc:school/freeschool.draft.skill/repair';

const skillTree = {
  skills: [
    node('bread', 'Bread baking'),
    node('ferment', 'Ferment vegetables'),
    node('workshop', 'Run a community workshop'),
    node('repair', 'Repair a bicycle'),
  ],
};

/** Type into the class editor's skill combobox and take the offered match. */
function pickSkill(typed: string, label: string) {
  fireEvent.change(screen.getByRole('combobox', { name: /skill/i }), { target: { value: typed } });
  fireEvent.click(screen.getByRole('option', { name: new RegExp(label) }));
}

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <EventEditScreen />
    </QueryClientProvider>,
  );
}

describe('EventEditScreen', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    paramsReturn = {};
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue(skillTree);
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:host1',
      kind: 'custodial',
      role: 20,
      isCustodial: true,
      emailVerified: true,
      onboarded: true,
    });
    vi.mocked(api.events.create)
      .mockReset()
      .mockResolvedValue({
        event: { uri: EVENT_URI, cid: 'cid1' },
        config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
        skillLevels: [],
      });
    vi.mocked(api.events.update).mockReset();
    vi.mocked(api.events.get).mockReset();
    vi.mocked(api.requests.list).mockReset().mockResolvedValue({ requests: [] });
    vi.mocked(api.requests.claim).mockReset().mockResolvedValue({ uri: 'at://did:plc:host1/freeschool.draft.claim/one', cid: 'cid3' });
    window.history.pushState({}, '', '/events/new');
  });

  it('omits `locations` entirely when "venue needed" is checked, even after address fields were filled in', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Sourdough basics' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.change(screen.getByLabelText(/street/i), { target: { value: '123 Main St' } });
    fireEvent.change(screen.getByLabelText(/town or city/i), { target: { value: 'Boulder' } });

    fireEvent.click(screen.getByLabelText(/venue needed/i));
    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];
    expect(body.locations).toBeUndefined();
    expect(body.name).toBe('Sourdough basics');
  });

  it('venue needed clears the exact address and preserves an editable neighbourhood', async () => {
    renderScreen();

    await screen.findByLabelText(/class title/i);
    fireEvent.change(screen.getByLabelText(/street/i), { target: { value: '123 Main St' } });
    fireEvent.change(screen.getByLabelText(/^neighbourhood/i), { target: { value: 'North Boulder' } });

    fireEvent.click(screen.getByLabelText(/venue needed/i));

    expect(screen.getByLabelText(/place name/i)).toBeDisabled();
    expect(screen.getByLabelText(/street/i)).toHaveValue('');
    expect(screen.getByLabelText(/street/i)).toBeDisabled();
    expect(screen.getByLabelText(/town or city/i)).toBeDisabled();
    expect(screen.getByLabelText(/^region$/i)).toBeDisabled();
    expect(screen.getByLabelText(/postal code/i)).toBeDisabled();
    expect(screen.getByLabelText(/^neighbourhood/i)).toHaveValue('North Boulder');
    expect(screen.getByLabelText(/^neighbourhood/i)).not.toBeDisabled();
    // One-line explanation of why the fields went dead.
    expect(screen.getByText(/address fields are off while venue needed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/venue needed/i));

    expect(screen.getByLabelText(/street/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/^neighbourhood/i)).not.toBeDisabled();
  });

  it('submits the suggested neighbourhood and explicit venue call without an exact address', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Sourdough basics' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.change(screen.getByLabelText(/street/i), { target: { value: '123 Main St' } });
    fireEvent.change(screen.getByLabelText(/^neighbourhood/i), { target: { value: 'North Boulder' } });

    fireEvent.click(screen.getByLabelText(/venue needed/i));
    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];
    expect(body.locations).toBeUndefined();
    expect(body.neighborhood).toBe('North Boulder');
    expect(body.venueNeeded).toBe(true);
  });

  it('B1: edit prefills the "venue needed" checkbox from the loaded event, and the fields load disabled', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Sourdough basics',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: true,
      tags: [],
      listed: true,
      skills: [],
      materials: [],
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });

    renderScreen();
    await screen.findByRole('heading', { name: 'Edit class' });

    expect(screen.getByLabelText(/venue needed/i)).toBeChecked();
    expect(screen.getByLabelText(/street/i)).toBeDisabled();
    expect(screen.getByLabelText(/^neighbourhood/i)).not.toBeDisabled();
  });

  it('submits a body shape matching CreateEventInput: required fields, timezone from the browser, and no series for "one time"', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Sourdough basics' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.click(screen.getByLabelText(/venue needed/i));
    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];

    expect(typeof body.name).toBe('string');
    expect(typeof body.startsAt).toBe('string');
    expect(new Date(body.startsAt).toString()).not.toBe('Invalid Date');
    expect(typeof body.timezone).toBe('string');
    expect(body.timezone!.length).toBeGreaterThan(0);
    expect(body.visibility).toBe('listed');
    expect('series' in body).toBe(false);

    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
  });

  it('lets the host publish an online class with an attendee meeting link',async()=>{
    renderScreen();
    fireEvent.change(await screen.findByLabelText(/class title/i),{target:{value:'An online skill share'}});
    fireEvent.change(screen.getByLabelText(/^starts$/i),{target:{value:'2026-10-01T18:00'}});
    fireEvent.change(screen.getByLabelText('How we’ll meet'),{target:{value:'community.lexicon.calendar.event#virtual'}});
    fireEvent.change(screen.getByLabelText(/Meeting link/),{target:{value:'https://example.org/class'}});
    fireEvent.click(screen.getByRole('button',{name:/post this class/i}));
    await waitFor(()=>expect(api.events.create).toHaveBeenCalled());
    // TASK 19c: the link is an app-side `meetingLink`, never a `uris` entry on the
    // host's public record — the form promises only RSVPs see it.
    const posted = vi.mocked(api.events.create).mock.calls[0]![0];
    expect(posted).toMatchObject({mode:'community.lexicon.calendar.event#virtual',venueNeeded:false,meetingLink:'https://example.org/class'});
    expect('uris' in posted).toBe(false);
  });

  it('builds a weekly series and sends it only on create', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Sourdough basics' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } }); // a Thursday evening
    fireEvent.click(screen.getByLabelText(/venue needed/i));

    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    fireEvent.click(screen.getByRole('button', { name: 'Thu' }));

    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];
    // Task 10: the wire payload now carries the host's literal local-day
    // click verbatim — no UTC shift. The server expands BYDAY in the
    // series' own timezone (`apps/appview/src/jobs/materialize-series.ts`),
    // so "Thu" stays "TH" even though a 6pm Denver start is already the next
    // calendar day in UTC.
    expect(body.series).toMatchObject({ freq: 'weekly', byDay: ['TH'] });
    expect(body.series!.rrule).toContain('FREQ=WEEKLY');
  });

  it('on the edit screen for an existing class, recurrence is read-only with the exact copy, and update never sends `series`', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Sourdough basics',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: true,
      tags: [],
      listed: true,
      skills: [],
      materials: [],
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });
    vi.mocked(api.events.update).mockResolvedValue({
      event: { uri: EVENT_URI, cid: 'cid9' },
      config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
    });

    renderScreen();

    expect(
      await screen.findByText(
        "Recurrence can't be changed after a class is published yet. To reshape a series, cancel it and post a new one.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.events.update).toHaveBeenCalled());
    const [id, body] = vi.mocked(api.events.update).mock.calls[0]!;
    expect(id).toBe(EVENT_URI);
    expect('series' in body).toBe(false);
  });

  it('CRITICAL FIX: editing a class and saving WITHOUT touching visibility sends no `visibility` key at all', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Sourdough basics',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: true,
      tags: [],
      listed: true,
      skills: [],
      materials: [],
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });
    vi.mocked(api.events.update).mockResolvedValue({
      event: { uri: EVENT_URI, cid: 'cid9' },
      config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
    });

    renderScreen();
    await screen.findByRole('heading', { name: 'Edit class' });
    // Never touch a visibility radio — this is the whole point of the test.
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.events.update).toHaveBeenCalled());
    const [, body] = vi.mocked(api.events.update).mock.calls[0]!;
    expect('visibility' in body).toBe(false);
  });

  it('edit: checking "venue needed" on a class that HAD an address sends `locations: []`, not an omitted key', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Sourdough basics',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: false,
      locations: [{ name: 'Sanitas Kitchen', street: '123 Main St', locality: 'Boulder' }],
      tags: [],
      listed: true,
      skills: [],
      materials: [],
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });
    vi.mocked(api.events.update).mockResolvedValue({
      event: { uri: EVENT_URI, cid: 'cid9' },
      config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
    });

    renderScreen();
    await screen.findByRole('heading', { name: 'Edit class' });
    fireEvent.click(screen.getByLabelText(/venue needed/i));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.events.update).toHaveBeenCalled());
    const [, body] = vi.mocked(api.events.update).mock.calls[0]!;
    expect(body.locations).toEqual([]);
  });

  it('edit: clearing the only skill sends `skills: []`, not an omitted key', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Sourdough basics',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: true,
      tags: [],
      listed: true,
      skills: [{ skill: 'at://did:plc:school/freeschool.draft.skill/bread', level: 2 as const }],
      materials: [],
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });
    vi.mocked(api.events.update).mockResolvedValue({
      event: { uri: EVENT_URI, cid: 'cid9' },
      config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
    });

    renderScreen();
    await screen.findByRole('heading', { name: 'Edit class' });
    expect(await screen.findByText('Bread baking')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Bread baking' }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.events.update).toHaveBeenCalled());
    const [, body] = vi.mocked(api.events.update).mock.calls[0]!;
    expect(body.skills).toEqual([]);
  });

  it('prefills title and skill from `?request=<id>` (the needs-board claim flow)', async () => {
    const REQUEST_URI = 'at://did:plc:asker1/freeschool.draft.request/req1';
    window.history.pushState({}, '', `/events/new?request=${encodeURIComponent(REQUEST_URI)}`);
    vi.mocked(api.requests.list).mockResolvedValue({
      requests: [
        {
          uri: REQUEST_URI,
          askedBy: 'did:plc:asker1',
          title: 'Someone teach me to sharpen things properly',
          status: 'open',
          claims: 0,
          rsvpCount: 6,
          viewerInterested: false,
          skill: 'at://did:plc:school/freeschool.draft.skill/bread',
        },
      ],
    });

    renderScreen();

    const titleInput = await screen.findByLabelText(/class title/i);
    await waitFor(() => expect(titleInput).toHaveValue('Someone teach me to sharpen things properly'));
    expect(await screen.findByText('Bread baking')).toBeInTheDocument();
  });

  it('sends real `materials`/`suppliesNote` fields on create, never composed into the description', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Sourdough basics' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.change(screen.getByLabelText('About this class'), { target: { value: 'Learn to bake a loaf together.' } });
    fireEvent.change(screen.getByLabelText('Who it’s for'), { target: { value: 'Beginners welcome.' } });
    fireEvent.change(screen.getByLabelText('Access & comfort'), { target: { value: 'Seated work.' } });
    fireEvent.change(screen.getByLabelText(/notes for attendees/i), { target: { value: 'Bring your own starter.' } });
    fireEvent.click(screen.getByLabelText(/venue needed/i));

    fireEvent.change(screen.getByPlaceholderText('A mixing bowl'), { target: { value: 'A mixing bowl' } });
    fireEvent.click(screen.getAllByRole('button', { name: /^add$/i })[0]!);
    fireEvent.change(screen.getByLabelText(/supplies note/i), { target: { value: 'Flour provided.' } });

    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];
    expect(body.materials).toEqual(['A mixing bowl']);
    expect(body.suppliesNote).toBe('Flour provided.');
    // Never composed into the description — that was the old workaround.
    // TASK 19c: the attendee notes go to their own app-side field; the PUBLIC
    // overview is the only free text that reaches the event record.
    expect(body.attendeeNotes).toBe('Bring your own starter.');
    expect('description' in body).toBe(false);
    expect(body.publicOverview).toEqual({ description: 'Learn to bake a loaf together.', audience: 'Beginners welcome.', accessibility: 'Seated work.' });
  });

  it('edit: prefills the attendee notes and the meeting link from their app-side fields (task 19c)', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Sourdough basics',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: true,
      tags: [],
      listed: true,
      skills: [],
      materials: [],
      // The record's own `description` is the PUBLIC overview now; it must never be
      // prefilled into the attendee-notes box.
      description: 'Public invitation',
      publicOverview: { description: 'Public invitation' },
      attendeeNotes: 'Come to the side door.',
      meetingLink: 'https://example.org/class',
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });
    vi.mocked(api.events.update).mockResolvedValue({
      event: { uri: EVENT_URI, cid: 'cid9' },
      config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
    });

    renderScreen();
    await screen.findByRole('heading', { name: 'Edit class' });
    expect(screen.getByLabelText(/notes for attendees/i)).toHaveValue('Come to the side door.');
    expect(screen.getByLabelText(/meeting link/i)).toHaveValue('https://example.org/class');
    expect(screen.getByLabelText('About this class')).toHaveValue('Public invitation');

    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.events.update).toHaveBeenCalled());
    const [, body] = vi.mocked(api.events.update).mock.calls[0]!;
    expect(body.attendeeNotes).toBe('Come to the side door.');
    expect(body.meetingLink).toBe('https://example.org/class');
    expect('description' in body).toBe(false);
    expect('uris' in body).toBe(false);
  });

  it('edit: prefills materials, suppliesNote, and the raw visibility enum from the host view', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Sourdough basics',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: true,
      tags: [],
      listed: true,
      skills: [],
      materials: ['A mixing bowl', 'A scale'],
      suppliesNote: 'Flour provided.',
      publicOverview: { description: 'Public invitation', audience: 'Beginners', accessibility: 'Seating available' },
      visibility: 'unlisted',
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });
    vi.mocked(api.events.update).mockResolvedValue({
      event: { uri: EVENT_URI, cid: 'cid9' },
      config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
    });

    renderScreen();
    await screen.findByRole('heading', { name: 'Edit class' });

    expect(screen.getByText('A mixing bowl')).toBeInTheDocument();
    expect(screen.getByText('A scale')).toBeInTheDocument();
    expect(screen.getByLabelText(/supplies note/i)).toHaveValue('Flour provided.');

    // Prefilled into STATE, but the touched-only submit rule means nothing
    // is checked yet and saving without touching visibility sends no key.
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.events.update).toHaveBeenCalled());
    const [, body] = vi.mocked(api.events.update).mock.calls[0]!;
    expect('visibility' in body).toBe(false);
    // Sent on edit even though they weren't changed — same "always send on
    // edit" rule as tags/locations/skills.
    expect(body.materials).toEqual(['A mixing bowl', 'A scale']);
    expect(body.suppliesNote).toBe('Flour provided.');
    expect(body.publicOverview).toEqual({ description: 'Public invitation', audience: 'Beginners', accessibility: 'Seating available' });
  });

  it('retries a failed request connection without publishing a second class', async () => {
    const requestUri = 'at://did:plc:asker1/freeschool.draft.request/req1';
    window.history.pushState({}, '', `/events/new?request=${encodeURIComponent(requestUri)}`);
    vi.mocked(api.requests.claim).mockRejectedValueOnce(new Error('offline'));
    renderScreen();
    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Sharpening together' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));
    expect(await screen.findByText(/Your class is published/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));
    await waitFor(() => expect(navigateSpy).toHaveBeenCalled());
    expect(api.events.create).toHaveBeenCalledTimes(1);
    expect(api.requests.claim).toHaveBeenCalledTimes(2);
    expect(api.requests.claim).toHaveBeenLastCalledWith(requestUri, { eventUri: EVENT_URI });
  });

  it('a class can share two skills, each with its own depth', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Sourdough basics' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.click(screen.getByLabelText(/venue needed/i));

    pickSkill('bread', 'Bread baking');
    pickSkill('ferment', 'Ferment vegetables');

    // Each chosen skill carries its own depth control.
    fireEvent.click(screen.getByRole('button', { name: 'Level 1 for Bread baking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Level 3 for Ferment vegetables' }));

    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];
    expect(body.skills).toEqual([
      { skill: BREAD, level: 1 },
      { skill: FERMENT, level: 3 },
    ]);
  });

  it('a class with no skill at all is still postable (a reading group, a social)', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Reading group' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.click(screen.getByLabelText(/venue needed/i));
    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];
    expect('skills' in body).toBe(false);
  });

  it('a fourth skill cannot be added — three is the ceiling', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/class title/i), { target: { value: 'Everything at once' } });
    fireEvent.change(screen.getByLabelText(/^starts$/i), { target: { value: '2026-10-01T18:00' } });
    fireEvent.click(screen.getByLabelText(/venue needed/i));

    pickSkill('bread', 'Bread baking');
    pickSkill('ferment', 'Ferment vegetables');
    pickSkill('workshop', 'Run a community workshop');
    expect(screen.getByText(/three skills is the most/i)).toBeInTheDocument();
    // A fourth is refused rather than silently replacing one of the three.
    pickSkill('repair', 'Repair a bicycle');
    expect(screen.queryByText('Repair a bicycle')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /post this class/i }));

    await waitFor(() => expect(api.events.create).toHaveBeenCalled());
    const body = vi.mocked(api.events.create).mock.calls[0]![0];
    expect(body.skills).toEqual([
      { skill: BREAD, level: 2 },
      { skill: FERMENT, level: 2 },
      { skill: WORKSHOP, level: 2 },
    ]);
  });

  it('edit: shows every skill the class already carries, and removing one sends the rest', async () => {
    paramsReturn = { id: EVENT_URI };
    vi.mocked(api.events.get).mockResolvedValue({
      uri: EVENT_URI,
      name: 'Bike clinic',
      startsAt: '2026-10-01T18:00:00-06:00',
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      venueNeeded: true,
      tags: [],
      listed: true,
      skills: [
        { skill: REPAIR, level: 2 as const, prerequisites: 'Bring the bike that makes the noise.' },
        { skill: WORKSHOP, level: 3 as const },
      ],
      materials: [],
      rsvps: { going: 0, interested: 0 },
      viewerRelation: 'host' as const,
    });
    vi.mocked(api.events.update).mockResolvedValue({
      event: { uri: EVENT_URI, cid: 'cid9' },
      config: { uri: 'at://did:plc:host1/coop.lexicon.event.config/cfg1', cid: 'cid2' },
    });

    renderScreen();
    await screen.findByRole('heading', { name: 'Edit class' });

    // Both skills are shown, each with its own depth already selected.
    expect(await screen.findByText('Repair a bicycle')).toBeInTheDocument();
    expect(screen.getByText('Run a community workshop')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Level 2 for Repair a bicycle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Level 3 for Run a community workshop' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove Run a community workshop' }));
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.events.update).toHaveBeenCalled());
    const [, body] = vi.mocked(api.events.update).mock.calls[0]!;
    expect(body.skills).toEqual([
      { skill: REPAIR, level: 2, prerequisites: 'Bring the bike that makes the noise.' },
    ]);
  });

  it('shows an explanation that a waitlist forms once capacity fills', async () => {
    renderScreen();
    fireEvent.change(await screen.findByLabelText(/capacity \(optional\)/i), { target: { value: '10' } });
    expect(await screen.findByText(/anyone else who rsvps joins a waitlist/i)).toBeInTheDocument();
  });
});
