import { useState } from 'react';
import { LoadingState, PageState } from '../../components/PageState';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/bits';
import { SkillPicker } from '../../components/SkillPicker';
import { AdminLayout } from './AdminLayout';
import { adminErrorSentence } from './adminErrors';
import { useDeprecateSkillMutation, useMoveSkillMutation, useSkillProposals, useSkillTree } from '../../lib/queries';
import { flattenSkills, parentOptions, SKILL_PATH_SEPARATOR } from '../../lib/skills';
import type { SkillProposalItem } from '../../lib/types';

/** `d LLL yyyy`-ish, locale-formatted; falls back to the raw ISO string on a
 * malformed date rather than showing "Invalid Date". */
function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * `/admin/skills` — the steward view of `freeschool.draft.skill` proposals (R-6:
 * a member's proposal publishes immediately; a steward's only two levers are
 * **Deprecate** and **Move**, both via `SchoolActorPort` on the server). Every row
 * comes from `GET /api/admin/skills/proposals`, newest first (`useSkillProposals`).
 *
 * The Move sheet reuses `SkillPicker` (Task 9) restricted to `parentOptions()` —
 * domains and areas only (depth ≤ 1) — over the full taxonomy from `useSkillTree`,
 * same as `ProposeSkillSheet`'s own parent picker.
 */
export function SkillsAdminScreen() {
  const { data, isPending, isError, refetch } = useSkillProposals();
  const { data: tree } = useSkillTree();
  const deprecateMutation = useDeprecateSkillMutation();
  const moveMutation = useMoveSkillMutation();

  const [deprecateTarget, setDeprecateTarget] = useState<SkillProposalItem | null>(null);
  const [moveTarget, setMoveTarget] = useState<SkillProposalItem | null>(null);
  const [moveParentUri, setMoveParentUri] = useState('');
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const parents = parentOptions(flattenSkills(tree?.skills ?? []));
  const proposals = data?.proposals ?? [];

  const closeDeprecate = () => setDeprecateTarget(null);
  const closeMove = () => {
    setMoveTarget(null);
    setMoveParentUri('');
  };

  const onConfirmDeprecate = async () => {
    if (!deprecateTarget) return;
    const { id } = deprecateTarget;
    setRowErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      await deprecateMutation.mutateAsync({ id, body: {} });
      closeDeprecate();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [id]: adminErrorSentence(err, 'Could not deprecate this skill. Try again.') }));
    }
  };

  const onConfirmMove = async () => {
    if (!moveTarget || !moveParentUri) return;
    const { id } = moveTarget;
    setRowErrors((prev) => ({ ...prev, [id]: '' }));
    try {
      await moveMutation.mutateAsync({ id, body: { parentUri: moveParentUri } });
      closeMove();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [id]: adminErrorSentence(err, 'Could not move this skill. Try again.') }));
    }
  };

  return (
    <AdminLayout
      title="Skills"
      current="skills"
      standfirst="Review what members have proposed for the shared taxonomy."
    >
      {isPending ? <LoadingState label="Loading proposed skills…" /> : null}
      {isError ? (
        <PageState
          title="Proposed skills couldn’t load."
          error
          action={
            <button className="primary-action" onClick={() => void refetch()}>
              Try again
            </button>
          }
        />
      ) : null}
      {!isPending && !isError && proposals.length === 0 ? (
        <p className="text-body text-ink-soft">No proposed skills yet. Members can propose one from any skill picker.</p>
      ) : null}
      {!isPending && !isError && proposals.length > 0 ? (
        <ul className="space-y-3">
          {proposals.map((p) => {
            const deprecated = p.status === 'deprecated';
            return (
              <li key={p.id} className="plate space-y-2 p-3.5">
                <div>
                  <p className="text-body font-bold">{p.label ?? p.id}</p>
                  {p.path.length > 0 ? (
                    <p className="text-caption text-ink-soft">{p.path.join(SKILL_PATH_SEPARATOR)}</p>
                  ) : null}
                </div>
                <p className="text-caption text-ink-faint">
                  Proposed by {p.proposerHandle ?? 'a member'} on {formatDate(p.proposedAt)}
                </p>
                {deprecated ? (
                  <p className="text-caption text-ink-faint">Deprecated.</p>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <Button ink="pink" variant="quiet" onClick={() => setDeprecateTarget(p)}>
                      Deprecate
                    </Button>
                    <Button
                      ink="blue"
                      variant="quiet"
                      onClick={() => {
                        setMoveTarget(p);
                        setMoveParentUri('');
                      }}
                    >
                      Move
                    </Button>
                  </div>
                )}
                {rowErrors[p.id] ? (
                  <p role="alert" className="text-body text-pink">
                    {rowErrors[p.id]}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <Sheet open={deprecateTarget !== null} onClose={closeDeprecate} title="Deprecate this skill?">
        <p className="text-body">
          {deprecateTarget ? (deprecateTarget.label ?? deprecateTarget.id) : ''} will no longer show as an active
          skill anywhere in the app. This can’t be undone from here.
        </p>
        <div className="mt-5 flex gap-3 pb-1">
          <Button ink="pink" onClick={() => void onConfirmDeprecate()} disabled={deprecateMutation.isPending}>
            Deprecate
          </Button>
          <Button ink="ink" variant="quiet" onClick={closeDeprecate}>
            Cancel
          </Button>
        </div>
      </Sheet>

      <Sheet open={moveTarget !== null} onClose={closeMove} title="Move this skill">
        <p className="text-body text-ink-soft">
          Choose the domain or area {moveTarget ? (moveTarget.label ?? moveTarget.id) : ''} should live under.
        </p>
        <div className="mt-3">
          <SkillPicker
            skills={parents}
            value={moveParentUri}
            onChange={(uri) => setMoveParentUri(uri)}
            label="New parent"
            placeholder="Start typing a domain or area"
            clearLabel="Change"
          />
        </div>
        <div className="mt-5 flex gap-3 pb-1">
          <Button ink="blue" onClick={() => void onConfirmMove()} disabled={!moveParentUri || moveMutation.isPending}>
            Move this skill here
          </Button>
          <Button ink="ink" variant="quiet" onClick={closeMove}>
            Cancel
          </Button>
        </div>
      </Sheet>
    </AdminLayout>
  );
}
