import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const TOKEN = 'reveal-tok123';

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => ({ token: TOKEN })),
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
    api: { auth: { revealOwnership: vi.fn() } },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { RevealScreen } = await import('./RevealScreen');

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <RevealScreen />
    </QueryClientProvider>,
  );
}

describe('RevealScreen', () => {
  it('shows the handle, password, and the "shown once" warning', async () => {
    vi.mocked(api.auth.revealOwnership).mockReset().mockResolvedValue({
      ok: true,
      handle: 'wren.fs.boulder',
      password: 'correct-horse-battery-staple',
      message: 'This is shown once. Sign in at your PDS with it, then change it to a password of your own.',
    });
    renderScreen();

    expect(await screen.findByText('wren.fs.boulder')).toBeInTheDocument();
    expect(screen.getByText('correct-horse-battery-staple')).toBeInTheDocument();
    expect(screen.getByText(/write this down now/i)).toBeInTheDocument();
  });

  it('fetches the token exactly once, even if the component is briefly re-rendered', async () => {
    vi.mocked(api.auth.revealOwnership).mockReset().mockResolvedValue({
      ok: true,
      handle: 'wren.fs.boulder',
      password: 'correct-horse-battery-staple',
      message: 'shown once',
    });
    const queryClient = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <RevealScreen />
      </QueryClientProvider>,
    );
    await screen.findByText('wren.fs.boulder');
    rerender(
      <QueryClientProvider client={queryClient}>
        <RevealScreen />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(api.auth.revealOwnership).toHaveBeenCalledTimes(1));
  });

  it('renders the Expired state plainly', async () => {
    vi.mocked(api.auth.revealOwnership)
      .mockReset()
      .mockRejectedValue(new ApiError(410, 'Expired', 'this link has expired'));
    renderScreen();
    expect(await screen.findByText(/this link has expired/i)).toBeInTheDocument();
  });

  it('renders the AlreadyUsed state plainly', async () => {
    vi.mocked(api.auth.revealOwnership)
      .mockReset()
      .mockRejectedValue(new ApiError(410, 'AlreadyUsed', 'this link has already been used'));
    renderScreen();
    expect(await screen.findByText(/already been used/i)).toBeInTheDocument();
  });

  it('renders the NotFound state plainly', async () => {
    vi.mocked(api.auth.revealOwnership)
      .mockReset()
      .mockRejectedValue(new ApiError(404, 'NotFound', 'unknown take-ownership link'));
    renderScreen();
    expect(await screen.findByText(/doesn't exist/i)).toBeInTheDocument();
  });

  it('copies the password to the clipboard on tap', async () => {
    vi.mocked(api.auth.revealOwnership).mockReset().mockResolvedValue({
      ok: true,
      handle: 'wren.fs.boulder',
      password: 'correct-horse-battery-staple',
      message: 'shown once',
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: /copy password/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('correct-horse-battery-staple'));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });
});
