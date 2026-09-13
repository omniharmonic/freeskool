/**
 * A1, end to end on the one link that matters most: the magic link in the verification
 * email must point at the PWA's `/verify` screen on `WEB_PUBLIC_URL` — never at the API
 * endpoint, on either origin. `VerifyScreen` is what calls `GET /api/auth/verify`.
 *
 * The mail is intercepted at the dev file sink (`SMTP_URL` unset), which is the real
 * delivery path in development, so this exercises `sendVerificationEmail` whole.
 */
process.env.WEB_PUBLIC_URL = 'https://app.example'
process.env.APPVIEW_PUBLIC_URL = 'https://api.example'
process.env.SESSION_SECRET ??= 'verify-mail-test-session-secret'
process.env.CUSTODY_KEYS ??= `v1:${Buffer.alloc(32, 9).toString('base64')}`
process.env.FEEDBACK_BALLOT_PEPPER ??= 'verify-mail-test-pepper'
process.env.DATABASE_URL ??= 'postgres://freeschool:freeschool@localhost:5434/freeschool'

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const dir = await mkdtemp(path.join(tmpdir(), 'fs-verify-mail-'))
process.env.DEV_MAIL_LOG = path.join(dir, 'dev-mail.log')

import { closeTestDb, pgAvailable, SKIP_MESSAGE, truncate } from './helpers/pg.js'
import { sendVerificationEmail } from '../src/lib/custody.js'
import { resetDevMailSink } from '../src/lib/mail.js'
import type { DevMailLine } from '../src/lib/mail.js'

let available = false

beforeAll(async () => {
  available = await pgAvailable()
  if (!available) console.warn(SKIP_MESSAGE)
})

beforeEach(async () => {
  if (!available) return
  await truncate('fs_email_verification')
  // A11: one run, one sink.
  await resetDevMailSink()
})

afterAll(async () => {
  if (available) await closeTestDb()
})

async function lastMail(): Promise<DevMailLine> {
  const lines = (await readFile(process.env.DEV_MAIL_LOG!, 'utf8')).trim().split('\n').filter(Boolean)
  return JSON.parse(lines.at(-1)!) as DevMailLine
}

describe('the verification email', () => {
  it('links to the PWA’s /verify screen on WEB_PUBLIC_URL, never to the API endpoint', async () => {
    if (!available) return
    const { url } = await sendVerificationEmail('did:plc:verify-mail-subject', 'someone@example.org')
    expect(url.startsWith('https://app.example/verify?token=')).toBe(true)

    const mail = await lastMail()
    expect(mail.body).toContain('https://app.example/verify?token=')
    expect(mail.body).not.toContain('/api/auth/verify')
    expect(mail.body).not.toContain('https://api.example')
    // Belt and braces: no stray `api` host anywhere in the body.
    expect(mail.body).not.toMatch(/https?:\/\/[^\s]*\bapi\b/)
  })

  it('truncates the dev sink at boot rather than growing a magic-link log forever', async () => {
    if (!available) return
    await sendVerificationEmail('did:plc:verify-mail-first', 'first@example.org')
    await resetDevMailSink()
    await sendVerificationEmail('did:plc:verify-mail-second', 'second@example.org')
    const lines = (await readFile(process.env.DEV_MAIL_LOG!, 'utf8')).trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)
    expect((JSON.parse(lines[0]!) as DevMailLine).to).toBe('second@example.org')
  })
})
