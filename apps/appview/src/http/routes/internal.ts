/**
 * Container-local endpoints. NOT under `/api` on purpose: `infra/production/Caddyfile`
 * routes only `/api/*` and the three `/oauth/*` documents to the AppView, so `/internal/*`
 * on a public host lands on the PWA's static fallback and never reaches this router.
 * The only caller is Caddy's own `ask`, from `http://127.0.0.1:9000` inside the edge
 * container.
 */
import { Hono } from 'hono'
import type { AppEnv } from '../session.js'
import { allowCertificateFor } from '../../lib/tls-check.js'

export const internal = new Hono<AppEnv>()

/**
 * `GET /internal/tls-check?domain=<host>` — Caddy's on-demand TLS gate. 200 means
 * "issue a certificate for this name", anything else means no. The body is empty in
 * both directions: Caddy reads the status, and the domain must not be echoed anywhere
 * (R9 — see `lib/tls-check.ts`).
 */
internal.get('/internal/tls-check', async (c) =>
  c.body(null, (await allowCertificateFor(c.req.query('domain') ?? '')) ? 200 : 403),
)
