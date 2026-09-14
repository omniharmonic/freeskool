import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const EVENT_URI = 'at://did:plc:host1/community.lexicon.calendar.event/abc123';

const params = vi.fn(() => ({ eventId: 'abc123' }) as { eventId: string });

vi.mock('@tanstack/react-router', () => ({
  useParams: (...args: unknown[]) => params(...(args as [])),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  Navigate: ({ params: to }: { params: { id: string } }) => <div data-testid="navigate">{to.id}</div>,
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

vi.mock('../lib/api', () => ({
  api: { calendar: { list: vi.fn() } },
}));

const { api } = await import('../lib/api');
const { EventRedirect } = await import('./EventRedirect');

function renderRedirect() {
  // No retries here: this suite asserts the failure state, not the backoff.
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <EventRedirect />
    </QueryClientProvider>,
  );
}

describe('EventRedirect', () => {
  beforeEach(() => {
    params.mockReset().mockReturnValue({ eventId: 'abc123' });
    vi.mocked(api.calendar.list)
      .mockReset()
      .mockResolvedValue({
        from: '2026-01-01T00:00:00Z',
        to: '2027-01-01T00:00:00Z',
        events: [{ uri: EVENT_URI, name: 'Sourdough basics', locationRedacted: true }],
      });
  });

  it('resolves an old short link to the class it names', async () => {
    renderRedirect();
    expect(await screen.findByTestId('navigate')).toHaveTextContent(EVENT_URI);
  });

  it('forwards a whole AT-URI without asking the calendar at all', async () => {
    params.mockReturnValue({ eventId: EVENT_URI });
    renderRedirect();
    expect(await screen.findByTestId('navigate')).toHaveTextContent(EVENT_URI);
    expect(api.calendar.list).not.toHaveBeenCalled();
  });

  it('says so plainly when the short id matches no class, rather than going blank', async () => {
    params.mockReturnValue({ eventId: 'wandered-off' });
    renderRedirect();
    expect(await screen.findByRole('heading', { name: "That class link didn't resolve", level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
  });

  it('offers a retry when the calendar itself could not be read', async () => {
    vi.mocked(api.calendar.list).mockRejectedValue(new Error('offline'));
    renderRedirect();
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
