import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; params?: unknown; search?: unknown; children?: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  useNavigate: vi.fn(() => vi.fn()),
}));

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    body?: unknown;
    constructor(status: number, code: string | undefined, message: string, body?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }
  return {
    api: {
      auth: { me: vi.fn() },
      members: { list: vi.fn() },
      skills: { tree: vi.fn() },
    },
    ApiError,
  };
});

const { api } = await import('../lib/api');
const { PeopleScreen } = await import('./PeopleScreen');

const SKILL_URI = 'at://did:plc:school/freeschool.draft.skill/mending';

const members = [
  {
    did: 'did:plc:wren',
    handle: 'wren.fs.boulder',
    displayName: 'Wren Halloway',
    bio: 'Mending pile.',
    role: 20,
    roleLabel: 'Host',
    claimCount: 3,
    vouchCount: 2,
    lastSeenAt: '2026-09-12T18:00:00.000Z',
  },
  {
    did: 'did:plc:juno',
    handle: 'juno.fs.boulder',
    displayName: 'Juno Marsh',
    role: 10,
    roleLabel: 'Member',
    claimCount: 1,
    vouchCount: 0,
    lastSeenAt: '2026-09-11T18:00:00.000Z',
  },
];

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <PeopleScreen />
    </QueryClientProvider>,
  );
}

describe('PeopleScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:viewer',
      kind: 'custodial',
      role: 20,
      handle: 'viewer.fs.boulder',
      isCustodial: true,
      emailVerified: true,
    });
    vi.mocked(api.members.list).mockReset().mockResolvedValue({ members });
    vi.mocked(api.skills.tree)
      .mockReset()
      .mockResolvedValue({
        skills: [
          {
            uri: SKILL_URI,
            id: 'mending',
            label: 'Mending',
            status: 'canonical',
            tier: 'A' as const,
            alsoUnder: [],
            children: [],
          },
        ],
      });
  });

  it('lists the members of the school', async () => {
    renderScreen();

    expect(await screen.findByText('Wren Halloway')).toBeInTheDocument();
    expect(screen.getByText('Juno Marsh')).toBeInTheDocument();
    expect(screen.getByText(/Host/)).toBeInTheDocument();
  });

  it('filters by name, passing the search through to the API', async () => {
    renderScreen();
    await screen.findByText('Wren Halloway');

    fireEvent.change(screen.getByLabelText(/search people/i), { target: { value: 'wren' } });

    await waitFor(() =>
      expect(api.members.list).toHaveBeenCalledWith(expect.objectContaining({ q: 'wren' })),
    );
  });

  it('filters by skill through the skill picker', async () => {
    renderScreen();
    await screen.findByText('Wren Halloway');

    fireEvent.change(await screen.findByLabelText(/search the skill taxonomy/i), {
      target: { value: 'mend' },
    });
    fireEvent.click(await screen.findByRole('option', { name: 'Mending' }));

    await waitFor(() =>
      expect(api.members.list).toHaveBeenCalledWith(expect.objectContaining({ skill: SKILL_URI })),
    );
  });

  it('says so plainly when nobody matches', async () => {
    vi.mocked(api.members.list).mockResolvedValue({ members: [] });
    renderScreen();

    expect(await screen.findByText(/nobody here yet/i)).toBeInTheDocument();
  });
});
