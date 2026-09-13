import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';
import type { CalendarEvent, ViewerRelation } from './types';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('sends credentials: include on every request', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await api.auth.logout();
    const init = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
  });

  it('sends a JSON body and content-type header on POST', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { did: 'did:plc:x', handle: 'x', verifyUrl: 'u' }));
    await api.auth.signup({ email: 'wren@example.com' });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/auth/signup');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'wren@example.com' });
  });

  it('throws ApiError with the status and the server error code on a 4xx response', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      jsonResponse(400, { error: 'InvalidRequest', message: 'email is required' }),
    );

    await expect(api.auth.signup({ email: 'not-an-email' })).rejects.toMatchObject({
      status: 400,
      code: 'InvalidRequest',
      message: 'email is required',
    });
    await expect(api.auth.signup({ email: 'not-an-email' })).rejects.toBeInstanceOf(ApiError);
  });

  it('events.icsHref builds the .ics path without making a request', () => {
    expect(api.events.icsHref('x')).toBe('/api/events/x.ics');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('auth.oauthStartUrl(true, handle) includes confirm=1 and the handle', () => {
    expect(api.auth.oauthStartUrl(true, 'wren.fs.boulder')).toContain('confirm=1');
    expect(api.auth.oauthStartUrl(true, 'wren.fs.boulder')).toBe(
      '/api/auth/oauth/start?confirm=1&handle=wren.fs.boulder',
    );
  });
});

describe('type-level: client types mirror the AppView response shapes', () => {
  // These assertions are caught by `tsc --noEmit` (the `typecheck` script),
  // not by vitest's esbuild transform — `@ts-expect-error` fails the build if
  // the line it guards stops being a type error, which is exactly what we
  // want if `ViewerRelation` or `CalendarEvent` drift from the server again.

  it('ViewerRelation has no `| string` escape hatch — only the five literals the server returns', () => {
    const allFive: ViewerRelation[] = ['public', 'rsvp', 'attendee', 'host', 'steward'];
    expect(allFive).toHaveLength(5);

    // @ts-expect-error — the old mock-era names; the server never returns these.
    const rejected1: ViewerRelation = 'rsvped';
    // @ts-expect-error
    const rejected2: ViewerRelation = 'attended';
    // @ts-expect-error — arbitrary strings used to be allowed via `| string`; not anymore.
    const rejected3: ViewerRelation = 'anything';
    void rejected1;
    void rejected2;
    void rejected3;
  });

  it('CalendarEvent permits the privacy-redacted shape (no hostDid/description/locations/uris)', () => {
    const redacted: CalendarEvent = { uri: 'at://did:plc:host/x/1', name: 'Sourdough', locationRedacted: true };
    expect(redacted.hostDid).toBeUndefined();
    expect(redacted.locations).toBeUndefined();

    // @ts-expect-error — `name` and `locationRedacted` are required; the server always sets them.
    const invalid: CalendarEvent = { uri: 'at://x' };
    void invalid;
  });
});
