// Client for our REST API. The API relays signed actions and keeps
// the plain terms; nothing it says about money is trusted without a check
// against the chain or a signature (see flows.ts).

import type { DealView } from './chain';

export class ApiError extends Error {
  /** HTTP status, 0 = the server could not be reached. */
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;
  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
  /** The server is down or overloaded: the "send it yourself" path applies. */
  get serverDown(): boolean {
    return this.status === 0 || this.status >= 500 || this.code === 'daily_cap';
  }
}

export interface ApiTerms {
  title: string;
  description: string;
  revisions: string;
  salt: string;
}

export interface ApiDeal {
  handle: string;
  contract_id: string;
  offer: string;
  offer_signature: string;
  terms: ApiTerms;
  deal_id: number | null;
  deal: DealView | null;
  revoked: boolean;
}

export interface Signed {
  payload: string;
  signature: string;
}

export interface QuoteResponse {
  quoteRequest: Record<string, unknown> | null;
  quote: Record<string, unknown> | null;
  signature: string | null;
  timestamp: string | null;
  correlationId?: string | null;
}

export interface PayQuote {
  quote_response: QuoteResponse;
  deposit_address: string | null;
  dry: boolean;
}

export interface PayoutQuote {
  quote_response: QuoteResponse;
  party: 'creator' | 'client';
  withdraw_payload: string | null;
  dry: boolean;
}

export interface PayStatus {
  status: string | null;
  updated_at: string | null;
  swap_details: Record<string, string | null>;
}

export interface TokenInfo {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number | string | null;
}

export interface SettleProposal {
  signer: 'creator' | 'client';
  payload: string;
  signature: string;
  created_at: string;
}

export interface NoteRecord {
  kind: string;
  signer: 'creator' | 'client';
  payload: string;
  signature: string;
  created_at: string;
}

export interface ActCall {
  contract_id: string;
  method_name: string;
  args: { deal_id: number; action: string; payload: string; signature: string };
  gas: string;
  deposit: string;
}

export interface Health {
  ok: boolean;
  network: string;
  contract_id: string;
  warnings: string[];
}

/** The part of `GET /api/config` the site reads. */
export interface ApiConfig {
  max_offer_ttl_seconds?: number;
  min_review_period_seconds?: number;
}

export interface Api {
  createDeal(body: {
    handle: string;
    offer: string;
    offer_signature: string;
    terms: ApiTerms;
    /** Only for a deal made from a marketplace request (marketplace/API.md). */
    request_handle?: string;
    profile_pk?: string;
    request_expires_at_ns?: string;
    request_sig?: string;
    deal_link_box?: { epk: string; iv: string; ct: string } | null;
  }): Promise<{ handle: string }>;
  getDeal(handle: string, token: string): Promise<ApiDeal>;
  join(handle: string, token: string, clientPk: string): Promise<{ deal_id: number }>;
  revoke(handle: string, signature: string): Promise<{ ok: boolean }>;
  payQuote(handle: string, signed: Signed): Promise<PayQuote>;
  payStatus(handle: string, token: string, depositAddress: string, memo: string | null): Promise<PayStatus>;
  action(handle: string, body: { action: string } & Signed): Promise<{ ok: boolean; tx_hash: string | null; message?: string }>;
  timeout(handle: string, token: string): Promise<{ ok: boolean; outcome: string }>;
  settleProposal(handle: string, token: string, signed: Signed): Promise<{ signer: string }>;
  settleProposals(handle: string, token: string): Promise<SettleProposal[]>;
  settle(handle: string, token: string, body: { payload: string; creator_signature: string; client_signature: string }): Promise<{ ok: boolean }>;
  payoutQuote(handle: string, signed: Signed): Promise<PayoutQuote>;
  tokens(): Promise<TokenInfo[]>;
  postNote(handle: string, token: string, signed: Signed): Promise<{ kind: string }>;
  notes(handle: string, token: string): Promise<{ notes: NoteRecord[]; has_arbiter_copy: { creator: boolean; client: boolean } }>;
  health(): Promise<Health>;
  /** The server's settings; the site uses the contract limits from it only when the chain can't be read. */
  config?(): Promise<ApiConfig>;
  disputeLog(): Promise<{ month: string; outcome: string; reason: string }[]>;
}

export function httpApi(base: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Api {
  async function call<T>(method: 'GET' | 'POST', path: string, opts: { body?: unknown; token?: string } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.token) headers['X-Deal-Token'] = opts.token;
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        // Relayed actions wait for the chain: the server gives up after 120 s itself.
        signal: AbortSignal.timeout(150_000),
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
    if (!res.ok) {
      throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? `HTTP ${res.status}`), json);
    }
    return json as T;
  }

  const deal = (handle: string) => `/api/deals/${handle}`;

  return {
    createDeal: (body) => call('POST', '/api/deals', { body }),
    getDeal: (handle, token) => call('GET', deal(handle), { token }),
    join: (handle, token, clientPk) => call('POST', `${deal(handle)}/join`, { token, body: { client_pk: clientPk } }),
    revoke: (handle, signature) => call('POST', `${deal(handle)}/revoke`, { body: { signature } }),
    payQuote: (handle, signed) => call('POST', `${deal(handle)}/pay-quote`, { body: signed }),
    payStatus: (handle, token, depositAddress, memo) => {
      const q = new URLSearchParams({ deposit_address: depositAddress });
      if (memo) q.set('deposit_memo', memo);
      return call('GET', `${deal(handle)}/pay-status?${q.toString()}`, { token });
    },
    action: (handle, body) => call('POST', `${deal(handle)}/actions`, { body }),
    timeout: (handle, token) => call('POST', `${deal(handle)}/timeout`, { token, body: {} }),
    settleProposal: (handle, token, signed) => call('POST', `${deal(handle)}/settle-proposal`, { token, body: signed }),
    settleProposals: async (handle, token) =>
      (await call<{ proposals: SettleProposal[] }>('GET', `${deal(handle)}/settle-proposals`, { token })).proposals,
    settle: (handle, token, body) => call('POST', `${deal(handle)}/settle`, { token, body }),
    payoutQuote: (handle, signed) => call('POST', `${deal(handle)}/payout-quote`, { body: signed }),
    tokens: () => call('GET', '/api/tokens'),
    postNote: (handle, token, signed) => call('POST', `${deal(handle)}/notes`, { token, body: signed }),
    notes: (handle, token) => call('GET', `${deal(handle)}/notes`, { token }),
    health: () => call('GET', '/api/health'),
    config: () => call('GET', '/api/config'),
    disputeLog: async () =>
      (await call<{ entries: { month: string; outcome: string; reason: string }[] }>('GET', '/api/dispute-log')).entries,
  };
}
