import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { SkillChip } from './bits';
import { ProposeSkillSheet } from './ProposeSkillSheet';
import { proposeParentFor, searchSkills, skillContext, type FlatSkill } from '../lib/skills';

/**
 * Type-ahead over the skill taxonomy.
 *
 * Benjamin's note on the three `<select>`s this replaces: "I should be able to
 * type it in instead of doing a dropdown." 745 nodes is past the point where a
 * dropdown is a list you read — it is a list you scroll past.
 *
 * Built to the WAI-ARIA 1.2 combobox pattern with list autocomplete: the text
 * box itself carries `role="combobox"`, the results are a sibling
 * `role="listbox"` it points at with `aria-controls`, and the keyboard focus
 * stays in the box while `aria-activedescendant` names the highlighted row.
 * Nothing is highlighted until the first ArrowDown, so a member who types a
 * whole name and presses Enter gets the top match rather than whatever the
 * cursor happened to be resting on.
 *
 * Once something is chosen the box collapses to a chip: the full breadcrumb,
 * a "Sensitive" marker for Tier B, and one button back to searching.
 */

export const PROPOSE_ROW_LABEL = "Can't find it? Propose a skill";

const MAX_ROWS = 12;

/** Row in the popup: a real skill, or the propose escape hatch at the end. */
type Row = { kind: 'skill'; skill: FlatSkill } | { kind: 'propose' };

export interface SkillPickerProps {
  /** The flattened taxonomy — `flattenSkills(useSkillTree().data?.skills ?? [])`. */
  skills: FlatSkill[];
  /** The chosen skill's uri, or '' for nothing chosen. */
  value: string;
  /**
   * `skill` is the chosen node, so a caller can react to its tier without a
   * second lookup; it is `undefined` when the value was cleared, and when a
   * just-proposed skill is not in the tree yet.
   */
  onChange: (uri: string, skill?: FlatSkill) => void;
  /** The text box's accessible name. */
  label?: string;
  placeholder?: string;
  /** Offers the "propose a skill" row, and the sheet behind it. */
  allowPropose?: boolean;
  /** The chip's button — "Change" on the screens that had one before. */
  clearLabel?: string;
  /** Shown under the box while nothing is chosen. */
  hint?: ReactNode;
}

export function SkillPicker({
  skills,
  value,
  onChange,
  label = 'Search the skill taxonomy',
  placeholder = 'Start typing a skill',
  allowPropose = false,
  clearLabel = 'Change',
  hint,
}: SkillPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [proposing, setProposing] = useState(false);
  /** A skill proposed this session is not in `skills` until `['skills']`
   * refetches — hold its label so the chip never flashes a raw at:// uri. */
  const [proposed, setProposed] = useState<{ uri: string; label: string } | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => searchSkills(skills, query, MAX_ROWS), [skills, query]);
  const rows: Row[] = useMemo(() => {
    const list: Row[] = matches.map((skill) => ({ kind: 'skill', skill }));
    if (allowPropose && query.trim()) list.push({ kind: 'propose' });
    return list;
  }, [matches, allowPropose, query]);

  const expanded = open && rows.length > 0;
  const activeRowId = expanded && active >= 0 ? `${baseId}-row-${active}` : undefined;

  // Keep the highlight inside the list as it shrinks under the next keystroke.
  useEffect(() => {
    setActive((current) => (current >= rows.length ? -1 : current));
  }, [rows.length]);

  const selected = skills.find((skill) => skill.uri === value);

  const choose = (row: Row) => {
    if (row.kind === 'propose') {
      setOpen(false);
      setProposing(true);
      return;
    }
    onChange(row.skill.uri, row.skill);
    setQuery('');
    setOpen(false);
    setActive(-1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (rows.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((current) => {
        const next = current < 0 ? (step === 1 ? 0 : rows.length - 1) : current + step;
        return (next + rows.length) % rows.length;
      });
      return;
    }
    if (event.key === 'Enter') {
      if (!expanded) return;
      event.preventDefault();
      const row = active >= 0 ? rows[active] : rows[0];
      if (row) choose(row);
      return;
    }
    if (event.key === 'Escape') {
      if (!open) return;
      // Stopped here so Esc closes the popup rather than the Sheet this
      // picker is often inside of — `Sheet`'s own `onCancel` is what would
      // otherwise take the keystroke.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    }
  };

  const proposeSheet = allowPropose ? (
    <ProposeSkillSheet
      open={proposing}
      onClose={() => setProposing(false)}
      skills={skills}
      initialLabel={query}
      defaultParentUri={matches[0] ? proposeParentFor(matches[0]) : ''}
      onProposed={(uri, proposedLabel) => {
        setProposed({ uri, label: proposedLabel });
        onChange(uri, undefined);
        setQuery('');
        setActive(-1);
      }}
    />
  ) : null;

  if (value) {
    const shown = selected?.path ?? (proposed?.uri === value ? proposed.label : value);
    return (
      <>
        <div className="flex min-h-[44px] items-center justify-between gap-3 border-[1.5px] border-ink bg-sheet px-3 py-2">
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-body">
            <span>{shown}</span>
            {selected?.tier === 'B' ? <SkillChip ink="pink">Sensitive</SkillChip> : null}
          </span>
          <button
            type="button"
            className="-my-2 shrink-0 px-1 py-2 text-caption text-blue"
            onClick={() => onChange('')}
          >
            {clearLabel}
          </button>
        </div>
        {proposeSheet}
      </>
    );
  }

  return (
    <>
      <div
        className="relative"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={expanded}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          {...(activeRowId ? { 'aria-activedescendant': activeRowId } : {})}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-h-[44px] w-full border-[1.5px] border-ink bg-sheet px-3 py-2.5 text-body outline-none focus-visible:outline-2"
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => {
            if (query.trim()) setOpen(true);
          }}
        />
        {/* Always in the DOM so `aria-controls` never dangles; `hidden` takes
            it out of the accessibility tree while the popup is collapsed. */}
        <ul
          id={listboxId}
          role="listbox"
          // Deliberately NOT the text box's own name: the list stays in the
          // DOM while collapsed, and a second element answering to "Search the
          // skill taxonomy" makes every `getByLabelText` on the page ambiguous.
          aria-label="Matching skills"
          hidden={!expanded}
          className="mt-1.5 max-h-[46vh] divide-y divide-rule overflow-y-auto overscroll-contain border-[1.5px] border-ink bg-sheet"
        >
          {expanded
            ? rows.map((row, index) => {
              const isActive = index === active;
              const rowId = `${baseId}-row-${index}`;
              const background = isActive ? 'var(--c-paper-3)' : 'transparent';
              if (row.kind === 'propose') {
                return (
                  <li
                    key="propose"
                    id={rowId}
                    role="option"
                    aria-selected={isActive}
                    style={{ background }}
                    className="flex min-h-[44px] cursor-pointer items-center px-3 py-2.5 text-caption font-bold text-blue"
                    // Keeps the text box's blur from tearing the list down
                    // before the tap turns into a click.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(row)}
                  >
                    {PROPOSE_ROW_LABEL}
                  </li>
                );
              }
              const context = skillContext(row.skill);
              return (
                <li
                  key={row.skill.uri}
                  id={rowId}
                  role="option"
                  aria-selected={isActive}
                  style={{ background }}
                  className="min-h-[44px] cursor-pointer px-3 py-2 text-left"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(row)}
                >
                  <span className="block text-body leading-snug">{row.skill.label}</span>
                  {context ? <span className="block text-caption text-ink-soft">{context}</span> : null}
                </li>
              );
              })
            : null}
        </ul>
        {hint && !expanded ? <div className="mt-1.5 text-caption text-ink-faint">{hint}</div> : null}
      </div>
      {proposeSheet}
    </>
  );
}

export interface SkillMultiPickerProps extends Omit<SkillPickerProps, 'value' | 'onChange' | 'clearLabel'> {
  values: string[];
  onChange: (uris: string[]) => void;
}

/**
 * The same combobox over a chip list. Choosing appends (never twice — a
 * second pick of the same skill is a no-op rather than a duplicate row), and
 * each chip carries its own "Remove <label>" button.
 */
export function SkillMultiPicker({ skills, values, onChange, ...rest }: SkillMultiPickerProps) {
  return (
    <div>
      {values.length > 0 ? (
        <ul className="mb-2 space-y-1.5">
          {values.map((uri) => {
            const skill = skills.find((candidate) => candidate.uri === uri);
            return (
              <li
                key={uri}
                className="flex min-h-[44px] items-center justify-between gap-3 border-[1.5px] border-ink bg-sheet px-3 py-2"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2 text-body">
                  <span>{skill?.path ?? uri}</span>
                  {skill?.tier === 'B' ? <SkillChip ink="pink">Sensitive</SkillChip> : null}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${skill?.label ?? uri}`}
                  className="-my-2 shrink-0 px-1 py-2 text-caption text-blue"
                  onClick={() => onChange(values.filter((kept) => kept !== uri))}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <SkillPicker
        {...rest}
        skills={skills}
        value=""
        onChange={(uri) => {
          if (!uri) return;
          onChange(values.includes(uri) ? values : [...values, uri]);
        }}
      />
    </div>
  );
}
