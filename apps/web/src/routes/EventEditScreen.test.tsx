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
    // A 6pm start in this machine's zone (America/Denver, per the test
    // environment) is already the next day in UTC, and `rrule`'s BYDAY
    // matches `getUTCDay()` — so the wire-level code for the host's "Thu"
    // click is its UTC-equivalent, "FR" (see recurrence.ts's `effectiveByDay`
    // doc comment; this is the bug found verifying this task manually).
    expect(body.series).toMatchObject({ freq: 'weekly', byDay: ['FR'] });
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
});
