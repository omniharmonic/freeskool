import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
  Link: ({to,children}: {to:string;children:ReactNode}) => <a href={to}>{children}</a>,
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
      auth: { me: vi.fn(), logout: vi.fn(), takeOwnership: vi.fn() },
      me: {
        profile: vi.fn(),
        updateProfile: vi.fn(),
        badges: vi.fn(),
        visibilityDefaults: vi.fn(),
        skillClaims: vi.fn(),
        setSkillClaims: vi.fn(),
        attestations: vi.fn(),
        importBskyProfile: vi.fn(),
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
      tier: 'B' as const,
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
    vi.mocked(api.auth.takeOwnership).mockReset();
    vi.mocked(api.me.attestations).mockReset().mockResolvedValue({ given: [], received: [] });
    vi.mocked(api.me.importBskyProfile).mockReset().mockResolvedValue({ imported: true, fields: ['displayName'] });
  });

  async function addDeEscalationClaim() {
    fireEvent.change(await screen.findByLabelText(/search the skill taxonomy/i), { target: { value: 'de-esc' } });
    fireEvent.click(await screen.findByRole('option', { name: 'De-escalation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Public' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add this skill' }));
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

  it('a rejected profile save keeps the editor open with the server error visible, and never reports success', async () => {
    vi.mocked(api.me.updateProfile).mockRejectedValueOnce(new ApiError(400, 'InvalidRequest', 'bio is too long'));
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText(/bio/i), { target: { value: 'a new bio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('bio is too long')).toBeInTheDocument();
    // The editor is still open — the bio field (and its still-unsaved value)
    // remains in the document, rather than the screen closing as if it saved.
    expect(screen.getByLabelText(/bio/i)).toHaveValue('a new bio');
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('display name and bio inputs carry the server\'s length limits (120/2000)', async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(screen.getByLabelText(/display name/i)).toHaveAttribute('maxLength', '120');
    expect(screen.getByLabelText(/bio/i)).toHaveAttribute('maxLength', '2000');
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

  it('B2 (#19): an OAuth-door session with an already-published PUBLIC claim saves it as school-only, with a one-line notice, instead of being unable to save at all', async () => {
    vi.mocked(api.me.visibilityDefaults).mockResolvedValue({ oauthDoor: true, tierBConfirmRequired: true });
    vi.mocked(api.me.skillClaims).mockResolvedValue({
      public: [{ uri: 'at://did:plc:wren/freeschool.draft.skillClaim/claim1', value: { skill: SKILL_URI, level: 'proficient' } }],
      school: [],
    });
    vi.mocked(api.me.setSkillClaims).mockResolvedValue({ published: [], keptAppSide: 1 });

    renderScreen();

    expect(
      await screen.findByText(
        /your public claims were switched to school-only because this account signed in through another provider/i,
      ),
    ).toBeInTheDocument();

    // The claim's own visibility toggle already shows "School only" active, not "Public" —
    // it was never resubmitted as public in the first place.
    const group = await screen.findByRole('group', { name: 'Visibility for De-escalation' });
    expect(within(group).getByRole('button', { name: 'School only' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Public' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Save what I can do' }));

    await waitFor(() => expect(api.me.setSkillClaims).toHaveBeenCalled());
    const body = vi.mocked(api.me.setSkillClaims).mock.calls[0]![0];
    expect(body.claims).toEqual([{ skill: SKILL_URI, level: 'proficient', note: undefined, visibility: 'school' }]);
  });

  it('selecting a Tier B skill defaults the draft visibility to school-only, and shows a "Sensitive" marker once added', async () => {
    vi.mocked(api.me.setSkillClaims).mockResolvedValue({
      published: [],
      keptAppSide: 1,
    });
    renderScreen();

    fireEvent.change(await screen.findByLabelText(/search the skill taxonomy/i), { target: { value: 'de-esc' } });
    fireEvent.click(await screen.findByRole('option', { name: 'De-escalation' }));

    // Tier B default: "School only" is the active toggle without being clicked.
    expect(screen.getByRole('button', { name: 'School only' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Add this skill' }));

    expect(await screen.findByText('Sensitive')).toBeInTheDocument();
  });

  describe('"Take ownership of this account"', () => {
    it('is shown for a custodial account, and hidden otherwise', async () => {
      renderScreen();
      expect(await screen.findByText('Take ownership of this account')).toBeInTheDocument();
    });

    it('is hidden when the account is not custodial', async () => {
      vi.mocked(api.auth.me).mockResolvedValue({
        did: 'did:plc:wren',
        kind: 'oauth',
        role: 20,
        handle: 'wren.fs.boulder',
        isCustodial: false,
        emailVerified: true,
      });
      renderScreen();
      await screen.findByRole('heading', { name: 'Me' });
      expect(screen.queryByText('Take ownership of this account')).not.toBeInTheDocument();
    });

    it('shows the revealUrl fallback when mail is unconfigured', async () => {
      // The web app's own page, not the raw API endpoint — the server emits
      // this shape (`WEB_PUBLIC_URL` + `/account/reveal/:token`).
      vi.mocked(api.auth.takeOwnership).mockResolvedValue({
        ok: true,
        handle: 'wren.fs.boulder',
        revealUrl: 'https://app.example/account/reveal/tok123',
      });
      renderScreen();

      fireEvent.click(await screen.findByRole('button', { name: 'Take ownership' }));

      expect(await screen.findByText(/check your email/i)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /account\/reveal\/tok123/ })).toHaveAttribute(
        'href',
        'https://app.example/account/reveal/tok123',
      );
    });

    it('shows the pending-link message on a 409 RevealPending', async () => {
      vi.mocked(api.auth.takeOwnership).mockRejectedValue(
        new ApiError(409, 'RevealPending', 'a take-ownership link is already pending for this account', {
          error: 'RevealPending',
          message: 'a take-ownership link is already pending for this account',
          expiresAt: '2026-09-14T00:00:00Z',
        }),
      );
      renderScreen();

      fireEvent.click(await screen.findByRole('button', { name: 'Take ownership' }));

      expect(await screen.findByText(/already pending/i)).toBeInTheDocument();
    });

    it('shows the server message on a 502 PdsRotationFailed', async () => {
      vi.mocked(api.auth.takeOwnership).mockRejectedValue(
        new ApiError(502, 'PdsRotationFailed', 'could not rotate the PDS password — nothing changed; please try again'),
      );
      renderScreen();

      fireEvent.click(await screen.findByRole('button', { name: 'Take ownership' }));

      expect(await screen.findByText(/could not rotate the pds password/i)).toBeInTheDocument();
    });
  });

  describe('the school directory', () => {
    it('hides you from the directory by sending directoryListing: false', async () => {
      vi.mocked(api.me.updateProfile).mockResolvedValue({
        did: 'did:plc:wren',
        profile: { displayName: 'Wren Halloway' },
        directoryListing: false,
      });
      renderScreen();

      fireEvent.click(await screen.findByRole('switch', { name: /hide me from the school directory/i }));

      await waitFor(() => expect(api.me.updateProfile).toHaveBeenCalledWith({ directoryListing: false }));
    });

    it('puts you back in the directory by sending directoryListing: true', async () => {
      vi.mocked(api.me.profile).mockResolvedValue({
        did: 'did:plc:wren',
        role: 20,
        evidence: {},
        thresholds: {},
        rsvps: [],
        profile: { displayName: 'Wren Halloway' },
        directoryListing: false,
      });
      vi.mocked(api.me.updateProfile).mockResolvedValue({
        did: 'did:plc:wren',
        profile: { displayName: 'Wren Halloway' },
        directoryListing: true,
      });
      renderScreen();

      fireEvent.click(await screen.findByRole('switch', { name: /hide me from the school directory/i }));

      await waitFor(() => expect(api.me.updateProfile).toHaveBeenCalledWith({ directoryListing: true }));
    });
  });

  it("lists the vouches you've received", async () => {
    vi.mocked(api.me.attestations).mockResolvedValue({
      given: [],
      received: [
        {
          id: 'att1',
          attesterDid: 'did:plc:juno',
          attesterDisplayName: 'Juno Marsh',
          skillUri: SKILL_URI,
          skillLabel: 'De-escalation',
          createdAt: '2026-09-10T00:00:00.000Z',
        },
      ],
    });
    renderScreen();

    expect(await screen.findByText(/juno marsh/i)).toBeInTheDocument();
    expect(screen.getByText(/vouches you.{1,3}ve received/i)).toBeInTheDocument();
  });

  it('offers "Refresh from Bluesky" only to a session signed in through an existing account', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Me' });
    expect(screen.queryByRole('button', { name: /refresh from bluesky/i })).not.toBeInTheDocument();

    vi.mocked(api.auth.me).mockResolvedValue({
      did: 'did:plc:wren',
      kind: 'oauth',
      role: 20,
      handle: 'wren.bsky.social',
      isCustodial: false,
      emailVerified: true,
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /refresh from bluesky/i }));
    await waitFor(() => expect(api.me.importBskyProfile).toHaveBeenCalled());
  });

  it('confirms the permanent public linkage once, then resends the profile save with confirmPublicLinkage', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({
      did: 'did:plc:wren',
      kind: 'oauth',
      role: 20,
      handle: 'wren.bsky.social',
      isCustodial: false,
      emailVerified: true,
    });
    vi.mocked(api.me.updateProfile).mockRejectedValueOnce(
      new ApiError(
        400,
        'PublicLinkageConfirmRequired',
        'publishing from an existing account links it to this school permanently; resend with confirmPublicLinkage: true',
      ),
    );
    vi.mocked(api.me.updateProfile).mockResolvedValueOnce({
      did: 'did:plc:wren',
      profile: { displayName: 'Wren Halloway', publicListing: true },
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByLabelText(/share my profile publicly/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/links this account to the school for good/i)).toBeInTheDocument();
    expect(api.me.updateProfile).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Link it and share' }));

    await waitFor(() => expect(api.me.updateProfile).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.me.updateProfile).mock.calls[1]![0]).toMatchObject({ confirmPublicLinkage: true });
  });
});
