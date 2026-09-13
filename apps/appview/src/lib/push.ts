/**
 * Web push, Declarative Web Push shape.
 *
 * iOS 18.4+ renders a push whose payload is the declarative JSON object below without
 * running a service worker — which matters because iOS only delivers push at all to a
 * Home-Screen-installed PWA, and revokes the subscription after a silent push.
 * `mutable: true` is what lets a service worker still amend the notification where one
 * exists, so the same payload serves both worlds.
 *
 *   { "web_push": 8030, "notification": { title, body, navigate, app_badge, mutable } }
 *
 * `web_push: 8030` is the magic version number from the spec.
 */
import webpush from 'web-push'
import { config } from '../config.js'

export const DECLARATIVE_WEB_PUSH_VERSION = 8030

export interface DeclarativePush {
  web_push: typeof DECLARATIVE_WEB_PUSH_VERSION
  notification: {
    title: string
    body?: string
    navigate: string
    app_badge?: number
    mutable: true
  }
}

export function declarativePayload(input: {
  title: string
  body?: string
  navigate: string
  appBadge?: number
}): DeclarativePush {
  return {
    web_push: DECLARATIVE_WEB_PUSH_VERSION,
    notification: {
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      navigate: input.navigate,
      ...(typeof input.appBadge === 'number' ? { app_badge: input.appBadge } : {}),
      mutable: true,
    },
  }
}

export interface PushSubscriptionRecord {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

let configured = false

function ensureVapid(): boolean {
  const c = config()
  if (!c.VAPID_PUBLIC_KEY || !c.VAPID_PRIVATE_KEY) return false
  if (!configured) {
    webpush.setVapidDetails(c.VAPID_SUBJECT, c.VAPID_PUBLIC_KEY, c.VAPID_PRIVATE_KEY)
    configured = true
  }
  return true
}

export type PushOutcome =
  | { ok: true }
  | { ok: false; gone: true; code: 'subscription_gone' }
  | { ok: false; gone: false; code: 'push_failed' | 'push_not_configured' }

export async function sendPush(sub: PushSubscriptionRecord, payload: DeclarativePush): Promise<PushOutcome> {
  if (!ensureVapid()) return { ok: false, gone: false, code: 'push_not_configured' }
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      // Declarative Web Push requires the JSON content type.
      headers: { 'Content-Type': 'application/json' },
      TTL: 3600,
      urgency: 'normal',
    })
    return { ok: true }
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode
    // 404/410: the browser dropped the subscription. Disable the target, don't retry.
    if (status === 404 || status === 410) return { ok: false, gone: true, code: 'subscription_gone' }
    return { ok: false, gone: false, code: 'push_failed' }
  }
}

export function vapidPublicKey(): string {
  return config().VAPID_PUBLIC_KEY
}
