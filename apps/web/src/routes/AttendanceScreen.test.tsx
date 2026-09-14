import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const EVENT_URI = 'at://did:plc:host1/community.lexicon.calendar.event/abc123';
const GOING_DID = 'did:plc:attendee1';
const INTERESTED_DID = 'did:plc:attendee2';
const MANUAL_DID = 'did:plc:walkin1';
const WALKIN_DID = 'did:plc:walkin2';

const directory = [
  {
    did: WALKIN_DID,
    handle: 'rowan.fs.boulder',
    displayName: 'Rowan Ash',
    role: 20,
    roleLabel: 'Member',
    claimCount: 1,
    vouchCount: 0,
    lastSeenAt: '2026-09-10T00:00:00Z',
  },
  {
    did: 'did:plc:walkin3',
    handle: 'juniper.fs.boulder',
    role: 20,
    roleLabel: 'Member',
    claimCount: 0,
    vouchCount: 0,
    lastSeenAt: '2026-09-09T00:00:00Z',
  },
];

vi.mock('@tanstack/react-router', () => ({
  useParams: vi.fn(() => ({ id: EVENT_URI })),
  useRouter: vi.fn(() => ({ history: { back: vi.fn() } })),
}));

vi.mock('../lib/api', () => {
  return {
    api: {
      events: { get: vi.fn(), roster: vi.fn() },
      attendance: { list: vi.fn(), set: vi.fn() },
      members: { list: vi.fn() },
    },
  };
});

const { api } = await import('../lib/api');
const { AttendanceScreen } = await import('./AttendanceScreen');

const hostEvent = {
  uri: EVENT_URI,
  name: 'Sourdough basics',
  startsAt: '2026-09-17T18:30:00-06:00',
  locationRedacted: false,
  hostDid: 'did:plc:host1',
  venueNeeded: false,
  tags: [],
  listed: true,
  skills: [],
  materials: [],
  rsvps: { going: 2, interested: 1 },
  viewerRelation: 'host' as const,
};

const roster = [
  { did: GOING_DID, handle: 'goer.fs.boulder', displayName: 'Goer', status: 'going' as const, createdAt: '2026-09-01T00:00:00Z' },
  {
    did: INTERESTED_DID,
    handle: 'curious.fs.boulder',
    status: 'interested' as const,
    createdAt: '2026-09-02T00:00:00Z',
  },
];

function renderScreen() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <AttendanceScreen />
    </QueryClientProvider>,
  );
}

describe('AttendanceScreen', () => {
  beforeEach(() => {
    vi.mocked(api.events.get).mockReset().mockResolvedValue(hostEvent);
    vi.mocked(api.events.roster).mockReset().mockResolvedValue(roster);
    vi.mocked(api.attendance.list).mockReset().mockResolvedValue({ total: 0, participated: 0, collapsed: false });
    vi.mocked(api.attendance.set).mockReset().mockResolvedValue({ ok: true, recorded: 1 });
    vi.mocked(api.members.list).mockReset().mockResolvedValue({ members: directory });
  });

  it('refuses a non-host viewer', async () => {
    vi.mocked(api.events.get).mockResolvedValue({ ...hostEvent, viewerRelation: 'rsvp' });
    renderScreen();
    expect(await screen.findByText(/only the host of a class may check off attendance/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('pre-populates the roster, checked by default only for "going"', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    expect(screen.getByText('Goer')).toBeInTheDocument();
    expect(screen.getByText('going')).toBeInTheDocument();
    expect(screen.getByText('curious.fs.boulder')).toBeInTheDocument();
    expect(screen.getByText('interested')).toBeInTheDocument();

    expect(screen.getByRole('checkbox', { name: /goer participated/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /curious.fs.boulder participated/i })).not.toBeChecked();
  });

  it('saves the roster as attendance rows, reflecting an unchecked box and a re-checked one', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    // The host unchecks the "going" attendee who did not actually show up...
    fireEvent.click(screen.getByRole('checkbox', { name: /goer participated/i }));
    // ...and checks the "interested" one who did.
    fireEvent.click(screen.getByRole('checkbox', { name: /curious.fs.boulder participated/i }));

    fireEvent.click(screen.getByRole('button', { name: /save attendance/i }));

    await waitFor(() =>
      expect(api.attendance.set).toHaveBeenCalledWith(EVENT_URI, [
        { did: GOING_DID, participated: false, role: 'attendee' },
        { did: INTERESTED_DID, participated: true, role: 'attendee' },
      ]),
    );
    expect(await screen.findByText(/thanks — counts updated\. feedback opens for attendees now\./i)).toBeInTheDocument();
  });

  it('adds a walk-in the host picks out of the member list, by name', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'rowan' } });
    fireEvent.click(await screen.findByRole('button', { name: /Rowan Ash/ }));

    // Named in the added list, never as a raw DID.
    expect(await screen.findByText('Rowan Ash')).toBeInTheDocument();
    expect(screen.queryByText(WALKIN_DID)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save attendance/i }));

    await waitFor(() =>
      expect(api.attendance.set).toHaveBeenCalledWith(EVENT_URI, [
        { did: GOING_DID, participated: true, role: 'attendee' },
        { did: INTERESTED_DID, participated: false, role: 'attendee' },
        { did: WALKIN_DID, participated: true, role: 'attendee' },
      ]),
    );
  });

  it('finds a member by their handle, and asks the server for the typed term', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.change(screen.getByLabelText('Search members'), { target: { value: 'juniper' } });

    expect(await screen.findByRole('button', { name: /juniper\.fs\.boulder/ })).toBeInTheDocument();
    // The debounce has to land before the typed term narrows the list.
    await waitFor(() => expect(screen.queryByRole('button', { name: /Rowan Ash/ })).not.toBeInTheDocument());
    await waitFor(() => expect(api.members.list).toHaveBeenCalledWith({ q: 'juniper' }));
  });

  it('never offers somebody who is already on the list', async () => {
    vi.mocked(api.members.list).mockResolvedValue({
      members: [
        { ...directory[0]!, did: GOING_DID, displayName: 'Goer', handle: 'goer.fs.boulder' },
        directory[1]!,
      ],
    });
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    expect(await screen.findByRole('button', { name: /juniper\.fs\.boulder/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Goer/ })).not.toBeInTheDocument();
  });

  it('adds someone who came without RSVPing, alongside the roster, on save', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.change(screen.getByLabelText(/their did/i), { target: { value: MANUAL_DID } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(await screen.findByText(MANUAL_DID)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save attendance/i }));

    await waitFor(() =>
      expect(api.attendance.set).toHaveBeenCalledWith(EVENT_URI, [
        { did: GOING_DID, participated: true, role: 'attendee' },
        { did: INTERESTED_DID, participated: false, role: 'attendee' },
        { did: MANUAL_DID, participated: true, role: 'attendee' },
      ]),
    );
  });

  it('rejects a manually-added identifier that does not start with "did:"', async () => {
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    fireEvent.change(screen.getByLabelText(/their did/i), { target: { value: 'not-a-did' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(screen.getByText(/starts with "did:"/i)).toBeInTheDocument();
    expect(screen.queryByText('not-a-did')).not.toBeInTheDocument();
  });

  it('shows a plain message and no save button when nobody RSVP\'d', async () => {
    vi.mocked(api.events.roster).mockResolvedValue([]);
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    expect(screen.getByText("Nobody RSVP'd to this class.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save attendance/i })).toBeDisabled();
  });

  it('never pre-lists a "notgoing" row: only the other roster rows render, and only they are saved', async () => {
    const DECLINED_DID = 'did:plc:declined1';
    vi.mocked(api.events.roster).mockResolvedValue([
      ...roster,
      { did: DECLINED_DID, handle: 'declined.fs.boulder', status: 'notgoing' as const, createdAt: '2026-09-03T00:00:00Z' },
    ]);
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });

    expect(screen.getByText('Goer')).toBeInTheDocument();
    expect(screen.getByText('curious.fs.boulder')).toBeInTheDocument();
    expect(screen.queryByText('declined.fs.boulder')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /save attendance/i }));

    await waitFor(() =>
      expect(api.attendance.set).toHaveBeenCalledWith(EVENT_URI, [
        { did: GOING_DID, participated: true, role: 'attendee' },
        { did: INTERESTED_DID, participated: false, role: 'attendee' },
      ]),
    );
  });

  it('shows a distinct message when the roster fetch itself fails', async () => {
    vi.mocked(api.events.roster).mockRejectedValue(new Error('network error'));
    renderScreen();
    await screen.findByRole('heading', { name: 'Sourdough basics' });
    expect(await screen.findByText("Couldn't load the RSVP list.")).toBeInTheDocument();
    expect(screen.queryByText("Nobody RSVP'd to this class.")).not.toBeInTheDocument();
  });
  it('keeps selections and offers recovery when saving attendance fails', async () => {
    vi.mocked(api.attendance.set).mockRejectedValueOnce(new Error('offline'));
    renderScreen();
    const going = await screen.findByRole('checkbox', { name: /goer participated/i });
    fireEvent.click(going);
    fireEvent.click(screen.getByRole('button', { name: 'Save attendance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your selections are still here');
    expect(going).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Save attendance' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save attendance' }));
    expect(await screen.findByText(/counts updated/i)).toBeInTheDocument();
  });

});
