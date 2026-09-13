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
import type {
  AttendanceRow,
  CreateEventInput,
  CreateRequestInput,
  FeedbackInput,
  NotificationPref,
  RequestClaimInput,
  RsvpSetInput,
  SetNewsletterInput,
  SetPublicRoleInput,
  SkillClaimsSetInput,
  UpdateProfileInput,
} from './types';

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

/** `GET /api/me` — profile fields plus role/evidence/rsvps; 401s with nobody
 * signed in, so `retry: false` matches `useMe()`. */
export function useMeProfile() {
  return useQuery({
    queryKey: ['me-profile'],
    queryFn: () => api.me.profile(),
    retry: false,
  });
}

export function useMeBadges() {
  return useQuery({
    queryKey: ['me-badges'],
    queryFn: () => api.me.badges(),
    retry: false,
  });
}

/** What this session is allowed to make public, and why (`oauthDoor`). */
export function useVisibilityDefaults() {
  return useQuery({
    queryKey: ['visibility-defaults'],
    queryFn: () => api.me.visibilityDefaults(),
    retry: false,
  });
}

export function useUpdateProfileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProfileInput) => api.me.updateProfile(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me-profile'] });
    },
  });
}

/** Never retries: a 400 `TierBConfirmRequired` (or 403 `PublicTogglesLocked`)
 * is the caller's cue to show a confirm dialog or a locked-toggle notice, not
 * a transient failure to retry past. */
export function useSetSkillClaimsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SkillClaimsSetInput) => api.me.setSkillClaims(body),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['my-claims'] });
    },
  });
}

export function useSetPublicRoleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetPublicRoleInput) => api.me.setPublicRole(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me-badges'] });
    },
  });
}

export function useNewsletterSubscription() {
  return useQuery({
    queryKey: ['newsletter'],
    queryFn: () => api.me.newsletter(),
    retry: false,
  });
}

export function useSetNewsletterMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SetNewsletterInput) => api.me.setNewsletter(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['newsletter'] });
    },
  });
}

export function useNotificationPrefs() {
  return useQuery({
    queryKey: ['notification-prefs'],
    queryFn: () => api.notifications.prefs(),
    retry: false,
  });
}

export function useSetNotificationPrefsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prefs: NotificationPref[]) => api.notifications.setPrefs(prefs),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['notification-prefs'] });
    },
  });
}

export function useCreateRequestMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRequestInput) => api.requests.create(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
    },
  });
}

/** Toggles the viewer's own "I want this too" interest on a request. */
export function useRequestRsvpMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (requestUri: string) => api.requests.rsvp(requestUri),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
    },
  });
}

export function useClaimRequestMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ requestUri, body }: { requestUri: string; body: RequestClaimInput }) =>
      api.requests.claim(requestUri, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['requests'] });
    },
  });
}

export function useFeedbackSummary(id: string | undefined) {
  return useQuery({
    queryKey: ['feedback-summary', id],
    queryFn: () => api.feedback.summary(id as string),
    enabled: Boolean(id),
  });
}

/** `POST /api/feedback` — a single anonymous ballot. Invalidates the
 * event's summary so a host watching it live sees the new count. */
export function useFeedbackSubmitMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: FeedbackInput) => api.feedback.submit(body),
    onSuccess: (_data, body) => {
      void queryClient.invalidateQueries({ queryKey: ['feedback-summary', body.eventUri] });
    },
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

/** `body` never carries `series` — see the doc comment on `api.events.update`. */
export function useUpdateEventMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Omit<Partial<CreateEventInput>, 'series'> }) =>
      api.events.update(id, body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['event', variables.id] });
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

/** Host-only counts for one class (`GET /api/events/:id/attendance`) — 401s/403s
 * for anyone but the host, so `retry: false` matches `useMe()`/`useMyRsvp()`. */
export function useAttendance(eventId: string | undefined) {
  return useQuery({
    queryKey: ['attendance', eventId],
    queryFn: () => api.attendance.list(eventId as string),
    enabled: Boolean(eventId),
    retry: false,
  });
}

export function useSetAttendanceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, rows }: { eventId: string; rows: AttendanceRow[] }) => api.attendance.set(eventId, rows),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['attendance', variables.eventId] });
    },
  });
}
