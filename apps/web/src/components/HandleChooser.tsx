import { useEffect, useState } from 'react';
import { Button } from './bits';
import { ApiError } from '../lib/api';
import { useHandleCheck, useSetHandleMutation } from '../lib/queries';

/** The rule the server enforces (`^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$`), said
 * the way a person would say it. Shown for a prefix that doesn't fit. */
export const HANDLE_RULE = '3 to 20 characters, lowercase letters, numbers and dashes.';

/** The part after the first dot: a member picks the prefix, the school keeps the domain. */
export function handleDomain(fullHandle: string): string {
  const dot = fullHandle.indexOf('.');
  return dot === -1 ? '' : fullHandle.slice(dot + 1);
}

type CheckState = 'idle' | 'checking' | 'available' | 'taken' | 'reserved' | 'invalid' | 'error';

function saveErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Could not change your handle. Try again.';
  switch (err.code) {
    case 'HandleTaken':
      return 'That handle was just taken. Try another.';
    case 'InvalidHandle':
      return HANDLE_RULE;
    case 'NotCustodial':
      return 'This account brought its own handle, so it is changed where that account lives.';
    case 'TooManyHandleChanges':
      return 'You have changed your handle a few times today. Try again tomorrow.';
    default:
      return err.message;
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

  useEffect(() => {
    const typed = prefix.trim();
    const timer = setTimeout(() => setDebounced(typed), 300);
    return () => clearTimeout(timer);
  }, [prefix]);

  const check = useHandleCheck(debounced);
  const setHandle = useSetHandleMutation();

  const typed = prefix.trim();
  let state: CheckState = 'idle';
  if (typed.length === 0) state = 'idle';
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
            onChange={(event) => setPrefix(event.target.value)}
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
