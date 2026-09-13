import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { Screen } from '../components/Screen';
import { Button } from '../components/bits';
import { SessionGate } from '../components/SessionGate';
import { ApiError } from '../lib/api';
import { useEvent, useFeedbackSubmitMutation } from '../lib/queries';
import type { FeedbackInput } from '../lib/types';

/** Verbatim from the plan — do not paraphrase. */
const ANONYMITY_SENTENCE =
  'Your answers are anonymous. The host only sees a summary once enough people respond.';

type Aspect = 'knowledge' | 'teaching' | 'experience';

const DIALS: Array<{ key: Aspect; label: string }> = [
  { key: 'knowledge', label: 'Knew the material' },
  { key: 'teaching', label: 'Taught it well' },
  { key: 'experience', label: 'The experience' },
];

/** The three points on every dial. The mean of whichever were answered
 * decides `direction` — there is no separate thumbs up/down control. */
const LEVELS: Array<{ value: 1 | 2 | 3; label: string }> = [
  { value: 1, label: 'Not much' },
  { value: 2, label: 'Some' },
  { value: 3, label: 'A lot' },
];

/**
 * `/events/$id/feedback` — one anonymous ballot, for `POST /api/feedback`
 * (`apps/appview/src/http/routes/feedback.ts`). Eligibility (attendance
 * checked off, within the 14-day window, one ballot per person) is entirely
 * the server's call: this screen never pre-guesses it from `viewerRelation`,
 * it just attempts the submission and surfaces whatever the server says —
 * the 403 message verbatim, or a dedicated state for the 409 `AlreadyVoted`.
 */
export function FeedbackScreen() {
  const { id } = useParams({ from: '/events/$id/feedback' });
  const { data: event } = useEvent(id);
  const submitMutation = useFeedbackSubmitMutation();

  const [ratings, setRatings] = useState<Partial<Record<Aspect, 1 | 2 | 3>>>({});
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const [alreadyVoted, setAlreadyVoted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answered = Object.values(ratings).filter((v): v is 1 | 2 | 3 => typeof v === 'number');
  const canSubmit = answered.length > 0 && !submitMutation.isPending;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setError(null);
    setAlreadyVoted(false);
    const average = answered.reduce((sum, v) => sum + v, 0) / answered.length;
    const body: FeedbackInput = {
      eventUri: id,
      direction: average >= 2 ? 'positive' : 'negative',
      ...(Object.keys(ratings).length ? { aspects: ratings } : {}),
      ...(note.trim() ? { text: note.trim() } : {}),
    };
    try {
      await submitMutation.mutateAsync(body);
      setSent(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'AlreadyVoted') {
        setAlreadyVoted(true);
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Could not send feedback. Try again.');
      }
    }
  };

  return (
    <Screen title="Feedback" standfirst={ANONYMITY_SENTENCE} back>
      <div className="safe-x space-y-5">
        <SessionGate prompt="Sign in to leave feedback.">
          {sent ? (
            <div className="plate plate-green p-4">
              <p className="text-body">
                Thanks — this helps {event?.name ?? 'the host'} teach it better next time.
              </p>
            </div>
          ) : alreadyVoted ? (
            <div className="plate plate-amber p-4">
              <p className="text-body">You've already left feedback for this class. One ballot per person.</p>
            </div>
          ) : (
            <>
              {DIALS.map(({ key, label }) => (
                <fieldset key={key} className="plate p-3.5">
                  <legend className="text-body font-bold">{label}</legend>
                  <div className="mt-2 flex flex-wrap gap-4">
                    {LEVELS.map((level) => (
                      <label key={level.value} className="flex items-center gap-1.5 text-caption">
                        <input
                          type="radio"
                          name={key}
                          checked={ratings[key] === level.value}
                          onChange={() => setRatings((prev) => ({ ...prev, [key]: level.value }))}
                        />
                        {level.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}

              <label className="block">
                <span className="text-caption text-ink-soft">Anything else? (optional)</span>
                <textarea
                  className="mt-1.5 min-h-[88px] w-full resize-none border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Whatever would help next time."
                />
              </label>

              {error ? <p className="text-body text-pink">{error}</p> : null}

              <Button wide ink="green" disabled={!canSubmit} onClick={() => void onSubmit()}>
                Send feedback
              </Button>
            </>
          )}
        </SessionGate>
      </div>
    </Screen>
  );
}
