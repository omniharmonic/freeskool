import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useRouterState: vi.fn(() => '/admin/peers'),
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
      admin: {
        peers: vi.fn(),
        setPeers: vi.fn(),
      },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../../lib/api');
const { PeersScreen } = await import('./PeersScreen');

const stewardMe = {
  did: 'did:plc:steward1',
  kind: 'custodial' as const,
  role: 40,
  isCustodial: true,
  emailVerified: true,
  onboarded: true,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PeersScreen />
    </QueryClientProvider>,
  );
}

describe('PeersScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue(stewardMe);
    vi.mocked(api.admin.peers).mockReset().mockResolvedValue({ peers: [] });
    vi.mocked(api.admin.setPeers).mockReset();
  });

  it('rejects a bare handle client-side without calling the server', async () => {
    renderScreen();
    await screen.findByText('No peers registered yet.');

    fireEvent.change(screen.getByPlaceholderText('https://pds.example.com'), {
      target: { value: 'alice.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));

    expect(await screen.findByText(/not yet by handle or did/i)).toBeInTheDocument();
    expect(api.admin.setPeers).not.toHaveBeenCalled();
  });

  it("maps the server's 400 InvalidRequest to a specific sentence, never the generic failure", async () => {
    vi.mocked(api.admin.setPeers).mockRejectedValue(
      new ApiError(400, 'InvalidRequest', 'Request failed with status 400'),
    );
    renderScreen();
    await screen.findByText('No peers registered yet.');

    // Looks like a URL client-side, so the request actually goes to the
    // server, which is the one that 400s here (e.g. a malformed URL zod
    // accepts as a string but rejects as a URL).
    fireEvent.change(screen.getByPlaceholderText('https://pds.example.com'), {
      target: { value: 'https://not a valid url' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add peer' }));

    await waitFor(() => expect(api.admin.setPeers).toHaveBeenCalled());
    expect(
      await screen.findByText(/that doesn't look like a pds address\. use a full https:\/\/ url/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Request failed with status 400')).not.toBeInTheDocument();
  });
});
