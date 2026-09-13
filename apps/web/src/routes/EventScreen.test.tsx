import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const EVENT_URI = 'at://did:plc:host1/community.lexicon.calendar.event/abc123';

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
  useParams: vi.fn(() => ({ id: EVENT_URI })),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
  Link: ({
    to,
    params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children?: ReactNode;
  }) => {
    const href = params ? Object.entries(params).reduce((acc, [k, v]) => acc.replace(`$${k}`, v), to) : to;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  Navigate: () => null,
}));

vi.mock('../components/InstallNudge', () => ({
  useInstallFlow: vi.fn(() => ({
    surface: 'installed',
    afterRsvp: vi.fn(),
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
      events: {
        get: vi.fn(),
        icsHref: (id: string) => `/api/events/${encodeURIComponent(id)}.ics`,
      },
      auth: { me: vi.fn() },
      rsvp: { get: vi.fn(), set: vi.fn(), clear: vi.fn() },
      invites: { mint: vi.fn() },
      push: { vapidKey: vi.fn(), subscribe: vi.fn() },
    },
    ApiError,
  };
});

const { useInstallFlow } = await import('../components/InstallNudge');
const { api } = await import('../lib/api');
const { EventScreen } = await import('./EventScreen');

const baseEvent = {
  uri: EVENT_URI,
  name: 'Sourdough basics',
  startsAt: '2026-09-17T18:30:00-06:00',
  endsAt: '2026-09-17T20:00:00-06:00',
  locationRedacted: true,
  venueNeeded: false,
  tags: ['skillshare'],
  origin: 'ours' as const,
  listed: true,
  skills: [],
  materials: [],
  rsvps: { going: 2, interested: 1 },
  viewerRelation: 'public' as const,
};

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <EventScreen />
    </QueryClientProvider>,
  );
}

describe('EventScreen', () => {
  beforeEach(() => {
    vi.mocked(useInstallFlow).mockReturnValue({
      surface: 'installed',
      afterRsvp: vi.fn(),
      openInstallSheet: vi.fn(),
      // extra fields `EventScreen` does not read, kept for interface shape
      turnOnReminders: vi.fn(),
      remindersOn: false,
      permission: 'default',
    });
    vi.mocked(api.events.get).mockReset().mockResolvedValue(baseEvent);
    vi.mocked(api.auth.me).mockReset().mockResolvedValue({
      did: 'did:plc:viewer1',
      kind: 'custodial',
      role: 1,
      isCustodial: true,
      emailVerified: true,
    });
    vi.mocked(api.rsvp.get).mockReset().mockResolvedValue({ rsvp: null, counts: { going: 2, interested: 1 } });
    vi.mocked(api.rsvp.set)
      .mockReset()
      .mockResolvedValue({ ok: true, status: 'going', alsoPublicRecord: false, counts: { going: 3, interested: 1 } });
    vi.mocked(api.rsvp.clear).mockReset().mockResolvedValue({ ok: true, counts: { going: 1, interested: 1 } });
  });

  it('hides the exact address when the viewer has not RSVP\'d (locationRedacted: true)', async () => {
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Sourdough basics' })).toBeInTheDocument();
    expect(screen.queryByText('Sanitas Kitchen')).not.toBeInTheDocument();
  });

  it('shows the exact address once viewerRelation says RSVP\'d (locationRedacted: false)', async () => {
    vi.mocked(api.events.get).mockResolvedValue({
      ...baseEvent,
      locationRedacted: false,
      hostDid: 'did:plc:host1',
      locations: [{ name: 'Sanitas Kitchen', street: '123 Main St', locality: 'Boulder' }],
      viewerRelation: 'rsvp',
    });
    renderScreen();
    expect(await screen.findByText(/Sanitas Kitchen/)).toBeInTheDocument();
    expect(screen.getByText(/123 Main St/)).toBeInTheDocument();
  });

  it('calls the RSVP mutation with alsoPublicRecord: true only after the permanence warning is accepted', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.click(await screen.findByRole('switch', { name: /also publish my rsvp publicly/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, make it public/i }));
    fireEvent.click(screen.getByRole('button', { name: /i'll be there/i }));

    await waitFor(() =>
      expect(api.rsvp.set).toHaveBeenCalledWith(EVENT_URI, { status: 'going', alsoPublicRecord: true }),
    );
  });

  it('never sends alsoPublicRecord: true when the warning sheet is dismissed instead of accepted', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.click(await screen.findByRole('switch', { name: /also publish my rsvp publicly/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: /i'll be there/i }));

    await waitFor(() =>
      expect(api.rsvp.set).toHaveBeenCalledWith(EVENT_URI, { status: 'going', alsoPublicRecord: false }),
    );
  });

  it('does not resend alsoPublicRecord: true on a later RSVP after clearing, without re-accepting the warning', async () => {
    vi.mocked(api.rsvp.get)
      .mockReset()
      .mockResolvedValueOnce({ rsvp: null, counts: { going: 2, interested: 1 } }) // initial mount
      .mockResolvedValueOnce({ rsvp: { status: 'going', alsoPublicRecord: true }, counts: { going: 3, interested: 1 } }) // after the first RSVP
      .mockResolvedValue({ rsvp: null, counts: { going: 2, interested: 1 } }); // after clearing, and from then on

    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.click(await screen.findByRole('switch', { name: /also publish my rsvp publicly/i }));
    fireEvent.click(await screen.findByRole('button', { name: /yes, make it public/i }));
    fireEvent.click(screen.getByRole('button', { name: /i'll be there/i }));
    await waitFor(() =>
      expect(api.rsvp.set).toHaveBeenCalledWith(EVENT_URI, { status: 'going', alsoPublicRecord: true }),
    );

    // Tapping the now-active "going" button clears the RSVP.
    fireEvent.click(await screen.findByRole('button', { name: /you're going/i }));
    await waitFor(() => expect(api.rsvp.clear).toHaveBeenCalledWith(EVENT_URI));

    // The toggle must visibly fall back to off once the clear is reflected —
    // carrying the old consent forward would be invisible AND wrong.
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: /also publish my rsvp publicly/i })).toHaveAttribute(
        'aria-checked',
        'false',
      ),
    );

    // RSVP again, without touching the toggle or the warning sheet at all.
    fireEvent.click(screen.getByRole('button', { name: /i'll be there/i }));

    await waitFor(() =>
      expect(api.rsvp.set).toHaveBeenLastCalledWith(EVENT_URI, { status: 'going', alsoPublicRecord: false }),
    );
  });

  it('shows a "Listed from another school" marker when the event is peer-routed, not hosted here', async () => {
    vi.mocked(api.events.get).mockResolvedValue({ ...baseEvent, origin: 'listed' });
    renderScreen();
    expect(await screen.findByText('Listed from another school')).toBeInTheDocument();
  });

  it('shows "Leave feedback" for a past class the viewer attended, and not otherwise', async () => {
    vi.mocked(api.events.get).mockResolvedValue({
      ...baseEvent,
      startsAt: '2020-01-01T18:30:00-06:00',
      endsAt: '2020-01-01T20:00:00-06:00',
      viewerRelation: 'attendee',
    });
    renderScreen();
    expect(await screen.findByRole('link', { name: /leave feedback/i })).toHaveAttribute(
      'href',
      `/events/${EVENT_URI}/feedback`,
    );
  });

  it('hides "Leave feedback" for an attendee of a class that has not happened yet', async () => {
    vi.mocked(api.events.get).mockResolvedValue({ ...baseEvent, viewerRelation: 'attendee' });
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    expect(screen.queryByRole('link', { name: /leave feedback/i })).not.toBeInTheDocument();
  });

  it('shows "See feedback summary" for the host', async () => {
    vi.mocked(api.events.get).mockResolvedValue({ ...baseEvent, viewerRelation: 'host' });
    renderScreen();
    expect(await screen.findByRole('link', { name: /see feedback summary/i })).toHaveAttribute(
      'href',
      `/events/${EVENT_URI}/feedback-summary`,
    );
  });

  it('shows no origin marker for a class hosted at this school', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    expect(screen.queryByText('Listed from another school')).not.toBeInTheDocument();
  });

  it('gates "Remind me" on install state: not installed opens the install sheet instead of requesting push', async () => {
    vi.mocked(useInstallFlow).mockReturnValue({
      surface: 'ios-safari',
      afterRsvp: vi.fn(),
      openInstallSheet: vi.fn(),
      turnOnReminders: vi.fn(),
      remindersOn: false,
      permission: 'default',
    });
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.click(await screen.findByRole('button', { name: /remind me/i }));

    expect(vi.mocked(useInstallFlow).mock.results.at(-1)?.value.openInstallSheet).toHaveBeenCalled();
    expect(api.push.vapidKey).not.toHaveBeenCalled();
  });

  it('when installed, "Remind me" requests permission and subscribes via api.push', async () => {
    const originalNotification = (globalThis as { Notification?: unknown }).Notification;
    const requestPermission = vi.fn().mockResolvedValue('granted');
    (globalThis as { Notification?: unknown }).Notification = { requestPermission, permission: 'default' };
    // jsdom has no PushManager; `onRemindMe`'s feature check just needs the name to exist.
    vi.stubGlobal('PushManager', class {});
    const subscribe = vi.fn().mockResolvedValue({
      endpoint: 'https://push.example/abc',
      toJSON: () => ({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p256', auth: 'auth' } }),
    });
    Object.defineProperty(globalThis.navigator, 'serviceWorker', {
      value: { ready: Promise.resolve({ pushManager: { subscribe } }) },
      configurable: true,
    });
    vi.mocked(api.push.vapidKey).mockResolvedValue({ key: 'vapid-key' });
    vi.mocked(api.push.subscribe).mockResolvedValue({ id: 'sub1', categories: [] });

    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    fireEvent.click(await screen.findByRole('button', { name: /remind me/i }));

    await waitFor(() =>
      expect(api.push.subscribe).toHaveBeenCalledWith({
        endpoint: 'https://push.example/abc',
        keys: { p256dh: 'p256', auth: 'auth' },
      }),
    );
    expect(api.push.vapidKey).toHaveBeenCalled();
    expect(requestPermission).toHaveBeenCalled();

    if (originalNotification) (globalThis as { Notification?: unknown }).Notification = originalNotification;
  });

  it('shows materials and the supplies note when the host set them', async () => {
    vi.mocked(api.events.get).mockResolvedValue({
      ...baseEvent,
      materials: ['A mixing bowl', 'A scale'],
      suppliesNote: 'Flour provided.',
    });
    renderScreen();
    expect(await screen.findByText('What to bring')).toBeInTheDocument();
    expect(screen.getByText('A mixing bowl')).toBeInTheDocument();
    expect(screen.getByText('A scale')).toBeInTheDocument();
    expect(screen.getByText('Flour provided.')).toBeInTheDocument();
  });

  it('omits the "What to bring" section when there are no materials and no supplies note', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    expect(screen.queryByText('What to bring')).not.toBeInTheDocument();
  });

  it('shows the waitlist position and an "on the waitlist" button state', async () => {
    vi.mocked(api.rsvp.get).mockResolvedValue({
      rsvp: { status: 'waitlisted', alsoPublicRecord: false, waitlistPosition: 3 },
      counts: { going: 2, interested: 1 },
    });
    renderScreen();
    expect(await screen.findByRole('button', { name: "You're on the waitlist" })).toBeInTheDocument();
    expect(screen.getByText(/you're #3 on the waitlist/i)).toBeInTheDocument();
  });

  it('tapping the waitlisted button clears the RSVP (leaving the waitlist)', async () => {
    vi.mocked(api.rsvp.get).mockResolvedValue({
      rsvp: { status: 'waitlisted', alsoPublicRecord: false, waitlistPosition: 3 },
      counts: { going: 2, interested: 1 },
    });
    renderScreen();
    fireEvent.click(await screen.findByRole('button', { name: "You're on the waitlist" }));
    await waitFor(() => expect(api.rsvp.clear).toHaveBeenCalledWith(EVENT_URI));
  });
});
