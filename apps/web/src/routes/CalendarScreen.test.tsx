import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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

vi.mock('../lib/api', () => ({
  api: { calendar: { list: vi.fn() } },
}));

const { api } = await import('../lib/api');
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
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <CalendarScreen />
    </QueryClientProvider>,
  );
}

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
    await screen.findByText('Sourdough basics');
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
