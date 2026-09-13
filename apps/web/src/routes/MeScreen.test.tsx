import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => navigateSpy),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
}));

vi.mock('../components/InstallNudge', () => ({
  useInstallFlow: vi.fn(() => ({
    surface: 'installed',
    permission: 'default',
    remindersOn: false,
    turnOnReminders: vi.fn(),
    openInstallSheet: vi.fn(),
  })),
}));

vi.mock('../lib/api', () => {
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
      auth: { me: vi.fn(), logout: vi.fn() },
      me: {
        profile: vi.fn(),
        updateProfile: vi.fn(),
        badges: vi.fn(),
        visibilityDefaults: vi.fn(),
        skillClaims: vi.fn(),
        setSkillClaims: vi.fn(),
      },
      skills: { tree: vi.fn() },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { MeScreen } = await import('./MeScreen');

const SKILL_URI = 'at://did:plc:school/freeschool.draft.skill/de-escalation';

const skillTree = {
  skills: [
    {
      uri: SKILL_URI,
      id: 'de-escalation',
      label: 'De-escalation',
      status: 'canonical',
      alsoUnder: [],
      children: [],
    },
  ],
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MeScreen />
    </QueryClientProvider>,
  );
}

describe('MeScreen', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:wren',
      kind: 'custodial',
      role: 20,
      handle: 'wren.fs.boulder',
      isCustodial: true,
      emailVerified: true,
    });
    vi.mocked(api.me.profile)
      .mockReset()
      .mockResolvedValue({
        did: 'did:plc:wren',
        role: 20,
        evidence: {},
        thresholds: {},
        rsvps: [],
        profile: { displayName: 'Wren Halloway', bio: 'Mending pile.' },
      });
    vi.mocked(api.me.badges)
      .mockReset()
      .mockResolvedValue({ counts: { hosted: 2, attended: 11, vouched: 4 }, role: 20, badges: ['Hosted 2 classes'] });
    vi.mocked(api.me.visibilityDefaults).mockReset().mockResolvedValue({ oauthDoor: false, tierBConfirmRequired: true });
    vi.mocked(api.me.skillClaims).mockReset().mockResolvedValue({ public: [], school: [] });
    vi.mocked(api.me.setSkillClaims).mockReset();
    vi.mocked(api.me.updateProfile).mockReset();
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue(skillTree);
  });

  async function addDeEscalationClaim() {
    fireEvent.change(await screen.findByLabelText(/search the skill taxonomy/i), { target: { value: 'de-esc' } });
    fireEvent.click(await screen.findByRole('button', { name: 'De-escalation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Public' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to the list below' }));
  }

  it("a Tier B claim cannot be set public without the confirm dialog, and confirming resends with confirmTierB: true", async () => {
    vi.mocked(api.me.setSkillClaims).mockRejectedValueOnce(
      new ApiError(400, 'TierBConfirmRequired', 'this is a sensitive skill; resend with confirmTierB: true to publish it'),
    );
    vi.mocked(api.me.setSkillClaims).mockResolvedValueOnce({ published: [{ uri: 'at://x', skill: SKILL_URI, level: 'practicing' }], keptAppSide: 0 });

    renderScreen();
    await addDeEscalationClaim();

    fireEvent.click(screen.getByRole('button', { name: 'Save what I can do' }));

    expect(await screen.findByText('This is a sensitive skill')).toBeInTheDocument();
    expect(api.me.setSkillClaims).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.me.setSkillClaims).mock.calls[0]![0]).not.toHaveProperty('confirmTierB', true);

    fireEvent.click(screen.getByRole('button', { name: 'Make it public anyway' }));

    await waitFor(() => expect(api.me.setSkillClaims).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.me.setSkillClaims).mock.calls[1]![0]).toMatchObject({ confirmTierB: true });
  });

  it('keeping it school-only closes the dialog without resending confirmTierB', async () => {
    vi.mocked(api.me.setSkillClaims).mockRejectedValueOnce(
      new ApiError(400, 'TierBConfirmRequired', 'this is a sensitive skill; resend with confirmTierB: true to publish it'),
    );

    renderScreen();
    await addDeEscalationClaim();
    fireEvent.click(screen.getByRole('button', { name: 'Save what I can do' }));

    expect(await screen.findByText('This is a sensitive skill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it school-only' }));

    // A closed `<dialog>` drops out of the accessibility tree even though
    // `Sheet.tsx` leaves its content in the DOM (it only toggles the native
    // `open` attribute, never unmounts).
    expect(screen.queryByRole('dialog', { name: 'This is a sensitive skill' })).not.toBeInTheDocument();
    expect(api.me.setSkillClaims).toHaveBeenCalledTimes(1);
  });

  it('an OAuth-door session sees the Public toggle disabled, with the reason, and new claims default to school-only', async () => {
    vi.mocked(api.me.visibilityDefaults).mockResolvedValue({ oauthDoor: true, tierBConfirmRequired: true });

    renderScreen();

    expect(
      await screen.findByText(/signed in with an existing account.*claims here stay school-only/i),
    ).toBeInTheDocument();

    const publicToggles = await screen.findAllByRole('button', { name: 'Public' });
    for (const toggle of publicToggles) expect(toggle).toBeDisabled();
  });
});
