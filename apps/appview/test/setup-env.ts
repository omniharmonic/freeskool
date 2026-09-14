/**
 * Runs in every vitest worker before a test file loads. A developer shell that has
 * exported the repo-root `.env` carries the DEV stack's identity (school DID, authority,
 * secrets, PDS admin password). The suites set their own values with `??=`, so those
 * exported values would silently win and make assertions depend on the shell. Strip
 * them here; `DATABASE_URL` is pinned separately by `vitest.config.ts` (`test.env`).
 */
for (const name of [
  'SCHOOL_DID',
  'SCHOOL_HANDLE',
  'SCHOOL_APP_PASSWORD',
  'AUTHORITY_DID',
  'AUTHORITY_HANDLE',
  'AUTHORITY_PASSWORD',
  'PDS_ADMIN_PASSWORD',
  'PDS_URL',
  'PDS_HANDLE_DOMAIN',
  'SCHOOL_DOMAIN_SUFFIX',
  'SCHOOL_LABELS',
  'PEER_PDS_HOSTS',
  'SESSION_SECRET',
  'CUSTODY_KEYS',
  'CUSTODY_KEY_VERSION',
  'FEEDBACK_BALLOT_PEPPER',
  'DEV_MAIL_LOG',
  'WEB_PUBLIC_URL',
  'APPVIEW_PUBLIC_URL',
  'SMTP_URL',
  'FREESCHOOL_NO_JOBS',
]) {
  delete process.env[name]
}
