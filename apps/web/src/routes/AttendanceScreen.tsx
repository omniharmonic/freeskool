import { LoadingState } from '../components/PageState';
import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { useAttendance, useEvent, useEventRoster, useSetAttendanceMutation } from '../lib/queries';
import type { AttendanceRow, RosterEntry } from '../lib/types';

const STATUS_LABEL: Record<Exclude<RosterEntry['status'], 'notgoing'>, string> = {
  going: 'going',
  interested: 'interested',
  waitlisted: 'waitlisted',
};

/**
 * `/events/$id/attendance` — the host attests who took part, for
 * `POST /api/events/:id/attendance` (`apps/appview/src/http/routes/events.ts`).
 *
 * Task 10 wiring for Task 12's roster route: `GET /api/events/:id/rsvps`
 * (host-or-steward only) now exists, so this screen pre-populates checkboxes
 * from the real roster instead of making the host type in each DID by hand.
 * A roster row's checkbox defaults to checked only for `status: 'going'` —
 * `interested`/`waitlisted` default unchecked but stay tickable, since
 * someone who merely expressed interest may still have shown up.
 *
 * The roster route returns EVERY row for the event, including `'notgoing'`
 * (`apps/appview/src/lib/rsvp.ts:189-196`'s `rsvpRoster` has no status
 * filter) — a member who explicitly declined has no business being
 * pre-listed for attendance, so those rows are filtered out entirely below,
 * never rendered as an unchecked checkbox.
 *
 * "Add someone who came without RSVPing" still takes a DID, not a handle:
 * `POST .../attendance`'s body (`attendanceBody` in
 * `apps/appview/src/http/routes/events.ts`) validates `did: z.string().
 * startsWith('did:')`, and there is no public handle→DID resolution route
 * for the client to call. See the Task 10 report for this deviation from
 * the brief's "handle field" wording.
 */
export function AttendanceScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: event, isPending } = useEvent(id);
  const { data: summary } = useAttendance(id);
  const { data: roster, isPending: rosterPending, isError: rosterError } = useEventRoster(id);
  const setAttendance = useSetAttendanceMutation();

  // did -> whether the host has ticked "participated" for that roster row.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [initialized, setInitialized] = useState(false);

  const [extra, setExtra] = useState<AttendanceRow[]>([]);
  const [didDraft, setDidDraft] = useState('');
  const [didError, setDidError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Never pre-list a 'notgoing' row at all — filtered out before anything
  // else touches the roster (the pre-populate effect below, the checklist,
  // and `onSave`'s submitted rows all read from this, never `roster` itself).
  // The type predicate narrows `status` so `STATUS_LABEL[r.status]` below
  // type-checks without `'notgoing'` needing an (unreachable) entry there.
  const rosterRows = (roster ?? []).filter(
    (r): r is RosterEntry & { status: Exclude<RosterEntry['status'], 'notgoing'> } => r.status !== 'notgoing',
  );

  // Pre-populate once, from the real roster: checked for 'going', unchecked
  // (but still tickable) for 'interested'/'waitlisted'.
  useEffect(() => {
    if (initialized || !roster) return;
    const next: Record<string, boolean> = {};
    for (const r of rosterRows) next[r.did] = r.status === 'going';
    setChecked(next);
    setInitialized(true);
    // `rosterRows` is derived fresh from `roster` every render, so depending
    // on `roster` alone (not `rosterRows`) is enough to re-run exactly when
    // the underlying data actually changes.
  }, [roster, initialized]);

  if (isPending || rosterPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x"><LoadingState label="Opening the attendance list…" /></div>
      </Screen>
    );
  }

  if (!event || event.viewerRelation !== 'host') {
    return (
      <Screen title="Attendance" back>
        <div className="safe-x">
          <p className="text-body text-ink-soft">Only the host of a class may check off attendance.</p>
        </div>
      </Screen>
    );
  }

  const addExtra = () => {
    const did = didDraft.trim();
    if (!did.startsWith('did:')) {
      setDidError('That doesn\'t look like a DID — it starts with "did:".');
      return;
    }
    if (rosterRows.some((r) => r.did === did) || extra.some((r) => r.did === did)) {
      setDidError('Already added.');
      return;
    }
    setDidError(null);
    setExtra((prev) => [...prev, { did, participated: true, role: 'attendee' }]);
    setDidDraft('');
  };

  const onSave = async () => {
    const fromRoster: AttendanceRow[] = rosterRows.map((r) => ({
      did: r.did,
      participated: Boolean(checked[r.did]),
      role: 'attendee',
    }));
    const rows = [...fromRoster, ...extra];
    if (rows.length === 0) return;
    setSaveError(null);
    try { await setAttendance.mutateAsync({ eventId: id, rows }); setSaved(true); }
    catch { setSaveError('Could not save attendance. Your selections are still here. Try again.'); }
  };

  const field = 'border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2';

  return (
    <Screen layout="form" title={event.name} standfirst="Check off who took part. Counts only — never a public roster." back>
      <div className="safe-x space-y-5">
        {summary ? (
          <p className="text-caption text-ink-soft">
            {summary.total} attested so far{summary.collapsed ? ' (older classes have been rolled up)' : ''}.
          </p>
        ) : null}

        {saved ? (
          <div className="plate plate-green p-4">
            <p className="text-body">Thanks — counts updated. Feedback opens for attendees now.</p>
          </div>
        ) : (
          <>
            {rosterRows.length > 0 ? (
              <ul className="attendance-list divide-y divide-rule">
                {rosterRows.map((r) => (
                  <li key={r.did} className="flex items-center justify-between gap-3 px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-body">{r.displayName ?? r.handle}</p>
                      <p className="text-caption text-ink-faint">{STATUS_LABEL[r.status]}</p>
                    </div>
                    <label className="flex shrink-0 items-center gap-1.5 text-caption">
                      <input
                        type="checkbox"
                        aria-label={`${r.displayName ?? r.handle} participated`}
                        checked={checked[r.did] ?? false}
                        onChange={(e) => setChecked((prev) => ({ ...prev, [r.did]: e.target.checked }))}
                      />
                      Participated
                    </label>
                  </li>
                ))}
              </ul>
            ) : rosterError ? (
              <p className="text-caption text-ink-faint">Couldn't load the RSVP list.</p>
            ) : (
              <p className="text-caption text-ink-faint">Nobody RSVP'd to this class.</p>
            )}

            <div className="plate p-4">
              <p className="text-caption text-ink-soft">Add someone who came without RSVPing</p>
              <div className="mt-1.5 flex flex-wrap items-end gap-3">
                <label className="flex-1">
                  <span className="block text-caption text-ink-soft">Their DID</span>
                  <input
                    className={`mt-1.5 w-full ${field}`}
                    value={didDraft}
                    onChange={(e) => setDidDraft(e.target.value)}
                    placeholder="did:plc:…"
                  />
                </label>
                <Button type="button" ink="blue" onClick={addExtra}>
                  Add
                </Button>
              </div>
              {didError ? <p className="mt-2 text-caption text-pink">{didError}</p> : null}
            </div>

            {extra.length > 0 ? (
              <ul className="attendance-list divide-y divide-rule">
                {extra.map((row, i) => (
                  <li key={row.did} className="flex items-center justify-between gap-3 px-3.5 py-3">
                    <p className="truncate text-body">{row.did}</p>
                    <button
                      type="button"
                      className="shrink-0 text-caption text-ink-faint"
                      aria-label={`Remove ${row.did}`}
                      onClick={() => setExtra((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {saveError ? <p role="alert">{saveError}</p> : null}
            <Button
              wide
              ink="green"
              disabled={setAttendance.isPending || (rosterRows.length === 0 && extra.length === 0)}
              onClick={() => void onSave()}
            >
              {setAttendance.isPending ? 'Saving…' : 'Save attendance'}
            </Button>
          </>
        )}
      </div>
    </Screen>
  );
}
