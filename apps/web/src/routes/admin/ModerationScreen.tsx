import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AdminLayout } from './AdminLayout';
import { adminErrorSentence } from './adminErrors';
import { Button } from '../../components/bits';
import { ApiError } from '../../lib/api';
import { useApproveModerationMutation, useExecuteModerationMutation, useMe, useModerationQueue, useProposeModerationMutation } from '../../lib/queries';
import type { ModerationAction, ModerationItem, ModerationProposeInput } from '../../lib/types';

const ACTION_LABEL: Record<ModerationAction, string> = {
  'curate-listing': 'Curate a listing',
  'remove-listing': 'Remove a listing',
  'restore-listing': 'Restore a listing',
  'set-role': "Set someone's role",
  'suspend-role': "Suspend someone's role",
  'close-request': 'Close a request',
  'void-attendance': 'Void an attendance record',
};
const ACTIONS = Object.keys(ACTION_LABEL) as ModerationAction[];
const MIN_REASON_LENGTH = 10;

/**
 * `/admin/moderation` — the steward queue for `freeschool.draft.moderationAction`.
 *
 * SELF-APPROVAL: the opener's own sign-off is recorded automatically when an
 * item is proposed (`POST /api/admin/moderation`'s `approvals` seed in
 * `apps/appview/src/http/routes/admin.ts`). So the steward who proposed an
 * item and then clicks "Approve" on it always gets back 409 `AlreadyApproved`
 * — that response has no `message` field on the wire (the route returns just
 * `{error, approvals}`), so `ApiError.message` would otherwise fall back to
 * the generic "Request failed with status 409". `adminErrorSentence`
 * (`./adminErrors.ts`) maps that CODE, and `approve`/`execute`'s
 * message-less `NotFound`/`AlreadyResolved`, to specific written sentences
 * instead, per the brief's "never a generic failure" rule. `execute`'s
 * `ErrThresholdNotMet` DOES carry a real message from the server (`deny()`
 * in `app-custody.ts`), so that one is rendered verbatim.
 */
export function ModerationScreen() {
  const { data: me } = useMe();
  const { data, isPending } = useModerationQueue();
  const queryClient = useQueryClient();
  const proposeMutation = useProposeModerationMutation();
  const approveMutation = useApproveModerationMutation();
  const executeMutation = useExecuteModerationMutation();

  const [action, setAction] = useState<ModerationAction>('curate-listing');
  const [subjectUri, setSubjectUri] = useState('');
  const [subjectDid, setSubjectDid] = useState('');
  const [reason, setReason] = useState('');
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [itemResults, setItemResults] = useState<Record<string, string>>({});

  const canPropose = reason.trim().length >= MIN_REASON_LENGTH;

  const onPropose = async () => {
    if (!canPropose) return;
    setProposeError(null);
    const body: ModerationProposeInput = {
      action,
      reason: reason.trim(),
      ...(subjectUri.trim() ? { subjectUri: subjectUri.trim() } : {}),
      ...(subjectDid.trim() ? { subjectDid: subjectDid.trim() } : {}),
    };
    try {
      await proposeMutation.mutateAsync(body);
      setSubjectUri('');
      setSubjectDid('');
      setReason('');
    } catch (err) {
      setProposeError(err instanceof ApiError ? err.message : 'Could not open that item. Try again.');
    }
  };

  const onApprove = async (id: string) => {
    setItemErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      await approveMutation.mutateAsync(id);
    } catch (err) {
      setItemErrors((prev) => ({ ...prev, [id]: adminErrorSentence(err, 'Could not approve. Try again.') }));
      // The item may have vanished from the queue since it was loaded — refetch
      // rather than leave a stale row the steward can keep clicking.
      if (err instanceof ApiError && err.code === 'NotFound') {
        void queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      }
    }
  };

  const onExecute = async (id: string) => {
    setItemErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      const result = await executeMutation.mutateAsync(id);
      setItemResults((prev) => ({ ...prev, [id]: result.ok ? 'Done.' : 'Could not run it.' }));
    } catch (err) {
      setItemErrors((prev) => ({ ...prev, [id]: adminErrorSentence(err, 'Could not run it. Try again.') }));
      // Another steward may have already run it, or it may be gone entirely —
      // either way the stale row needs a fresh read, not another click.
      if (err instanceof ApiError && (err.code === 'NotFound' || err.code === 'AlreadyResolved')) {
        void queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      }
    }
  };

  const requiredApprovals = data?.requiredApprovals ?? 1;
  const items = data?.items ?? [];

  return (
    <AdminLayout title="Moderation" current="moderation" standfirst="Open, approve, and run destructive actions — every one needs a written reason.">
      <section aria-labelledby="propose-heading" className="mb-7">
        <h2 id="propose-heading" className="mb-2.5 text-lede font-bold">
          Open an item
        </h2>
        <div className="plate space-y-3 p-3.5">
          <label className="block">
            <span className="text-caption text-ink-soft">Action</span>
            <select
              className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={action}
              onChange={(e) => setAction(e.target.value as ModerationAction)}
            >
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABEL[a]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-caption text-ink-soft">Subject record (at://…) — if this targets a record</span>
            <input
              className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={subjectUri}
              onChange={(e) => setSubjectUri(e.target.value)}
              placeholder="at://…"
            />
          </label>
          <label className="block">
            <span className="text-caption text-ink-soft">Subject DID — if this targets a person</span>
            <input
              className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={subjectDid}
              onChange={(e) => setSubjectDid(e.target.value)}
              placeholder="did:…"
            />
          </label>
          <label className="block">
            <span className="text-caption text-ink-soft">Reason — required, at least {MIN_REASON_LENGTH} characters</span>
            <textarea
              className="mt-1.5 min-h-[72px] w-full resize-none border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
              value={reason}
              maxLength={1000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {proposeError ? <p className="text-body text-pink">{proposeError}</p> : null}
          <Button wide onClick={() => void onPropose()} disabled={!canPropose || proposeMutation.isPending}>
            Open item
          </Button>
        </div>
      </section>

      <section aria-labelledby="queue-heading">
        <h2 id="queue-heading" className="mb-2.5 text-lede font-bold">
          Queue
        </h2>
        {isPending ? <p className="text-body text-ink-soft">Loading…</p> : null}
        {!isPending && items.length === 0 ? <p className="text-body text-ink-soft">Nothing open right now.</p> : null}
        <ul className="space-y-3">
          {items.map((item) => (
            <QueueItemCard
              key={item.id}
              item={item}
              requiredApprovals={requiredApprovals}
              viewerDid={me?.did}
              error={itemErrors[item.id]}
              result={itemResults[item.id]}
              onApprove={() => void onApprove(item.id)}
              onExecute={() => void onExecute(item.id)}
              approving={approveMutation.isPending}
              executing={executeMutation.isPending}
            />
          ))}
        </ul>
      </section>
    </AdminLayout>
  );
}

function QueueItemCard({
  item,
  requiredApprovals,
  viewerDid,
  error,
  result,
  onApprove,
  onExecute,
  approving,
  executing,
}: {
  item: ModerationItem;
  requiredApprovals: number;
  viewerDid: string | undefined;
  error: string | undefined;
  result: string | undefined;
  onApprove: () => void;
  onExecute: () => void;
  approving: boolean;
  executing: boolean;
}) {
  const approvalCount = item.approvals.length;
  const met = approvalCount >= requiredApprovals;
  const alreadyApproved = viewerDid ? item.approvals.some((a) => a.stewardDid === viewerDid) : false;
  const resolved = item.status !== 'open';

  return (
    <li className="plate space-y-3 p-3.5">
      <div>
        <p className="text-body font-bold">{ACTION_LABEL[item.action] ?? item.action}</p>
        {item.subjectUri ? <p className="mt-0.5 break-all text-caption text-ink-soft">{item.subjectUri}</p> : null}
        {item.subjectDid ? <p className="mt-0.5 break-all text-caption text-ink-soft">{item.subjectDid}</p> : null}
      </div>
      <p className="text-body">{item.reason}</p>
      <p className="text-caption text-ink-faint">
        {approvalCount} of {requiredApprovals} stewards approved{resolved ? ` — ${item.status}` : ''}
      </p>

      {/* Public-projection preview: state + category only, never the reason
          or a DID — this is what a non-steward viewer sees if this record
          ever surfaces publicly. */}
      <div className="border-l-[3px] border-amber pl-3">
        <p className="text-caption text-ink-soft">
          What the public sees — state: {item.status}, category: {item.action}
        </p>
      </div>

      {!resolved ? (
        <div className="flex flex-wrap gap-3">
          <Button
            ink="blue"
            onClick={onApprove}
            disabled={approving || alreadyApproved}
          >
            {alreadyApproved ? 'Approved' : 'Approve'}
          </Button>
          <Button ink="green" onClick={onExecute} disabled={executing || !met}>
            Run it
          </Button>
        </div>
      ) : null}
      {!met && !resolved ? <p className="text-caption text-ink-faint">Needs {requiredApprovals - approvalCount} more approval(s) before it can run.</p> : null}
      {error ? <p className="text-body text-pink">{error}</p> : null}
      {result ? <p className="text-body text-green">{result}</p> : null}
    </li>
  );
}
