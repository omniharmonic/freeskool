import { useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheet';
import { Button } from './bits';
import { SkillPicker } from './SkillPicker';
import { ApiError } from '../lib/api';
import { useProposeSkillMutation } from '../lib/queries';
import { parentOptions, type FlatSkill } from '../lib/skills';
import type { SkillExistsBody } from '../lib/types';

/**
 * "Can't find it? Propose a skill" — the end of the picker's list.
 *
 * A proposal is a name and the area it belongs under, nothing more: a member
 * should never have to argue a taxonomy case to say what they can teach. The
 * parent list is deliberately domains and areas only, so a proposal lands
 * somewhere a steward can find it rather than at the root.
 *
 * Two answers from the server are real answers rather than failures, and both
 * are shown as plain sentences: 409 `SkillExists` means the taxonomy already
 * covers it under another name (the existing node is selected for the member,
 * so the sentence is a correction, not a dead end), and 503
 * `AuthorityUnavailable` means this school has no curation authority set up.
 */

export interface ProposeSkillSheetProps {
  open: boolean;
  onClose: () => void;
  skills: FlatSkill[];
  /** Prefills the name with whatever was typed into the picker. */
  initialLabel?: string;
  /** The area of the picker's best current match. */
  defaultParentUri?: string;
  onProposed: (uri: string, label: string) => void;
}

export function ProposeSkillSheet({
  open,
  onClose,
  skills,
  initialLabel = '',
  defaultParentUri = '',
  onProposed,
}: ProposeSkillSheetProps) {
  const proposeMutation = useProposeSkillMutation();
  const [label, setLabel] = useState(initialLabel);
  const [description, setDescription] = useState('');
  const [parentUri, setParentUri] = useState(defaultParentUri);
  const [notice, setNotice] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Reopening starts clean, and picks up whatever the picker had typed by then.
  // Guarded on the open TRANSITION, not on `open` being true: selecting the
  // existing skill after a 409 clears the picker's query, which changes
  // `initialLabel`/`defaultParentUri` under a sheet that is still open — and a
  // plain `[open, initialLabel, defaultParentUri]` effect would wipe the very
  // message that explains what just happened.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setLabel(initialLabel);
      setDescription('');
      setParentUri(defaultParentUri);
      setNotice(null);
      setDone(false);
    }
    wasOpen.current = open;
  }, [open, initialLabel, defaultParentUri]);

  const areas = parentOptions(skills);

  const close = () => {
    setNotice(null);
    onClose();
  };

  const submit = async () => {
    setNotice(null);
    try {
      const created = await proposeMutation.mutateAsync({
        label: label.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        parentUri,
      });
      onProposed(created.uri, created.label);
      setDone(true);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SkillExists') {
        const existing = (err.body as SkillExistsBody | undefined)?.existing;
        if (existing) {
          setNotice(`That skill already exists: ${existing.label}`);
          onProposed(existing.uri, existing.label);
          return;
        }
      }
      if (err instanceof ApiError && err.status === 503) {
        setNotice('Proposing skills is not switched on for this school yet');
        return;
      }
      setNotice(err instanceof ApiError ? err.message : 'Could not propose this skill. Try again.');
    }
  };

  const field =
    'mt-1.5 min-h-[44px] w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2';

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Propose a skill"
      footer={
        <Button
          wide
          onClick={() => void submit()}
          disabled={label.trim().length < 2 || !parentUri || proposeMutation.isPending || done}
        >
          Propose this skill
        </Button>
      }
    >
      <p className="text-body text-ink-soft">
        Name it the way you would say it out loud. A steward files it into the taxonomy later — nothing here
        waits on that.
      </p>
      <label className="mt-4 block">
        <span className="text-caption text-ink-soft">What is it called?</span>
        <input
          className={field}
          value={label}
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Sharpening hand tools"
        />
      </label>
      <label className="mt-4 block">
        <span className="text-caption text-ink-soft">A line about it (optional)</span>
        <textarea
          className={`${field} min-h-[88px] resize-none`}
          value={description}
          maxLength={500}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="What someone would actually learn to do."
        />
      </label>
      <div className="mt-4">
        <span className="text-caption text-ink-soft">Which area does it belong under?</span>
        <div className="mt-1.5">
          <SkillPicker
            skills={areas}
            value={parentUri}
            onChange={(uri) => setParentUri(uri)}
            label="Area this skill belongs under"
            placeholder="Start typing an area"
            clearLabel="Change"
          />
        </div>
      </div>
      {notice ? (
        <p role="alert" className="mt-3 text-body text-pink">
          {notice}
        </p>
      ) : null}
    </Sheet>
  );
}
