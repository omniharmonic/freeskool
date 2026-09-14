import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom has no `<dialog>` showModal/close — Sheet.tsx calls them unconditionally
// in a `useEffect`, so any test that opens the composer sheet needs this polyfill.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
}

const REQUEST_URI = 'at://did:plc:asker1/freeschool.draft.request/req1';
const SKILL_URI = 'at://did:plc:school/freeschool.draft.skill/sharpening';

const navigateSpy = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => navigateSpy),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
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
      auth: { me: vi.fn() },
      requests: { list: vi.fn(), create: vi.fn(), rsvp: vi.fn(), claim: vi.fn() },
      skills: { tree: vi.fn() },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { RequestsScreen } = await import('./RequestsScreen');

const openRequest = {
  uri: REQUEST_URI,
  askedBy: 'did:plc:asker1',
  title: 'Someone teach me to sharpen things properly',
  description: 'Kitchen knives, chisels, a scythe I inherited.',
  status: 'open' as const,
  claims: 0,
  threshold: 6,
  rsvpCount: 6,
  viewerInterested: false,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <RequestsScreen />
    </QueryClientProvider>,
  );
}

describe('RequestsScreen', () => {
  beforeEach(() => {
    navigateSpy.mockReset();
    vi.mocked(api.auth.me)
      .mockReset()
      .mockResolvedValue({ did: 'did:plc:host1', kind: 'custodial', role: 20, isCustodial: true, emailVerified: true, onboarded: true });
    vi.mocked(api.requests.list).mockReset().mockResolvedValue({ requests: [openRequest] });
    vi.mocked(api.requests.rsvp).mockReset().mockResolvedValue({ interested: true, count: 7 });
    vi.mocked(api.requests.claim)
      .mockReset()
      .mockResolvedValue({ uri: 'at://did:plc:host1/freeschool.draft.claim/c1', cid: 'cid1' });
    vi.mocked(api.skills.tree).mockReset().mockResolvedValue({ skills: [] });
    vi.mocked(api.requests.create)
      .mockReset()
      .mockResolvedValue({ uri: 'at://did:plc:host1/freeschool.draft.request/new1', cid: 'cid1' });
  });

  it('posts the skill chosen in the type-ahead picker, not a dropdown value', async () => {
    vi.mocked(api.skills.tree).mockResolvedValue({
      skills: [
        {
          uri: 'at://did:plc:school/freeschool.draft.skill/crafts',
          id: 'crafts',
          label: 'Crafts',
          status: 'canonical',
          tier: 'A' as const,
          alsoUnder: [],
          children: [
            {
              uri: SKILL_URI,
              id: 'sharpening',
              label: 'Sharpening hand tools',
              status: 'canonical',
              tier: 'A' as const,
              alsoUnder: [],
              children: [],
            },
          ],
        },
      ],
    });
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Ask for one' }));
    fireEvent.change(await screen.findByPlaceholderText(/someone teach me to sharpen things properly/i), {
      target: { value: 'Teach me to sharpen things' },
    });

    // No <select> anywhere in the composer any more.
    expect(screen.queryByRole('combobox', { name: /search the skill taxonomy/i })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: /search the skill taxonomy/i }), {
      target: { value: 'sharpen' },
    });
    fireEvent.click(await screen.findByRole('option', { name: /Sharpening hand tools/ }));

    expect(screen.getByText('Crafts › Sharpening hand tools')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /post this request/i }));

    await waitFor(() =>
      expect(api.requests.create).toHaveBeenCalledWith({
        title: 'Teach me to sharpen things',
        description: undefined,
        skill: SKILL_URI,
      }),
    );
  });

  it("shows the empty-state copy when there's nothing on the board", async () => {
    vi.mocked(api.requests.list).mockResolvedValue({ requests: [] });
    renderScreen();
    expect(await screen.findByText(/post what you'd like to learn\. someone nearby probably knows it\./i)).toBeInTheDocument();
  });

  it('"I want this too" calls api.requests.rsvp with the request uri', async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: /i want this too/i }));
    await waitFor(() => expect(api.requests.rsvp).toHaveBeenCalledWith(REQUEST_URI));
  });

  it('"I can teach this" claims the request, then navigates to /events/new with the request id', async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: /i can teach this/i }));

    await waitFor(() => expect(api.requests.claim).toHaveBeenCalledWith(REQUEST_URI, {}));
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith({ to: '/events/new', search: { request: REQUEST_URI } }),
    );
  });

  it('shows the server message and does not navigate when claiming fails (e.g. ThresholdNotMet)', async () => {
    vi.mocked(api.requests.claim).mockRejectedValueOnce(
      new ApiError(409, 'ThresholdNotMet', 'this request needs 6 interested people; has 5'),
    );
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: /i can teach this/i }));

    expect(await screen.findByText(/needs 6 interested people/i)).toBeInTheDocument();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('prompts sign-in instead of showing action buttons when nobody is signed in', async () => {
    vi.mocked(api.auth.me).mockRejectedValue(new ApiError(401, 'Unauthorized', 'sign in'));
    renderScreen();

    expect((await screen.findAllByText(/sign in/i)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /i want this too/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /i can teach this/i })).not.toBeInTheDocument();
  });

  it('shows an inline error (and does not silently succeed) when "I want this too" fails', async () => {
    vi.mocked(api.requests.rsvp).mockRejectedValueOnce(new ApiError(500, 'ServerError', 'something went wrong'));
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: /i want this too/i }));

    expect(await screen.findByText('something went wrong')).toBeInTheDocument();
    // Did not optimistically flip to "counted in" — the request item itself
    // still reads from the (unchanged) list data.
    expect(screen.queryByRole('button', { name: /you're counted in/i })).not.toBeInTheDocument();
  });

  it('the composer does NOT show the "Asked" success state when api.requests.create fails, and shows the server message', async () => {
    vi.mocked(api.requests.create).mockRejectedValueOnce(new ApiError(400, 'InvalidRequest', 'title is required'));
    renderScreen();

    fireEvent.click(await screen.findByRole('button', { name: 'Ask for one' }));
    fireEvent.change(await screen.findByPlaceholderText(/someone teach me to sharpen things properly/i), {
      target: { value: 'Teach me to weld' },
    });
    fireEvent.click(screen.getByRole('button', { name: /post this request/i }));

    expect(await screen.findByText('title is required')).toBeInTheDocument();
    expect(screen.queryByText('Asked')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /post this request/i })).toBeInTheDocument();
  });
});
