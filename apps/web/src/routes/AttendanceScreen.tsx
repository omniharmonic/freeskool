import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { useAttendance, useEvent, useSetAttendanceMutation } from '../lib/queries';
import type { AttendanceRow } from '../lib/types';

/**
 * `/events/$id/attendance` — the host attests who took part, for
 * `POST /api/events/:id/attendance` (`apps/appview/src/http/routes/events.ts`).
 *
 * THE GAP THIS SCREEN WORKS AROUND: R9 keeps RSVPs app-side and
 * deliberately un-enumerable (`rsvpDidsFor` in `apps/appview/src/lib/rsvp.ts`
 * is commented "INTERNAL ONLY... never serialized to a response", and no
 * route anywhere hands the host a list of who RSVP'd). There is therefore no
 * pre-populated roster to tick boxes next to — the brief's "list RSVPs with
 * check boxes" cannot be built against the real API as it stands. This
 * screen instead lets the host add each attendee by DID (which they have —
 * from meeting them, or from the school's own records) and check off
 * participation per row; `onSave` sends exactly the shape
 * `POST .../attendance` expects. A roster endpoint would make this screen
 * simpler; it does not exist yet.
 */
export function AttendanceScreen() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { data: event, isPending } = useEvent(id);
  const { data: summary } = useAttendance(id);
  const setAttendance = useSetAttendanceMutation();

  const [rows, setRows] = useState<AttendanceRow[]>([]);
  const [didDraft, setDidDraft] = useState('');
  const [roleDraft, setRoleDraft] = useState<AttendanceRow['role']>('attendee');
  const [didError, setDidError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (isPending) {
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

  const addAttendee = () => {
    const did = didDraft.trim();
    if (!did.startsWith('did:')) {
      setDidError('That doesn\'t look like a DID — it starts with "did:".');
      return;
    }
    if (rows.some((r) => r.did === did)) {
      setDidError('Already added.');
      return;
    }
    setDidError(null);
    setRows((prev) => [...prev, { did, participated: true, role: roleDraft }]);
    setDidDraft('');
    setRoleDraft('attendee');
  };

  const onSave = async () => {
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
            <div className="plate p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex-1">
                  <span className="block text-caption text-ink-soft">Attendee's DID</span>
                  <input
                    className={`mt-1.5 w-full ${field}`}
                    value={didDraft}
                    onChange={(e) => setDidDraft(e.target.value)}
                    placeholder="did:plc:…"
                  />
                </label>
                <label>
                  <span className="block text-caption text-ink-soft">Role</span>
                  <select
                    className={`mt-1.5 ${field}`}
                    value={roleDraft}
                    onChange={(e) => setRoleDraft(e.target.value as AttendanceRow['role'])}
                  >
                    <option value="attendee">Attendee</option>
                    <option value="assistant">Assistant</option>
                    <option value="co-host">Co-host</option>
                  </select>
                </label>
                <Button type="button" ink="blue" onClick={addAttendee}>
                  Add
                </Button>
              </div>
              {didError ? <p className="mt-2 text-caption text-pink">{didError}</p> : null}
            </div>

            {rows.length > 0 ? (
              <ul className="divide-y divide-rule border-[1.5px] border-ink">
                {rows.map((row, i) => (
                  <li key={row.did} className="flex items-center justify-between gap-3 px-3.5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-body">{row.did}</p>
                      <p className="text-caption text-ink-faint">{row.role}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <label className="flex items-center gap-1.5 text-caption">
                        <input
                          type="checkbox"
                          aria-label="Participated"
                          checked={row.participated ?? true}
                          onChange={(e) =>
                            setRows((prev) =>
                              prev.map((r, idx) => (idx === i ? { ...r, participated: e.target.checked } : r)),
                            )
                          }
                        />
                        Participated
                      </label>
                      <button
                        type="button"
                        className="text-caption text-ink-faint"
                        aria-label={`Remove ${row.did}`}
                        onClick={() => setRows((prev) => prev.filter((_, idx) => idx !== i))}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-caption text-ink-faint">No attendees added yet.</p>
            )}

            <Button wide ink="green" disabled={rows.length === 0} onClick={() => void onSave()}>
              Save attendance
            </Button>
          </>
        )}
      </div>
    </Screen>
  );
}
