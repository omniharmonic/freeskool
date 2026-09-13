/** Keep an invitation through same-device email sign-in. Only invite paths are
 * accepted; this is never an arbitrary redirect from a query string. */
const KEY = 'freeschool.signin-invite';
const MAX_AGE = 30 * 60 * 1000;
function safeInvite(path: unknown): path is string {
  return typeof path === 'string' && /^\/invite\/[A-Za-z0-9_-]+$/.test(path);
}
export function rememberSignInReturn(search: string): void {
  const path = new URLSearchParams(search).get('next');
  try {
    if (safeInvite(path)) sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
    else sessionStorage.removeItem(KEY);
  } catch { /* Storage can be unavailable in a private browser. */ }
}
export function consumeSignInReturn(): string {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (raw) {
      const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
      if (safeInvite(path) && typeof at === 'number' && Date.now() - at >= 0 && Date.now() - at < MAX_AGE) return path;
    }
  } catch { /* A stale or malformed value should never interrupt sign-in. */ }
  return '/requests';
}
