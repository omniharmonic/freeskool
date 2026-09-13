import { useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { Button } from '../../components/bits';
import { QrCode } from '../../components/QrCode';
import { ApiError } from '../../lib/api';
import { useHandoffStartMutation } from '../../lib/queries';
import type { HandoffStartResult } from '../../lib/types';

const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * `/admin/handoff` — `POST /api/admin/handoff` (steward-only; the surrounding
 * `AdminLayout` already enforces that). A created link is kept ONLY in this
 * component's own state: there is no "list pending hand-offs" endpoint on the
 * AppView (`apps/appview/src/http/routes/handoff.ts` has `propose`/`accept`,
 * nothing else), so a page reload loses it — the copy below says so plainly
 * rather than implying a history that doesn't exist.
 */
export function HandoffScreen() {
  const startMutation = useHandoffStartMutation();
  const [toHandleOrDid, setToHandleOrDid] = useState('');
  const [created, setCreated] = useState<HandoffStartResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const onCreate = async () => {
    setError(null);
    setCopied(false);
    try {
      const result = await startMutation.mutateAsync(
        toHandleOrDid.trim() ? { toHandleOrDid: toHandleOrDid.trim() } : {},
      );
      setCreated(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create a hand-off link. Try again.');
    }
  };

  const onCopy = () => {
    if (!created) return;
    navigator.clipboard?.writeText(created.url).then(
      () => setCopied(true),
      () => undefined,
    );
  };

  return (
    <AdminLayout
      title="Hand-off"
      current="handoff"
      standfirst="Any steward can hand stewardship to another member at any time, so this school never depends on one person staying forever."
    >
      <div className="space-y-5">
        <label className="block">
          <span className="block text-caption text-ink-soft">Hand it to someone specific (optional)</span>
          <input
            className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2"
            value={toHandleOrDid}
            onChange={(e) => setToHandleOrDid(e.target.value)}
            placeholder="a handle or DID, or leave blank for whoever holds the link"
          />
        </label>

        {error ? <p className="text-body text-pink">{error}</p> : null}

        <Button wide onClick={() => void onCreate()} disabled={startMutation.isPending}>
          Create hand-off link
        </Button>

        {created ? (
          <div className="plate space-y-3 p-4">
            <p className="break-all text-body">{created.url}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button ink="blue" onClick={onCopy}>
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <QrCode value={created.url} />
            </div>
            <p className="text-caption text-ink-soft">
              Works once, and expires {dateTimeFormat.format(new Date(created.expiresAt))}.
            </p>
            <p className="text-caption text-ink-faint">
              This is the most recently created link from this session only — there is no list of pending
              hand-offs yet.
            </p>
          </div>
        ) : null}
      </div>
    </AdminLayout>
  );
}
