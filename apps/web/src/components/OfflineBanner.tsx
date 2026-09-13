import { useEffect, useState } from 'react';

/**
 * The calendar is cached for 30 days, so offline is a degraded state rather
 * than a broken one — the banner says which.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && !navigator.onLine);

  useEffect(() => {
    const online = () => setOffline(false);
    const down = () => setOffline(true);
    window.addEventListener('online', online);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      className="app-chrome absolute inset-x-0 z-30 border-b-[1.5px] border-ink px-4 py-1.5 text-center text-caption font-medium"
      style={{
        top: 'calc(max(12px, env(safe-area-inset-top)) + 46px)',
        background: 'var(--c-amber)',
        color: '#1a1405',
      }}
    >
      No connection. Showing the classes saved on this phone.
    </div>
  );
}
