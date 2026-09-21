import { useEffect, useState } from 'react';
import { Button } from './bits';
import { ApiError } from '../lib/api';
import { useHandleCheck, useSetHandleMutation } from '../lib/queries';

/** Mirror of the server's rule — `HANDLE_PREFIX_RE` in `apps/appview/src/lib/handles.ts:37`.
 * Keep the two identical: a client that is stricter refuses handles the school would
 * happily give out, and a client that is looser sends requests that can only 400. */
export const HANDLE_PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$/;

/**
 * Mirror of the server's reserved list — `RESERVED_LABELS` in
 * `apps/appview/src/lib/handles.ts`. The PWA cannot import server code, so this is a
 * copy; keep the two identical (`HandleChooser.test.tsx` and `handles.test.ts` both
 * pin the same array).
 *
 * These are labels the edge may hand to a school (`boulder.freeskool.xyz` serves
 * Boulder) or to infrastructure, so they can never be a member's handle host. The
 * server is still the authority — it also knows the school labels this deployment
 * runs, which are config, not a constant. This copy only answers the obvious ones
 * sooner, without a round trip.
 */
export const RESERVED_LABELS = [
  'admin', 'www', 'pds', 'skills', 'school', 'help', 'mail', 'api',
  'app', 'static', 'assets', 'internal', 'denver', 'boulder',
  'tributary', 'events', 'directory', 'gate',
];

/** That rule said the way a person would say it. Shown for a prefix that doesn't fit. */
export const HANDLE_RULE = '3 to 20 characters, lowercase letters, numbers and dashes.';

/** The part after the first dot: a member picks the prefix, the school keeps the domain. */
export function handleDomain(fullHandle: string): string {
  const dot = fullHandle.indexOf('.');
  return dot === -1 ? '' : fullHandle.slice(dot + 1);
}

type CheckState = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid' | 'error';

/**
 * Every way `PUT /api/me/handle` can refuse, said in the member's language
 * (UX audit finding 9). The server's own sentence is never shown: during the
 * stack trouble behind that finding, `/welcome` read "Unsupported state or
 * unable to authenticate data" under a member's typed handle. An unmapped
 * code falls through to one plain sentence instead.
 */
function saveErrorMessage(err: unknown): string {
  const fallback = 'Could not save that handle. Try again.';
  if (!(err instanceof ApiError)) return fallback;
  if (err.status === 502) return 'The identity server did not answer. Try again in a moment.';
  switch (err.code) {
    case 'HandleTaken':
      return 'Someone already has that handle.';
    case 'InvalidHandle':
      return HANDLE_RULE;
    case 'NotCustodial':
      return 'This account brought its own handle, so it is changed where that account lives.';
    case 'TooManyHandleChanges':
      return 'You can change your handle three times a day. Try again tomorrow.';
    case 'PdsUnavailable':
      return 'The identity server did not answer. Try again in a moment.';
    default:
      return fallback;
  }
}

/**
 * Choosing a handle, shared by `/welcome`'s first card and the "Your handle"
 * row in Me — the same control in both places, because it is the same act.
 *
 * Only the prefix is typed and only the prefix is sent; the domain comes off
 * the handle the member already has. Availability is checked as they type
 * (debounced 300 ms, `GET /api/me/handle/check`) so a taken name is visible
 * before the save, but the save is still the thing that can fail: the check
 * and the change are two moments, and somebody else can land in between.
 */
export function HandleChooser({
  currentHandle,
  onSaved,
  onCancel,
}: {
  currentHandle: string;
  onSaved?: (handle: string) => void;
  onCancel?: () => void;
}) {
  const domain = handleDomain(currentHandle);
  const [prefix, setPrefix] = useState('');
  const [debounced, setDebounced] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The input already trims and lowercases every keystroke, so `prefix` is the
  // normalized prefix throughout.
  const typed = prefix;
  const wellFormed = HANDLE_PREFIX_RE.test(typed);
  const isReserved = RESERVED_LABELS.includes(typed);

  // Only a syntactically valid prefix is worth asking the server about: "is this
  // spelled right" is answerable here, and answering it here means no request per
  // keystroke while someone is still halfway through typing.
  useEffect(() => {
    // A reserved label is answerable here too, and asking about one would only spend a
    // request to be told what this file already knows.
    if (!wellFormed || isReserved) {
      setDebounced('');
      return;
    }
    const timer = setTimeout(() => setDebounced(typed), 300);
    return () => clearTimeout(timer);
  }, [typed, wellFormed, isReserved]);

  const check = useHandleCheck(debounced);
  const setHandle = useSetHandleMutation();

  let state: CheckState = 'idle';
  if (typed.length === 0) state = 'idle';
  else if (!wellFormed) state = 'invalid';
  else if (isReserved) state = 'reserved';
  else if (typed !== debounced || check.isPending || check.isFetching) state = 'checking';
  else if (check.isError) state = 'error';
  else if (check.data?.available) state = 'available';
  else state = check.data?.reason ?? 'invalid';

  const message: Record<CheckState, string> = {
    idle: '',
    checking: 'Checking…',
    available: `${typed}.${domain} is free`,
    taken: 'That handle is taken. Try another.',
    reserved: 'That handle is reserved. Try another.',
    invalid: HANDLE_RULE,
    error: 'Could not check that handle. Try again.',
  };

  const save = async () => {
    setSaveError(null);
    try {
      const result = await setHandle.mutateAsync(typed);
      setSaved(true);
      setPrefix('');
      setDebounced('');
      onSaved?.(result.handle);
    } catch (err) {
      setSaveError(saveErrorMessage(err));
    }
  };

  if (saved) {
    return (
      <p role="status" className="text-body text-ink-soft">
        Saved. That is how people will find you from now on.
      </p>
    );
  }

  return (
    <div>
      {/* Not a wrapping `<label>`: the domain sits inside the field's row, and a
          label would swallow it into the input's accessible name. */}
      <div className="block">
        <span className="text-caption text-ink-soft">Your handle</span>
        <span className="mt-1.5 flex items-center gap-1.5">
          <input
            aria-label="Your handle"
            value={prefix}
            // Normalized as it is typed, not on submit: a phone capitalizes the first
            // letter of a field by habit, and a capitalized prefix must never reach the
            // server (nor read back as "invalid" to the member who typed it).
            onChange={(event) => setPrefix(event.target.value.trim().toLowerCase())}
            maxLength={20}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="wren"
            className="min-h-[44px] min-w-0 flex-1 border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
          />
          <span className="shrink-0 text-body text-ink-soft">.{domain}</span>
        </span>
      </div>
      <p role="status" className={`mt-1.5 text-caption ${state === 'available' ? 'text-ink-soft' : 'text-ink-faint'}`}>
        {message[state]}
      </p>
      {saveError ? (
        <p role="alert" className="mt-1.5 text-caption text-pink">
          {saveError}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-3">
        <Button
          ink="blue"
          disabled={state !== 'available' || setHandle.isPending}
          onClick={() => void save()}
        >
          {setHandle.isPending ? 'Saving…' : 'Save this handle'}
        </Button>
        {onCancel ? (
          <Button variant="quiet" ink="ink" onClick={onCancel}>
            Keep the one I have
          </Button>
        ) : null}
      </div>
    </div>
  );
}
