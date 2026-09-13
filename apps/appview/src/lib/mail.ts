/**
 * SMTP via nodemailer, with a console transport when `SMTP_URL` is unset so local
 * development never silently drops a magic link.
 *
 * Bodies are plain text plus an optional `.ics` attachment. No tracking pixels, no
 * per-recipient URLs beyond the one-time token.
 */
import nodemailer, { type Transporter } from 'nodemailer'
import { config } from '../config.js'
import { log } from './logging.js'

export interface Mail {
  to: string
  subject: string
  text: string
  /** An `.ics` invitation, attached as text/calendar. */
  ics?: { filename: string; content: string }
}

let transport: Transporter | undefined

function getTransport(): Transporter | null {
  const url = config().SMTP_URL
  if (!url) return null
  return (transport ??= nodemailer.createTransport(url))
}

export async function sendMail(mail: Mail): Promise<{ delivered: boolean; transport: 'smtp' | 'console' }> {
  const t = getTransport()
  if (!t) {
    // The one place a user-facing URL is printed: there is no other way to get it in dev.
    console.log(`\n--- email (SMTP_URL unset) ---\nsubject: ${mail.subject}\n${mail.text}\n---\n`)
    return { delivered: true, transport: 'console' }
  }
  await t.sendMail({
    from: config().MAIL_FROM,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
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
