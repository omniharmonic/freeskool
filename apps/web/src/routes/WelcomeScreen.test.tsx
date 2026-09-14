import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom has no `<dialog>` showModal/close — the skill picker's propose sheet
// mounts one, so every screen that renders a Sheet needs this polyfill.
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
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: vi.fn(() => navigateSpy),
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
      me: {
        checkHandle: vi.fn(),
        setHandle: vi.fn(),
        onboarded: vi.fn(),
        updateProfile: vi.fn(),
        setSkillClaims: vi.fn(),
      },
      skills: { tree: vi.fn() },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { WelcomeScreen } = await import('./WelcomeScreen');

const SKILL_URI = 'at://did:plc:school/freeschool.draft.skill/bread';

const skillTree = {
  skills: [
    {
      uri: SKILL_URI,
      id: 'bread',
      label: 'Bread baking',
      status: 'canonical',
      tier: 'A' as const,
      alsoUnder: [],
      children: [],
    },
  ],
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <WelcomeScreen />
    </QueryClientProvider>,
  );
}

/** Opens card 1's editor and types `prefix` into it. */
async function typeHandle(prefix: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Choose my own' }));
  fireEvent.change(await screen.findByLabelText('Your handle'), { target: { value: prefix } });
}

describe('WelcomeScreen', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    sessionStorage.clear();
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:wren',
      kind: 'custodial',
      role: 20,
      handle: 'quiet-fern-4821.fs.boulder',
      isCustodial: true,
      emailVerified: true,
      onboarded: false,
    });
    vi.mocked(api.me.checkHandle).mockReset().mockResolvedValue({ available: true });
    vi.mocked(api.me.setHandle).mockReset().mockResolvedValue({ handle: 'wren.fs.boulder' });
    vi.mocked(api.me.onboarded).mockReset().mockResolvedValue({ onboarded: true });
    vi.mocked(api.me.updateProfile).mockReset().mockResolvedValue({
      did: 'did:plc:wren',
      profile: { displayName: 'Wren Halloway' },
    });
    vi.mocked(api.me.setSkillClaims).mockReset().mockResolvedValue({ published: [], keptAppSide: 1 });
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue(skillTree);
  });

  it('shows the handle you were given, the three steps, and what is public', async () => {
    renderScreen();

    expect(await screen.findByText('quiet-fern-4821.fs.boulder')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 3')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your handle is public and lives in the AT Protocol directory permanently. Everything else here is only visible to members of this school.',
      ),
    ).toBeInTheDocument();
  });

  it('checks availability as you type, debounced, and asks the server for the prefix only', async () => {
    renderScreen();
    await typeHandle('wren');

    expect(await screen.findByText(/wren\.fs\.boulder is free/i)).toBeInTheDocument();
    await waitFor(() => expect(api.me.checkHandle).toHaveBeenCalledWith('wren'));
  });

  it('says a taken handle is taken, and keeps Save disabled', async () => {
    vi.mocked(api.me.checkHandle).mockResolvedValue({ available: false, reason: 'taken' });
    renderScreen();
    await typeHandle('wren');

    expect(await screen.findByText(/that handle is taken/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save this handle' })).toBeDisabled();
  });

  it('names the rule when the handle does not fit it', async () => {
    vi.mocked(api.me.checkHandle).mockResolvedValue({ available: false, reason: 'invalid' });
    renderScreen();
    await typeHandle('Wren!');

    expect(
      await screen.findByText('3 to 20 characters, lowercase letters, numbers and dashes.'),
    ).toBeInTheDocument();
  });

  it('saves the handle and shows the full one it became', async () => {
    renderScreen();
    await typeHandle('wren');
    await screen.findByText(/is free/i);

    fireEvent.click(screen.getByRole('button', { name: 'Save this handle' }));

    await waitFor(() => expect(api.me.setHandle).toHaveBeenCalledWith('wren'));
    expect(await screen.findByText('wren.fs.boulder')).toBeInTheDocument();
  });

  it('explains a 409 rather than leaving the save silent', async () => {
    vi.mocked(api.me.setHandle).mockRejectedValueOnce(new ApiError(409, 'HandleTaken', 'handle not available'));
    renderScreen();
    await typeHandle('wren');
    await screen.findByText(/is free/i);

    fireEvent.click(screen.getByRole('button', { name: 'Save this handle' }));

    expect(await screen.findByText(/that handle was just taken/i)).toBeInTheDocument();
  });

  it('saves the profile card without publishing anything', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText('Display name'), { target: { value: 'Wren Halloway' } });
    fireEvent.change(screen.getByLabelText('A line about you'), { target: { value: 'Mending pile.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and continue' }));

    await waitFor(() =>
      expect(api.me.updateProfile).toHaveBeenCalledWith({ displayName: 'Wren Halloway', bio: 'Mending pile.' }),
    );
  });

  it('saves chosen skills school-only, at "practicing"', async () => {
    renderScreen();

    fireEvent.change(await screen.findByLabelText('Search the skill taxonomy'), { target: { value: 'bread' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Bread baking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save these skills' }));

    await waitFor(() =>
      expect(api.me.setSkillClaims).toHaveBeenCalledWith({
        claims: [{ skill: SKILL_URI, level: 'practicing', visibility: 'school' }],
      }),
    );
  });

  it('walks the step strip forward as cards are skipped', async () => {
    renderScreen();
    await screen.findByText('Step 1 of 3');

    fireEvent.click(screen.getByRole('button', { name: 'Skip choosing a handle' }));
    expect(await screen.findByText('Step 2 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Skip the profile' }));
    expect(await screen.findByText('Step 3 of 3')).toBeInTheDocument();
  });

  it('Finish marks the member onboarded and lands them on the requests board', async () => {
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(api.me.onboarded).toHaveBeenCalled());
    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/requests' }));
  });

  it('still lands the member somewhere if marking them onboarded fails', async () => {
    vi.mocked(api.me.onboarded).mockRejectedValueOnce(new ApiError(500, 'Internal', 'nope'));
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));

    await waitFor(() => expect(navigateSpy).toHaveBeenCalledWith({ to: '/requests' }));
  });

  it('sends a signed-out visitor to the door instead of an empty form', async () => {
    vi.mocked(api.auth.me).mockRejectedValue(new ApiError(401, 'Unauthorized', 'sign in'));
    renderScreen();

    expect(await screen.findByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/signin');
  });
});
