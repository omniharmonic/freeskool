/**
 * A1 / A9 / A11 — the three things that are wrong in a way no screen reveals:
 *
 *   A1  every link a human clicks is on the PWA's origin (`WEB_PUBLIC_URL`), not on the
 *       API's. The magic link in particular must land on the PWA's `/verify` screen, which
 *       is what calls `GET /api/auth/verify`; a link straight to the endpoint shows a
 *       browser a JSON blob and sets the cookie on the wrong origin.
 *   A9  no log line ever carries an error MESSAGE, because a message carries handles.
 *   A11 production refuses to boot without a mail transport, and the signup response only
 *       carries a magic link outside production.
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { describeError, safe } from '../src/lib/logging.js'

const BASE_ENV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://freeschool:freeschool@localhost:5434/freeschool',
  SESSION_SECRET: 'links-and-boot-test-session-secret',
  CUSTODY_KEYS: `v1:${Buffer.alloc(32, 7).toString('base64')}`,
  CUSTODY_KEY_VERSION: 'v1',
  FEEDBACK_BALLOT_PEPPER: 'links-and-boot-test-pepper',
} as unknown as NodeJS.ProcessEnv

describe('A1: webPublicUrl is where humans are sent', () => {
  it('falls back to the AppView origin when the PWA has no origin of its own', () => {
    const c = loadConfig({ ...BASE_ENV, APPVIEW_PUBLIC_URL: 'http://localhost:4000' })
    expect(c.webPublicUrl).toBe('http://localhost:4000')
  })

  it('prefers WEB_PUBLIC_URL, trailing slash stripped', () => {
    const c = loadConfig({ ...BASE_ENV, APPVIEW_PUBLIC_URL: 'https://api.example', WEB_PUBLIC_URL: 'https://app.example/' })
    expect(c.webPublicUrl).toBe('https://app.example')
    // The OAuth client_id stays on the API origin: the PDS fetches it, nobody clicks it.
    expect(c.oauthClientId).toBe('https://api.example/oauth/client-metadata.json')
  })
})

describe('A11: production needs a mail transport', () => {
  it('throws at boot when NODE_ENV=production and SMTP_URL is empty', () => {
    expect(() => loadConfig({ ...BASE_ENV, NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/SMTP_URL is required/)
  })

  it('boots in production once SMTP_URL is set', () => {
    const c = loadConfig({
      ...BASE_ENV,
      NODE_ENV: 'production',
      SMTP_URL: 'smtp://user:pass@smtp.example.org:587',
      APPVIEW_PUBLIC_URL: 'https://api.example',
    } as NodeJS.ProcessEnv)
    expect(c.isProd).toBe(true)
  })

  it('does not constrain development or test', () => {
    expect(loadConfig({ ...BASE_ENV, NODE_ENV: 'test' } as NodeJS.ProcessEnv).isProd).toBe(false)
  })
})

describe('A9: an error label never carries the message', () => {
  it('drops a message that contains a handle, keeping the class name', () => {
    const err = new Error('could not find repo for alice.test')
    expect(describeError(err)).toBe('Error')
    expect(describeError(err)).not.toContain('alice.test')
  })

  it('keeps an XRPC error code, which is a closed vocabulary', () => {
    const err = Object.assign(new Error('could not find repo for alice.test'), { error: 'RepoNotFound' })
    expect(describeError(err)).toBe('Error: RepoNotFound')
    expect(describeError(err)).not.toContain('alice.test')
  })

  it('refuses a bogus "code" rather than echoing it', () => {
    const err = Object.assign(new Error('nope'), { error: 'not a code: alice.test' })
    expect(describeError(err)).toBe('Error')
  })

  it('safe() still redacts DIDs, emails and at-uris for hand-written lines', () => {
    const scrubbed = safe('did:plc:abc123 wrote at://did:plc:abc123/x/y for dana@example.org')
    expect(scrubbed).not.toContain('did:plc:abc123')
    expect(scrubbed).not.toContain('dana@example.org')
  })
})
