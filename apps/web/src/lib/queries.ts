/**
 * TanStack Query hooks over `api.ts`.
 *
 * Query keys are arrays starting with the resource name (`['event', id]`),
 * so a mutation can invalidate a whole resource with a prefix match
 * (`queryClient.invalidateQueries({ queryKey: ['calendar'] })` matches every
 * `useCalendar(range)` variant, whatever `range` was).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type { CreateEventInput, RsvpSetInput } from './types';

export function useCalendar(range: { from?: string; to?: string; school?: string } = {}) {
  return useQuery({
    queryKey: ['calendar', range],
    queryFn: () => api.calendar.list(range),
  });
}

export function useEvent(id: string | undefined) {
  return useQuery({
    queryKey: ['event', id],
    queryFn: () => api.events.get(id as string),
    enabled: Boolean(id),
  });
}

/**
 * The viewer's own RSVP for one event (`GET /api/rsvp?eventUri=`) — 401s with
 * nobody signed in, so `retry: false` matches `useMe()` rather than hammering
 * the AppView for a request that will never succeed.
 */
export function useMyRsvp(eventUri: string | undefined) {
  return useQuery({
    queryKey: ['rsvp', eventUri],
    queryFn: () => api.rsvp.get(eventUri as string),
    enabled: Boolean(eventUri),
    retry: false,
  });
}

/** Who the viewer is, or a rejected promise if nobody is signed in. */
export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.auth.me(),
    retry: false,
  });
}

export function useRequests() {
  return useQuery({
    queryKey: ['requests'],
    queryFn: () => api.requests.list(),
  });
}

export function useSkillTree() {
  return useQuery({
    queryKey: ['skills'],
    queryFn: () => api.skills.tree(),
  });
}

export function useSkill(id: string | undefined) {
  return useQuery({
    queryKey: ['skill', id],
    queryFn: () => api.skills.get(id as string),
    enabled: Boolean(id),
  });
}

export function useMyClaims() {
  return useQuery({
    queryKey: ['my-claims'],
    queryFn: () => api.me.skillClaims(),
  });
}

export function useFeedbackSummary(id: string | undefined) {
  return useQuery({
    queryKey: ['feedback-summary', id],
    queryFn: () => api.feedback.summary(id as string),
    enabled: Boolean(id),
  });
}

export function useAdminPolicy() {
  return useQuery({
    queryKey: ['admin-policy'],
    queryFn: () => api.admin.policy(),
  });
}

export function useModerationQueue() {
  return useQuery({
    queryKey: ['moderation-queue'],
    queryFn: () => api.admin.moderation.list(),
  });
}

export function usePeers() {
  return useQuery({
    queryKey: ['peers'],
    queryFn: () => api.admin.peers(),
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications.list(),
  });
}

export function useRsvpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, ...input }: { eventId: string } & RsvpSetInput) => api.rsvp.set(eventId, input),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['event', variables.eventId] });
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['rsvp', variables.eventId] });
    },
  });
}

export function useRsvpClearMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) => api.rsvp.clear(eventId),
    onSuccess: (_data, eventId) => {
      void queryClient.invalidateQueries({ queryKey: ['event', eventId] });
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
      void queryClient.invalidateQueries({ queryKey: ['rsvp', eventId] });
    },
  });
}

export function useZineMonth(yyyyMm: string | undefined) {
  return useQuery({
    queryKey: ['zine', yyyyMm],
    queryFn: () => api.zine.month(yyyyMm as string),
    enabled: Boolean(yyyyMm),
  });
}

export function useCreateEventMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateEventInput) => api.events.create(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}
