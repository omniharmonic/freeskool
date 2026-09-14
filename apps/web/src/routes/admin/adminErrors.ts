import { ApiError } from '../../lib/api';

/**
 * Server codes confirmed (by reading the route, and — for `AlreadyApproved`,
 * `ErrThresholdNotMet`, `AlreadySent` — by a live run against the real
 * AppView, see the Task 8 report) to carry NO `message` field on the wire.
 * `request()` in `lib/api.ts` falls back to the generic "Request failed
 * with status N" whenever that happens, which the brief forbids surfacing
 * anywhere in the admin screens. Keyed by `ApiError.code`, scoped to the
 * codes that are actually message-less; a code the server DOES send a real
 * message for (moderation's own `InvalidRequest`, `ErrThresholdNotMet`,
 * `AlreadySent`, …) is never looked up here — `adminErrorSentence` only
 * consults this table when `ApiError.message` is still the generic string.
 */
const CODE_SENTENCES: Partial<Record<string, string>> = {
  // `POST /api/admin/moderation/:id/approve` when the caller already
  // approved (almost always the steward who opened it — their own approval
  // is seeded at open time).
  AlreadyApproved:
    'You already signed off on this when you opened it — a different steward needs to approve before it can run.',
  // `PUT /api/admin/peers` when `add`/`remove` fails its zod shape (`add`
  // must be a URL) — `peersBody.safeParse` failing returns just `{error}`.
  InvalidRequest: "That doesn't look like a PDS address. Use a full https:// URL.",
  // `POST /api/admin/moderation/:id/approve` or `.../execute` when the item
  // has vanished from `fs_moderation_queue` between load and click.
  NotFound: 'This item is no longer in the queue.',
  // `POST /api/admin/moderation/:id/execute` when another steward already
  // ran it first.
  AlreadyResolved: 'Another steward already ran this. Refreshing the queue.',
  // `POST /api/admin/skills/:id/deprecate` or `.../move` (503) when this
  // school has no curation authority configured — same condition
  // `ProposeSkillSheet` handles for proposals.
  AuthorityUnavailable: 'Proposing and editing skills is not switched on for this school yet.',
  // Same endpoints (502) when `SchoolActorPort` itself failed to write the
  // change as the school.
  AuthorityError: 'The taxonomy account could not save that change. Try again in a moment.',
};

function isGenericFallback(err: ApiError): boolean {
  return err.message === `Request failed with status ${err.status}`;
}

/**
 * Turns a caught error into a specific, written sentence — never the
 * generic network-layer fallback. When the server sent a real message
 * (e.g. `ErrThresholdNotMet`, `AlreadySent`), that message is returned
 * verbatim, per the brief's "render the server's message" rule; only a
 * message-less response is mapped through `CODE_SENTENCES` first.
 */
export function adminErrorSentence(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  if (err.code && isGenericFallback(err)) {
    const sentence = CODE_SENTENCES[err.code];
    if (sentence) return sentence;
  }
  return err.message || fallback;
}
