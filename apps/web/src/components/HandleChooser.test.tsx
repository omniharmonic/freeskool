import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
  return {
    api: { me: { checkHandle: vi.fn(), setHandle: vi.fn() } },
    ApiError,
  };
});

const { api } = await import('../lib/api');
const { HandleChooser, HANDLE_PREFIX_RE, HANDLE_RULE } = await import('./HandleChooser');

function renderChooser() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <HandleChooser currentHandle="quiet-fern-4821.fs.boulder" />
    </QueryClientProvider>,
  );
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText('Your handle'), { target: { value } });
}

/** The debounce is 300 ms of real time; nothing here needs longer than one tick past it. */
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('HandleChooser', () => {
  beforeEach(() => {
    vi.mocked(api.me.checkHandle).mockReset().mockResolvedValue({ available: true });
    vi.mocked(api.me.setHandle).mockReset().mockResolvedValue({ handle: 'wren.fs.boulder' });
  });

  it('mirrors the server rule exactly (apps/appview/src/lib/handles.ts)', () => {
    expect(HANDLE_PREFIX_RE.source).toBe('^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$');
  });

  it('lowercases and trims as you type, so a capitalized prefix never reaches the server', async () => {
    renderChooser();

    type('  Wren  ');

    expect(screen.getByLabelText('Your handle')).toHaveValue('wren');
    await waitFor(() => expect(api.me.checkHandle).toHaveBeenCalledWith('wren'));
  });

  it('answers a malformed prefix itself, without asking the server', async () => {
    renderChooser();

    type('ab');

    expect(await screen.findByText(HANDLE_RULE)).toBeInTheDocument();
    await afterDebounce();
    expect(api.me.checkHandle).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save this handle' })).toBeDisabled();
  });

  it('answers a prefix with a character the rule has no room for, without asking the server', async () => {
    renderChooser();

    type('wren!');

    expect(await screen.findByText(HANDLE_RULE)).toBeInTheDocument();
    await afterDebounce();
    expect(api.me.checkHandle).not.toHaveBeenCalled();
  });

  it('asks the server once, after the debounce, for a well-formed prefix', async () => {
    renderChooser();

    type('w');
    type('wr');
    type('wren-42');

    await waitFor(() => expect(api.me.checkHandle).toHaveBeenCalledWith('wren-42'));
    await afterDebounce();
    expect(api.me.checkHandle).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('wren-42.fs.boulder is free')).toBeInTheDocument();
  });

  it('keeps the server as the authority on reserved and taken', async () => {
    vi.mocked(api.me.checkHandle).mockResolvedValueOnce({ available: false, reason: 'reserved' });
    renderChooser();

    type('school');

    expect(await screen.findByText('That handle is reserved. Try another.')).toBeInTheDocument();

    vi.mocked(api.me.checkHandle).mockResolvedValueOnce({ available: false, reason: 'taken' });
    type('wren');

    expect(await screen.findByText('That handle is taken. Try another.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save this handle' })).toBeDisabled();
  });

  it('sends the normalized prefix, not what was typed', async () => {
    renderChooser();

    type('WREN');
    await screen.findByText('wren.fs.boulder is free');
    fireEvent.click(screen.getByRole('button', { name: 'Save this handle' }));

    await waitFor(() => expect(api.me.setHandle).toHaveBeenCalledWith('wren'));
  });
});
