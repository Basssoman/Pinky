// The browser reads the deal from the chain itself, through public NEAR RPCs,
// not through our API. Everything about money (state, amounts,
// timers, keys) shown on the site comes from here.

import { base64Encode, fromUtf8, utf8 } from './bytes';

export type DealState =
  | 'Created'
  | 'Funded'
  | 'Delivered'
  | 'Released'
  | 'PaidOut'
  | 'Disputed'
  | 'Refunded'
  | 'Cancelled'
  | 'Expired';

export type Outcome =
  | 'Accepted'
  | 'AutoReleased'
  | 'RefundedByCreator'
  | 'RefundedAfterDeadline'
  | 'Cancelled'
  | 'ClosedUnpaid'
  | { ArbiterSplit: { creator_share_bps: number } }
  | { TimeoutSplit: { creator_share_bps: number } }
  | { Settled: { creator_share_bps: number } };

/** Contract `DealView`. */
export interface DealView {
  id: number;
  amount: string;
  funded_amount: string;
  state: DealState;
  creator_pk: string;
  client_pk: string;
  fee_bps: number;
  fee_amount: string;
  delivery_duration_ns: string;
  delivery_deadline_ns: string | null;
  review_period_ns: string;
  pay_by_ns: string;
  funding_cutoff_ns: string;
  funded_at_ns: string | null;
  delivered_at_ns: string | null;
  deliverable_hash: string | null;
  terms_hash: string;
  creator_payout: string;
  client_payout: string;
  created_at_ns: string;
  review_ends_at_ns: string | null;
  disputed_at_ns: string | null;
  dispute_ends_at_ns: string | null;
  ended_at_ns: string | null;
  outcome: Outcome | null;
  settle_seq: number;
  creator_pending: string;
  client_pending: string;
  creator_withdrawn: string;
  client_withdrawn: string;
  settled: boolean;
  creator_fingerprint: string;
  client_fingerprint: string;
  /** The deal was purged; this view was rebuilt from its tombstone. */
  purged?: boolean;
}

interface Tombstone {
  id: number;
  state: DealState;
  outcome: Outcome | null;
  ended_at_ns: string;
  creator_pk: string;
  client_pk: string;
  client_payout: string;
  client_pending: string;
  client_withdrawn: string;
  creator_fingerprint: string;
  client_fingerprint: string;
}

/** The periods of the contract the timers on the site depend on. */
export interface ChainPeriods {
  disputePeriodNs: bigint;
  payByPeriodNs: bigint;
  fundingGraceNs: bigint;
  /** Longest a client link may work (the contract refuses a later offer expiry). Missing = not known. */
  maxOfferTtlNs?: bigint;
}

export interface ChainReader {
  /** The deal, a purged deal's leftovers (`purged: true`), or null. */
  getDeal(id: number): Promise<DealView | null>;
  getDealIdByOffer(offer: string): Promise<number | null>;
  isOfferRevoked(offer: string): Promise<boolean>;
  getPeriods(): Promise<ChainPeriods>;
  /** Time of the latest final block in ms (the clock the contract uses). */
  getTimeMs(): Promise<number>;
}

function tombstoneAsDeal(t: Tombstone): DealView {
  return {
    id: t.id,
    amount: '0',
    funded_amount: '0',
    state: t.state,
    creator_pk: t.creator_pk,
    client_pk: t.client_pk,
    fee_bps: 0,
    fee_amount: '0',
    delivery_duration_ns: '0',
    delivery_deadline_ns: null,
    review_period_ns: '0',
    pay_by_ns: '0',
    funding_cutoff_ns: '0',
    funded_at_ns: null,
    delivered_at_ns: null,
    deliverable_hash: null,
    terms_hash: '',
    creator_payout: '0',
    client_payout: t.client_payout,
    created_at_ns: '0',
    review_ends_at_ns: null,
    disputed_at_ns: null,
    dispute_ends_at_ns: null,
    ended_at_ns: t.ended_at_ns,
    outcome: t.outcome,
    settle_seq: 0,
    creator_pending: '0',
    client_pending: t.client_pending,
    creator_withdrawn: '0',
    client_withdrawn: t.client_withdrawn,
    settled: t.client_payout === '0' && t.client_pending === '0',
    creator_fingerprint: t.creator_fingerprint,
    client_fingerprint: t.client_fingerprint,
    purged: true,
  };
}

export class ChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainError';
  }
}

/** Reads the escrow contract through public RPCs, trying each URL in turn. */
export function rpcChain(contractId: string, rpcUrls: string[], fetchImpl: typeof fetch = (...a) => fetch(...a)): ChainReader {
  let preferred = 0;

  async function rpc<T>(method: string, params: unknown): Promise<T> {
    let last: unknown = new Error('no RPC configured');
    for (let i = 0; i < rpcUrls.length; i++) {
      const at = (preferred + i) % rpcUrls.length;
      try {
        const res = await fetchImpl(rpcUrls[at], {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'kept', method, params }),
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
        const body = (await res.json()) as { result?: T & { error?: string }; error?: unknown };
        if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error).slice(0, 200)}`);
        // A failed view call comes back as result.error: the contract or the
        // method is not there. Another RPC would say the same.
        if (body.result && typeof body.result === 'object' && typeof body.result.error === 'string') {
          throw new ChainError(body.result.error.slice(0, 200));
        }
        preferred = at;
        return body.result as T;
      } catch (e) {
        if (e instanceof ChainError) throw e;
        last = e;
      }
    }
    throw new ChainError(`could not reach the NEAR network (${(last as Error)?.message ?? last})`);
  }

  async function view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    const out = await rpc<{ result: number[] }>('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: base64Encode(utf8(JSON.stringify(args))),
    });
    return JSON.parse(fromUtf8(Uint8Array.from(out.result))) as T;
  }

  return {
    async getDeal(id) {
      const deal = await view<DealView | null>('get_deal', { deal_id: id });
      if (deal) return deal;
      const tomb = await view<Tombstone | null>('get_tombstone', { deal_id: id });
      return tomb ? tombstoneAsDeal(tomb) : null;
    },
    async getDealIdByOffer(offer) {
      const v = await view<number | null>('get_deal_id_by_offer', { offer });
      return typeof v === 'number' ? v : null;
    },
    async isOfferRevoked(offer) {
      return (await view<boolean>('is_offer_revoked', { offer })) === true;
    },
    async getPeriods() {
      const c = await view<{ dispute_period_ns: string; pay_by_period_ns: string; funding_grace_ns: string; max_offer_ttl_ns?: string }>(
        'get_config',
        {},
      );
      return {
        disputePeriodNs: BigInt(c.dispute_period_ns),
        payByPeriodNs: BigInt(c.pay_by_period_ns),
        fundingGraceNs: BigInt(c.funding_grace_ns),
        ...(c.max_offer_ttl_ns ? { maxOfferTtlNs: BigInt(c.max_offer_ttl_ns) } : {}),
      };
    },
    async getTimeMs() {
      const b = await rpc<{ header: { timestamp_nanosec?: string; timestamp: number } }>('block', { finality: 'final' });
      const ns = b.header.timestamp_nanosec ?? String(b.header.timestamp);
      return Number(BigInt(ns) / 1_000_000n);
    },
  };
}

export const nsToMs = (ns: string | bigint): number => Number(BigInt(ns) / 1_000_000n);
export const msToNs = (ms: number): bigint => BigInt(Math.floor(ms)) * 1_000_000n;
