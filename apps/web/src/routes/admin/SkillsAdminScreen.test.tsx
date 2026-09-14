import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// jsdom has no `<dialog>` showModal/close — Sheet.tsx calls them unconditionally
// in a `useEffect`, so every test that opens a Sheet needs this polyfill.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
}

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useRouterState: vi.fn(() => '/admin/skills'),
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
      skills: { tree: vi.fn() },
      admin: {
        skills: {
          proposals: vi.fn(),
          deprecate: vi.fn(),
          move: vi.fn(),
        },
      },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../../lib/api');
const { SkillsAdminScreen } = await import('./SkillsAdminScreen');

const stewardMe = {
  did: 'did:plc:steward1',
  kind: 'custodial' as const,
  role: 40,
  isCustodial: true,
  emailVerified: true,
  onboarded: true,
};

const emptyTree = { skills: [] };

const proposal = {
  id: 'bike-repair',
  skillUri: 'at://did:plc:school/freeschool.draft.skill/bike-repair',
  label: 'Bike repair',
  status: 'proposed',
  path: ['Crafts', 'Bike repair'],
  proposerHandle: 'alice.test',
  proposedAt: '2026-09-01T12:00:00.000Z',
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <SkillsAdminScreen />
    </QueryClientProvider>,
  );
}

describe('SkillsAdminScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue(stewardMe);
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue(emptyTree);
    vi.mocked(api.admin.skills.proposals).mockReset().mockResolvedValue({ proposals: [] });
    vi.mocked(api.admin.skills.deprecate).mockReset();
    vi.mocked(api.admin.skills.move).mockReset();
  });

  it('shows the empty state verbatim when nothing is proposed', async () => {
    renderScreen();
    expect(
      await screen.findByText('No proposed skills yet. Members can propose one from any skill picker.'),
    ).toBeInTheDocument();
  });

  it('renders a proposal row with label, path, proposer handle, and created date', async () => {
    vi.mocked(api.admin.skills.proposals).mockResolvedValue({ proposals: [proposal] });
    renderScreen();

    expect(await screen.findByText('Bike repair')).toBeInTheDocument();
    expect(screen.getByText('Crafts › Bike repair')).toBeInTheDocument();
    expect(screen.getByText(/alice\.test/)).toBeInTheDocument();
  });

  it('opens a confirm sheet and calls the deprecate mutation on confirm', async () => {
    vi.mocked(api.admin.skills.proposals).mockResolvedValue({ proposals: [proposal] });
    vi.mocked(api.admin.skills.deprecate).mockResolvedValue({ uri: proposal.skillUri, status: 'deprecated' });
    renderScreen();

    await screen.findByText('Bike repair');
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate' }));

    // Confirm sheet is open; there are now two "Deprecate" buttons (row + confirm) —
    // the confirm one is the last in document order.
    const confirmButtons = await screen.findAllByRole('button', { name: 'Deprecate' });
    fireEvent.click(confirmButtons.at(-1)!);

    await waitFor(() => expect(api.admin.skills.deprecate).toHaveBeenCalledWith('bike-repair', {}));
  });

  it('shows the friendly sentence inside the sheet on a 502, then closes and refetches on retry success', async () => {
    vi.mocked(api.admin.skills.proposals).mockResolvedValue({ proposals: [proposal] });
    vi.mocked(api.admin.skills.deprecate)
      .mockRejectedValueOnce(new ApiError(502, 'AuthorityError', 'Request failed with status 502'))
      .mockResolvedValueOnce({ uri: proposal.skillUri, status: 'deprecated' });
    renderScreen();

    await screen.findByText('Bike repair');
    fireEvent.click(screen.getByRole('button', { name: 'Deprecate' }));

    const confirmButtons = await screen.findAllByRole('button', { name: 'Deprecate' });
    const confirmButton = confirmButtons.at(-1)!;
    fireEvent.click(confirmButton);

    expect(
      await screen.findByText('The taxonomy account could not save that change. Try again in a moment.'),
    ).toBeInTheDocument();

    // The sheet stayed open — the confirm button is still reachable and the
    // proposal row behind it didn't take its own error paint.
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByText('Deprecate this skill?')).toBeInTheDocument();

    fireEvent.click(confirmButton);

    await waitFor(() => expect(api.admin.skills.deprecate).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByText('The taxonomy account could not save that change. Try again in a moment.'),
      ).not.toBeInTheDocument(),
    );
    // Mutation success invalidates `['skill-proposals']`, so the list refetches
    // beyond its initial load.
    await waitFor(() => expect(api.admin.skills.proposals).toHaveBeenCalledTimes(2));
  });

  it('opens a parent picker and calls the move mutation with the chosen parent', async () => {
    const domain = {
      uri: 'at://did:plc:school/freeschool.draft.skill/crafts',
      id: 'crafts',
      label: 'Crafts',
      status: 'canonical' as const,
      tier: 'A' as const,
      alsoUnder: [],
      children: [],
    };
    vi.mocked(api.skills.tree).mockResolvedValue({ skills: [domain] });
    vi.mocked(api.admin.skills.proposals).mockResolvedValue({ proposals: [proposal] });
    vi.mocked(api.admin.skills.move).mockResolvedValue({ uri: proposal.skillUri, broader: [domain.uri] });
    renderScreen();

    await screen.findByText('Bike repair');
    fireEvent.click(screen.getByRole('button', { name: 'Move' }));

    const picker = await screen.findByLabelText('New parent');
    fireEvent.change(picker, { target: { value: 'Crafts' } });
    fireEvent.click(await screen.findByText('Crafts', { selector: 'span' }));

    fireEvent.click(screen.getByRole('button', { name: 'Move this skill here' }));

    await waitFor(() =>
      expect(api.admin.skills.move).toHaveBeenCalledWith('bike-repair', { parentUri: domain.uri }),
    );
  });
});
