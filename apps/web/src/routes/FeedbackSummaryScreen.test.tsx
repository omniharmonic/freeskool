import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const EVENT_URI = 'at://did:plc:host1/community.lexicon.calendar.event/abc123';

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => ({ id: EVENT_URI })),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
}));

vi.mock('../lib/api', () => ({
  api: {
    events: { get: vi.fn() },
    feedback: { summary: vi.fn() },
  },
}));

const { api } = await import('../lib/api');
const { FeedbackSummaryScreen } = await import('./FeedbackSummaryScreen');

const hostEvent = {
  uri: EVENT_URI,
  name: 'Sourdough basics',
  startsAt: '2026-09-17T18:30:00-06:00',
  endsAt: '2026-09-17T20:00:00-06:00',
  locationRedacted: false,
  hostDid: 'did:plc:host1',
  venueNeeded: false,
  tags: [],
  listed: true,
  skills: [],
  materials: [],
  rsvps: { going: 3, interested: 0 },
  viewerRelation: 'host' as const,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackSummaryScreen />
    </QueryClientProvider>,
  );
}

describe('FeedbackSummaryScreen', () => {
  beforeEach(() => {
    vi.mocked(api.events.get).mockReset().mockResolvedValue(hostEvent);
    vi.mocked(api.feedback.summary).mockReset();
  });

  it('refuses a non-host, non-steward viewer', async () => {
    vi.mocked(api.events.get).mockResolvedValue({ ...hostEvent, viewerRelation: 'attendee' });
    vi.mocked(api.feedback.summary).mockResolvedValue({ released: false, count: 0 });
    renderScreen();
    expect(
      await screen.findByText(/only the host or a steward may see this class's feedback summary/i),
    ).toBeInTheDocument();
  });

  it('shows only the count while the summary is sealed (unreleased)', async () => {
    vi.mocked(api.feedback.summary).mockResolvedValue({ released: false, count: 2 });
    renderScreen();

    expect(await screen.findByText(/2 people have left feedback/i)).toBeInTheDocument();
    expect(screen.queryByText(/positive/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/negative/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/knew the material/i)).not.toBeInTheDocument();
  });

  it('renders per-aspect means as filled dots, never as a decimal number, once released', async () => {
    vi.mocked(api.feedback.summary).mockResolvedValue({
      released: true,
      count: 3,
      positive: 2,
      negative: 1,
      aspects: {
        knowledge: { mean: 2.33, n: 3 }, // rounds to 2 of 3 dots
        teaching: { mean: 3, n: 3 }, // all 3 dots
      },
      textK: 5,
      textReleased: false,
    });
    renderScreen();

    expect(await screen.findByText(/3 people have left feedback/i)).toBeInTheDocument();
    expect(screen.getByText(/2 positive, 1 negative/i)).toBeInTheDocument();
    expect(screen.getByText('Knew the material')).toBeInTheDocument();
    expect(screen.getByText('Taught it well')).toBeInTheDocument();

    // No decimal digits anywhere in the rendered summary.
    expect(document.body.textContent).not.toMatch(/\d\.\d/);

    // Text withheld below textK.
    expect(screen.getByText(/withheld until at least 5/i)).toBeInTheDocument();
  });

  it('shows released free text once textK is met', async () => {
    vi.mocked(api.feedback.summary).mockResolvedValue({
      released: true,
      count: 5,
      positive: 4,
      negative: 1,
      textK: 5,
      textReleased: true,
      texts: ['Loved it', 'Would take again'],
    });
    renderScreen();

    expect(await screen.findByText('Loved it')).toBeInTheDocument();
    expect(screen.getByText('Would take again')).toBeInTheDocument();
    expect(screen.queryByText(/withheld/i)).not.toBeInTheDocument();
  });
});
