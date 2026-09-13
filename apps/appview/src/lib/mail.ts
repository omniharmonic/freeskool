/**
 * SMTP via nodemailer, with a FILE transport when `SMTP_URL` is unset so local
 * development never silently drops a magic link.
 *
 * The dev transport appends one JSON line per mail (`{to, subject, body, at}`) to
 * `config().devMailLog` — `apps/appview/.dev-mail.log` by default, gitignored. Stdout gets
 * the subject and the sink's path and nothing else: a mail body can carry a magic link, an
 * address or a handle (`lib/custody.ts`'s take-ownership mail names `@handle`), and R9 says
 * none of those belong in a log line. `tail -f apps/appview/.dev-mail.log` is where a local
 * operator reads their link; `apps/web/e2e/mvp.spec.ts` reads it the same way.
 *
 * Bodies are plain text plus an optional `.ics` attachment. No tracking pixels, no
 * per-recipient URLs beyond the one-time token.
 */
import { appendFile } from 'node:fs/promises'
import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'
import { log } from './logging.js'

export interface Mail {
  to: string
  subject: string
  text: string
  /** Plain HTML alternative (e.g. the monthly newsletter). Never a tracking pixel. */
  html?: string
  /** An `.ics` invitation, attached as text/calendar. */
  ics?: { filename: string; content: string }
}

let transport: Transporter | undefined

function getTransport(): Transporter | null {
  const url = config().SMTP_URL
  if (!url) return null
  return (transport ??= nodemailer.createTransport(url))
}

/** One JSON line per mail. The shape `apps/web/e2e/mvp.spec.ts` parses. */
export interface DevMailLine {
  to: string
  subject: string
  body: string
  at: string
}

export async function sendMail(mail: Mail): Promise<{ delivered: boolean; transport: 'smtp' | 'file' }> {
  const t = getTransport()
  if (!t) {
    const file = config().devMailLog
    const line: DevMailLine = { to: mail.to, subject: mail.subject, body: mail.text, at: new Date().toISOString() }
    try {
      await appendFile(file, `${JSON.stringify(line)}\n`, 'utf8')
      // The path is safe to print; the body is not (magic links, handles, addresses).
      console.log(`[appview] mail written to the dev sink (SMTP_URL unset): ${file}`)
    } catch (err) {
      log.warn('dev mail sink write failed; the magic link is only in the signup response', {
        detail: String(err),
      })
    }
    return { delivered: true, transport: 'file' }
  }
  await t.sendMail({
    from: config().MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...(mail.html ? { html: mail.html } : {}),
    ...(mail.ics
      ? {
          attachments: [
            {
              filename: mail.ics.filename,
              content: mail.ics.content,
              contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
            },
          ],
        }
      : {}),
  })
  log.info('mail sent', { subject: mail.subject })
  return { delivered: true, transport: 'smtp' }
}
