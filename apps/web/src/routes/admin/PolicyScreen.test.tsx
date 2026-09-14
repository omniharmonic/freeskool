import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useRouterState: vi.fn(() => '/admin/policy'),
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
        policy: vi.fn(),
        setPolicy: vi.fn(),
      },
    },
    ApiError,
  };
});

const { api } = await import('../../lib/api');
const { PolicyScreen } = await import('./PolicyScreen');

const stewardMe = {
  did: 'did:plc:steward1',
  kind: 'custodial' as const,
  role: 40,
  isCustodial: true,
  emailVerified: true,
  onboarded: true,
};

const thresholds = {
  memberRequires: 'none' as const,
  hostMinAttended: 0,
  facilitatorMinHosted: 3,
  firstEventApproval: false,
  feedbackK: 3,
  destructiveActionStewards: 2,
  publishRoles: false,
};

const policyResponse = {
  uri: 'at://did:plc:school/freeschool.draft.policy/p1',
  thresholds,
  record: {
    title: 'How Free School works',
    text: 'Everything is free. Anyone can teach.',
    version: '1',
    effectiveAt: '2026-01-01T00:00:00Z',
    thresholds,
    createdAt: '2026-01-01T00:00:00Z',
  },
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PolicyScreen />
    </QueryClientProvider>,
  );
}

describe('PolicyScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue(stewardMe);
    vi.mocked(api.admin.policy).mockReset().mockResolvedValue(policyResponse);
    vi.mocked(api.admin.setPolicy).mockReset();
  });

  it('round-trips the thresholds object from the server into the form and back out on save', async () => {
    vi.mocked(api.admin.setPolicy).mockResolvedValue({ uri: 'at://…', cid: 'bafy…', auditId: 'audit1' });
    renderScreen();

    await screen.findByDisplayValue('How Free School works');

    // The loaded thresholds show up as the current values.
    const hostMinField = screen.getByLabelText(/classes attended before someone can host/i);
    expect(hostMinField).toHaveValue(0);
    const facilitatorField = screen.getByLabelText(/classes hosted before someone is a facilitator/i);
    expect(facilitatorField).toHaveValue(3);

    // Change one threshold and save.
    fireEvent.change(facilitatorField, { target: { value: '5' } });
    fireEvent.change(screen.getByPlaceholderText('A written reason, for the audit log.'), {
      target: { value: 'Raising the bar for facilitators.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    await waitFor(() =>
      expect(api.admin.setPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'How Free School works',
          version: '1',
          reason: 'Raising the bar for facilitators.',
          thresholds: expect.objectContaining({ ...thresholds, facilitatorMinHosted: 5 }),
        }),
      ),
    );
    expect(await screen.findByText('Saved — takes effect immediately.')).toBeInTheDocument();
  });

  it("shows the server's message, never a generic failure, when the steward threshold is not met", async () => {
    const { ApiError } = await import('../../lib/api');
    vi.mocked(api.admin.setPolicy).mockRejectedValue(
      new ApiError(403, 'ErrThresholdNotMet', 'destructive action needs 2 stewards, have 1'),
    );
    renderScreen();
    await screen.findByDisplayValue('How Free School works');

    fireEvent.change(screen.getByPlaceholderText('A written reason, for the audit log.'), {
      target: { value: 'Trying to save alone.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));

    expect(await screen.findByText('destructive action needs 2 stewards, have 1')).toBeInTheDocument();
  });
});
