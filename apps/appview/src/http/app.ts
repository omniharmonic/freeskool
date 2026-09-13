/**
 * The Hono app.
 *
 * Privacy-relevant middleware, in order:
 *   - NO request logger. Deliberate: a request log is a record of who looked at what.
 *     Only the start-up line and bounded error categories are ever printed.
 *   - `Referrer-Policy: no-referrer` on every response (R9), so a click out of the PWA
 *     never leaks an event URL to a third party.
 *   - a conservative CSP and `X-Content-Type-Options`, because this origin serves JSON
 *     and `.ics` and should never be treated as a document host.
 */
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { config } from '../config.js'
import { withViewer, type AppEnv } from './session.js'
import { health } from './routes/health.js'
import { auth } from './routes/auth.js'
import { calendar } from './routes/calendar.js'
import { events } from './routes/events.js'
import { rsvps } from './routes/rsvp.js'
import { requests } from './routes/requests.js'
import { skills } from './routes/skills.js'
import { feedbackRoutes } from './routes/feedback.js'
import { admin } from './routes/admin.js'
import { notifications } from './routes/notifications.js'
import { me } from './routes/me.js'
import { oauthRoutes } from './routes/oauth.js'
import { invites } from './routes/invites.js'
import { zine } from './routes/zine.js'
import { school } from './routes/school.js'
import { newsletterRoutes } from './routes/newsletter.js'
import { handoffRoutes } from './routes/handoff.js'

export function createApp() {
  const app = new Hono<AppEnv>()

  app.use('*', async (c, next) => {
    await next()
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  })

  // The PWA is a separate origin in development; it must send its session cookie.
  app.use(
    '/api/*',
    cors({
      origin: (origin) => (origin && isAllowedOrigin(origin) ? origin : config().APPVIEW_PUBLIC_URL),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['content-type'],
    }),
  )

  app.use('*', withViewer)

  app.route('/', health)
  app.route('/', oauthRoutes)
  app.route('/api/auth', auth)
  app.route('/api', calendar)
  app.route('/api', events)
  app.route('/api', rsvps)
  app.route('/api', requests)
  app.route('/api', skills)
  app.route('/api', feedbackRoutes)
  app.route('/api/admin', admin)
  app.route('/api', notifications)
  app.route('/api/me', me)
  app.route('/api', invites)
  app.route('/api', zine)
  app.route('/api', school)
  app.route('/api', newsletterRoutes)
  app.route('/api', handoffRoutes)

  app.notFound((c) => c.json({ error: 'NotFound' }, 404))
  app.onError((err, c) => {
    const e = err as { status?: number; code?: string; message?: string }
    const status = typeof e.status === 'number' && e.status >= 400 && e.status < 600 ? e.status : 500
    // Message only; never the stack, never the request body.
    return c.json({ error: e.code ?? 'InternalError', message: e.message ?? 'something went wrong' }, status as 500)
  })

  return app
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === config().APPVIEW_PUBLIC_URL) return true
  try {
    const u = new URL(origin)
    // Local PWA dev servers only.
    return !config().isProd && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
  } catch {
    return false
  }
}
