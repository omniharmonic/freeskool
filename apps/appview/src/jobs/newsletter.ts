/**
 * Monthly digest. Monthly, on pg-boss.
 *
 * COMPOSING reads last month's listed classes out of the index and renders a plain-text
 * + simple-HTML draft into `fs_newsletter_issue` with `status: 'draft'`. SENDING is a
 * separate, explicit step (`sendNewsletterIssue`, called from `POST
 * /api/admin/newsletter/:id/send`, steward-gated) — a cron job that mails the whole
 * school unattended is not a feature, so the scheduled job only ever composes.
 *
 * Sending:
 *   - recipients come from `fs_newsletter_subscription` (opt-in, distinct from
 *     `fs_notification_target` — see `lib/newsletter-subscriptions.ts`), capped at
 *     `MAX_RECIPIENTS_PER_RUN`;
 *   - each recipient gets a FRESH, single-use one-click unsubscribe link
 *     (`rotateUnsubscribeToken`) appended to both the text and HTML body — no tracking
 *     pixel, no click-tracked links, nothing else per-recipient;
 *   - the mail transport is injectable (`deps.sendFn`) so tests never touch a real SMTP
 *     transport or print the console fallback.
 */
import { getIndexer } from '../index/indexer.js'
import { eventsInWindow, sidecarsForEvent } from '../index/queries.js'
import type { EventConfig, EventListing } from '../lexicons/coop.js'
import { isListed } from '../http/visibility.js'
import { getDb } from '../db/index.js'
import { newsletterIssue } from '../db/schema.js'
import { rowId } from '../lib/ids.js'
import { describeError, log } from '../lib/logging.js'
import { config } from '../config.js'
import { sendMail, type Mail } from '../lib/mail.js'
import { activeSubscribers, rotateUnsubscribeToken } from '../lib/newsletter-subscriptions.js'
import { eq } from 'drizzle-orm'

export interface Digest {
  subject: string
  body: string
  eventCount: number
}

export async function composeMonthlyDigest(period: string): Promise<Digest> {
  const [year, month] = period.split('-').map(Number)
  const from = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1))
  const to = new Date(Date.UTC(year ?? 1970, month ?? 1, 1))

  const indexer = await getIndexer()
  const events = await eventsInWindow(indexer, from.toISOString(), to.toISOString(), 500)

  const lines: string[] = []
  let count = 0
  for (const e of events) {
    const [listings, configs] = await Promise.all([
      sidecarsForEvent<EventListing>(indexer, 'eventListing', e.uri),
      sidecarsForEvent<EventConfig>(indexer, 'eventConfig', e.uri),
    ])
    if (!isListed({ listings: listings.map((l) => l.value), configs: configs.map((x) => x.value) })) continue
    count++
    const name = typeof e.value.name === 'string' ? e.value.name : 'Untitled'
    const when = typeof e.value.startsAt === 'string' ? e.value.startsAt.slice(0, 16).replace('T', ' ') : 'TBD'
    // The digest never names a host or an attendee. A class, a date, a link.
    lines.push(`- ${when}  ${name}`)
  }

  return {
    subject: `Free School, ${period}`,
    body: [
      `What happened at Free School in ${period}:`,
      '',
      ...(lines.length ? lines : ['(no listed classes this month)']),
      '',
      'Everything is free. Anyone can teach.',
    ].join('\n'),
    eventCount: count,
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * MJML-free: plain paragraphs, inline styles only, no external resources, and
 * deliberately never an `<img` tag anywhere — there is no tracking pixel to hide.
 */
export function renderDigestHtml(digest: Digest): string {
  const paragraphs = digest.body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => `<p style="margin:0 0 8px;">${escapeHtml(line)}</p>`)
    .join('\n')
  return [
    '<!doctype html>',
    '<html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111;">',
    `<h1 style="font-size:18px;">${escapeHtml(digest.subject)}</h1>`,
    paragraphs,
    '</body></html>',
  ].join('\n')
}

export interface NewsletterIssueDraft {
  id: string
  month: string
  html: string
  text: string
  status: 'draft'
}

/** Composes a draft and stores it in `fs_newsletter_issue`. Does not send anything. */
export async function composeNewsletterIssue(period: string): Promise<NewsletterIssueDraft> {
  const digest = await composeMonthlyDigest(period)
  const html = renderDigestHtml(digest)
  const id = rowId()
  await getDb().insert(newsletterIssue).values({ id, month: period, html, text: digest.body, status: 'draft' })
  log.info('newsletter draft composed', { events: digest.eventCount })
  return { id, month: period, html, text: digest.body, status: 'draft' }
}

/** The scheduled job body. Composes last month's draft; never sends. */
export async function runMonthlyNewsletter(now = new Date()): Promise<{ id: string; period: string }> {
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const period = prev.toISOString().slice(0, 7)
  const draft = await composeNewsletterIssue(period)
  return { id: draft.id, period }
}

export const MAX_RECIPIENTS_PER_RUN = 500

export interface SendNewsletterDeps {
  sendFn?: (mail: Mail) => Promise<{ delivered: boolean; transport: string }>
}

export type SendNewsletterResult =
  | { ok: true; recipientCount: number; failedCount: number; skipped?: number }
  | { ok: false; status: number; error: string; message?: string }

/**
 * One-click unsubscribe, on the PWA's origin (A1: every link a human clicks is on
 * `webPublicUrl`). The path is still the API route — there is no PWA screen for it and it
 * needs none, a GET is the whole interaction — so the PWA origin must forward `/api/*` to
 * the AppView, which is exactly what the dev server proxy and the production deployment
 * already do. With `WEB_PUBLIC_URL` unset this is byte-identical to the old link.
 */
function unsubscribeUrl(token: string): string {
  return `${config().webPublicUrl}/api/newsletter/unsubscribe/${token}`
}

/**
 * Sends a DRAFT issue to every currently-subscribed member, up to `MAX_RECIPIENTS_PER_RUN`,
 * then marks it sent. A second call against an already-sent issue is refused rather than
 * re-sending.
 *
 * Two things this deliberately does NOT do:
 *   - one recipient's send throwing does not abort the run for everyone after them —
 *     each send is isolated (try/catch per recipient); `failedCount` is the tally;
 *   - resend the REMAINDER when a school has more than `MAX_RECIPIENTS_PER_RUN` active
 *     subscribers. That would need a per-issue delivery ledger (who has received THIS
 *     issue) this table does not have. Documented limitation: `skipped` in the result
 *     names how many were not reached this run; reaching them needs a follow-up issue.
 */
export async function sendNewsletterIssue(id: string, deps: SendNewsletterDeps = {}): Promise<SendNewsletterResult> {
  const send = deps.sendFn ?? sendMail
  const db = getDb()
  const rows = await db.select().from(newsletterIssue).where(eq(newsletterIssue.id, id)).limit(1)
  const issue = rows[0]
  if (!issue) return { ok: false, status: 404, error: 'NotFound', message: 'no such newsletter issue' }
  if (issue.status === 'sent') return { ok: false, status: 409, error: 'AlreadySent', message: 'this issue was already sent' }

  // Peek one past the cap so we know whether anyone was skipped, without a second query.
  const candidates = await activeSubscribers(MAX_RECIPIENTS_PER_RUN + 1)
  const skipped = Math.max(0, candidates.length - MAX_RECIPIENTS_PER_RUN)
  const subscribers = skipped > 0 ? candidates.slice(0, MAX_RECIPIENTS_PER_RUN) : candidates
  const subject = issue.html.match(/<h1[^>]*>(.*?)<\/h1>/)?.[1] ?? `Free School, ${issue.month}`

  let sent = 0
  let failed = 0
  for (const sub of subscribers) {
    try {
      const token = await rotateUnsubscribeToken(sub.did)
      const url = unsubscribeUrl(token)
      const html = `${issue.html}\n<p style="font-size:12px;color:#666;">Don't want this? <a href="${url}">Unsubscribe</a>.</p>`
      const text = `${issue.text}\n\nUnsubscribe: ${url}`
      await send({ to: sub.emailRef, subject, text, html })
      sent++
    } catch (err) {
      // Isolated on purpose: a transport failure for one address must never abort the
      // rest of the run, and must never be retried with a newly-rotated (and now
      // unsent) token at this recipient's expense.
      failed++
      log.warn('newsletter send failed for one recipient', { detail: describeError(err) })
    }
  }

  await db
    .update(newsletterIssue)
    .set({ status: 'sent', sentAt: new Date(), recipientCount: sent, failedCount: failed })
    .where(eq(newsletterIssue.id, id))
  return { ok: true, recipientCount: sent, failedCount: failed, ...(skipped > 0 ? { skipped } : {}) }
}
