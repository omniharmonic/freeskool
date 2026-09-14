/**
 * THE SCHOOL PICKER (MS §3).
 *
 * Renders only when the member belongs to MORE THAN ONE school. One school is not a
 * choice, and a control that offers a choice of one teaches people the app is bigger and
 * more confusing than it is.
 *
 * Switching is a NAVIGATION, not a re-render: every city is its own origin
 * (`denver.freeskool.xyz`), so the button tells the AppView to move the session
 * (`POST /api/auth/switch-school`, which is what makes the apex agree too) and then sends
 * the browser to the host the server names. We never build that host ourselves — the
 * server knows which `fs_school_domain` row is canonical, and a client guessing
 * `<label>.<suffix>` would be wrong the day a city brings its own domain.
 *
 * Privacy (R9/MS §10.1): the list is the member's OWN membership, served only to them by
 * `GET /api/auth/me`. It names no other member and no other school's contents. It is the
 * single place in the PWA where two schools appear on one screen.
 */
import { useEffect, useRef, useState } from 'react';
import type { AuthMe, ViewerSchool } from '../lib/types';
import { useSwitchSchoolMutation } from '../lib/queries';

export function SchoolSwitcher({ me }: { me: AuthMe | undefined }) {
  const schools = me?.schools ?? [];
  const currentDid = me?.school?.did;
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const switchSchool = useSwitchSchoolMutation();
  const wrap = useRef<HTMLDivElement>(null);

  // A menu that stays open behind the rest of the screen is a menu people tap by accident.
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (schools.length < 2) return null;

  const current = schools.find((s) => s.did === currentDid);

  async function choose(school: ViewerSchool) {
    setError(null);
    if (school.did === currentDid) {
      setOpen(false);
      return;
    }
    try {
      const result = await switchSchool.mutateAsync(school.did);
      const host = result.host || school.host;
      if (!host) {
        setError('That school has no address yet.');
        return;
      }
      // A full navigation on purpose: the new origin loads its own app, its own service
      // worker scope and its own cache. `assign`, not `replace`, so Back still works.
      window.location.assign(`${window.location.protocol}//${host}/`);
    } catch {
      setError('Could not switch schools. Try again.');
    }
  }

  return (
    <div className="school-switcher" ref={wrap}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        className="display text-caption font-bold text-blue"
        onClick={() => setOpen((v) => !v)}
      >
        {current?.name ?? 'Switch school'} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul className="school-switcher-menu" role="listbox" aria-label="Your schools">
          {schools.map((school) => (
            <li key={school.did}>
              <button
                type="button"
                role="option"
                aria-selected={school.did === currentDid}
                disabled={switchSchool.isPending}
                onClick={() => void choose(school)}
              >
                {school.name}
                {school.did === currentDid ? <span className="text-caption"> · here</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-pink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
