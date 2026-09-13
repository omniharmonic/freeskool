import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const EVENT_URI = 'at://did:plc:host1/community.lexicon.calendar.event/abc123';
const ATTENDEE_DID = 'did:plc:attendee1';

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => ({ id: EVENT_URI })),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
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
      events: { get: vi.fn() },
      attendance: { list: vi.fn(), set: vi.fn() },
    },
    ApiError,
  };
});

const { api } = await import('../lib/api');
const { AttendanceScreen } = await import('./AttendanceScreen');

const hostEvent = {
  uri: EVENT_URI,
  name: 'Sourdough basics',
  startsAt: '2026-09-17T18:30:00-06:00',
  locationRedacted: false,
  hostDid: 'did:plc:host1',
  venueNeeded: false,
  tags: [],
  listed: true,
  skills: [],
  rsvps: { going: 2, interested: 1 },
  viewerRelation: 'host' as const,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AttendanceScreen />
    </QueryClientProvider>,
  );
}

describe('AttendanceScreen', () => {
  beforeEach(() => {
    vi.mocked(api.events.get).mockReset().mockResolvedValue(hostEvent);
    vi.mocked(api.attendance.list).mockReset().mockResolvedValue({ total: 0, participated: 0, collapsed: false });
    vi.mocked(api.attendance.set).mockReset().mockResolvedValue({ ok: true, recorded: 1 });
  });

  it('refuses a non-host viewer', async () => {
    vi.mocked(api.events.get).mockResolvedValue({ ...hostEvent, viewerRelation: 'rsvp' });
    renderScreen();
    expect(await screen.findByText(/only the host of a class may check off attendance/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('adds an attendee by DID, lets the host uncheck "participated", and saves via api.attendance.set', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.change(screen.getByLabelText(/attendee's did/i), { target: { value: ATTENDEE_DID } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByText(ATTENDEE_DID)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /participated/i }));
    fireEvent.click(screen.getByRole('button', { name: /save attendance/i }));

    await waitFor(() =>
      expect(api.attendance.set).toHaveBeenCalledWith(EVENT_URI, [
        { did: ATTENDEE_DID, participated: false, role: 'attendee' },
      ]),
    );
    expect(await screen.findByText(/thanks — counts updated\. feedback opens for attendees now\./i)).toBeInTheDocument();
  });

  it('rejects a DID that does not start with "did:"', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.change(screen.getByLabelText(/attendee's did/i), { target: { value: 'not-a-did' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByText(/starts with "did:"/i)).toBeInTheDocument();
    expect(screen.queryByText('not-a-did')).not.toBeInTheDocument();
  });
});
