import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const SUBJECT_DID = 'did:plc:wren';
const SKILL_URI = 'at://did:plc:school/freeschool.draft.skill/mending';

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => ({ did: SUBJECT_DID })),
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
      members: { get: vi.fn() },
      attestations: { create: vi.fn(), remove: vi.fn() },
      me: { attestations: vi.fn() },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { MemberProfileScreen } = await import('./MemberProfileScreen');

const profile = {
  did: SUBJECT_DID,
  handle: 'wren.fs.boulder',
  displayName: 'Wren Halloway',
  bio: 'Keeper of the mending pile.',
  role: 20,
  roleLabel: 'Host',
  claimCount: 2,
  vouchCount: 3,
  lastSeenAt: '2026-09-12T18:00:00.000Z',
  claims: [
    {
      skillUri: SKILL_URI,
      skillLabel: 'Mending',
      level: 'teaching',
      visibility: 'school' as const,
      vouchCount: 3,
      viewerVouched: false,
    },
    {
      skillUri: 'at://did:plc:school/freeschool.draft.skill/sourdough',
      skillLabel: 'Sourdough',
      level: 'learning',
      visibility: 'public' as const,
      vouchCount: 0,
      viewerVouched: false,
    },
  ],
  badges: { counts: { hosted: 2, attended: 5, vouched: 3 }, role: 20, badges: ['Hosted 2 classes'] },
  hosting: [{ uri: 'at://did:plc:wren/community.lexicon.calendar.event/1', name: 'Mending circle', startsAt: '2026-09-20T18:00:00.000Z' }],
  resources: [{ id: 'res1', title: 'Darning notes' }],
};

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemberProfileScreen />
    </QueryClientProvider>,
  );
}

describe('MemberProfileScreen', () => {
  beforeEach(() => {
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:viewer',
      kind: 'custodial',
      role: 20,
      handle: 'viewer.fs.boulder',
      isCustodial: true,
      emailVerified: true,
    });
    vi.mocked(api.members.get).mockReset().mockResolvedValue(profile);
    vi.mocked(api.me.attestations).mockReset().mockResolvedValue({ given: [], received: [] });
    vi.mocked(api.attestations.create).mockReset().mockResolvedValue({ id: 'att1' });
    vi.mocked(api.attestations.remove).mockReset().mockResolvedValue(undefined);
  });

  it('shows the member, their claims grouped by level, what they host, and their notes', async () => {
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Wren Halloway' })).toBeInTheDocument();
    expect(screen.getByText('wren.fs.boulder')).toBeInTheDocument();
    expect(screen.getByText('Keeper of the mending pile.')).toBeInTheDocument();
    expect(screen.getByText('Teaching')).toBeInTheDocument();
    expect(screen.getByText('Learning')).toBeInTheDocument();
    expect(screen.getByText('Mending')).toBeInTheDocument();
    expect(screen.getByText('Mending circle')).toBeInTheDocument();
    expect(screen.getByText('Darning notes')).toBeInTheDocument();
  });

  it('vouches for one skill, sending the subject and the skill', async () => {
    renderScreen();

    const buttons = await screen.findAllByRole('button', { name: 'Vouch' });
    fireEvent.click(buttons[0]!);

    await waitFor(() =>
      expect(api.attestations.create).toHaveBeenCalledWith({ subjectDid: SUBJECT_DID, skillUri: SKILL_URI }),
    );
    expect(await screen.findByRole('button', { name: 'Vouched ✓' })).toBeInTheDocument();
  });

  it('takes a vouch back through the attestation id from the viewer’s own list', async () => {
    vi.mocked(api.members.get).mockResolvedValue({
      ...profile,
      claims: [{ ...profile.claims[0]!, viewerVouched: true }],
    });
    vi.mocked(api.me.attestations).mockResolvedValue({
      given: [{ id: 'att1', subjectDid: SUBJECT_DID, skillUri: SKILL_URI, createdAt: '2026-09-12T00:00:00.000Z' }],
      received: [],
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Vouched ✓' }));

    await waitFor(() => expect(api.attestations.remove).toHaveBeenCalledWith('att1'));
  });

  it('shows the reason rather than a dead end when the vouch is refused', async () => {
    vi.mocked(api.attestations.create).mockRejectedValue(
      new ApiError(409, 'AlreadyVouched', 'you have already vouched for this skill'),
    );
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Vouch' }))[0]!);

    expect(await screen.findByText(/already vouched/i)).toBeInTheDocument();
  });

  it('cannot vouch for yourself, and says why', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({
      did: SUBJECT_DID,
      kind: 'custodial',
      role: 20,
      handle: 'wren.fs.boulder',
      isCustodial: true,
      emailVerified: true,
    });
    renderScreen();

    const vouch = (await screen.findAllByRole('button', { name: 'Vouch' }))[0]!;
    expect(vouch).toBeDisabled();
    expect(vouch).toHaveAttribute('title', expect.stringMatching(/your own/i));
  });

  it('lets the subject see who vouched for each of their own skills', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({
      did: SUBJECT_DID,
      kind: 'custodial',
      role: 20,
      handle: 'wren.fs.boulder',
      isCustodial: true,
      emailVerified: true,
    });
    vi.mocked(api.me.attestations).mockResolvedValue({
      given: [],
      received: [
        {
          id: 'att9',
          attesterDid: 'did:plc:juno',
          attesterDisplayName: 'Juno Marsh',
          skillUri: SKILL_URI,
          skillLabel: 'Mending',
          createdAt: '2026-09-10T00:00:00.000Z',
        },
      ],
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /who vouched \(1\)/i }));

    expect(await screen.findByText('Juno Marsh')).toBeInTheDocument();
  });

  it('says plainly when the member is not in the directory', async () => {
    vi.mocked(api.members.get).mockRejectedValue(new ApiError(404, 'NotFound', 'not found'));
    renderScreen();

    expect(await screen.findByText(/isn’t in the school directory/i)).toBeInTheDocument();
  });
});
