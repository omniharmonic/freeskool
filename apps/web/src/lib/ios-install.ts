// src/lib/ios-install.ts
// Detection for the iOS install nudge. Verified against Safari 26.6 (iOS 26.6), 2026-09-12.
// Copied from docs research R8 (“Detection (TypeScript)”) — do not re-derive.

export type Surface =
  | 'installed'        // running as a Home Screen web app — push is available
  | 'ios-safari'       // real Safari on iOS — can install
  | 'ios-inapp'        // Instagram/FB/Telegram/etc. webview — cannot install
  | 'ios-other-browser'// Chrome/Edge/Firefox on iOS — can install, worse flow
  | 'other';           // not iOS

interface SafariNavigator extends Navigator {
  /** Non-standard, WebKit-only. true in a Home Screen web app. */
  standalone?: boolean;
}

/**
 * True when launched from the Home Screen (iOS) or any standalone display mode.
 *
 * IMPORTANT iOS QUIRK: `(display-mode: standalone)` is FALSE in an installed iOS
 * web app even when the manifest says `display: standalone` — WebKit reports
 * `display-mode: fullscreen` instead (webkit.org/b/264218). So on iOS we trust
 * `navigator.standalone`, and we accept `fullscreen` in the media-query fallback.
 * `navigator.standalone` is also the only signal that works for a web app
 * installed with no manifest at all, which iOS 26 permits.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as SafariNavigator;
  if (typeof nav.standalone === 'boolean') return nav.standalone;
  const mm = window.matchMedia;
  if (!mm) return false;
  return mm('(display-mode: standalone)').matches
    || mm('(display-mode: fullscreen)').matches
    || mm('(display-mode: minimal-ui)').matches;
}

/**
 * iOS or iPadOS, including iPad's desktop-class user agent.
 * Note: Safari 26+ FREEZES the OS version in the UA string, so never try to
 * parse an iOS version number out of it — feature-detect instead.
 */
export function isIOS(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ reports as Macintosh; touch points disambiguate.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/**
 * Best-effort in-app-browser detection. Deliberately conservative: a false
 * negative shows install steps that don't work; a false positive only shows
 * an unnecessary "open in Safari" hint. Since iOS 26 some Facebook builds ship
 * no FBAV/FBAN token at all, so UA sniffing alone is not sufficient — we also
 * probe for injected globals.
 */
export function isInAppBrowser(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const w = window as unknown as Record<string, unknown>;

  if ('TelegramWebviewProxy' in w || 'Telegram' in w) return true;
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|LinkedInApp|Twitter|Snapchat|Pinterest|GSA\//i.test(ua)) {
    return true;
  }
  // Real iOS Safari always reports "Safari/" and "Version/". Most WKWebView
  // hosts keep "Safari/" but drop "Version/".
  if (isIOS() && /Safari\//.test(ua) && !/Version\//.test(ua)) return true;
  return false;
}

export function detectSurface(): Surface {
  if (isStandalone()) return 'installed';
  if (!isIOS()) return 'other';
  if (isInAppBrowser()) return 'ios-inapp';
  // CriOS = Chrome, EdgiOS = Edge, FxiOS = Firefox — all WebKit, all can install.
  if (/CriOS|EdgiOS|FxiOS|OPT\//.test(navigator.userAgent)) return 'ios-other-browser';
  return 'ios-safari';
}

/** Push can only be requested from an installed app on iOS. */
export function canRequestPush(): boolean {
  if (typeof window === 'undefined') return false;
  const supported = 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator;
  if (!supported) return false;
  return isIOS() ? isStandalone() : true;
}

// ---- nudge eligibility -------------------------------------------------------

const KEY = 'fs.installNudge.v1';
const COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_SHOWS = 3;

type NudgeState = { shows: number; lastShownAt: number };

function readState(): NudgeState {
  try {
    return { shows: 0, lastShownAt: 0, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { shows: 0, lastShownAt: 0 }; // private mode / blocked storage
  }
}

/** Call after a successful RSVP — not on first load. */
export function shouldShowInstallNudge(): boolean {
  const surface = detectSurface();
  if (surface !== 'ios-safari' && surface !== 'ios-inapp') return false;
  const { shows, lastShownAt } = readState();
  return shows < MAX_SHOWS && Date.now() - lastShownAt > COOLDOWN_MS;
}

export function recordInstallNudgeShown(): void {
  try {
    const { shows } = readState();
    localStorage.setItem(KEY, JSON.stringify({ shows: shows + 1, lastShownAt: Date.now() }));
  } catch { /* non-fatal */ }
}

/** Install clears the nudge ledger — we never ask an installed user again. */
export function clearInstallNudge(): void {
  try {
    localStorage.removeItem(KEY);
  } catch { /* non-fatal */ }
}

/**
 * Subscribe to push. MUST be called synchronously from a user-gesture handler:
 * Apple requires the subscription call to happen "immediately from the gesture's
 * event handler code".
 */
export async function enableReminders(vapidPublicKey: string): Promise<PushSubscription | null> {
  if (!canRequestPush()) return null;
  const permission = await Notification.requestPermission(); // prompt must originate in the gesture
  if (permission !== 'granted') return null;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true, // required by WebKit; silent push is prohibited
    applicationServerKey: vapidPublicKey,
  });
  // iOS exposes no expirationTime and dead endpoints can look healthy:
  // re-register on every launch and reconcile server-side.
  await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });
  void navigator.storage?.persist?.(); // heuristically granted for installed apps
  return sub;
}
