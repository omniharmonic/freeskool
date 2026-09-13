import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useRouterState: vi.fn(() => '/admin/moderation'),
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
        moderation: {
          list: vi.fn(),
          propose: vi.fn(),
          approve: vi.fn(),
          execute: vi.fn(),
        },
      },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../../lib/api');
const { ModerationScreen } = await import('./ModerationScreen');

const STEWARD_DID = 'did:plc:steward1';

const stewardMe = {
  did: STEWARD_DID,
  kind: 'custodial' as const,
  role: 40,
  isCustodial: true,
  emailVerified: true,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ModerationScreen />
    </QueryClientProvider>,
  );
}

describe('ModerationScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue(stewardMe);
    vi.mocked(api.admin.moderation.list).mockReset().mockResolvedValue({
      requiredApprovals: 2,
      items: [],
    });
    vi.mocked(api.admin.moderation.propose).mockReset();
    vi.mocked(api.admin.moderation.approve).mockReset();
    vi.mocked(api.admin.moderation.execute).mockReset();
  });

  it('disables the propose submit button until the reason has at least 10 characters', async () => {
    renderScreen();
    await screen.findByText('Nothing open right now.');

    const submit = screen.getByRole('button', { name: 'Open item' });
    expect(submit).toBeDisabled();

    const reasonField = screen.getByLabelText(/reason — required/i);
    fireEvent.change(reasonField, { target: { value: 'too short' } });
    expect(submit).toBeDisabled();

    fireEvent.change(reasonField, { target: { value: 'this reason is long enough' } });
    expect(submit).toBeEnabled();
  });

  it('submits the propose form with the written reason', async () => {
    vi.mocked(api.admin.moderation.propose).mockResolvedValue({ id: 'mod1', status: 'open' });
    renderScreen();
    await screen.findByText('Nothing open right now.');

    fireEvent.change(screen.getByLabelText(/reason — required/i), {
      target: { value: 'a clearly written reason' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open item' }));

    await waitFor(() =>
      expect(api.admin.moderation.propose).toHaveBeenCalledWith({
        action: 'curate-listing',
        reason: 'a clearly written reason',
      }),
    );
  });

  it('shows a specific message, not a generic failure, when approving as the proposing steward', async () => {
    vi.mocked(api.admin.moderation.list).mockResolvedValue({
      requiredApprovals: 2,
      items: [
        {
          id: 'mod1',
          action: 'remove-listing',
          subjectUri: 'at://did:plc:host1/community.lexicon.calendar.event/abc',
          reason: 'spam listing',
          status: 'open',
          approvals: [{ stewardDid: STEWARD_DID, at: '2026-09-01T00:00:00Z' }],
          createdAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    renderScreen();
    await screen.findByText('spam listing');

    // The proposing steward already approved at open time — the button
    // reflects that rather than offering to approve again.
    expect(screen.getByRole('button', { name: 'Approved' })).toBeDisabled();
  });

  it("maps the server's 409 AlreadyApproved to a specific sentence, never the generic fallback", async () => {
    vi.mocked(api.admin.moderation.list).mockResolvedValue({
      requiredApprovals: 2,
      items: [
        {
          id: 'mod1',
          action: 'remove-listing',
          subjectUri: 'at://did:plc:host1/community.lexicon.calendar.event/abc',
          reason: 'spam listing',
          status: 'open',
          // A second steward (not the viewer) opened it, so "Approve" is live for the viewer.
          approvals: [{ stewardDid: 'did:plc:other-steward', at: '2026-09-01T00:00:00Z' }],
          createdAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    vi.mocked(api.admin.moderation.approve).mockRejectedValue(
      new ApiError(409, 'AlreadyApproved', 'Request failed with status 409'),
    );
    renderScreen();
    await screen.findByText('spam listing');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText(/a different steward needs to approve before it can run/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Request failed with status 409')).not.toBeInTheDocument();
  });

  it("disables running an item until the steward threshold is met", async () => {
    vi.mocked(api.admin.moderation.list).mockResolvedValue({
      requiredApprovals: 2,
      items: [
        {
          id: 'mod1',
          action: 'remove-listing',
          subjectUri: 'at://did:plc:host1/community.lexicon.calendar.event/abc',
          reason: 'spam listing',
          status: 'open',
          approvals: [{ stewardDid: STEWARD_DID, at: '2026-09-01T00:00:00Z' }],
          createdAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    renderScreen();
    await screen.findByText('spam listing');

    expect(screen.getByRole('button', { name: 'Run it' })).toBeDisabled();
    expect(screen.getByText(/needs 1 more approval/i)).toBeInTheDocument();
  });

  it("maps the server's 409 AlreadyResolved on execute to a specific sentence, and refetches the queue", async () => {
    const openItem = {
      id: 'mod1',
      action: 'remove-listing' as const,
      subjectUri: 'at://did:plc:host1/community.lexicon.calendar.event/abc',
      reason: 'spam listing',
      status: 'open',
      approvals: [
        { stewardDid: STEWARD_DID, at: '2026-09-01T00:00:00Z' },
        { stewardDid: 'did:plc:other-steward', at: '2026-09-01T00:00:00Z' },
      ],
      createdAt: '2026-09-01T00:00:00Z',
    };
    // The refetch's second `list()` call is held open deliberately: react-query
    // keeps showing the OLD data while a refetch is in flight, so the item row
    // (and its error text) stays on screen until this resolves — letting the
    // test see the error sentence before asserting the queue then clears.
    let resolveSecondList!: (value: { requiredApprovals: number; items: never[] }) => void;
    const secondList = new Promise<{ requiredApprovals: number; items: never[] }>((resolve) => {
      resolveSecondList = resolve;
    });
    vi.mocked(api.admin.moderation.list)
      .mockResolvedValueOnce({ requiredApprovals: 2, items: [openItem] })
      // A different steward beat this one to it — the refetch after the 409
      // sees the item already resolved and gone from the open queue.
      .mockImplementationOnce(() => secondList);
    vi.mocked(api.admin.moderation.execute).mockRejectedValue(
      new ApiError(409, 'AlreadyResolved', 'Request failed with status 409'),
    );
    renderScreen();
    await screen.findByText('spam listing');

    fireEvent.click(screen.getByRole('button', { name: 'Run it' }));

    expect(
      await screen.findByText(/another steward already ran this\. refreshing the queue/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Request failed with status 409')).not.toBeInTheDocument();
    await waitFor(() => expect(api.admin.moderation.list).toHaveBeenCalledTimes(2));

    resolveSecondList({ requiredApprovals: 2, items: [] });
    expect(await screen.findByText('Nothing open right now.')).toBeInTheDocument();
  });

  it('shows only state and category in the public-projection preview — never the reason or a DID', async () => {
    vi.mocked(api.admin.moderation.list).mockResolvedValue({
      requiredApprovals: 2,
      items: [
        {
          id: 'mod1',
          action: 'set-role',
          subjectDid: 'did:plc:someone',
          reason: 'a private reason only stewards should see',
          status: 'open',
          approvals: [{ stewardDid: STEWARD_DID, at: '2026-09-01T00:00:00Z' }],
          createdAt: '2026-09-01T00:00:00Z',
        },
      ],
    });
    renderScreen();
    await screen.findByText('a private reason only stewards should see');

    const preview = screen.getByText(/what the public sees/i);
    expect(preview.textContent).toContain('state: open');
    expect(preview.textContent).toContain('category: set-role');
    expect(preview.textContent).not.toContain('did:plc:someone');
    expect(preview.textContent).not.toContain('a private reason');
  });
});
