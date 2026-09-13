import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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
  return { api: { auth: { signup: vi.fn() } }, ApiError };
});

const { api, ApiError } = await import('../lib/api');
const { SignInScreen } = await import('./SignInScreen');

describe('SignInScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.signup).mockReset();
  });

  it('posts the email to signup and shows the check-your-email state', async () => {
    vi.mocked(api.auth.signup).mockResolvedValueOnce({
      did: 'did:plc:wren',
      handle: 'wren123.fs.test',
      verifyUrl: 'http://localhost:4000/verify?token=abc',
    });

    render(<SignInScreen />);
    fireEvent.change(screen.getByLabelText(/your email/i), { target: { value: 'wren@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create a new Free School identity (recommended)' }));

    await waitFor(() => expect(api.auth.signup).toHaveBeenCalledWith({ email: 'wren@example.com' }));
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
  });

  it('shows the server error message when signup fails', async () => {
    // A well-formed address, rejected server-side (rate limit, bad PDS state,
    // etc.) — an *invalid* address never reaches the handler at all, because
    // `<input type="email" required>` blocks that submission natively.
    vi.mocked(api.auth.signup).mockRejectedValueOnce(
      new ApiError(502, 'SignupFailed', 'could not create the account'),
    );

    render(<SignInScreen />);
    fireEvent.change(screen.getByLabelText(/your email/i), { target: { value: 'wren@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create a new Free School identity (recommended)' }));

    expect(await screen.findByText('could not create the account')).toBeInTheDocument();
    expect(screen.queryByText(/check your email/i)).not.toBeInTheDocument();
  });

  it('links the second door to the OAuth confirm screen', () => {
    render(<SignInScreen />);
    const link = screen.getByRole('link', { name: 'Use an existing AT Protocol account' });
    expect(link).toHaveAttribute('href', '/oauth/confirm');
  });
});
