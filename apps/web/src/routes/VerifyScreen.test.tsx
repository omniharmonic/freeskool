import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(),
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
  return { api: { auth: { verify: vi.fn(), me: vi.fn() } }, ApiError };
});

const { useNavigate } = await import('@tanstack/react-router');
const { api, ApiError } = await import('../lib/api');
const { VerifyScreen } = await import('./VerifyScreen');

// The real `useNavigate`'s return type is generic over the route tree, which a
// bare `vi.fn()` mock can't satisfy structurally — this test only needs it
// callable, so narrow to exactly that rather than fighting the router's types.
const useNavigateMock = useNavigate as unknown as { mockReturnValue: (v: unknown) => void };

describe('VerifyScreen', () => {
  let navigateSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigateSpy = vi.fn();
    useNavigateMock.mockReturnValue(navigateSpy);
    vi.mocked(api.auth.verify).mockReset();
    // The default session behind these tests is a member who has already been
    // through `/welcome` — the onboarding hop is the exception, not the rule.
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:wren',
      kind: 'custodial',
      role: 20,
      handle: 'wren.fs.boulder',
      isCustodial: true,
      emailVerified: true,
      onboarded: true,
    });
  });

  it('shows an error state when ?token= is missing', () => {
    window.history.pushState({}, '', '/verify');

    render(<VerifyScreen />);

    expect(screen.getByText(/this link is missing its token/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute('href', '/signin');
    expect(api.auth.verify).not.toHaveBeenCalled();
  });

  it('calls api.auth.verify exactly once (even under StrictMode double-invoke) and navigates to /requests on success', async () => {
    window.history.pushState({}, '', '/verify?token=abc123');
    vi.mocked(api.auth.verify).mockResolvedValueOnce({ ok: true, did: 'did:plc:wren' });

    // StrictMode deliberately double-invokes effects in development
    // (`main.tsx` wraps the whole app in it) — this is exactly the scenario
    // that, unguarded, calls the single-use verify token twice and 400s the
    // second time (confirmed live against the AppView during the manual
    // check). `VerifyScreen`'s `useRef` guard must survive that.
    render(
      <StrictMode>
        <VerifyScreen />
      </StrictMode>,
    );

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/requests' }));

    expect(api.auth.verify).toHaveBeenCalledTimes(1);
    expect(api.auth.verify).toHaveBeenCalledWith('abc123');
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it('sends a brand-new custodial member to /welcome instead of the requests board', async () => {
    window.history.pushState({}, '', '/verify?token=abc123');
    vi.mocked(api.auth.verify).mockResolvedValueOnce({ ok: true, did: 'did:plc:wren' });
    vi.mocked(api.auth.me).mockResolvedValueOnce({
      did: 'did:plc:wren',
      kind: 'custodial',
      role: 20,
      handle: 'quiet-fern-4821.fs.boulder',
      isCustodial: true,
      emailVerified: true,
      onboarded: false,
    });

    render(<VerifyScreen />);

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/welcome' }));
  });

  it('does not send an account that brought its own handle to /welcome', async () => {
    window.history.pushState({}, '', '/verify?token=abc123');
    vi.mocked(api.auth.verify).mockResolvedValueOnce({ ok: true, did: 'did:plc:wren' });
    vi.mocked(api.auth.me).mockResolvedValueOnce({
      did: 'did:plc:wren',
      kind: 'oauth',
      role: 20,
      handle: 'wren.bsky.social',
      isCustodial: false,
      emailVerified: true,
      onboarded: false,
    });

    render(<VerifyScreen />);

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/requests' }));
  });

  it('still signs the member in when the session lookup after verify fails', async () => {
    window.history.pushState({}, '', '/verify?token=abc123');
    vi.mocked(api.auth.verify).mockResolvedValueOnce({ ok: true, did: 'did:plc:wren' });
    vi.mocked(api.auth.me).mockRejectedValueOnce(new Error('network'));

    render(<VerifyScreen />);

    await vi.waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/requests' }));
  });

  it('shows the server error message when verify rejects with an ApiError', async () => {
    window.history.pushState({}, '', '/verify?token=bad-token');
    vi.mocked(api.auth.verify).mockRejectedValueOnce(new ApiError(400, 'InvalidToken', 'that link has expired'));

    render(<VerifyScreen />);

    expect(await screen.findByText('that link has expired')).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('shows a generic fallback message when verify rejects with a non-ApiError', async () => {
    window.history.pushState({}, '', '/verify?token=bad-token');
    vi.mocked(api.auth.verify).mockRejectedValueOnce(new Error('fetch failed'));

    render(<VerifyScreen />);

    expect(await screen.findByText('Could not verify that link. Try again.')).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });
});
