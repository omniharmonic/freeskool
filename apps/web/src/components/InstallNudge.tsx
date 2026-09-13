import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  canRequestPush,
  clearInstallNudge,
  detectSurface,
  enableReminders,
  recordInstallNudgeShown,
  shouldShowInstallNudge,
  type Surface,
} from '../lib/ios-install';
import { Sheet } from './Sheet';
import { Button } from './bits';

type Mode = 'closed' | 'install' | 'inapp' | 'denied';

interface InstallFlow {
  surface: Surface;
  /** Call after a successful RSVP — never on first load. */
  afterRsvp: () => void;
  /** Opens the install sheet from a gated "Remind me" tap. */
  openInstallSheet: () => void;
  turnOnReminders: () => Promise<void>;
  remindersOn: boolean;
  permission: NotificationPermission | 'unsupported';
}

const Ctx = createContext<InstallFlow | null>(null);

export function useInstallFlow(): InstallFlow {
  const value = useContext(Ctx);
  if (!value) throw new Error('useInstallFlow must be used inside <InstallProvider>');
  return value;
}

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '';

export function InstallProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>('closed');
  const [surface, setSurface] = useState<Surface>('other');
  const [remindersOn, setRemindersOn] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('unsupported');
  const [showPostInstall, setShowPostInstall] = useState(false);

  useEffect(() => {
    const detected = detectSurface();
    setSurface(detected);
    if ('Notification' in window) setPermission(Notification.permission);
    if (detected === 'installed') {
      clearInstallNudge(); // installed users are never asked again
      if ('Notification' in window && Notification.permission === 'default') setShowPostInstall(true);
    }
  }, []);

  const afterRsvp = useCallback(() => {
    if (!shouldShowInstallNudge()) return;
    recordInstallNudgeShown();
    setMode(detectSurface() === 'ios-inapp' ? 'inapp' : 'install');
  }, []);

  const openInstallSheet = useCallback(() => {
    setMode(detectSurface() === 'ios-inapp' ? 'inapp' : 'install');
  }, []);

  const turnOnReminders = useCallback(async () => {
    if (!canRequestPush()) {
      openInstallSheet();
      return;
    }
    // Called straight from the tap handler: WebKit requires it.
    const sub = await enableReminders(VAPID_PUBLIC_KEY).catch(() => null);
    const next = 'Notification' in window ? Notification.permission : 'unsupported';
    setPermission(next);
    setShowPostInstall(false);
    if (sub) setRemindersOn(true);
    else if (next === 'denied') setMode('denied');
  }, [openInstallSheet]);

  const value = useMemo<InstallFlow>(
    () => ({ surface, afterRsvp, openInstallSheet, turnOnReminders, remindersOn, permission }),
    [surface, afterRsvp, openInstallSheet, turnOnReminders, remindersOn, permission],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {showPostInstall ? (
        <PostInstallBanner onTurnOn={turnOnReminders} onDismiss={() => setShowPostInstall(false)} />
      ) : null}
      <InstallSheets mode={mode} onClose={() => setMode('closed')} />
    </Ctx.Provider>
  );
}

function InstallSheets({ mode, onClose }: { mode: Mode; onClose: () => void }) {
  const [showSteps, setShowSteps] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <>
      <Sheet open={mode === 'install'} onClose={onClose} title="Get a reminder before class">
        <p className="text-body">
          iPhone only sends reminders from apps on your Home Screen. Add Free School — it takes about ten
          seconds, and it works offline.
        </p>
        {/* A genuine sequence, so it is genuinely numbered. Apple moved Add to
            Home Screen in iOS 26 and again in 27, so name the menu item, never
            an icon position. */}
        <ol className="mt-4 space-y-2.5">
          {[
            <>
              Tap the <b>⋯</b> or <b>Share</b> button in Safari's toolbar
            </>,
            <>
              Choose <b>Add to Home Screen</b>
            </>,
            <>
              Keep <b>Open as Web App</b> on, then tap <b>Add</b>
            </>,
          ].map((step, i) => (
            <li key={i} className="flex gap-3">
              <span className="stamp mt-px w-5 shrink-0 text-pink">{i + 1}</span>
              <span className="text-body">{step}</span>
            </li>
          ))}
        </ol>
        {showSteps ? (
          <div className="mt-4 space-y-2">
            {[
              "Safari's toolbar, bottom right on most iPhones",
              'The menu that opens, scrolled down a little',
              'The Add button, top right of the next screen',
            ].map((caption, i) => (
              <figure key={i} className="plate plate-blue overflow-hidden">
                <div
                  className="halftone h-20"
                  style={{ '--ht': 'var(--c-blue)' } as React.CSSProperties}
                  aria-hidden="true"
                />
                <figcaption className="px-3 py-2 text-caption text-ink-soft">
                  Frame {i + 1}. {caption}
                </figcaption>
              </figure>
            ))}
            <p className="text-caption text-ink-soft">
              Can't find it? The menu button is sometimes the three dots and sometimes the square with an
              arrow, depending on your iOS version. Either one has Add to Home Screen in it.
            </p>
          </div>
        ) : null}
        <div className="mt-5 flex gap-3 pb-1">
          <Button onClick={() => setShowSteps((v) => !v)} ink="blue">
            {showSteps ? 'Hide the frames' : 'Show me'}
          </Button>
          <Button onClick={onClose} ink="ink" variant="quiet">
            Not now
          </Button>
        </div>
      </Sheet>

      <Sheet open={mode === 'inapp'} onClose={onClose} title="Open in Safari first">
        <p className="text-body">
          You're in Instagram's browser, which can't add apps to your Home Screen. Open this page in Safari
          and we'll pick up where you left off.
        </p>
        <div className="mt-5 flex gap-3 pb-1">
          <Button
            ink="blue"
            onClick={() => {
              navigator.clipboard?.writeText(location.href).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? 'Link copied' : 'Copy link'}
          </Button>
          <Button onClick={onClose} ink="ink" variant="quiet">
            Not now
          </Button>
        </div>
      </Sheet>

      <Sheet open={mode === 'denied'} onClose={onClose} title="No reminders, no problem">
        <p className="text-body">
          You'll still see everything you RSVPed to on the Calendar tab. You can turn reminders on later in
          Settings, then Notifications, then Free School.
        </p>
        <div className="mt-5 pb-1">
          <Button onClick={onClose} ink="ink" variant="quiet">
            Got it
          </Button>
        </div>
      </Sheet>
    </>
  );
}

function PostInstallBanner({ onTurnOn, onDismiss }: { onTurnOn: () => void; onDismiss: () => void }) {
  return (
    <div
      className="app-chrome absolute inset-x-0 z-30 px-3"
      style={{ bottom: 'calc(max(10px, env(safe-area-inset-bottom, 0px)) + 64px)' }}
    >
      <div className="plate plate-pink p-3.5">
        <p className="text-body">
          Reminders are on the house. <b>Turn on reminders</b> for the classes you RSVP to.
        </p>
        <div className="mt-3 flex gap-3">
          <Button onClick={onTurnOn}>Turn on</Button>
          <Button onClick={onDismiss} ink="ink" variant="quiet">
            Maybe later
          </Button>
        </div>
      </div>
    </div>
  );
}
