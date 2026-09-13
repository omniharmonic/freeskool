/**
 * BFF stubs. Auth runs server-side on the same origin (R8): the DPoP key and
 * tokens never reach the browser, the redirect stays inside `scope`, and the
 * session cookie is the one thing iOS copies at Add to Home Screen.
 *
 * Nothing here is wired to a backend yet — each call is shaped so swapping in
 * `fetch` is a one-line change.
 */

export interface AuthStartResult {
  ok: boolean;
  redirectedTo: string;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Primary door: mint an account on the school's own PDS, server-side. */
export async function startNewIdentity(handle: string): Promise<AuthStartResult> {
  await post('/api/auth/signup', { handle }).catch(() => undefined);
  return { ok: true, redirectedTo: '/api/auth/signup' };
}

/** Secondary door: ATProto OAuth for an account the person already has. */
export async function startExistingAccount(handle: string): Promise<AuthStartResult> {
  await post('/api/auth/oauth/start', { handle, next: location.pathname }).catch(() => undefined);
  return { ok: true, redirectedTo: '/api/auth/oauth/start' };
}

export async function signOut(): Promise<void> {
  await post('/api/auth/logout').catch(() => undefined);
}

export async function rsvp(eventUri: string, going: boolean): Promise<void> {
  await post('/api/rsvp', { eventUri, going }).catch(() => undefined);
}

export async function claimRequest(requestUri: string): Promise<void> {
  await post('/api/requests/claim', { requestUri }).catch(() => undefined);
}

export async function createRequest(input: {
  title: string;
  description: string;
  skillId: string;
}): Promise<void> {
  await post('/api/requests', input).catch(() => undefined);
}

/** `.ics` is a real navigation, never a download attribute (R8). */
export function icsHref(eventUri: string): string {
  const rkey = eventUri.split('/').pop() ?? '';
  return `/api/events/${encodeURIComponent(rkey)}.ics`;
}

export function inviteHref(eventUri: string): string {
  const rkey = eventUri.split('/').pop() ?? '';
  return `/api/events/${encodeURIComponent(rkey)}/invite`;
}
