// Client for the marketplace routes of our API (marketplace/API.md). The
// server stores profiles, requests and reviews; it never holds a key. In
// development a stand-in can replace it (src/dev/marketMock.ts, never in a
// production build).

import { ApiError } from './api';
import type {
  Card,
  Contact,
  InboxItem,
  KeyChange,
  KeyResetEntry,
  LinkBox,
  OwnAccount,
  Profile,
  ProfileFields,
  PublicReview,
  RequestView,
  ReviewLink,
  SignedWrite,
} from './market';

export interface NewRequest {
  profile_id: string;
  service_id?: string;
  brief: string;
  wanted_deadline?: string;
  client_contact: Contact;
  /** x25519 key (hex) the deal link will be encrypted to; derived from the request token. */
  client_box_pk: string;
  /** Lines of `brief` (0-based) the AI helper wrote and the client kept as they were: the creator sees them marked. */
  ai_lines?: number[];
}

/** What `POST /api/deals` gets in addition when the deal is made from a request. */
export interface DealFromRequest {
  request_handle: string;
  request_expires_at_ns: string;
  request_sig: string;
  deal_link_box: LinkBox | null;
}

/** What "Report" can point at; `reply` = the creator's answer to a review (target = the review id). */
export type ReportKind = 'profile' | 'review' | 'reply' | 'request';
export type ReportReason = 'scam' | 'link' | 'offensive' | 'other';
export interface NewReport {
  kind: ReportKind;
  target_id: string;
  reason: ReportReason;
  /** Optional, up to 500 characters. */
  text?: string;
}

export interface BriefAnswer {
  checklist: string;
  model: string;
  /** true only when our server verified the NEAR AI signature and the TEE hardware report of this answer. */
  verified: boolean;
  /** With `verified`: false = NVIDIA's GPU check could not run (only the Intel TDX part was verified). */
  gpu_checked?: boolean;
  proof?: { chat_id: string; signing_address: string };
}

export interface MarketApi {
  profiles(q: { category?: string; q?: string; cursor?: string }): Promise<{ items: Card[]; next_cursor: string | null }>;
  profile(id: string): Promise<Profile>;
  putProfile(id: string, body: { profile_pk: string; profile: ProfileFields } & SignedWrite): Promise<Profile | { ok: boolean }>;
  hideProfile(id: string, body: { profile_pk: string } & SignedWrite): Promise<{ ok: boolean }>;
  /** `handle` = sha256(token); the token itself never leaves this browser (like deal links). */
  /** `profile_pk` = the creator's profile key now: this browser pins it (older servers leave it out). */
  createRequest(body: NewRequest & { handle: string }): Promise<{ handle: string; profile_pk?: string }>;
  request(handle: string, token: string): Promise<RequestView>;
  cancelRequest(handle: string, token: string): Promise<{ ok: boolean }>;
  /** `key_change` = a key change by support in progress, for the owner to cancel. */
  inbox(id: string, auth: { profile_pk: string } & SignedWrite): Promise<{ items: InboxItem[]; key_change?: KeyChange | null }>;
  /** "No", with an optional reason. */
  decline(handle: string, body: { profile_pk: string; reason?: string } & SignedWrite): Promise<{ ok: boolean }>;
  /** "In talks". */
  discuss(handle: string, body: { profile_pk: string } & SignedWrite): Promise<{ ok: boolean }>;
  /** Which profile this key controls (after a key reset it is an older profile); 404 = none. */
  profileByKey(pk: string): Promise<{ profile_id: string | null; pending: { profile_id: string; status: string; effective_at: string | null } | null }>;
  /** The current key stops a key change by support. */
  cancelKeyReset(profileId: string, body: { profile_pk: string; reset_id: string } & SignedWrite): Promise<{ ok: boolean }>;
  reviewLink(dealHandle: string, dealToken: string): Promise<ReviewLink>;
  postReview(dealHandle: string, dealToken: string, body: { rating: number; text: string; expires_at_ns: string; sig: string }): Promise<{ ok: boolean }>;
  /** AI brief helper: is it switched on on the server? */
  briefStatus(): Promise<{ enabled: boolean }>;
  /** One shot: a short request → an acceptance checklist from NEAR AI (the server holds the key). */
  brief(body: { request: string; service_title?: string; lang?: string }): Promise<BriefAnswer>;
  /** The creator's one answer to a review. */
  replyReview(profileId: string, reviewId: string, body: { profile_pk: string; text: string } & SignedWrite): Promise<{ ok: boolean; review?: PublicReview }>;
  /** The profile picture: `image` = base64 of the file; the server re-encodes it. */
  putAvatar(profileId: string, body: { profile_pk: string; image: string } & SignedWrite): Promise<{ ok: boolean; avatar: string }>;
  removeAvatar(profileId: string, body: { profile_pk: string } & SignedWrite): Promise<{ ok: boolean }>;
  /** Where the picture of this version is served (always our own API). */
  avatarUrl(profileId: string, version: string): string;
  /** "Report": stored for the team; no sign-in, no key. */
  report(body: NewReport): Promise<{ ok: boolean }>;
  /** Public log of key changes by support. */
  keyResets(): Promise<{ items: KeyResetEntry[] }>;
  /** The client opened a deal that ended by itself (starts the 3-day review window). */
  openReview(dealHandle: string, dealToken: string, body: SignedWrite): Promise<{ ok: boolean; started: boolean; can_review: boolean; review_until: string | null }>;
  /** Verified accounts, the owner's side; all signed by the profile key. */
  accounts(profileId: string, auth: { profile_pk: string } & SignedWrite): Promise<{ items: OwnAccount[] }>;
  addAccount(profileId: string, body: { profile_pk: string; url: string } & SignedWrite): Promise<{ ok: boolean; account: OwnAccount }>;
  checkAccount(profileId: string, accountId: string, body: { profile_pk: string } & SignedWrite): Promise<{ ok: boolean; result: string; account: OwnAccount }>;
  removeAccount(profileId: string, accountId: string, body: { profile_pk: string } & SignedWrite): Promise<{ ok: boolean }>;
}

export function httpMarketApi(base: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): MarketApi {
  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ApiError(0, 'unreachable', 'The server is not responding.');
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* not JSON: handled by the status below */
    }
    if (!res.ok) throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? `HTTP ${res.status}`), json);
    return json as T;
  }

  const qs = (o: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : '';
  };
  const req = (handle: string) => `/api/requests/${handle}`;

  return {
    profiles: (q) => call('GET', `/api/profiles${qs(q)}`),
    profile: (id) => call('GET', `/api/profiles/${id}`),
    putProfile: (id, body) => call('PUT', `/api/profiles/${id}`, { body }),
    hideProfile: (id, body) => call('DELETE', `/api/profiles/${id}`, { body: { ...body, delete: true } }),
    createRequest: (body) => call('POST', '/api/requests', { body }),
    request: (handle, token) => call('GET', req(handle), { headers: { 'x-request-token': token } }),
    cancelRequest: (handle, token) => call('POST', `${req(handle)}/cancel`, { headers: { 'x-request-token': token }, body: {} }),
    inbox: (id, auth) =>
      call('GET', `/api/profiles/${id}/requests${qs({ profile_pk: auth.profile_pk, expires_at_ns: auth.expires_at_ns, sig: auth.sig })}`),
    decline: (handle, body) => call('POST', `${req(handle)}/decline`, { body }),
    discuss: (handle, body) => call('POST', `${req(handle)}/discuss`, { body }),
    profileByKey: (pk) => call('GET', `/api/profiles/by-key${qs({ pk })}`),
    cancelKeyReset: (id, body) => call('POST', `/api/profiles/${id}/key-reset/cancel`, { body }),
    reviewLink: (handle, token) => call('GET', `/api/deals/${handle}/review`, { headers: { 'X-Deal-Token': token } }),
    postReview: (handle, token, body) => call('POST', `/api/deals/${handle}/review`, { headers: { 'X-Deal-Token': token }, body }),
    briefStatus: () => call('GET', '/api/brief'),
    brief: (body) => call('POST', '/api/brief', { body }),
    replyReview: (id, reviewId, body) => call('POST', `/api/profiles/${id}/reviews/${reviewId}/reply`, { body }),
    putAvatar: (id, body) => call('PUT', `/api/profiles/${id}/avatar`, { body }),
    removeAvatar: (id, body) => call('DELETE', `/api/profiles/${id}/avatar`, { body }),
    avatarUrl: (id, v) => `${base}/api/profiles/${encodeURIComponent(id)}/avatar/${encodeURIComponent(v)}`,
    report: (body) => call('POST', '/api/reports', { body }),
    keyResets: () => call('GET', '/api/key-resets'),
    openReview: (handle, token, body) => call('POST', `/api/deals/${handle}/review/open`, { headers: { 'X-Deal-Token': token }, body }),
    accounts: (id, auth) => call('GET', `/api/profiles/${id}/accounts${qs({ profile_pk: auth.profile_pk, expires_at_ns: auth.expires_at_ns, sig: auth.sig })}`),
    addAccount: (id, body) => call('POST', `/api/profiles/${id}/accounts`, { body }),
    checkAccount: (id, aid, body) => call('POST', `/api/profiles/${id}/accounts/${aid}/check`, { body }),
    removeAccount: (id, aid, body) => call('DELETE', `/api/profiles/${id}/accounts/${aid}`, { body }),
  };
}
