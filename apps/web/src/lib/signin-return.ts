/** Keep an invitation, or a masthead "Sign in" click, through same-device email
 * sign-in. Only an invite path or one of the tabbed screens is accepted; this
 * is never an arbitrary redirect from a query string. */
const KEY = 'freeschool.signin-invite';
const MAX_AGE = 30 * 60 * 1000;
/** The tabbed screens a signed-out visitor can click "Sign in" from (masthead,
 * `Screen.tsx`) — worth returning to, unlike a one-off deep link. */
const TAB_PATHS = new Set(['/', '/skills', '/requests', '/people']);
function safeReturnPath(path: unknown): path is string {
  return typeof path === 'string' && (/^\/invite\/[A-Za-z0-9_-]+$/.test(path) || TAB_PATHS.has(path));
}
export function rememberSignInReturn(search: string): void {
  const path = new URLSearchParams(search).get('next');
  try {
    if (safeReturnPath(path)) sessionStorage.setItem(KEY, JSON.stringify({ path, at: Date.now() }));
    else sessionStorage.removeItem(KEY);
  } catch { /* Storage can be unavailable in a private browser. */ }
}
export function consumeSignInReturn(): string {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (raw) {
      const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
      if (safeReturnPath(path) && typeof at === 'number' && Date.now() - at >= 0 && Date.now() - at < MAX_AGE) return path;
    }
  } catch { /* A stale or malformed value should never interrupt sign-in. */ }
  return '/requests';
}
