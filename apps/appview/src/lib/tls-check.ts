/**
 * The on-demand TLS gate (MS §3).
 *
 * Caddy fronts a wildcard (`*.freeskool.xyz`) it cannot get a wildcard certificate for —
 * there is no DNS challenge on this box — so every handle host and every school host is
 * issued ON DEMAND, one name at a time, and Caddy asks this before each issuance.
 *
 * Three rules, in order:
 *   1. `www.<web host>`, the one extra name the apex block cannot carry itself (Caddy
 *      will not issue for a specific name it believes a configured wildcard covers).
 *   2. a school host: a single known label under `SCHOOL_DOMAIN_SUFFIX`. Federation
 *      Task 2 moves the known set from config into `fs_school_domain`; the answer's
 *      shape does not change.
 *   3. otherwise, a single label under ANY handle domain this deployment serves, which
 *      only the PDS can vouch for — it is the one that issued the handle.
 *
 * Rule 3 is a LIST, not one name, because of federation ruling 3: the handle domain moves
 * from `freeskool.xyz` to `freeskool.directory`, and for the length of that migration a
 * member's DID document may still name either. If the gate stopped vouching for the old
 * domain the instant `PDS_HANDLE_DOMAIN` flipped, every handle that had not yet been
 * rewritten would become unreachable at the next certificate renewal. Both domains are
 * offered to the PDS, which is the only thing that actually knows which handles exist;
 * `PDS_LEGACY_HANDLE_DOMAIN` (and the csv `PDS_HANDLE_DOMAINS`) is how the second one is
 * named, and clearing it at the end of the migration narrows the gate again.
 *
 * Everything else is NO, and so is a PDS that fails to answer inside three seconds: an
 * unanswered check must never mint a certificate. Let's Encrypt allows 50 certificates
 * per registered domain per week, and a gate that answers from a PATTERN rather than
 * from known names spends that budget the first time a bot dials random SNIs at the box.
 *
 * Privacy (R9): the domain is the name of a member's handle host. It is never logged,
 * never echoed into a response body, and never carried into an error message.
 */
import { config } from '../config.js'
import { labelUnder, schoolLabels } from './handles.js'

/** A handshake is waiting on this answer; a slow PDS must not become a hung dial. */
const PDS_TIMEOUT_MS = 3000

export async function allowCertificateFor(domain: string): Promise<boolean> {
  const host = domain.trim().toLowerCase().replace(/\.$/, '')
  if (!host || !/^[a-z0-9.-]+$/.test(host)) return false

  const c = config()
  if (c.webHost && host === `www.${c.webHost}`) return true

  const school = labelUnder(host, c.schoolDomainSuffix)
  if (school && schoolLabels(c).has(school)) return true

  // A handle host is exactly one label under a handle domain. A name outside every one of
  // them is a name this stack does not serve, whatever the PDS might say about it.
  if (!c.handleDomains.some((domain) => labelUnder(host, domain))) return false
  return pdsVouchesFor(host)
}

async function pdsVouchesFor(host: string): Promise<boolean> {
  try {
    const url = new URL('/tls-check', `${config().PDS_URL.replace(/\/$/, '')}/`)
    url.searchParams.set('domain', host)
    const res = await fetch(url, { signal: AbortSignal.timeout(PDS_TIMEOUT_MS) })
    return res.ok
  } catch {
    // Deliberately silent: the only thing there is to say names the domain.
    return false
  }
}
