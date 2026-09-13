import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

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

  it('auth.oauthStartUrl(true) includes confirm=1', () => {
    expect(api.auth.oauthStartUrl(true)).toContain('confirm=1');
    expect(api.auth.oauthStartUrl(true)).toBe('/api/auth/oauth/start?confirm=1');
  });
});
