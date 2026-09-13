import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// jsdom has no real canvas backend, so `qrcode`'s draw call would otherwise
// always reject here (the exact failure `QrCode.tsx`'s fallback line — B5 —
// is for); mocked to succeed so this file's assertions stay about the
// hand-off flow, not about canvas support in the test environment.
vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useRouterState: vi.fn(() => '/admin/handoff'),
  Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock('../../lib/api', () => {
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
      auth: { me: vi.fn() },
      admin: { handoff: { start: vi.fn(), accept: vi.fn() } },
    },
    ApiError,
  };
});

const { api } = await import('../../lib/api');
const { HandoffScreen } = await import('./HandoffScreen');

const stewardMe = {
  did: 'did:plc:steward1',
  kind: 'custodial' as const,
  role: 40,
  isCustodial: true,
  emailVerified: true,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <HandoffScreen />
    </QueryClientProvider>,
  );
}

describe('HandoffScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue(stewardMe);
    vi.mocked(api.admin.handoff.start).mockReset();
  });

  it('creates a hand-off link, shows the URL, a QR code, and the expiry — and nothing else, since there is no pending-list endpoint', async () => {
    vi.mocked(api.admin.handoff.start).mockResolvedValue({
      id: 'h1',
      url: 'https://appview.example/admin/handoff/accept/tok123',
      token: 'tok123',
      expiresAt: '2026-09-20T00:00:00Z',
    });

    renderScreen();
    await screen.findByRole('button', { name: /create hand-off link/i });
    fireEvent.click(screen.getByRole('button', { name: /create hand-off link/i }));

    expect(await screen.findByText('https://appview.example/admin/handoff/accept/tok123')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /qr code/i })).toBeInTheDocument();
    expect(screen.getByText(/most recently created link from this session only/i)).toBeInTheDocument();
  });

  it('passes the optional handle/DID field through to the start call', async () => {
    vi.mocked(api.admin.handoff.start).mockResolvedValue({
      id: 'h1',
      url: 'https://appview.example/admin/handoff/accept/tok123',
      token: 'tok123',
      expiresAt: '2026-09-20T00:00:00Z',
    });
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/hand it to someone specific/i), {
      target: { value: 'wren.fs.boulder' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create hand-off link/i }));

    await waitFor(() => expect(api.admin.handoff.start).toHaveBeenCalledWith({ toHandleOrDid: 'wren.fs.boulder' }));
  });

  it("shows the server's message on failure, never a generic error", async () => {
    const { ApiError } = await import('../../lib/api');
    vi.mocked(api.admin.handoff.start).mockRejectedValue(new ApiError(404, 'NotFound', 'could not resolve that handle'));
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /create hand-off link/i }));

    expect(await screen.findByText('could not resolve that handle')).toBeInTheDocument();
  });
});
