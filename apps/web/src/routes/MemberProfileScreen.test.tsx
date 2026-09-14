import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
      requests: { create: vi.fn() },
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
      onboarded: true,
    });
    vi.mocked(api.members.get).mockReset().mockResolvedValue(profile);
    vi.mocked(api.me.attestations).mockReset().mockResolvedValue({ given: [], received: [] });
    vi.mocked(api.attestations.create).mockReset().mockResolvedValue({ id: 'att1' });
    vi.mocked(api.attestations.remove).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.requests.create).mockReset().mockResolvedValue({ uri: 'at://did:plc:viewer/freeschool.draft.request/r1', cid: 'bafy' });
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

  it('shows what they did instead of the "Host" label below Facilitator — everyone qualifies under the default policy', async () => {
    renderScreen();

    const heading = await screen.findByRole('heading', { name: 'Wren Halloway' });
    const header = heading.closest('.member-header') as HTMLElement;
    expect(within(header).queryByText('Host')).not.toBeInTheDocument();
    expect(within(header).getByText(/Hosted 2 classes/)).toBeInTheDocument();
    expect(within(header).getByText(/3 vouches/)).toBeInTheDocument();
  });

  it('names the role once it reaches Facilitator, instead of the hosted count', async () => {
    vi.mocked(api.members.get).mockResolvedValue({
      ...profile,
      role: 30,
      roleLabel: 'Facilitator',
    });
    renderScreen();

    const heading = await screen.findByRole('heading', { name: 'Wren Halloway' });
    const header = heading.closest('.member-header') as HTMLElement;
    expect(within(header).getByText(/Facilitator/)).toBeInTheDocument();
    expect(within(header).queryByText(/Hosted 2 classes/)).not.toBeInTheDocument();
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

  it('reconciles with the server when the vouch is refused, instead of failing again on retry', async () => {
    // 409 `AlreadyVouched`: the vouch is already there, this page just hadn't
    // heard. The refetched profile is what the button should show.
    vi.mocked(api.attestations.create).mockRejectedValue(
      new ApiError(409, 'AlreadyVouched', 'you have already vouched for this skill'),
    );
    vi.mocked(api.members.get)
      .mockReset()
      .mockResolvedValueOnce(profile)
      .mockResolvedValue({
        ...profile,
        claims: [{ ...profile.claims[0]!, viewerVouched: true }, profile.claims[1]!],
      });
    renderScreen();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Vouch' }))[0]!);

    expect(await screen.findByText(/already vouched/i)).toBeInTheDocument();
    await waitFor(() => expect(api.members.get).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('button', { name: 'Vouched ✓' })).toBeInTheDocument();
  });

  it('cannot vouch for yourself, and says why', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({
      did: SUBJECT_DID,
      kind: 'custodial',
      role: 20,
      handle: 'wren.fs.boulder',
      isCustodial: true,
      emailVerified: true,
      onboarded: true,
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
      onboarded: true,
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

  it('explains what a vouch is, beside the button, and links to the longer answer', async () => {
    renderScreen();

    expect(
      await screen.findByText(/A vouch says you have seen this person do this/),
    ).toBeInTheDocument();
    expect(screen.getByText(/who vouched is visible only to them/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How vouches work' })).toHaveAttribute('href', '/how-it-works');
  });

  describe('"Ask <name> to teach this"', () => {
    it('posts an ordinary request for that skill, addressed to them', async () => {
      renderScreen();

      fireEvent.click((await screen.findAllByRole('button', { name: 'Ask Wren to teach this' }))[0]!);

      await waitFor(() =>
        expect(api.requests.create).toHaveBeenCalledWith({
          title: 'Mending',
          skill: SKILL_URI,
          askedOf: SUBJECT_DID,
        }),
      );
      // Said back in the member's own words.
      expect(await screen.findByText(/Asked Wren\./)).toBeInTheDocument();
    });

    /**
     * MERGING (Task 10 report, concern 3). Somebody had already asked Wren for this, so
     * the AppView put this member on that request instead of adding a second one. Saying
     * "Asked Wren" there would be a small lie — nothing new went on the board, and Wren
     * was not told again.
     */
    it('says the ask joined an existing request when the AppView merged it', async () => {
      vi.mocked(api.requests.create).mockResolvedValue({ uri: 'at://x/y/z', cid: 'bafy', merged: true });
      renderScreen();

      fireEvent.click((await screen.findAllByRole('button', { name: 'Ask Wren to teach this' }))[0]!);

      expect(await screen.findByText(/Added you to the existing request for Mending/)).toBeInTheDocument();
      expect(screen.queryByText(/Asked Wren\./)).not.toBeInTheDocument();
    });

    it('treats the daily limit as a limit, not a breakage', async () => {
      vi.mocked(api.requests.create).mockRejectedValue(
        new ApiError(429, 'TooManyAsks', 'you can ask for up to 10 things a day'),
      );
      renderScreen();

      fireEvent.click((await screen.findAllByRole('button', { name: 'Ask Wren to teach this' }))[0]!);

      expect(await screen.findByRole('alert')).toHaveTextContent(/asked for a lot today/i);
    });

    it('is offered for every skill they claim', async () => {
      renderScreen();
      expect(await screen.findAllByRole('button', { name: 'Ask Wren to teach this' })).toHaveLength(2);
    });

    it('is never offered on your own profile — you cannot ask yourself', async () => {
      vi.mocked(api.auth.me).mockResolvedValue({
        did: SUBJECT_DID,
        kind: 'custodial',
        role: 20,
        handle: 'wren.fs.boulder',
        isCustodial: true,
        emailVerified: true,
        onboarded: true,
      });
      renderScreen();

      await screen.findByRole('heading', { name: 'Wren Halloway' });
      expect(screen.queryByRole('button', { name: /Ask .* to teach this/ })).not.toBeInTheDocument();
    });

    it('says so and leaves the button alone when the ask is refused', async () => {
      vi.mocked(api.requests.create).mockRejectedValue(new ApiError(500, 'Internal', 'nope'));
      renderScreen();

      fireEvent.click((await screen.findAllByRole('button', { name: 'Ask Wren to teach this' }))[0]!);

      expect(await screen.findByRole('alert')).toHaveTextContent(/could not send that ask/i);
      expect(screen.getAllByRole('button', { name: 'Ask Wren to teach this' }).length).toBeGreaterThan(0);
    });
  });

  it('says plainly when the member is not in the directory', async () => {
    vi.mocked(api.members.get).mockRejectedValue(new ApiError(404, 'NotFound', 'not found'));
    renderScreen();

    expect(await screen.findByText(/isn’t in the school directory/i)).toBeInTheDocument();
  });
});
