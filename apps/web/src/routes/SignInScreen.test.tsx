import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// `SignInScreen`'s second door is a router `Link` (not a plain `<a>`), so it
// never triggers a full navigation that the dev proxy would 404 — see the
// comment at the `Link` in `SignInScreen.tsx`. Stub it with a plain anchor so
// this test doesn't need a real router context.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children?: ReactNode }) => (
    <a href={to} className={className}>
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
  return { api: { auth: { signin: vi.fn(), signup: vi.fn() }, school: { howItWorks: vi.fn() } }, ApiError };
});

const { api, ApiError } = await import('../lib/api');
const { SignInScreen } = await import('./SignInScreen');

/** The screen reads this school's own public page for its name (see `?switched=1`). */
function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SignInScreen />
    </QueryClientProvider>,
  );
}

describe('SignInScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.signin).mockReset();
    vi.mocked(api.school.howItWorks).mockReset();
    window.history.replaceState({}, '', '/signin');
  });

  it('posts the email to signin (new or returning, one door) and shows the check-your-email state', async () => {
    vi.mocked(api.auth.signin).mockResolvedValueOnce({
      did: 'did:plc:wren',
      handle: 'wren123.fs.test',
      verifyUrl: 'http://localhost:4000/verify?token=abc',
    });

    renderScreen();
    fireEvent.change(screen.getByLabelText(/your email/i), { target: { value: 'wren@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));

    await waitFor(() => expect(api.auth.signin).toHaveBeenCalledWith({ email: 'wren@example.com' }));
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  });

  it('shows the helper text under the email field', () => {
    renderScreen();
    expect(screen.getByText('New here or coming back, this is the door.')).toBeInTheDocument();
  });

  it('shows the server error message when signin fails', async () => {
    // A well-formed address, rejected server-side (rate limit, bad PDS state,
    // etc.) — an *invalid* address never reaches the handler at all, because
    // `<input type="email" required>` blocks that submission natively.
    vi.mocked(api.auth.signin).mockRejectedValueOnce(
      new ApiError(502, 'SignupFailed', 'could not create the account'),
    );

    renderScreen();
    fireEvent.change(screen.getByLabelText(/your email/i), { target: { value: 'wren@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue with email' }));

    expect(await screen.findByText('could not create the account')).toBeInTheDocument();
    expect(screen.queryByText(/check your email/i)).not.toBeInTheDocument();
  });

  it('links the second door to the OAuth confirm screen', () => {
    renderScreen();
    const link = screen.getByRole('link', { name: 'Use an existing AT Protocol account' });
    expect(link).toHaveAttribute('href', '/oauth/confirm');
  });

  /**
   * A member who switched cities on a deployment whose session cookie is host-only lands
   * here signed out. Saying nothing would read as the app losing them.
   */
  describe('arriving from the school switcher', () => {
    it('names the school they switched to and says why they are here', async () => {
      vi.mocked(api.school.howItWorks).mockResolvedValue({
        title: 'How it works',
        school: { name: 'Denver Free School' },
        sections: [],
        lastUpdated: '2026-09-14',
        printable: true,
      });
      window.history.replaceState({}, '', '/signin?returnTo=/&switched=1');

      renderScreen();

      expect(
        await screen.findByText('You switched to Denver Free School. Sign in here to continue.'),
      ).toBeInTheDocument();
    });

    it('still explains itself when the school’s name cannot be read', async () => {
      vi.mocked(api.school.howItWorks).mockRejectedValue(new ApiError(500, 'Internal', 'nope'));
      window.history.replaceState({}, '', '/signin?switched=1');

      renderScreen();

      expect(
        await screen.findByText('You switched schools. Sign in here to continue.'),
      ).toBeInTheDocument();
    });

    it('says nothing on an ordinary visit, and asks the server nothing', () => {
      renderScreen();

      expect(screen.queryByText(/You switched/)).not.toBeInTheDocument();
      expect(api.school.howItWorks).not.toHaveBeenCalled();
    });
  });
});
