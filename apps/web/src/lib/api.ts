/**
 * Typed client for the AppView's HTTP API (`apps/appview/src/http/routes/*.ts`).
 *
 * Every call sends `credentials: 'include'` so the session cookie rides along
 * — the dev proxy (`vite.config.ts`) and the AppView's CORS config
 * (`apps/appview/src/http/app.ts`) both assume this is a same-origin request
 * in development. Non-2xx responses throw `ApiError`, carrying the server's
 * `error` code through rather than swallowing it.
 *
 * Paths mostly match an existing route exactly. Four do not yet exist on the
 * AppView and are documented here rather than silently guessed at:
 *   - `events.update`     → `PUT /api/events/:id` (no edit route yet; the
 *     natural counterpart to `GET /api/events/:id`)
 *   - `requests.rsvp`     → `POST /api/requests/:id/rsvp` (joining a request's
 *     interest count; distinct from `claim`, which offers to teach it)
 *   - `me.updateProfile`  → `PUT /api/me` (no profile-edit route yet)
 *   - `rsvp.mine`         → reuses `GET /api/me`, which already returns the
 *     viewer's own RSVPs; there is no dedicated "all my rsvps" route
 * A later task implements the first three; see the task-1 report for detail.
 */
import type {
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
  HandoffResult,
  HandoffStartInput,
  HowItWorksResponse,
  InviteMintInput,
  InviteMintResult,
  InviteRedeemResult,
  ModerationApproveResult,
  ModerationExecuteResult,
  ModerationProposeInput,
  ModerationProposeResult,
  ModerationQueueResponse,
  MyRsvp,
  NewsletterDraft,
  NotificationPref,
  NotificationPrefsResponse,
  NotificationsResponse,
  PeersInput,
  PeersResponse,
  PushSubscribeResult,
  PushSubscriptionInput,
  RequestClaimInput,
  RequestMutationResult,
  RequestsResponse,
  RsvpClearResult,
  RsvpSetInput,
  RsvpSetResult,
  SignupResult,
  SkillClaimInput,
  SkillClaimsResponse,
  SkillClaimsSetResult,
  SkillDetail,
  SkillTreeResponse,
  UpdateProfileInput,
  VerifyResult,
  ZineMonthResponse,
  MeResponse,
} from './types';

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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
    throw new ApiError(res.status, errBody.error, errBody.message ?? `Request failed with status ${res.status}`);
  }
  return data as T;
}

const get = <T>(path: string, query?: Record<string, QueryValue>, headers?: Record<string, string>) =>
  request<T>(path, { method: 'GET', query, headers });
const post = <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body });
const put = <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body });
const del = <T>(path: string, query?: Record<string, QueryValue>) => request<T>(path, { method: 'DELETE', query });

export const api = {
  auth: {
    signup: (body: { email: string; inviterDid?: string }) => post<SignupResult>('/api/auth/signup', body),
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
  },

  calendar: {
    list: (range: { from?: string; to?: string; school?: string } = {}) =>
      get<CalendarResponse>('/api/calendar', range),
  },

  events: {
    get: (id: string) => get<EventDetail>(`/api/events/${encodeURIComponent(id)}`),
    create: (body: CreateEventInput) => post<CreateEventResult>('/api/events', body),
    update: (id: string, body: Partial<CreateEventInput>) =>
      put<CreateEventResult>(`/api/events/${encodeURIComponent(id)}`, body),
    icsHref: (id: string): string => `/api/events/${encodeURIComponent(id)}.ics`,
  },

  rsvp: {
    set: (eventId: string, input: RsvpSetInput) =>
      post<RsvpSetResult>('/api/rsvp', { eventUri: eventId, ...input }),
    clear: (eventId: string) => del<RsvpClearResult>('/api/rsvp', { eventUri: eventId }),
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
    rsvp: (id: string) => post<{ ok: boolean }>(`/api/requests/${encodeURIComponent(id)}/rsvp`),
    claim: (id: string, body: RequestClaimInput) =>
      post<RequestMutationResult>(`/api/requests/${encodeURIComponent(id)}/claim`, body),
  },

  skills: {
    tree: () => get<SkillTreeResponse>('/api/skills'),
    get: (id: string) => get<SkillDetail>(`/api/skills/${encodeURIComponent(id)}`),
  },

  me: {
    skillClaims: () => get<SkillClaimsResponse>('/api/me/skill-claims'),
    setSkillClaims: (claims: SkillClaimInput[]) =>
      put<SkillClaimsSetResult>('/api/me/skill-claims', { claims }),
    profile: () => get<MeResponse>('/api/me'),
    updateProfile: (body: UpdateProfileInput) => put<MeResponse>('/api/me', body),
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
    peers: () => get<PeersResponse>('/api/admin/peers'),
    setPeers: (p: PeersInput) => put<PeersResponse>('/api/admin/peers', p),
    newsletter: {
      compose: () => post<NewsletterDraft>('/api/admin/newsletter'),
      send: (id: string) => post<{ ok: boolean }>(`/api/admin/newsletter/${encodeURIComponent(id)}/send`),
    },
    handoff: {
      start: (b: HandoffStartInput) => post<HandoffResult>('/api/admin/handoff', b),
      accept: (token: string) => post<HandoffResult>(`/api/admin/handoff/${encodeURIComponent(token)}/accept`),
    },
  },

  school: {
    howItWorks: () => get<HowItWorksResponse>('/api/school/how-it-works'),
  },

  zine: {
    month: (yyyyMm: string) => get<ZineMonthResponse>(`/api/zine/${encodeURIComponent(yyyyMm)}`),
  },
};
