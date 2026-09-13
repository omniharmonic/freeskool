import { describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UseMutationResult } from '@tanstack/react-query';

vi.mock('./api', () => ({
  api: {
    rsvp: {
      set: vi.fn(async () => ({
        ok: true,
        status: 'going',
        alsoPublicRecord: false,
        counts: { going: 1, interested: 0 },
      })),
    },
  },
}));

// Imported after the mock so `useRsvpMutation` picks up the mocked `api`.
const { useRsvpMutation } = await import('./queries');

describe('useRsvpMutation', () => {
  it('invalidates the event and calendar queries on success', async () => {
    const queryClient = new QueryClient();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    let mutation: UseMutationResult<unknown, unknown, { eventId: string; status: 'going' }> | undefined;
    function Harness() {
      mutation = useRsvpMutation() as typeof mutation;
      return null;
    }

    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Harness)));
    });

    await act(async () => {
      await mutation!.mutateAsync({ eventId: 'at://did:plc:host/community.lexicon.calendar.event/1', status: 'going' });
    });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['event', 'at://did:plc:host/community.lexicon.calendar.event/1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['calendar'] });

    await act(async () => {
      root.unmount();
    });
  });
});
