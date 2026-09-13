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
      requests: { list: vi.fn() },
    },
    ApiError,
  };
});

const { api } = await import('../lib/api');
const { EventEditScreen } = await import('./EventEditScreen');

const skillTree = {
  skills: [
    {
      uri: 'at://did:plc:school/freeschool.draft.skill/bread',
      id: 'bread',
      label: 'Bread baking',
      status: 'canonical',
      tier: 'A' as const,
      alsoUnder: [],
      children: [],
    },
  ],
};

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

  it('B1: ticking "venue needed" clears and disables the address and neighbourhood fields; unticking re-enables them', async () => {
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
    expect(screen.getByLabelText(/^neighbourhood/i)).toHaveValue('');
    expect(screen.getByLabelText(/^neighbourhood/i)).toBeDisabled();
    // One-line explanation of why the fields went dead.
    expect(screen.getByText(/venue needed.*location.*fields|location fields.*venue needed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/venue needed/i));

    expect(screen.getByLabelText(/street/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/^neighbourhood/i)).not.toBeDisabled();
  });

  it('B1: submits neither address nor neighbourhood when "venue needed" is checked, even if previously filled in', async () => {
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
    expect(body.neighborhood).toBeUndefined();
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
    expect(screen.getByLabelText(/^neighbourhood/i)).toBeDisabled();
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
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
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
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Bring your own starter.' } });
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
    expect(body.description).toBe('Bring your own starter.');
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
  });

  it('shows an explanation that a waitlist forms once capacity fills', async () => {
    renderScreen();
    fireEvent.change(await screen.findByLabelText(/capacity \(optional\)/i), { target: { value: '10' } });
    expect(await screen.findByText(/anyone else who rsvps joins a waitlist/i)).toBeInTheDocument();
  });
});
