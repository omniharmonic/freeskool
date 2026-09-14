/**
 * TanStack Query hooks over `api.ts`.
 *
 * Query keys are arrays starting with the resource name (`['event', id]`),
 * so a mutation can invalidate a whole resource with a prefix match
 * (`queryClient.invalidateQueries({ queryKey: ['calendar'] })` matches every
 * `useCalendar(range)` variant, whatever `range` was).
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import type {
  AdminPolicyInput,
  AttestationInput,
  AttendanceRow,
  CancelEventInput,
  CreateEventInput,
  CreateRequestInput,
  FeedbackInput,
  HandoffStartInput,
  ModerationProposeInput,
  NotificationPref,
  PeersInput,
  RequestClaimInput,
  RsvpSetInput,
  SetNewsletterInput,
  SetPublicRoleInput,
  SkillClaimsSetInput,
  SkillDeprecateInput,
  SkillMoveInput,
  SkillProposeInput,
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

/**
 * `POST /api/auth/switch-school`. Deliberately does NOT invalidate anything:
 * every city is its own origin, so the caller navigates to the returned host
 * and the whole app reloads there. Invalidating first would repaint the
 * current school's screens with a session that has already moved.
 */
export function useSwitchSchoolMutation() {
  return useMutation({
    mutationFn: (schoolDid: string) => api.auth.switchSchool(schoolDid),
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

/**
 * `POST /api/skills`. Never retries: 409 `SkillExists` and 503
 * `AuthorityUnavailable` are both real answers the picker shows as copy, not
 * transient failures. Invalidates `['skills']` so the freshly proposed node
 * is in the tree by the time the picker renders it as a chip.
 */
export function useProposeSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SkillProposeInput) => api.skills.propose(body),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
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
      queryClient.removeQueries({queryKey:['public-profile']});
      void queryClient.invalidateQueries({queryKey:['practitioners']});
      void queryClient.invalidateQueries({queryKey:['resources']});
      void queryClient.invalidateQueries({queryKey:['resource']});
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
      void queryClient.invalidateQueries({ queryKey: ['public-profile'] });
      void queryClient.invalidateQueries({ queryKey: ['practitioners'] });
    },
  });
}

/**
 * Live availability for a handle prefix (`GET /api/me/handle/check`). The
 * caller debounces the prefix itself (300 ms in `HandleChooser`) — this only
 * gates on there being something to ask about, and never retries: "taken" and
 * "invalid" are answers, not failures.
 */
export function useHandleCheck(prefix: string) {
  return useQuery({
    queryKey: ['handle-check', prefix],
    queryFn: () => api.me.checkHandle(prefix),
    enabled: prefix.length > 0,
    retry: false,
    staleTime: 30_000,
  });
}

/** `PUT /api/me/handle`. Invalidates `['me']` — the handle is on `GET
 * /api/auth/me`, which is what every screen reads it from. */
export function useSetHandleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prefix: string) => api.me.setHandle(prefix),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      void queryClient.invalidateQueries({ queryKey: ['me-profile'] });
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
}

/** `POST /api/me/onboarded` — `/welcome`'s last step. */
export function useOnboardedMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.me.onboarded(),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
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

/** `PUT /api/admin/policy` is a destructive action (see the doc comment on
 * `AdminPolicyInput`'s `approvals` field) — a 403 is a real, expected
 * response, not a transient failure, so this never retries. */
export function useSetPolicyMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AdminPolicyInput) => api.admin.setPolicy(body),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-policy'] });
    },
  });
}

export function useModerationQueue() {
  return useQuery({
    queryKey: ['moderation-queue'],
    queryFn: () => api.admin.moderation.list(),
  });
}

export function useProposeModerationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ModerationProposeInput) => api.admin.moderation.propose(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['resource'] });
      void queryClient.invalidateQueries({ queryKey: ['public-profile'] });
    },
  });
}

/** `AlreadyApproved` (409) is the real, expected response when the caller is
 * the steward who opened the item — their own approval was already
 * recorded at open time (see `ModerationScreen`'s doc comment). Never retry
 * past it. */
export function useApproveModerationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.moderation.approve(id),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['resource'] });
      void queryClient.invalidateQueries({ queryKey: ['public-profile'] });
    },
  });
}

/** `ErrThresholdNotMet` (403) is a real, expected response short of the
 * policy's steward threshold — never retry past it. */
export function useExecuteModerationMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.admin.moderation.execute(id),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['moderation-queue'] });
      void queryClient.invalidateQueries({ queryKey: ['resources'] });
      void queryClient.invalidateQueries({ queryKey: ['resource'] });
      void queryClient.invalidateQueries({ queryKey: ['public-profile'] });
    },
  });
}

export function usePeers(probe = false) {
  return useQuery({
    queryKey: ['peers', probe],
    queryFn: () => api.admin.peers({ probe }),
  });
}

export function useSetPeersMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PeersInput) => api.admin.setPeers(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['peers'] });
    },
  });
}

/** `GET /api/admin/skills/proposals` — the steward queue for the skill taxonomy
 * (`SkillsAdminScreen`). Also read from `AdminOverviewScreen` for the pending
 * count, which passes `enabled: false` for a member who is not a steward: the
 * route 403s for them, and an ordinary member opening `/admin` should not spend
 * a refused request the browser logs as an error (UX audit finding 16).
 * `retry: false` for the same reason — a 403 is an answer, not a blip. */
export function useSkillProposals(enabled = true) {
  return useQuery({
    queryKey: ['skill-proposals'],
    queryFn: () => api.admin.skills.proposals(),
    enabled,
    retry: false,
  });
}

/** `POST /api/admin/skills/:id/deprecate`. Invalidates the proposal queue and
 * the public taxonomy tree, since a deprecated node changes both. */
export function useDeprecateSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body = {} }: { id: string; body?: SkillDeprecateInput }) => api.admin.skills.deprecate(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skill-proposals'] });
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

/** `POST /api/admin/skills/:id/move`. Same invalidation as deprecate — the
 * taxonomy tree's shape changed too. */
export function useMoveSkillMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: SkillMoveInput }) => api.admin.skills.move(id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skill-proposals'] });
      void queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
  });
}

/** Composing never mutates anything server-persistent in a way the UI needs
 * to invalidate elsewhere — it only ever creates a fresh draft row the
 * caller then holds onto by id. */
export function useComposeNewsletterMutation() {
  return useMutation({
    mutationFn: (period?: string) => api.admin.newsletter.compose(period),
  });
}

/** `AlreadySent` (409) is a real, expected response on a re-send — never
 * retry past it. */
export function useSendNewsletterMutation() {
  return useMutation({
    mutationFn: (id: string) => api.admin.newsletter.send(id),
    retry: false,
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

/**
 * The host calls a class off (`POST /api/events/:id/cancel`).
 *
 * Invalidates the class itself AND the calendar: a cancelled class stays on both
 * — the record is never deleted — but it now reads as cancelled, and a stale
 * cache would keep showing people a class that is not happening.
 */
export function useCancelEventMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body?: CancelEventInput }) => api.events.cancel(id, body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['event', variables.id] });
      void queryClient.invalidateQueries({ queryKey: ['calendar'] });
    },
  });
}

/** Host-only counts for one class (`GET /api/events/:id/attendance`) — 401s/403s
 * for anyone but the host, so `retry: false` matches `useMe()`/`useMyRsvp()`.
 * `enabled` lets a caller who already knows the viewer is not the host skip the
 * request entirely, rather than spending a 403 the browser logs as an error
 * (UX audit finding 16). */
export function useAttendance(eventId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['attendance', eventId],
    queryFn: () => api.attendance.list(eventId as string),
    enabled: Boolean(eventId) && enabled,
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

/** Host-or-steward-only roster (`GET /api/events/:id/rsvps`) — 403s for
 * anyone else, so `retry: false` matches `useAttendance()`, and `enabled` lets
 * a caller skip the request when it already knows the answer would be a 403. */
export function useEventRoster(eventId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['roster', eventId],
    queryFn: () => api.events.roster(eventId as string),
    enabled: Boolean(eventId) && enabled,
    retry: false,
  });
}

export function useHowItWorks() {
  return useQuery({
    queryKey: ['how-it-works'],
    queryFn: () => api.school.howItWorks(),
  });
}

export function useHandoffStartMutation() {
  return useMutation({
    mutationFn: (body: HandoffStartInput) => api.admin.handoff.start(body),
    retry: false,
  });
}

export function useHandoffAcceptMutation() {
  return useMutation({
    mutationFn: (token: string) => api.admin.handoff.accept(token),
    retry: false,
  });
}

/** The exit from custody. Never retries: a 409 `RevealPending` or 502
 * `PdsRotationFailed` are real, expected responses to show, not transient
 * failures. */
export function useTakeOwnershipMutation() {
  return useMutation({
    mutationFn: () => api.auth.takeOwnership(),
    retry: false,
  });
}

/** `GET /api/auth/take-ownership/:token` — unauthenticated and single-use.
 * `staleTime: Infinity` + `gcTime: Infinity` + `retry: false` keep a remount
 * (or a dev double-effect, or the query simply falling out of the cache and
 * refetching later) from spending the token a second time against the
 * server; the query cache itself already dedupes genuinely concurrent
 * requests for the same key. A real failure (network, 5xx) is still visible
 * via `isError`/`error` — this only stops re-fetching a result already
 * proven correct, or re-trying automatically past a refusal. */
export function useOwnershipReveal(token: string) {
  return useQuery({
    queryKey: ['ownership-reveal', token],
    queryFn: () => api.auth.revealOwnership(token),
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ── members directory and vouches (Task 10) ──────────────────────────────

/**
 * `GET /api/members` — the people directory. Members-only: a signed-out
 * viewer gets a 401 that will never become anything else, so `retry: false`
 * matches `useMe()`. Paged with the route's opaque cursor; `q`/`skill` are
 * part of the key, so changing either starts a fresh first page.
 */
export function useMembers(filters: { q?: string; skill?: string } = {}) {
  return useInfiniteQuery({
    queryKey: ['members', filters],
    queryFn: ({ pageParam }) =>
      api.members.list({ ...filters, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.cursor,
    retry: false,
  });
}

/** One member's directory profile. A 404 means they've hidden themselves —
 * a real answer to show as copy, never retried past. */
export function useMemberProfile(did: string | undefined) {
  return useQuery({
    queryKey: ['member', did],
    queryFn: () => api.members.get(did as string),
    enabled: Boolean(did),
    retry: false,
  });
}

/** The vouches the viewer has given and received. `given` is what resolves a
 * vouch back to the id a `DELETE` needs. */
export function useMyAttestations() {
  return useQuery({
    queryKey: ['my-attestations'],
    queryFn: () => api.me.attestations(),
    retry: false,
  });
}

/** Every surface that shows a vouch count or a "Vouched ✓" state. */
function invalidateVouches(queryClient: ReturnType<typeof useQueryClient>, subjectDid?: string) {
  void queryClient.invalidateQueries({ queryKey: ['my-attestations'] });
  void queryClient.invalidateQueries({ queryKey: ['member', subjectDid] });
  void queryClient.invalidateQueries({ queryKey: ['members'] });
  void queryClient.invalidateQueries({ queryKey: ['skill'] });
  void queryClient.invalidateQueries({ queryKey: ['me-badges'] });
}

/** `POST /api/attestations`. Never retries: 400 `SelfAttestation`, 404
 * `SubjectNotHolding` and 409 `AlreadyVouched` are all real answers. */
export function useVouchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AttestationInput) => api.attestations.create(body),
    retry: false,
    onSuccess: (_data, body) => invalidateVouches(queryClient, body.subjectDid),
  });
}

/** `DELETE /api/attestations/:id` — taking a vouch back. */
export function useUnvouchMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: { id: string; subjectDid?: string }) => api.attestations.remove(id),
    retry: false,
    onSuccess: (_data, variables) => invalidateVouches(queryClient, variables.subjectDid),
  });
}

/** `POST /api/me/import-bsky-profile` — "Refresh from Bluesky" on Me. */
export function useImportBskyProfileMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.me.importBskyProfile(),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['me-profile'] });
    },
  });
}
