/**
 * Typed client for the AppView's HTTP API (`apps/appview/src/http/routes/*.ts`).
 *
 * Every call sends `credentials: 'include'` so the session cookie rides along
 * — the dev proxy (`vite.config.ts`) and the AppView's CORS config
 * (`apps/appview/src/http/app.ts`) both assume this is a same-origin request
 * in development. Non-2xx responses throw `ApiError`, carrying the server's
 * `error` code through rather than swallowing it.
 *
 * Paths mostly match an existing route exactly. One binding was simply
 * missing rather than pointed at the wrong place — `rsvp.get`, for
 * `GET /api/rsvp?eventUri=` (Task 4 added it; the route itself is Task 2's).
 *   - `rsvp.mine`  → reuses `GET /api/me`, which already returns the
 *     viewer's own RSVPs; there is no dedicated "all my rsvps" route.
 * `me.skill-claims`/`me.badges`/`me.visibility-defaults`/`me.public-role`
 * and `me.newsletter` all live under `/api/me` (`apps/appview/src/http/routes/
 * me.ts`); `me.newsletter` itself is `apps/appview/src/http/routes/
 * newsletter.ts`, mounted at `/api` (its own path already starts with
 * `/me/newsletter`).
 */
import type {
  KnowledgeResource, PublicProfile,
  AttestationCreated,
  AttestationInput,
  ImportBskyProfileResult,
  MemberProfileResponse,
  MembersQuery,
  MembersResponse,
  MyAttestationsResponse,
  AdminPolicyInput,
  AdminPolicyResponse,
  AdminPolicyWriteResult,
  AttendanceRow,
  AttendanceSetResult,
  AttendanceSummary,
  AuthMe,
  CalendarResponse,
  CreateEventInput,
  CreateEventResult,
  CreateRequestInput,
  EventDetail,
  FeedbackInput,
  FeedbackSummary,
  HandoffAcceptResult,
  HandoffStartInput,
  HandoffStartResult,
  HowItWorksResponse,
  InviteMintInput,
  InviteMintResult,
  InviteRedeemResult,
  ModerationApproveResult,
  ModerationExecuteResult,
  ModerationProposeInput,
  ModerationProposeResult,
  MeBadgesResponse,
  ModerationQueueResponse,
  MyRsvp,
  NewsletterDraft,
  NewsletterSubscriptionResult,
  NotificationPref,
  NotificationPrefsResponse,
  NotificationsResponse,
  OwnershipRevealResult,
  PeersInput,
  PeersResponse,
  PublicRoleResponse,
  PushSubscribeResult,
  PushSubscriptionInput,
  RequestClaimInput,
  RequestMutationResult,
  RequestRsvpResult,
  RequestsResponse,
  RosterEntry,
  RsvpClearResult,
  RsvpGetResult,
  RsvpSetInput,
  RsvpSetResult,
  SetNewsletterInput,
  SetPublicRoleInput,
  SignupResult,
  SkillClaimsResponse,
  SkillClaimsSetInput,
  SkillClaimsSetResult,
  SkillDetail,
  SkillProposeInput,
  SkillProposeResult,
  SkillTreeResponse,
  TakeOwnershipResult,
  UpdateEventResult,
  UpdateProfileInput,
  UpdateProfileResult,
  VerifyResult,
  VisibilityDefaults,
  ZineMonthResponse,
  MeResponse,
} from './types';

export class ApiError extends Error {
  status: number;
  code?: string;
  /** The full parsed response body, for the rare caller that needs a field
   * beyond `error`/`message` (e.g. `take-ownership`'s `expiresAt` on a 409). */
  body?: unknown;

  constructor(status: number, code: string | undefined, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

type QueryValue = string | number | boolean | undefined;

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, QueryValue>;
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, headers: extraHeaders } = options;
  const headers = new Headers(extraHeaders);
  let payload: BodyInit | undefined;
  if (body !== undefined) {
    headers.set('content-type', 'application/json');
    payload = JSON.stringify(body);
  }

  const res = await fetch(buildUrl(path, query), {
    method,
    headers,
    body: payload,
    credentials: 'include',
  });

  const raw = await res.text();
  const data = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined;

  if (!res.ok) {
    const errBody = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, errBody.error, errBody.message ?? `Request failed with status ${res.status}`, data);
  }
  return data as T;
}

const get = <T>(path: string, query?: Record<string, QueryValue>, headers?: Record<string, string>) =>
  request<T>(path, { method: 'GET', query, headers });
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
const put = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body });
const del = <T>(path: string, query?: Record<string, QueryValue>) => request<T>(path, { method: 'DELETE', query });

export const api = {
  knowledge: {
    mine: () => get<{resources: KnowledgeResource[]}>('/api/my-resources'),
    list: (filters: {skill?:string;author?:string;event?:string} = {}) => get<{resources:KnowledgeResource[]}>('/api/resources',filters),
    get: (id:string) => request<KnowledgeResource>(`/api/resources/${encodeURIComponent(id)}`),
    create: (body: {title:string;description?:string;skills:string[];uri?:string;license?:string;event?:{uri:string;cid:string}}) => request<{id:string}>('/api/resources',{method:'POST',body}),
    update: (id:string,body: {title:string;description?:string;skills:string[];uri?:string;license?:string;event?:{uri:string;cid:string}}) => request<{id:string}>(`/api/resources/${encodeURIComponent(id)}`,{method:'PUT',body}),
    remove: (id:string) => request<{ok:true}>(`/api/resources/${encodeURIComponent(id)}`,{method:'DELETE'}),
    profile: (did:string) => request<PublicProfile>(`/api/profiles/${encodeURIComponent(did)}`),
    practitioners: (skill:string) => request<{profiles:Array<{did:string;displayName:string;bio:string;level:string}>}>(`/api/practitioners?${new URLSearchParams({skill})}`),
  },
  auth: {
    signup: (body: { email: string; inviterDid?: string }) => post<SignupResult>('/api/auth/signup', body),
    /**
     * "Continue with email" — the one door for a new AND a returning member
     * (`SignInScreen`). Same handler as `signup` on the AppView
     * (`apps/appview/src/http/routes/auth.ts`), same response shape; kept as its own
     * named call here so the screen's copy and its API call agree on what this is.
     */
    signin: (body: { email: string; inviterDid?: string }) => post<SignupResult>('/api/auth/signin', body),
    verify: (token: string) =>
      get<VerifyResult>('/api/auth/verify', { token }, { accept: 'application/json' }),
    me: () => get<AuthMe>('/api/auth/me'),
    logout: () => post<{ ok: boolean }>('/api/auth/logout'),
    /**
     * Secondary door. `confirm` must be true or the AppView refuses with 428;
     * `handle` (a handle or a DID) is required too or it refuses with 400
     * (`apps/appview/src/http/routes/auth.ts:78-79`).
     */
    oauthStartUrl: (confirm: boolean, handle: string): string =>
      buildUrl('/api/auth/oauth/start', { confirm: confirm ? '1' : '0', handle }),
    /** The exit from custody — see `MeScreen`'s "Take ownership" section. */
    takeOwnership: () => post<TakeOwnershipResult>('/api/auth/take-ownership'),
    /** Deliberately unauthenticated and single-use — see `RevealScreen`. */
    revealOwnership: (token: string) =>
      get<OwnershipRevealResult>(`/api/auth/take-ownership/${encodeURIComponent(token)}`),
  },

  calendar: {
    list: (range: { from?: string; to?: string; school?: string } = {}) =>
      get<CalendarResponse>('/api/calendar', range),
  },

  events: {
    get: (id: string) => get<EventDetail>(`/api/events/${encodeURIComponent(id)}`),
    create: (body: CreateEventInput) => post<CreateEventResult>('/api/events', body),
    /** `series` is never sent here — the AppView rejects it with 400
     * `SeriesEditNotSupported` (see `EventEditScreen.tsx`'s doc comment). */
    update: (id: string, body: Omit<Partial<CreateEventInput>, 'series'>) =>
      put<UpdateEventResult>(`/api/events/${encodeURIComponent(id)}`, body),
    icsHref: (id: string): string => `/api/events/${encodeURIComponent(id)}.ics`,
    /** Host-or-steward-only roster (`GET /api/events/:id/rsvps`) — 403s for
     * anyone else. The route returns the array directly, not wrapped. */
    roster: (id: string) => get<RosterEntry[]>(`/api/events/${encodeURIComponent(id)}/rsvps`),
  },

  rsvp: {
    set: (eventId: string, input: RsvpSetInput) =>
      post<RsvpSetResult>('/api/rsvp', { eventUri: eventId, ...input }),
    clear: (eventId: string) => del<RsvpClearResult>('/api/rsvp', { eventUri: eventId }),
    /** The viewer's own RSVP for one event — `null` if they have none. */
    get: (eventId: string) => get<RsvpGetResult>('/api/rsvp', { eventUri: eventId }),
    mine: async (): Promise<MyRsvp[]> => (await get<MeResponse>('/api/me')).rsvps,
  },

  attendance: {
    list: (eventId: string) => get<AttendanceSummary>(`/api/events/${encodeURIComponent(eventId)}/attendance`),
    set: (eventId: string, rows: AttendanceRow[]) =>
      post<AttendanceSetResult>(`/api/events/${encodeURIComponent(eventId)}/attendance`, { attendees: rows }),
  },

  requests: {
    list: () => get<RequestsResponse>('/api/requests'),
    create: (body: CreateRequestInput) => post<RequestMutationResult>('/api/requests', body),
    rsvp: (id: string) => post<RequestRsvpResult>(`/api/requests/${encodeURIComponent(id)}/rsvp`),
    claim: (id: string, body: RequestClaimInput) =>
      post<RequestMutationResult>(`/api/requests/${encodeURIComponent(id)}/claim`, body),
  },

  skills: {
    tree: () => get<SkillTreeResponse>('/api/skills'),
    get: (id: string) => get<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`),
    /**
     * Propose a skill the taxonomy is missing. 409 `SkillExists` carries the
     * node that already covers it (`SkillExistsBody` on `ApiError.body`); 503
     * `AuthorityUnavailable` means this school has no curation authority set
     * up yet. Both are real answers, not transient failures — see
     * `useProposeSkillMutation`.
     */
    propose: (body: SkillProposeInput) => post<SkillProposeResult>('/api/skills', body),
  },

  /**
   * The members-only people directory (R9: this roster is never public). Every
   * call here 401s for a signed-out viewer — that is the intended answer, not a
   * failure to retry past.
   */
  members: {
    list: (query: MembersQuery = {}) => get<MembersResponse>('/api/members', query),
    /** 404 when the member has hidden themselves from the directory. */
    get: (did: string) => get<MemberProfileResponse>(`/api/members/${encodeURIComponent(did)}`),
  },

  attestations: {
    create: (body: AttestationInput) => post<AttestationCreated>('/api/attestations', body),
    remove: (id: string) => del<void>(`/api/attestations/${encodeURIComponent(id)}`),
  },

  me: {
    skillClaims: () => get<SkillClaimsResponse>('/api/me/skill-claims'),
    setSkillClaims: (body: SkillClaimsSetInput) => put<SkillClaimsSetResult>('/api/me/skill-claims', body),
    profile: () => get<MeResponse>('/api/me'),
    updateProfile: (body: UpdateProfileInput) => put<UpdateProfileResult>('/api/me', body),
    /** The vouches I've given and the ones I've received. App-side only. */
    attestations: () => get<MyAttestationsResponse>('/api/me/attestations'),
    /** On-demand re-import; always overwrites, because asking for it means it. */
    importBskyProfile: () => post<ImportBskyProfileResult>('/api/me/import-bsky-profile'),
    badges: () => get<MeBadgesResponse>('/api/me/badges'),
    visibilityDefaults: () => get<VisibilityDefaults>('/api/me/visibility-defaults'),
    publicRole: () => get<PublicRoleResponse>('/api/me/public-role'),
    setPublicRole: (body: SetPublicRoleInput) => put<PublicRoleResponse>('/api/me/public-role', body),
    newsletter: () => get<NewsletterSubscriptionResult>('/api/me/newsletter'),
    setNewsletter: (body: SetNewsletterInput) => put<NewsletterSubscriptionResult>('/api/me/newsletter', body),
  },

  feedback: {
    submit: (body: FeedbackInput) => post<{ ok: boolean }>('/api/feedback', body),
    summary: (eventId: string) =>
      get<FeedbackSummary>(`/api/events/${encodeURIComponent(eventId)}/feedback-summary`),
  },

  invites: {
    mint: (body: InviteMintInput) => post<InviteMintResult>('/api/invites', body),
    redeem: (token: string) => post<InviteRedeemResult>(`/api/invites/${encodeURIComponent(token)}/redeem`),
  },

  push: {
    vapidKey: () => get<{ key: string | null }>('/api/push/vapid-public-key'),
    subscribe: (sub: PushSubscriptionInput) => post<PushSubscribeResult>('/api/push/subscribe', sub),
    unsubscribe: (endpoint: string) => del<{ ok: boolean }>('/api/push/subscribe', { endpoint }),
  },

  notifications: {
    list: () => get<NotificationsResponse>('/api/notifications'),
    prefs: () => get<NotificationPrefsResponse>('/api/notifications/prefs'),
    setPrefs: (p: NotificationPref[]) => put<{ ok: boolean }>('/api/notifications/prefs', { prefs: p }),
  },

  admin: {
    policy: () => get<AdminPolicyResponse>('/api/admin/policy'),
    setPolicy: (p: AdminPolicyInput) => put<AdminPolicyWriteResult>('/api/admin/policy', p),
    moderation: {
      list: () => get<ModerationQueueResponse>('/api/admin/moderation'),
      propose: (b: ModerationProposeInput) => post<ModerationProposeResult>('/api/admin/moderation', b),
      approve: (id: string) =>
        post<ModerationApproveResult>(`/api/admin/moderation/${encodeURIComponent(id)}/approve`),
      execute: (id: string) =>
        post<ModerationExecuteResult>(`/api/admin/moderation/${encodeURIComponent(id)}/execute`),
    },
    /** `probe` mirrors `?probe=1` — a live reachability check per peer. There is
     * no last-sync timestamp on a peer row (see `PeersScreen`'s doc comment). */
    peers: (opts: { probe?: boolean } = {}) =>
      get<PeersResponse>('/api/admin/peers', opts.probe ? { probe: 1 } : undefined),
    setPeers: (p: PeersInput) => put<PeersResponse>('/api/admin/peers', p),
    newsletter: {
      /** `period` defaults server-side to the current month (`YYYY-MM`). */
      compose: (period?: string) => request<NewsletterDraft>('/api/admin/newsletter', { method: 'POST', query: period ? { period } : undefined }),
      send: (id: string) => post<{ ok: boolean; recipientCount: number }>(`/api/admin/newsletter/${encodeURIComponent(id)}/send`),
    },
    handoff: {
      start: (b: HandoffStartInput) => post<HandoffStartResult>('/api/admin/handoff', b),
      // NOT under /api/admin: that prefix is steward-gated, and accepting is open to
      // any Member — see apps/appview/src/http/routes/handoff.ts.
      accept: (token: string) => post<HandoffAcceptResult>(`/api/handoff/${encodeURIComponent(token)}/accept`),
    },
  },

  school: {
    howItWorks: () => get<HowItWorksResponse>('/api/school/how-it-works'),
  },

  zine: {
    month: (yyyyMm: string) => get<ZineMonthResponse>(`/api/zine/${encodeURIComponent(yyyyMm)}`),
  },
};
