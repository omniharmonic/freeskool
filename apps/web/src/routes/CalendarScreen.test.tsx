import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// jsdom has no `scrollIntoView` — CalendarScreen opens on the first busy day
// with it, harmlessly, in an effect.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

vi.mock('@tanstack/react-router', () => ({
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
    api: { calendar: { list: vi.fn() }, auth: { me: vi.fn() } },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { CalendarScreen } = await import('./CalendarScreen');

const listedEvent = {
  uri: 'at://did:plc:peer/community.lexicon.calendar.event/peer1',
  name: 'Lock-picking basics',
  startsAt: '2026-09-17T18:00:00-06:00',
  endsAt: '2026-09-17T19:00:00-06:00',
  locationRedacted: true,
  venueNeeded: false,
  tags: [],
  neighborhood: 'South Boulder',
  origin: 'listed' as const,
};

const oursEvent = {
  uri: 'at://did:plc:host1/community.lexicon.calendar.event/ours1',
  name: 'Sourdough basics',
  startsAt: '2026-09-17T18:30:00-06:00',
  endsAt: '2026-09-17T20:00:00-06:00',
  locationRedacted: true,
  venueNeeded: false,
  tags: [],
  neighborhood: 'North Boulder',
  origin: 'ours' as const,
};

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <CalendarScreen />
    </QueryClientProvider>,
  );
}

// Signed in by default — matches production for anyone who has already
// signed in — so the masthead-specific tests below are the ones that flip it.
beforeEach(() => {
  vi.mocked(api.auth.me)
    .mockReset()
    .mockResolvedValue({ did: 'did:plc:host1', kind: 'custodial', role: 20, isCustodial: true, emailVerified: true, onboarded: true });
});

describe('CalendarScreen', () => {
  it('marks a peer-routed class "Listed from another school"', async () => {
    vi.mocked(api.calendar.list).mockReset().mockResolvedValue({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      events: [listedEvent],
    });
    renderScreen();
    expect(await screen.findByText('Listed from another school')).toBeInTheDocument();
  });

  it('shows no origin marker for a class hosted at this school', async () => {
    vi.mocked(api.calendar.list).mockReset().mockResolvedValue({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      events: [oursEvent],
    });
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    expect(screen.queryByText('Listed from another school')).not.toBeInTheDocument();
  });

  it('does not flash the empty-calendar copy while the query is still pending', async () => {
    vi.mocked(api.calendar.list).mockReset().mockReturnValue(new Promise(() => {})); // never resolves
    renderScreen();
    expect(screen.queryByText(/nothing on the calendar yet/i)).not.toBeInTheDocument();
  });

  it('shows the empty state, linking to /requests, once the query resolves with no events', async () => {
    vi.mocked(api.calendar.list).mockReset().mockResolvedValue({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
      events: [],
    });
    renderScreen();
    expect(await screen.findByText(/nothing on the calendar yet/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "Post what you'd like to learn." })).toHaveAttribute(
      'href',
      '/requests',
    );
  });
});


describe('calendar discovery', () => {
  it('moves to another month and queries its actual date range', async () => {
    vi.mocked(api.calendar.list).mockReset().mockResolvedValue({ from: '', to: '', events: [] });
    renderScreen();
    await screen.findByText(/nothing on the calendar yet/i);
    const previous = vi.mocked(api.calendar.list).mock.calls.at(-1)![0]!;
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(vi.mocked(api.calendar.list).mock.calls.at(-1)![0]!.from).not.toBe(previous.from));
    expect(new Date(vi.mocked(api.calendar.list).mock.calls.at(-1)![0]!.from!)).toEqual(new Date(previous.to!));
  });
  it('filters the displayed classes by their content', async () => {
    vi.mocked(api.calendar.list).mockReset().mockResolvedValue({ from: '', to: '', events: [oursEvent, listedEvent] });
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'South Boulder' } });
    expect(screen.queryByRole('heading', { name: 'Sourdough basics' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Lock-picking basics' })).toBeInTheDocument();
  });
  it('offers retry instead of calling a failed calendar empty', async () => {
    vi.mocked(api.calendar.list).mockReset().mockRejectedValue(new Error('offline'));
    renderScreen();
    expect(await screen.findByRole('alert')).toHaveTextContent('couldn’t load');
    expect(screen.queryByText(/nothing on the calendar yet/i)).not.toBeInTheDocument();
  });
});

describe('masthead sign-in', () => {
  beforeEach(() => {
    vi.mocked(api.calendar.list).mockReset().mockResolvedValue({ from: '', to: '', events: [] });
  });

  it('shows "Sign in" in the masthead, returning to this page, when nobody is signed in', async () => {
    vi.mocked(api.auth.me).mockReset().mockRejectedValue(new ApiError(401, 'Unauthorized', 'sign in'));
    renderScreen();

    const link = await screen.findByRole('link', { name: 'Sign in' });
    expect(link).toHaveAttribute('href', '/signin?next=%2F');
    expect(screen.getByText('Browse freely. Sign in to RSVP, teach or ask for a class.')).toBeInTheDocument();
  });

  it('shows neither the masthead "Sign in" link nor the guest lede once signed in', async () => {
    renderScreen();
    await screen.findByText(/nothing on the calendar yet/i);

    expect(screen.queryByRole('link', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByText('Browse freely. Sign in to RSVP, teach or ask for a class.')).not.toBeInTheDocument();
  });
});
