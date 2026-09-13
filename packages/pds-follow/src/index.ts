/**
 * The reusable surface of the R4 follower.
 *
 * `follow-pds.ts` is the CLI spike; everything the AppView's `PdsChangeSource`
 * needs is re-exported here so there is exactly one copy of the identity /
 * migration / lexicon-JSON logic in the monorepo.
 *
 * Deliberately NOT exported: `CursorStore` (file-backed; the AppView persists
 * cursors in its own database) and the CLI commands.
 */
export { Identity, hasMoved, type Resolved } from './identity.js'
export { lexToJson } from './lex-json.js'
export { toWsOrigin, type PeerHost } from './config.js'
export { backfillDid, type BackfillResult, type BackfilledRecord } from './backfill.js'
