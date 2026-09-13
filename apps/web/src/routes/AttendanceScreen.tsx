import { useEffect, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { useAttendance, useEvent, useEventRoster, useSetAttendanceMutation } from '../lib/queries';
import type { AttendanceRow, RosterEntry } from '../lib/types';

const STATUS_LABEL: Record<RosterEntry['status'], string> = {
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
  const { data: roster, isPending: rosterPending } = useEventRoster(id);
  const setAttendance = useSetAttendanceMutation();

  // did -> whether the host has ticked "participated" for that roster row.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [initialized, setInitialized] = useState(false);

  const [extra, setExtra] = useState<AttendanceRow[]>([]);
  const [didDraft, setDidDraft] = useState('');
  const [didError, setDidError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Pre-populate once, from the real roster: checked for 'going', unchecked
  // (but still tickable) for 'interested'/'waitlisted'.
  useEffect(() => {
    if (initialized || !roster) return;
    const next: Record<string, boolean> = {};
    for (const r of roster) next[r.did] = r.status === 'going';
    setChecked(next);
    setInitialized(true);
  }, [roster, initialized]);

  if (isPending || rosterPending) {
    return (
      <Screen title="Loading…" back>
        <div className="safe-x" />
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

  const rosterRows = roster ?? [];

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
    await setAttendance.mutateAsync({ eventId: id, rows });
    setSaved(true);
  };

  const field = 'border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2';

  return (
    <Screen title={event.name} standfirst="Check off who took part. Counts only — never a public roster." back>
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
              <ul className="divide-y divide-rule border-[1.5px] border-ink">
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
              <ul className="divide-y divide-rule border-[1.5px] border-ink">
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

            <Button
              wide
              ink="green"
              disabled={rosterRows.length === 0 && extra.length === 0}
              onClick={() => void onSave()}
            >
              Save attendance
            </Button>
          </>
        )}
      </div>
    </Screen>
  );
}
