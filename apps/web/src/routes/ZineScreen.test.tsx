import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../lib/api', () => ({
  api: { zine: { month: vi.fn() } },
}));

const { api } = await import('../lib/api');
const { ZineScreen } = await import('./ZineScreen');

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ZineScreen />
    </QueryClientProvider>,
  );
}

describe('ZineScreen', () => {
  it('renders the days and classes from the API payload', async () => {
    vi.mocked(api.zine.month).mockResolvedValue({
      month: '2026-09',
      school: { name: 'Boulder Free School' },
      days: [
        {
          date: '2026-09-17',
          events: [
            {
              uri: 'at://did:plc:host1/community.lexicon.calendar.event/abc',
              name: 'Sourdough basics',
              startsAt: '2026-09-17T18:30:00-06:00',
              endsAt: '2026-09-17T20:00:00-06:00',
              locationRedacted: true,
              venueNeeded: false,
              tags: ['skillshare'],
              neighborhood: 'North Boulder',
            },
          ],
        },
      ],
      howToPost: 'Tag your class and set it to listed.',
    });

    renderScreen();

    expect(await screen.findByText('Sourdough basics')).toBeInTheDocument();
    expect(screen.getByText('North Boulder')).toBeInTheDocument();
    expect(vi.mocked(api.zine.month).mock.calls[0]?.[0]).toMatch(/^\d{4}-\d{2}$/);
  });

  it('marks a venue-needed class without showing a street address', async () => {
    vi.mocked(api.zine.month).mockResolvedValue({
      month: '2026-09',
      school: { name: 'Boulder Free School' },
      days: [
        {
          date: '2026-09-20',
          events: [
            {
              uri: 'at://did:plc:host2/community.lexicon.calendar.event/def',
              name: 'Sign painting',
              startsAt: '2026-09-20T17:00:00-06:00',
              locationRedacted: true,
              venueNeeded: true,
              tags: [],
            },
          ],
        },
      ],
      howToPost: 'Tag your class and set it to listed.',
    });

    renderScreen();

    expect(await screen.findByText('Sign painting')).toBeInTheDocument();
    expect(screen.getByText(/venue needed/i)).toBeInTheDocument();
  });

  it('does not flash "nothing posted" copy while the month query is still pending', async () => {
    vi.mocked(api.zine.month).mockReturnValue(new Promise(() => {})); // never resolves
    renderScreen();
    expect(screen.queryByText(/nothing posted for/i)).not.toBeInTheDocument();
  });
});
