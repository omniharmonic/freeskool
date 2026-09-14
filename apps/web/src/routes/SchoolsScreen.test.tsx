import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@tanstack/react-router', () => ({
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
}));

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, _code: string | undefined, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    api: {
      schools: { list: vi.fn(), nearby: vi.fn() },
      auth: { me: vi.fn() },
    },
    ApiError,
  };
});

const { api, ApiError } = await import('../lib/api');
const { SchoolsScreen } = await import('./SchoolsScreen');

const BOULDER = {
  did: 'did:plc:boulder',
  label: 'boulder',
  name: 'Boulder Free School',
  city: 'Boulder, CO',
  host: 'boulder.freeskool.xyz',
};
const DENVER = {
  did: 'did:plc:denver',
  label: 'denver',
  name: 'Denver Free School',
  city: 'Denver, CO',
  host: 'denver.freeskool.xyz',
};

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SchoolsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.schools.list).mockReset().mockResolvedValue({ schools: [BOULDER, DENVER] });
  vi.mocked(api.schools.nearby).mockReset().mockResolvedValue([]);
  vi.mocked(api.auth.me).mockReset().mockRejectedValue(new ApiError(401, 'Unauthorized', 'no session'));
});

describe('SchoolsScreen', () => {
  it('lists every school with its city and a link to its own host', async () => {
    renderScreen();

    expect(await screen.findByText('Boulder Free School')).toBeInTheDocument();
    expect(screen.getByText('Denver, CO')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /denver\.freeskool\.xyz/ });
    // Another school is another ORIGIN: a real link out, not a router hop.
    expect(link).toHaveAttribute('href', 'https://denver.freeskool.xyz');
  });

  it('never shows a count of anything (ruling 7)', async () => {
    renderScreen();
    await screen.findByText('Boulder Free School');

    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d+\s+(members?|people|classes)/i);
    expect(text).toMatch(/no member numbers on this page/i);
  });

  it('marks the school this host is showing, and only that one', async () => {
    vi.mocked(api.auth.me).mockResolvedValue({
      did: 'did:plc:wren',
      kind: 'custodial',
      role: 20,
      isCustodial: true,
      emailVerified: true,
      onboarded: true,
      school: { did: DENVER.did, label: DENVER.label, name: DENVER.name },
      schools: [{ ...DENVER, host: DENVER.host }],
    });
    renderScreen();

    const here = await screen.findAllByText(/you’re here/);
    expect(here).toHaveLength(1);
  });

  it('shows nearby schools from their own published records', async () => {
    vi.mocked(api.schools.nearby).mockResolvedValue([
      { did: 'did:plc:fort-collins', name: 'Fort Collins Free School', city: 'Fort Collins, CO', host: 'fc.example.org', tags: ['skillshare'] },
    ]);
    renderScreen();

    expect(await screen.findByText('Fort Collins Free School')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /fc\.example\.org/ })).toHaveAttribute('href', 'https://fc.example.org');
  });

  it('treats an AppView that does not serve /nearby yet as "none", not as an error', async () => {
    vi.mocked(api.schools.nearby).mockRejectedValue(new ApiError(404, 'NotFound', 'not found'));
    renderScreen();

    expect(await screen.findByText('No connected schools yet.')).toBeInTheDocument();
    // The schools list itself is unaffected by the missing section.
    expect(screen.getByText('Boulder Free School')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers a way back when the directory itself cannot load', async () => {
    vi.mocked(api.schools.list).mockRejectedValue(new ApiError(500, 'Oops', 'boom'));
    renderScreen();

    expect(await screen.findByText(/list of schools couldn’t load/i)).toBeInTheDocument();
    vi.mocked(api.schools.list).mockResolvedValue({ schools: [BOULDER] });
    screen.getByRole('button', { name: 'Try again' }).click();
    await waitFor(() => expect(screen.getByText('Boulder Free School')).toBeInTheDocument());
  });
});
