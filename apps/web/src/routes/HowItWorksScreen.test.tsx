import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
}));

vi.mock('../lib/api', () => ({
  api: { school: { howItWorks: vi.fn() } },
}));

const { api } = await import('../lib/api');
const { HowItWorksScreen } = await import('./HowItWorksScreen');

const payload = {
  title: 'How Boulder Free School works',
  school: { name: 'Boulder Free School' },
  sections: [
    { heading: 'What this is', body: 'A free, volunteer-run skill-sharing school.' },
    { heading: 'How to post a class', body: 'Any signed-in member can post a class.' },
  ],
  lastUpdated: '2026-09-01T00:00:00Z',
  printable: true as const,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <HowItWorksScreen />
    </QueryClientProvider>,
  );
}

describe('HowItWorksScreen', () => {
  it('renders every section heading and body from the server payload', async () => {
    vi.mocked(api.school.howItWorks).mockReset().mockResolvedValue(payload);
    renderScreen();

    expect(await screen.findByText('What this is')).toBeInTheDocument();
    expect(screen.getByText('A free, volunteer-run skill-sharing school.')).toBeInTheDocument();
    expect(screen.getByText('How to post a class')).toBeInTheDocument();
    expect(screen.getByText('Any signed-in member can post a class.')).toBeInTheDocument();
  });

  it('the Print button calls window.print', async () => {
    vi.mocked(api.school.howItWorks).mockReset().mockResolvedValue(payload);
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => undefined);

    renderScreen();
    await waitFor(() => expect(api.school.howItWorks).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: /print/i }));

    expect(printSpy).toHaveBeenCalledTimes(1);
    printSpy.mockRestore();
  });
});
