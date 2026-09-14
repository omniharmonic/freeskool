import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillNode } from '../lib/types';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom has no `<dialog>` showModal/close — Sheet.tsx calls them unconditionally
// in a `useEffect`, so any test that opens the propose sheet needs this polyfill.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
}

vi.mock('../lib/api', () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    body?: unknown;
    constructor(status: number, code: string | undefined, message: string, body?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.body = body;
    }
  }
  return { api: { skills: { tree: vi.fn(), propose: vi.fn() } }, ApiError };
});

const { api, ApiError } = await import('../lib/api');
const { SkillPicker, SkillMultiPicker } = await import('./SkillPicker');
const { flattenSkills } = await import('../lib/skills');

function node(id: string, label: string, children: SkillNode[] = [], description?: string): SkillNode {
  return {
    uri: `at://did:plc:school/freeschool.draft.skill/${id}`,
    id,
    label,
    ...(description ? { description } : {}),
    status: 'canonical',
    tier: id === 'deescalation' ? ('B' as const) : ('A' as const),
    alsoUnder: [],
    children,
  };
}

const uri = (id: string) => `at://did:plc:school/freeschool.draft.skill/${id}`;

const skills = flattenSkills([
  node('crafts', 'Crafts', [
    node('textiles', 'Textiles', [node('mending', 'Mending'), node('sewing', 'Sewing machines')]),
  ]),
  node('care', 'Care and conflict', [node('conflict', 'Conflict', [node('deescalation', 'De-escalation')])]),
]);

function renderPicker(props: Partial<Parameters<typeof SkillPicker>[0]> = {}) {
  const onChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <SkillPicker skills={skills} value="" onChange={onChange} {...props} />
    </QueryClientProvider>,
  );
  return { onChange, ...utils };
}

const combobox = () => screen.getByRole('combobox', { name: /search the skill taxonomy/i });

describe('SkillPicker', () => {
  beforeEach(() => {
    vi.mocked(api.skills.propose).mockReset();
  });

  it('starts collapsed, with the listbox only appearing once something is typed', () => {
    renderPicker();
    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    fireEvent.change(combobox(), { target: { value: 'mend' } });

    expect(combobox()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Mending/ })).toBeInTheDocument();
  });

  it('points aria-controls at the listbox it opens', () => {
    renderPicker();
    fireEvent.change(combobox(), { target: { value: 'mend' } });
    expect(combobox().getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
  });

  it('shows each option as its label with a "Domain › Area" secondary line', () => {
    renderPicker();
    fireEvent.change(combobox(), { target: { value: 'mend' } });
    const option = screen.getByRole('option', { name: /Mending/ });
    expect(within(option).getByText('Mending')).toBeInTheDocument();
    expect(within(option).getByText('Crafts › Textiles')).toBeInTheDocument();
  });

  it('moves the active option with the arrow keys and selects it with Enter', () => {
    const { onChange } = renderPicker();
    fireEvent.change(combobox(), { target: { value: 'e' } });

    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    const first = screen.getAllByRole('option')[0]!;
    expect(combobox()).toHaveAttribute('aria-activedescendant', first.id);
    expect(first).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(combobox(), { key: 'ArrowDown' });
    const second = screen.getAllByRole('option')[1]!;
    expect(combobox()).toHaveAttribute('aria-activedescendant', second.id);

    fireEvent.keyDown(combobox(), { key: 'ArrowUp' });
    expect(combobox()).toHaveAttribute('aria-activedescendant', first.id);

    fireEvent.keyDown(combobox(), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(uri('mending'), expect.objectContaining({ label: 'Mending' }));
  });

  it('selects an option on click', () => {
    const { onChange } = renderPicker();
    fireEvent.change(combobox(), { target: { value: 'sewing' } });
    fireEvent.click(screen.getByRole('option', { name: /Sewing machines/ }));
    expect(onChange).toHaveBeenCalledWith(uri('sewing'), expect.objectContaining({ label: 'Sewing machines' }));
  });

  it('closes the listbox on Escape without choosing anything', () => {
    const { onChange } = renderPicker();
    fireEvent.change(combobox(), { target: { value: 'mend' } });
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(combobox(), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(combobox()).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never lists more than twelve skills', () => {
    const many = flattenSkills(Array.from({ length: 40 }, (_, i) => node(`bread-${i}`, `Bread ${i}`)));
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SkillPicker skills={many} value="" onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    fireEvent.change(combobox(), { target: { value: 'bread' } });
    expect(screen.getAllByRole('option')).toHaveLength(12);
  });

  it('offers the propose row only when allowPropose is set', () => {
    const { unmount } = renderPicker();
    fireEvent.change(combobox(), { target: { value: 'mend' } });
    expect(screen.queryByRole('option', { name: /propose a skill/i })).not.toBeInTheDocument();
    unmount();

    renderPicker({ allowPropose: true });
    fireEvent.change(combobox(), { target: { value: 'mend' } });
    expect(screen.getByRole('option', { name: "Can't find it? Propose a skill" })).toBeInTheDocument();
  });

  it('still offers the propose row when nothing in the taxonomy matches', () => {
    renderPicker({ allowPropose: true });
    fireEvent.change(combobox(), { target: { value: 'zzzz nothing' } });
    expect(screen.getByRole('option', { name: "Can't find it? Propose a skill" })).toBeInTheDocument();
  });

  it('renders the chosen skill as a chip with a clear button', () => {
    const onChange = vi.fn();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SkillPicker skills={skills} value={uri('mending')} onChange={onChange} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Crafts › Textiles › Mending')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('marks a Tier B choice as sensitive on the chip', () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SkillPicker skills={skills} value={uri('deescalation')} onChange={vi.fn()} />
      </QueryClientProvider>,
    );
    expect(screen.getByText('Sensitive')).toBeInTheDocument();
  });

  describe('propose a skill', () => {
    const openSheet = () => {
      fireEvent.change(combobox(), { target: { value: 'mending' } });
      fireEvent.click(screen.getByRole('option', { name: "Can't find it? Propose a skill" }));
    };

    it('opens the sheet prefilled with what was typed, under the best match’s area', async () => {
      renderPicker({ allowPropose: true });
      openSheet();

      expect(await screen.findByRole('heading', { name: 'Propose a skill' })).toBeInTheDocument();
      expect(screen.getByLabelText(/what is it called/i)).toHaveValue('mending');
      // Best match for "mending wool" is Mending, which sits in the Textiles area.
      expect(screen.getByText('Crafts › Textiles')).toBeInTheDocument();
    });

    it('posts the proposal and selects the new skill', async () => {
      vi.mocked(api.skills.propose).mockResolvedValue({
        uri: uri('wool-mending'),
        id: 'wool-mending',
        label: 'Wool mending',
        status: 'proposed',
        tier: 'A',
      });
      const { onChange } = renderPicker({ allowPropose: true });
      openSheet();

      fireEvent.change(await screen.findByLabelText(/what is it called/i), { target: { value: 'Wool mending' } });
      fireEvent.click(screen.getByRole('button', { name: /propose this skill/i }));

      await waitFor(() =>
        expect(api.skills.propose).toHaveBeenCalledWith({ label: 'Wool mending', parentUri: uri('textiles') }),
      );
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(uri('wool-mending'), undefined));
    });

    it('names the existing skill and selects it when the taxonomy already has one', async () => {
      vi.mocked(api.skills.propose).mockRejectedValue(
        new ApiError(409, 'SkillExists', 'that skill already exists', {
          error: 'SkillExists',
          existing: node('mending', 'Mending'),
        }),
      );
      const { onChange } = renderPicker({ allowPropose: true });
      openSheet();

      fireEvent.change(await screen.findByLabelText(/what is it called/i), { target: { value: 'Mending' } });
      fireEvent.click(screen.getByRole('button', { name: /propose this skill/i }));

      expect(await screen.findByText('That skill already exists: Mending')).toBeInTheDocument();
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(uri('mending'), undefined));
    });

    it('says so plainly when the school has not switched proposals on', async () => {
      vi.mocked(api.skills.propose).mockRejectedValue(
        new ApiError(503, 'AuthorityUnavailable', 'no curation authority configured'),
      );
      const { onChange } = renderPicker({ allowPropose: true });
      openSheet();

      fireEvent.change(await screen.findByLabelText(/what is it called/i), { target: { value: 'Wool mending' } });
      fireEvent.click(screen.getByRole('button', { name: /propose this skill/i }));

      expect(
        await screen.findByText('Proposing skills is not switched on for this school yet'),
      ).toBeInTheDocument();
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});

describe('SkillMultiPicker', () => {
  function renderMulti(values: string[]) {
    const onChange = vi.fn();
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <SkillMultiPicker skills={skills} values={values} onChange={onChange} />
      </QueryClientProvider>,
    );
    return { onChange };
  }

  it('keeps a chip list and appends what the combobox chooses', () => {
    const { onChange } = renderMulti([uri('mending')]);
    expect(screen.getByText('Crafts › Textiles › Mending')).toBeInTheDocument();

    fireEvent.change(combobox(), { target: { value: 'sewing' } });
    fireEvent.click(screen.getByRole('option', { name: /Sewing machines/ }));

    expect(onChange).toHaveBeenCalledWith([uri('mending'), uri('sewing')]);
  });

  it('removes a chip without touching the others', () => {
    const { onChange } = renderMulti([uri('mending'), uri('sewing')]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Mending' }));
    expect(onChange).toHaveBeenCalledWith([uri('sewing')]);
  });

  it('never adds the same skill twice', () => {
    const { onChange } = renderMulti([uri('mending')]);
    fireEvent.change(combobox(), { target: { value: 'mending' } });
    fireEvent.click(screen.getByRole('option', { name: /Mending/ }));
    expect(onChange).toHaveBeenCalledWith([uri('mending')]);
  });
});
