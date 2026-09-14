import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/api', () => ({
  api: { auth: { switchSchool: vi.fn() } },
  ApiError: class ApiError extends Error {},
}));

const { api } = await import('../lib/api');
const { SchoolSwitcher } = await import('./SchoolSwitcher');
import type { AuthMe, ViewerSchool } from '../lib/types';

const BOULDER: ViewerSchool = {
  did: 'did:plc:boulder',
  label: 'boulder',
  name: 'Boulder Free School',
  host: 'boulder.freeskool.xyz',
};
const DENVER: ViewerSchool = {
  did: 'did:plc:denver',
  label: 'denver',
  name: 'Denver Free School',
  host: 'denver.freeskool.xyz',
};

function me(schools: ViewerSchool[], here = schools[0]): AuthMe {
  return {
    did: 'did:plc:mira',
    kind: 'custodial',
    role: 2,
    isCustodial: true,
    emailVerified: true,
    onboarded: true,
    school: here ? { did: here.did, label: here.label, name: here.name } : undefined,
    schools,
  };
}

function renderSwitcher(viewer: AuthMe | undefined) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SchoolSwitcher me={viewer} />
    </QueryClientProvider>,
  );
}

/** `window.location.assign` is not implemented in jsdom; this is what the switch does. */
const assign = vi.fn();

beforeEach(() => {
  vi.mocked(api.auth.switchSchool).mockReset();
  assign.mockReset();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { protocol: 'https:', assign },
  });
});

describe('SchoolSwitcher', () => {
  it('renders nothing for a member of one school: one school is not a choice', () => {
    const { container } = renderSwitcher(me([BOULDER]));
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when nobody is signed in', () => {
    const { container } = renderSwitcher(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('names the school this host is showing, and offers the others', () => {
    renderSwitcher(me([BOULDER, DENVER], DENVER));
    expect(screen.getByRole('button', { name: /Denver Free School/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Denver Free School/ }));
    const options = screen.getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Boulder Free School', 'Denver Free School · here']);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('moves the session, then NAVIGATES to the host the server named', async () => {
    vi.mocked(api.auth.switchSchool).mockResolvedValue({
      school: { did: DENVER.did, label: DENVER.label, name: DENVER.name },
      host: 'denver.example.org',
    });
    renderSwitcher(me([BOULDER, DENVER]));

    fireEvent.click(screen.getByRole('button', { name: /Boulder Free School/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Denver Free School' }));

    await waitFor(() => expect(api.auth.switchSchool).toHaveBeenCalledWith(DENVER.did));
    // The SERVER's host, not the one the client already had: only it knows which
    // `fs_school_domain` row is canonical, and a city may bring its own domain.
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://denver.example.org/'));
  });

  it('does not navigate when the member picks the school they are already in', async () => {
    renderSwitcher(me([BOULDER, DENVER]));
    fireEvent.click(screen.getByRole('button', { name: /Boulder Free School/ }));
    fireEvent.click(screen.getByRole('option', { name: /Boulder Free School/ }));

    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(api.auth.switchSchool).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it('says so and stays put when the switch is refused', async () => {
    vi.mocked(api.auth.switchSchool).mockRejectedValue(new Error('403'));
    renderSwitcher(me([BOULDER, DENVER]));

    fireEvent.click(screen.getByRole('button', { name: /Boulder Free School/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Denver Free School' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not switch schools'));
    expect(assign).not.toHaveBeenCalled();
  });
});
