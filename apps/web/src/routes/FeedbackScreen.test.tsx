import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const EVENT_URI = 'at://did:plc:host1/community.lexicon.calendar.event/abc123';

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
      auth: { me: vi.fn() },
      feedback: { submit: vi.fn() },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { FeedbackScreen } = await import('./FeedbackScreen');

const attendedEvent = {
  uri: EVENT_URI,
  name: 'Sourdough basics',
  startsAt: '2026-09-10T18:30:00-06:00',
  endsAt: '2026-09-10T20:00:00-06:00',
  locationRedacted: false,
  hostDid: 'did:plc:host1',
  venueNeeded: false,
  tags: [],
  listed: true,
  skills: [],
  materials: [],
  rsvps: { going: 3, interested: 0 },
  viewerRelation: 'attendee' as const,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <FeedbackScreen />
    </QueryClientProvider>,
  );
}

describe('FeedbackScreen', () => {
  beforeEach(() => {
    vi.mocked(api.events.get).mockReset().mockResolvedValue(attendedEvent);
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:viewer1',
      kind: 'custodial',
      role: 1,
      isCustodial: true,
      emailVerified: true,
      onboarded: true,
    });
    vi.mocked(api.feedback.submit).mockReset().mockResolvedValue({ ok: true });
  });

  it('explains anonymity verbatim', async () => {
    renderScreen();
    expect(
      await screen.findByText(
        'Your answers are anonymous. The host only sees a summary once enough people respond.',
      ),
    ).toBeInTheDocument();
  });

  it('disables submit until the required direction question is answered', async () => {
    renderScreen();
    await screen.findByText('Knew the material');
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeDisabled();

    // Answering a dial alone is not enough — dials and the note stay optional.
    const knowledgeGroup = screen.getByRole('group', { name: 'Knew the material' });
    fireEvent.click(within(knowledgeGroup).getByRole('radio', { name: 'A lot' }));
    expect(screen.getByRole('button', { name: /send feedback/i })).toBeDisabled();

    const directionGroup = screen.getByRole('group', { name: /would you come to another class by this host/i });
    fireEvent.click(within(directionGroup).getByRole('radio', { name: 'Yes' }));

    expect(screen.getByRole('button', { name: /send feedback/i })).toBeEnabled();
  });

  it('submits "Yes" as direction: positive, alongside the dials and note', async () => {
    renderScreen();
    await screen.findByText('Knew the material');

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Knew the material' })).getByRole('radio', { name: 'A lot' }),
    );
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Taught it well' })).getByRole('radio', { name: 'Some' }),
    );
    fireEvent.click(
      within(screen.getByRole('group', { name: /would you come to another class by this host/i })).getByRole(
        'radio',
        { name: 'Yes' },
      ),
    );
    fireEvent.change(screen.getByLabelText(/anything else/i), { target: { value: 'Great class!' } });
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    await waitFor(() =>
      expect(api.feedback.submit).toHaveBeenCalledWith({
        eventUri: EVENT_URI,
        direction: 'positive',
        aspects: { knowledge: 3, teaching: 2 },
        text: 'Great class!',
      }),
    );
    expect(await screen.findByText(/thanks/i)).toBeInTheDocument();
  });

  it('submits "Not this time" as direction: negative', async () => {
    renderScreen();
    await screen.findByText('Knew the material');

    fireEvent.click(
      within(screen.getByRole('group', { name: /would you come to another class by this host/i })).getByRole(
        'radio',
        { name: 'Not this time' },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    await waitFor(() =>
      expect(api.feedback.submit).toHaveBeenCalledWith({
        eventUri: EVENT_URI,
        direction: 'negative',
      }),
    );
    expect(await screen.findByText(/thanks/i)).toBeInTheDocument();
  });

  it('shows the already-voted state on a 409 AlreadyVoted', async () => {
    vi.mocked(api.feedback.submit).mockRejectedValue(
      new ApiError(409, 'AlreadyVoted', 'you have already left feedback for this class'),
    );
    renderScreen();
    await screen.findByText('Knew the material');

    fireEvent.click(
      within(screen.getByRole('group', { name: /would you come to another class by this host/i })).getByRole(
        'radio',
        { name: 'Yes' },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    expect(await screen.findByText(/already left feedback for this class/i)).toBeInTheDocument();
  });

  it('shows the server\'s 403 message when the viewer was not checked off as attending', async () => {
    vi.mocked(api.feedback.submit).mockRejectedValue(
      new ApiError(403, 'NotEligible', 'feedback is open to people the host confirmed were there'),
    );
    renderScreen();
    await screen.findByText('Knew the material');

    fireEvent.click(
      within(screen.getByRole('group', { name: /would you come to another class by this host/i })).getByRole(
        'radio',
        { name: 'Yes' },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: /send feedback/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/feedback is open to people the host confirmed were there/i);
  });
});
