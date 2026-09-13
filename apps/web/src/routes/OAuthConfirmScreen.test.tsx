import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const originalLocation = window.location;

describe('OAuthConfirmScreen', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    // Only the navigation test below replaces `window.location` (jsdom's isn't
    // directly assignable); restore it unconditionally here rather than at the
    // end of that test body, so a thrown assertion can never leave it swapped
    // out for every test that runs after.
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
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

  it('probes /oauth/client-metadata.json exactly once, then navigates to the start URL once', async () => {
    // `/oauth/client-metadata.json` does nothing on success but return a static
    // document (`apps/appview/src/http/oauth.ts`'s `clientMetadata()`), unlike
    // `/api/auth/oauth/start`, which does real upstream work (PAR, an
    // `oauthState` row) even just to answer — so the probe must never be that
    // endpoint, and the button must never hit the network twice.
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 200 }));
    Object.defineProperty(window, 'location', { value: { ...originalLocation, href: '' }, writable: true });

    render(<OAuthConfirmScreen />);
    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    await waitFor(() =>
      expect(window.location.href).toBe('/api/auth/oauth/start?confirm=1&handle=wren.bsky.social'),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/oauth/client-metadata.json');
  });

  it('shows the unavailable message when the probe returns 503 OAuthUnavailable', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'OAuthUnavailable', message: 'no https origin' }), { status: 503 }),
    );

    render(<OAuthConfirmScreen />);
    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    expect(await screen.findByText(UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('also shows the unavailable message for the real server error code (OAuthNotConfigured, status 503)', async () => {
    // `apps/appview/src/http/oauth.ts`'s `OAuthUnavailableError.code` is actually
    // `OAuthNotConfigured` — confirmed against the running dev AppView — so the
    // match must not depend on the `OAuthUnavailable` string alone; it keys off
    // the 503 status, which this route has no other reason to return.
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

  it('shows a generic message when the probe fails for some other reason', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('{}', { status: 500 }));

    render(<OAuthConfirmScreen />);
    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    expect(await screen.findByText('Could not start sign-in. Try again.')).toBeInTheDocument();
  });

  it('shows a generic message when the probe throws (network failure)', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));

    render(<OAuthConfirmScreen />);
    fireEvent.change(screen.getByLabelText('Your handle, like name.bsky.social'), {
      target: { value: 'wren.bsky.social' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue anyway' }));

    expect(await screen.findByText('Could not start sign-in. Try again.')).toBeInTheDocument();
  });
});
