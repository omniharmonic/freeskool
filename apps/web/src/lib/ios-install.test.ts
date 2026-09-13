import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectSurface,
  isInAppBrowser,
  isStandalone,
  recordInstallNudgeShown,
  shouldShowInstallNudge,
  clearInstallNudge,
} from './ios-install';

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1';
const INSTAGRAM =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 340.0.0.20.109 (iPhone15,2; iOS 26_0; en_US)';
const IPHONE_CHROME =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1';
const DESKTOP_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// jsdom defines neither `maxTouchPoints` nor `standalone`, so these are set as
// own properties on the navigator instance and deleted again after each test.
const stubbed = new Set<string>();

function setNavProp(key: string, value: unknown) {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
  stubbed.add(key);
}

function stubNavigator(ua: string, extras: Record<string, unknown> = {}) {
  const iphone = ua.includes('iPhone');
  setNavProp('userAgent', ua);
  setNavProp('platform', iphone ? 'iPhone' : 'MacIntel');
  setNavProp('maxTouchPoints', iphone ? 5 : 0);
  for (const [key, value] of Object.entries(extras)) setNavProp(key, value);
}

/** jsdom implements no `window.matchMedia`, so it is installed per test. */
function stubMatchMedia(matcher: (query: string) => boolean) {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string) => ({ matches: matcher(query) }) as MediaQueryList,
    configurable: true,
    writable: true,
  });
}

function resetNavigator() {
  for (const key of stubbed) Reflect.deleteProperty(navigator, key);
  stubbed.clear();
}

function clearStandalone() {
  // `navigator.standalone` is non-standard and absent in jsdom; remove whatever
  // a previous test defined so `typeof` is back to 'undefined'.
  Reflect.deleteProperty(navigator, 'standalone');
  stubbed.delete('standalone');
}

afterEach(() => {
  resetNavigator();
  localStorage.clear();
  vi.useRealTimers();
});

describe('isStandalone', () => {
  it('trusts navigator.standalone over the display-mode media query', () => {
    // The iOS quirk in full: WebKit reports display-mode: fullscreen (not
    // standalone) in an installed web app, so the boolean has to win.
    stubNavigator(IPHONE_SAFARI, { standalone: true });
    stubMatchMedia(() => false);
    expect(isStandalone()).toBe(true);
  });

  it('is false in a Safari tab even though the media query is consulted', () => {
    stubNavigator(IPHONE_SAFARI, { standalone: false });
    expect(isStandalone()).toBe(false);
  });

  it('falls back to display-mode (incl. fullscreen) where standalone is absent', () => {
    stubNavigator(DESKTOP_CHROME);
    stubMatchMedia((query) => query.includes('fullscreen'));
    expect(isStandalone()).toBe(true);
  });
});

describe('isInAppBrowser', () => {
  it('catches the Instagram webview by its UA token', () => {
    stubNavigator(INSTAGRAM, { standalone: false });
    expect(isInAppBrowser()).toBe(true);
  });

  it('catches a webview that ships no vendor token, via the missing Version/', () => {
    stubNavigator(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1',
      { standalone: false },
    );
    expect(isInAppBrowser()).toBe(true);
  });

  it('catches Telegram by its injected global', () => {
    stubNavigator(IPHONE_SAFARI, { standalone: false });
    Object.defineProperty(window, 'TelegramWebviewProxy', { value: {}, configurable: true });
    try {
      expect(isInAppBrowser()).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'TelegramWebviewProxy');
    }
  });

  it('does not flag real iOS Safari', () => {
    stubNavigator(IPHONE_SAFARI, { standalone: false });
    expect(isInAppBrowser()).toBe(false);
  });
});

describe('detectSurface', () => {
  it.each([
    ['installed', IPHONE_SAFARI, { standalone: true }],
    ['ios-safari', IPHONE_SAFARI, { standalone: false }],
    ['ios-inapp', INSTAGRAM, { standalone: false }],
    ['other', DESKTOP_CHROME, { standalone: false }],
  ] as const)('reports %s', (expected, ua, extras) => {
    stubNavigator(ua, extras);
    expect(detectSurface()).toBe(expected);
  });

  it('files iOS Chrome under ios-inapp, not ios-other-browser', () => {
    // Documenting R8's detector as written rather than patching it: CriOS sends
    // "Safari/" with no "Version/", so the in-app check fires before the CriOS
    // check is reached and `ios-other-browser` is unreachable on iOS Chrome.
    // The cost is a harmless "open in Safari" hint (R8 calls this the safe
    // direction to be wrong in) — flagged for the coordinator.
    stubNavigator(IPHONE_CHROME, { standalone: false });
    expect(detectSurface()).toBe('ios-inapp');
  });
});

describe('install nudge cooldown', () => {
  it('shows on an installable iOS surface, then holds off for 14 days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-17T18:00:00Z'));
    stubNavigator(IPHONE_SAFARI, { standalone: false });

    expect(shouldShowInstallNudge()).toBe(true);
    recordInstallNudgeShown();
    expect(shouldShowInstallNudge()).toBe(false);

    vi.advanceTimersByTime(13 * 24 * 60 * 60 * 1000);
    expect(shouldShowInstallNudge()).toBe(false);

    vi.advanceTimersByTime(2 * 24 * 60 * 60 * 1000); // day 15
    expect(shouldShowInstallNudge()).toBe(true);
  });

  it('stops after three lifetime shows', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    stubNavigator(IPHONE_SAFARI, { standalone: false });

    for (let i = 0; i < 3; i++) {
      expect(shouldShowInstallNudge()).toBe(true);
      recordInstallNudgeShown();
      vi.advanceTimersByTime(15 * 24 * 60 * 60 * 1000);
    }
    expect(shouldShowInstallNudge()).toBe(false);
  });

  it('never nudges an installed app, and install clears the ledger', () => {
    stubNavigator(IPHONE_SAFARI, { standalone: false });
    recordInstallNudgeShown();
    expect(localStorage.getItem('fs.installNudge.v1')).not.toBeNull();

    clearStandalone();
    stubNavigator(IPHONE_SAFARI, { standalone: true });
    expect(shouldShowInstallNudge()).toBe(false);
    clearInstallNudge();
    expect(localStorage.getItem('fs.installNudge.v1')).toBeNull();
  });

  it('survives blocked storage instead of throwing', () => {
    stubNavigator(IPHONE_SAFARI, { standalone: false });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    try {
      expect(shouldShowInstallNudge()).toBe(true); // fresh state, asks once
      expect(() => recordInstallNudgeShown()).not.toThrow();
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});
