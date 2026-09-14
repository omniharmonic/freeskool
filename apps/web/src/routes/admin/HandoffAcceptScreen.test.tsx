import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const TOKEN = 'tok123';

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => ({ token: TOKEN })),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
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
      admin: { handoff: { accept: vi.fn() } },
    },
    ApiError,
  };
});

const { api } = await import('../../lib/api');
const { HandoffAcceptScreen } = await import('./HandoffAcceptScreen');

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <HandoffAcceptScreen />
    </QueryClientProvider>,
  );
}

describe('HandoffAcceptScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:member1',
      kind: 'custodial',
      role: 1,
      isCustodial: true,
      emailVerified: true,
      onboarded: true,
    });
    vi.mocked(api.admin.handoff.accept).mockReset();
  });

  it('requires an explicit tap before accepting — not automatic on load', async () => {
    renderScreen();
    await screen.findByRole('button', { name: /accept stewardship/i });
    expect(api.admin.handoff.accept).not.toHaveBeenCalled();
  });

  it('accepts on tap and shows the steward confirmation', async () => {
    vi.mocked(api.admin.handoff.accept).mockResolvedValue({ ok: true, uri: 'at://…', auditId: 'audit1' });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /accept stewardship/i }));

    expect(await screen.findByText("You're now a steward of this school.")).toBeInTheDocument();
    await waitFor(() => expect(api.admin.handoff.accept).toHaveBeenCalledWith(TOKEN));
  });

  it('shows the single-steward warning when the server returns it', async () => {
    vi.mocked(api.admin.handoff.accept).mockResolvedValue({
      ok: true,
      uri: 'at://…',
      auditId: 'audit1',
      warning: 'single-steward',
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /accept stewardship/i }));

    expect(await screen.findByText(/only active steward right now/i)).toBeInTheDocument();
  });

  it("shows the server's message on a refused accept", async () => {
    const { ApiError } = await import('../../lib/api');
    vi.mocked(api.admin.handoff.accept).mockRejectedValue(
      new ApiError(410, 'Expired', 'this hand-off link has expired'),
    );
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /accept stewardship/i }));

    expect(await screen.findByText('this hand-off link has expired')).toBeInTheDocument();
  });
});
