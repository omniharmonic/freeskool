import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useRouterState: vi.fn(() => '/admin'),
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
      admin: { skills: { proposals: vi.fn() } },
    },
    ApiError,
  };
});

const { api } = await import('../../lib/api');
const { AdminLayout, AdminOverviewScreen } = await import('./AdminLayout');

const memberMe = {
  did: 'did:plc:member1',
  kind: 'custodial' as const,
  role: 20,
  isCustodial: true,
  emailVerified: true,
  onboarded: true,
};

function renderOverview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdminOverviewScreen />
    </QueryClientProvider>,
  );
}

describe('the steward screens\' help line', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({ ...memberMe, role: 40 });
    vi.mocked(api.admin.skills.proposals).mockReset().mockResolvedValue({ proposals: [] });
  });

  // UX audit journey finding 15: every steward screen assumed its own vocabulary.
  it('prints the one-line explanation above the tool', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AdminLayout title="Moderation" current="moderation" help="An item is one thing a steward wants to do.">
          <p>the tool</p>
        </AdminLayout>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('An item is one thing a steward wants to do.')).toBeInTheDocument();
  });

  it('is inside the steward gate: a member sees the notice and no help text', async () => {
    vi.mocked(api.auth.me).mockResolvedValue(memberMe);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AdminLayout title="Moderation" current="moderation" help="An item is one thing a steward wants to do.">
          <p>the tool</p>
        </AdminLayout>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Stewards only.')).toBeInTheDocument();
    expect(screen.queryByText('An item is one thing a steward wants to do.')).not.toBeInTheDocument();
  });
});

describe('AdminOverviewScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue(memberMe);
    vi.mocked(api.admin.skills.proposals).mockReset().mockResolvedValue({ proposals: [] });
  });

  it('tells an ordinary member this is stewards only, without asking for steward data', async () => {
    renderOverview();

    expect(await screen.findByText('Stewards only.')).toBeInTheDocument();
    // UX audit finding 16: the proposals route 403s for a member, and a refused
    // request is the first thing any error reporter collects. Never send it.
    expect(api.admin.skills.proposals).not.toHaveBeenCalled();
  });

  it('shows a steward the tools, and the pending count', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({ ...memberMe, role: 40 });
    vi.mocked(api.admin.skills.proposals).mockResolvedValue({
      proposals: [
        {
          id: 'scythe',
          skillUri: 'at://did:plc:school/freeschool.draft.skill/scythe',
          label: 'Scythe sharpening',
          status: 'proposed',
          path: ['Land'],
          proposedAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    renderOverview();

    expect(await screen.findByText('1 pending')).toBeInTheDocument();
    expect(screen.queryByText('Stewards only.')).not.toBeInTheDocument();
  });
});
