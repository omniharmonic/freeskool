import { LoadingState, PageState } from '../../components/PageState';
import { useEffect, useState } from 'react';
import { AdminLayout } from './AdminLayout';
import { Button, Toggle } from '../../components/bits';
import { ApiError } from '../../lib/api';
import { useAdminPolicy, useSetPolicyMutation } from '../../lib/queries';
import type { AdminPolicyInput, PolicyThresholds } from '../../lib/types';

const MEMBER_GATE_OPTIONS: Array<{ value: PolicyThresholds['memberRequires']; label: string }> = [
  { value: 'none', label: "No gate — if you say you're part of Free School, you're part of Free School" },
  { value: 'invite-or-vouch', label: 'An invite or a vouch from an existing member' },
  { value: 'attended-one', label: 'Having attended at least one class' },
];

/**
 * `/admin/policy` — plain-language switches and numbers over every field in
 * `freeschool.draft.policy#thresholds`, plus the policy text itself.
 *
 * A WRITE HERE CAN 403: `PUT /api/admin/policy` is a destructive action
 * (`DESTRUCTIVE_ACTIONS` in `packages/school-actor/src/port.ts`) gated on the
 * policy's OWN `destructiveActionStewards` threshold (2 by default) — a lone
 * steward saving alone will get back `ErrThresholdNotMet` unless `approvals`
 * already carries enough co-signing stewards. This screen has no UI to
 * collect a second steward's signature (no such flow exists anywhere yet —
 * moderation's propose/approve/execute queue is the only place that does),
 * so it sends `approvals: []` and simply surfaces whatever the server says.
 * That is the brief's "never a generic failure" rule doing its job: a solo
 * steward school with the default threshold will see the real 403 reason
 * rather than a false "Saved".
 */
export function PolicyScreen() {
  const { data, isPending, isError, refetch } = useAdminPolicy();
  const setPolicyMutation = useSetPolicyMutation();

  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [version, setVersion] = useState('');
  const [thresholds, setThresholds] = useState<PolicyThresholds | null>(null);
  const [reason, setReason] = useState('');
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (initialized || !data) return;
    setTitle(data.record?.title ?? '');
    setText(data.record?.text ?? '');
    setVersion(data.record?.version ?? '');
    setThresholds(data.thresholds);
    setInitialized(true);
  }, [data, initialized]);

  const setThreshold = <K extends keyof PolicyThresholds>(key: K, value: PolicyThresholds[K]) => {
    setThresholds((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const canSave = title.trim().length > 0 && text.trim().length > 0 && version.trim().length > 0 && reason.trim().length >= 3;

  const onSave = async () => {
    if (!canSave || !thresholds) return;
    setError(null);
    setSaved(false);
    const body: AdminPolicyInput = {
      title: title.trim(),
      text: text.trim(),
      version: version.trim(),
      thresholds,
      reason: reason.trim(),
      approvals: [],
    };
    try {
      await setPolicyMutation.mutateAsync(body);
      setSaved(true);
      setReason('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the policy. Try again.');
    }
  };

  return (
    <AdminLayout
      title="Policy"
      current="policy"
      standfirst="Who can join, when hosting unlocks, and how many stewards a removal needs."
    >
      {isError ? <PageState title="The policy couldn’t load." error action={<button className="primary-action" onClick={() => void refetch()}>Try again</button>}>Your changes have not been sent.</PageState> : isPending || !thresholds ? (
        <LoadingState label="Loading the current policy…" />
      ) : (
        <div className="space-y-5">
          <section aria-labelledby="policy-thresholds-heading">
            <h2 id="policy-thresholds-heading" className="mb-2.5 text-lede font-bold">
              Role ladder
            </h2>
            <div className="plate divide-y-[1.5px] divide-rule">
              <fieldset className="m-0 border-0 p-3.5">
                <legend className="p-0 text-body">Who can join</legend>
                <div className="mt-2.5 space-y-2">
                  {MEMBER_GATE_OPTIONS.map((opt) => (
                    <label key={opt.value} className="flex items-start gap-2.5 text-caption">
                      <input
                        type="radio"
                        name="member-requires"
                        className="mt-0.5"
                        checked={thresholds.memberRequires === opt.value}
                        onChange={() => setThreshold('memberRequires', opt.value)}
                      />
                      <span>{opt.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <NumberField
                label="Classes attended before someone can host"
                hint="0 means hosting is open from the start."
                value={thresholds.hostMinAttended}
                min={0}
                max={20}
                onChange={(v) => setThreshold('hostMinAttended', v)}
              />

              <NumberField
                label="Classes hosted before someone is a facilitator"
                hint="Facilitators can also curate the calendar and close requests."
                value={thresholds.facilitatorMinHosted}
                min={0}
                max={50}
                onChange={(v) => setThreshold('facilitatorMinHosted', v)}
              />

              <div className="flex items-center justify-between gap-4 p-3.5">
                <span className="min-w-0">
                  <span className="block text-body">A first-time host's class needs approval first</span>
                  <span className="block text-caption text-ink-soft">Off lets anyone who qualifies post immediately.</span>
                </span>
                <Toggle
                  label="First-event approval"
                  checked={thresholds.firstEventApproval}
                  onChange={(v) => setThreshold('firstEventApproval', v)}
                />
              </div>

              <NumberField
                label="People needed before feedback is shown to a host"
                hint="Keeps any one person's feedback from being identifiable."
                value={thresholds.feedbackK}
                min={2}
                max={10}
                onChange={(v) => setThreshold('feedbackK', v)}
              />

              <NumberField
                label="Stewards needed to approve a removal"
                hint="Removing a listing, suspending a role, voiding attendance, or changing this policy."
                value={thresholds.destructiveActionStewards}
                min={1}
                max={5}
                onChange={(v) => setThreshold('destructiveActionStewards', v)}
              />

              <div className="flex items-center justify-between gap-4 p-3.5">
                <span className="min-w-0">
                  <span className="block text-body">Let qualifying members' roles reach the protocol</span>
                  <span className="block text-caption text-ink-soft">
                    Off by default. Even on, a given member still needs their own opt-in — this never names anyone by
                    itself.
                  </span>
                </span>
                <Toggle
                  label="Publish roles"
                  checked={thresholds.publishRoles ?? false}
                  onChange={(v) => setThreshold('publishRoles', v)}
                />
              </div>
            </div>
          </section>

          <section aria-labelledby="policy-text-heading">
            <h2 id="policy-text-heading" className="mb-2.5 text-lede font-bold">
              Policy text
            </h2>
            <div className="plate space-y-3 p-3.5">
              <label className="block">
                <span className="text-caption text-ink-soft">Title</span>
                <input
                  className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                  value={title}
                  maxLength={120}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="text-caption text-ink-soft">Version</span>
                <input
                  className="mt-1.5 w-full border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                  value={version}
                  maxLength={20}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="e.g. 2026.1"
                />
              </label>
              <label className="block">
                <span className="text-caption text-ink-soft">Text members will read</span>
                <textarea
                  className="mt-1.5 min-h-[140px] w-full resize-y border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
            </div>
          </section>

          <section aria-labelledby="policy-reason-heading">
            <h2 id="policy-reason-heading" className="mb-2.5 text-lede font-bold">
              Why this change
            </h2>
            <label className="block">
              <textarea
                className="min-h-[72px] w-full resize-none border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
                value={reason}
                maxLength={1000}
                placeholder="A written reason, for the audit log."
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
          </section>

          {saved ? <p role="status" className="text-body text-green">Saved — takes effect immediately.</p> : null}
          {error ? <p role="alert" className="text-body text-pink">{error}</p> : null}

          <Button wide onClick={() => void onSave()} disabled={!canSave || setPolicyMutation.isPending}>
            Save policy
          </Button>
        </div>
      )}
    </AdminLayout>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="p-3.5">
      <label className="block">
        <span className="text-body">{label}</span>
        {hint ? <span className="mt-0.5 block text-caption text-ink-soft">{hint}</span> : null}
        <input
          type="number"
          min={min}
          max={max}
          className="mt-1.5 w-24 border-[1.5px] border-ink bg-sheet px-3 py-2 text-body outline-none"
          value={value}
          onChange={(e) => {
            const next = Math.min(max, Math.max(min, Number(e.target.value) || min));
            onChange(next);
          }}
        />
      </label>
    </div>
  );
}
