import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const CONFIRM_COPY =
  "Before you continue: anyone on the internet will be able to see that this account is part of Free School, and that link can't be undone later — not by us, and not by you. If you'd rather keep Free School separate, go back and create a new identity instead.";

const UNAVAILABLE_MESSAGE = "Signing in with an existing account isn't available on this server yet.";

vi.mock('../lib/api', () => ({
  api: {
    auth: {
      oauthStartUrl: vi.fn(
        (confirm: boolean, handle: string) =>
          `/api/auth/oauth/start?confirm=${confirm ? '1' : '0'}&handle=${encodeURIComponent(handle)}`,
      ),
    },
  },
}));

const { OAuthConfirmScreen } = await import('./OAuthConfirmScreen');

describe('OAuthConfirmScreen', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('renders the verbatim hard-confirm copy and both buttons', () => {
    render(<OAuthConfirmScreen />);
    expect(screen.getByText(CONFIRM_COPY)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go back and create a new identity' })).toHaveAttribute(
      'href',
      '/signin',
    );
  });

  it('disables "Continue anyway" until a handle is entered', () => {
    render(<OAuthConfirmScreen />);
    expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    expect(screen.getByRole('button', { name: 'Continue anyway' })).toBeEnabled();
  });

  it('navigates to the start URL when the server allows it (detected via an opaque redirect)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ type: 'opaqueredirect', status: 0 } as Response);
    const originalLocation = window.location;
    // jsdom's window.location is not directly assignable; replace it for the assertion.
    Object.defineProperty(window, 'location', { value: { ...originalLocation, href: '' }, writable: true });

    render(<OAuthConfirmScreen />);
    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    await waitFor(() =>
      expect(window.location.href).toBe('/api/auth/oauth/start?confirm=1&handle=wren.bsky.social'),
    );

    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it("shows the unavailable message when the start endpoint returns 503 OAuthUnavailable", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'OAuthUnavailable', message: 'no https origin' }), { status: 503 }),
    );

    render(<OAuthConfirmScreen />);
    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    expect(await screen.findByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
  });

  it('also shows the unavailable message for the real server error code (OAuthNotConfigured, status 503)', async () => {
    // `apps/appview/src/http/oauth.ts`'s `OAuthUnavailableError.code` is actually
    // `OAuthNotConfigured` — confirmed against the running dev AppView — so the
    // match must not depend on the `OAuthUnavailable` string alone.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'OAuthNotConfigured', message: 'needs https' }), { status: 503 }),
    );

    render(<OAuthConfirmScreen />);
    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    expect(await screen.findByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
  });
});
