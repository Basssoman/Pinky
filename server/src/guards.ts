// Abuse guards: rate limits, duplicate-submission cache, and an off-chain
// pre-check that mirrors the contract's rules so obviously failing actions
// never cost relayer gas (review finding 8).

import type { DealView } from './chain.ts';
import {
  DENIED_DESTINATIONS,
  isAccountId,
  isCanonicalDecimal,
  isU128,
  isU64,
  MAX_DELIVERABLE_LEN,
  utf8Len,
  type ActionName,
} from './encoding.ts';

/**
 * Smallest withdraw the relayer submits (0.1 USDC). Below it a 1Click
 * payout fails anyway, and 1-unit top-ups could be cycled to burn relayer
 * NEAR. Anyone can still submit `act_call` for less themselves.
 */
export const MIN_RELAYED_WITHDRAW = 100_000n;

/** Fixed-window counter per key. */
export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(windowMs = 60_000, now: () => number = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }

  /** true if the key already used up its budget in this window (no increment). */
  exhausted(key: string, limit: number): boolean {
    const e = this.hits.get(key);
    return !!e && this.now() - e.windowStart < this.windowMs && e.count >= limit;
  }

  /** true if allowed. */
  take(key: string, limit: number): boolean {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || t - e.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: t, count: 1 });
      if (this.hits.size > 50_000) this.prune(t);
      return true;
    }
    if (e.count >= limit) return false;
    e.count++;
    return true;
  }

  private prune(t: number): void {
    for (const [k, e] of this.hits) if (t - e.windowStart >= this.windowMs) this.hits.delete(k);
  }
}

export type Entry<T> = { state: 'pending' } | { state: 'done'; value: T; at: number };

/** Remembers submitted (deal, action, payload, signature) tuples. */
export class DedupeCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = 10 * 60_000, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(key: string): Entry<T> | undefined {
    const e = this.entries.get(key);
    if (e && e.state === 'done' && this.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  start(key: string): void {
    this.entries.set(key, { state: 'pending' });
  }

  finish(key: string, value: T): void {
    this.entries.set(key, { state: 'done', value, at: this.now() });
    if (this.entries.size > 10_000) {
      for (const [k, e] of this.entries) if (e.state === 'done' && this.now() - e.at > this.ttlMs) this.entries.delete(k);
    }
  }

  /** Failed submissions may be retried (the contract decides). */
  forget(key: string): void {
    this.entries.delete(key);
  }
}

const LIVE = ['Funded', 'Delivered', 'Disputed'];

/** Delivery deadline of a funded deal (contract v2: set at funding). */
function deliveryDeadline(deal: DealView): bigint | null {
  return deal.delivery_deadline_ns ? BigInt(deal.delivery_deadline_ns) : null;
}

/**
 * Mirrors the contract v2 rules for `act`. Returns an error message, or null
 * if the action looks valid. `nowNs` is the server clock (the chain decides).
 */
export function precheckAction(
  deal: DealView,
  action: ActionName,
  payload: Record<string, unknown>,
  signer: 'creator' | 'client',
  nowNs: bigint,
  contractId: string,
  tokenId: string,
): string | null {
  const deadline = deliveryDeadline(deal);
  switch (action) {
    case 'cancel':
      return deal.state === 'Created' ? null : `cancel: deal is ${deal.state}`;
    case 'deliver': {
      if (deal.state !== 'Funded' || deadline === null) return `deliver: deal is ${deal.state}`;
      if (nowNs > deadline) return 'deliver: delivery deadline has passed';
      const h = payload.deliverable_hash;
      // Bytes, like the contract (`str.len()`); Cyrillic is 2 bytes a char.
      if (typeof h !== 'string' || h.length === 0 || utf8Len(h) > MAX_DELIVERABLE_LEN) {
        return `deliver: payload.deliverable_hash must be a 1..${MAX_DELIVERABLE_LEN} byte string`;
      }
      return null;
    }
    case 'refund':
      if (deal.state !== 'Funded' || deadline === null) return `refund: deal is ${deal.state}`;
      if (signer === 'creator') return null;
      return nowNs > deadline ? null : 'refund: the client may refund only after the delivery deadline';
    case 'accept':
      return deal.state === 'Delivered' ? null : `accept: deal is ${deal.state}`;
    case 'dispute': {
      if (deal.state !== 'Delivered') return `dispute: deal is ${deal.state}`;
      const ends = BigInt(deal.review_ends_at_ns ?? '0');
      return nowNs <= ends ? null : 'dispute: review period is over';
    }
    case 'revoke_settle': {
      if (!LIVE.includes(deal.state)) return `revoke_settle: deal is ${deal.state}`;
      // Contract v2: the signature names the seq it revokes.
      const seq = payload.seq;
      if (!isU64(seq)) return 'revoke_settle: payload.seq must be a canonical integer string';
      if (BigInt(seq) !== BigInt(deal.settle_seq)) return 'revoke_settle: seq is not the current settle_seq';
      return null;
    }
    case 'withdraw': {
      // v2: no state check (the client may withdraw extra money mid-deal);
      // only a payout of this key can be withdrawn.
      const dest = payload.destination;
      if (!isAccountId(dest)) return 'withdraw: payload.destination must be a NEAR account id';
      if (dest === contractId || dest === tokenId || DENIED_DESTINATIONS.includes(dest)) return 'withdraw: bad destination';
      const amount = payload.amount;
      const expires = payload.expires_at_ns;
      if (!isU128(amount) || BigInt(amount) <= 0n) {
        return 'withdraw: payload.amount must be a positive canonical integer string';
      }
      if (!isU64(expires)) {
        return 'withdraw: payload.expires_at_ns must be a canonical integer string (u64)';
      }
      if (nowNs > BigInt(expires)) return 'withdraw: signature expired';
      const payout = BigInt(signer === 'creator' ? deal.creator_payout : deal.client_payout);
      const pending = BigInt(signer === 'creator' ? deal.creator_pending : deal.client_pending);
      if (pending > 0n) return 'withdraw: another withdrawal is in progress';
      if (BigInt(amount) > payout) return 'withdraw: amount exceeds the withdrawable payout';
      // Only whole-payout withdraws are relayed: dust withdraws would burn
      // relayer gas and escrow storage for free.
      if (BigInt(amount) !== payout) return 'withdraw: amount must equal the whole withdrawable payout';
      if (payout < MIN_RELAYED_WITHDRAW) {
        return 'withdraw: below 0.1 USDC the relayer does not submit withdraws (submit act_call yourself)';
      }
      return null;
    }
  }
}

// ---------------------------------------------------------------- round 3

/** "No deadline" sort key. */
export const NO_DEADLINE = 2n ** 64n;

/**
 * Per-key async lock with a waiting queue ordered by earliest deadline
 * (then arrival). Used so that at most one relayer transaction per deal is
 * queued or in flight; waiters re-check fresh chain state when they get the
 * lock.
 */
export class KeyedLock {
  private readonly waiting = new Map<string, { deadline: bigint; seq: number; start: () => void }[]>();
  private readonly busy = new Set<string>();
  private seq = 0;

  async acquire(key: string, deadline: bigint = NO_DEADLINE): Promise<() => void> {
    const release = () => this.release(key);
    if (!this.busy.has(key)) {
      this.busy.add(key);
      return release;
    }
    return new Promise((resolve) => {
      const q = this.waiting.get(key) ?? [];
      q.push({ deadline, seq: this.seq++, start: () => resolve(release) });
      q.sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : a.seq - b.seq));
      this.waiting.set(key, q);
    });
  }

  private release(key: string): void {
    const next = this.waiting.get(key)?.shift();
    if (next) {
      next.start();
      return;
    }
    this.waiting.delete(key);
    this.busy.delete(key);
  }
}

/** Where daily counters that must survive a restart are kept (the SQLite store). */
export interface CounterStore {
  countEventsSince(key: string, sinceMs: number): number;
  addEvent(key: string, atMs: number): void;
}

/**
 * Counter per key over a rolling 24 h window. Keys for which `persist(key)`
 * is true live in the store, so a restart does not reset them; the others
 * (keys that contain an IP prefix) stay in memory only, so no client
 * addresses are written to disk.
 */
export class DailyCounter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly store?: CounterStore;
  private readonly persist: (key: string) => boolean;
  constructor(now: () => number = Date.now, store?: CounterStore, persist: (key: string) => boolean = () => false) {
    this.now = now;
    this.store = store;
    this.persist = persist;
  }
  count(key: string): number {
    const cutoff = this.now() - 24 * 3600 * 1000;
    if (this.store && this.persist(key)) return this.store.countEventsSince(key, cutoff);
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    this.hits.set(key, list);
    return list.length;
  }
  add(key: string): void {
    if (this.store && this.persist(key)) {
      this.store.addEvent(key, this.now());
      return;
    }
    this.count(key);
    this.hits.get(key)!.push(this.now());
  }
}

/** Daily-counter keys kept in the DB: deal- and link-scoped, never an IP. */
export const PERSISTED_COUNTERS = /^(withdraw|tx|revoke_settle|payquote|revoke|note):/;

/**
 * Key for per-minute buckets: the IPv4 address itself, the IPv6
 * /64 (one device / subnet), so rotating addresses inside a /64 does not
 * give fresh buckets. Daily caps use the wider `ipPrefix`.
 */
export function ipKey(ip: string): string {
  if (/^(?:::ffff:)?\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/^::ffff:/, '');
  return `${expandIpv6(ip).slice(0, 4).join(':')}::/64`;
}

/**
 * Network prefix used for per-IP caps: IPv4 /24, IPv6 /48 (one customer
 * allocation; a /64 per device would let one attacker use 65k buckets).
 */
export function ipPrefix(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.(\d+)\.\d+$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  return `${expandIpv6(ip).slice(0, 3).join(':')}::/48`;
}

/** "2001:db8::1" -> 8 groups (lowercase, no leading zeros). */
function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => (g.replace(/^0+(?=.)/, '') || '0'));
}

/**
 * Contract rejections that can never succeed later for the same signed
 * request (safe to cache). Time- or state-dependent ones are NOT cached.
 */
export function isPermanentRejection(message: string): boolean {
  return /signature already used|signature expired|invalid signature|invalid creator signature|invalid client signature|signature must be|unknown action|payload|deal not found|offer already used|offer expired|revoked|weak/.test(
    message,
  );
}

/**
 * Relayer priority: only deadlines the contract itself enforces, read from
 * the deal state (never a value the signer chooses). Withdraws go last: a
 * signer-chosen `expires_at_ns` let a counterparty push a victim's dispute
 * or delivery past its deadline.
 */
export function actionDeadline(deal: DealView, action: ActionName): bigint {
  switch (action) {
    case 'deliver':
      return deliveryDeadline(deal) ?? NO_DEADLINE;
    case 'dispute':
    case 'accept':
      return deal.review_ends_at_ns ? BigInt(deal.review_ends_at_ns) : NO_DEADLINE;
    default:
      return NO_DEADLINE;
  }
}

/**
 * The time after which the contract will certainly reject the action, so
 * the relayer drops it instead of paying gas for a sure failure.
 */
export function actionHardDeadline(deal: DealView, action: ActionName, payload?: Record<string, unknown>): bigint | null {
  if (action === 'deliver') return deliveryDeadline(deal);
  // `accept` has no time limit in the contract: never drop it.
  if (action === 'dispute' && deal.review_ends_at_ns) return BigInt(deal.review_ends_at_ns);
  // A withdraw after its signed expiry is a sure failure.
  if (action === 'withdraw' && isU64(payload?.expires_at_ns)) return BigInt(payload.expires_at_ns as string);
  return null;
}

/**
 * Actions whose delay can cost a party money: a late deliver
 * lets the client refund, a late dispute lets the deal auto-release. A late
 * accept gives the same split as the auto-release, so it is not critical.
 */
export function isTimeCritical(action: ActionName): boolean {
  return action === 'deliver' || action === 'dispute';
}

/**
 * The timer a settle must beat (contract v2): delivery
 * deadline in Funded, review end in Delivered, dispute end in Disputed.
 * null = settle is not possible in this state.
 */
export function settleTimerEnd(deal: DealView): bigint | null {
  switch (deal.state) {
    case 'Funded':
      return deliveryDeadline(deal);
    case 'Delivered':
      return deal.review_ends_at_ns ? BigInt(deal.review_ends_at_ns) : null;
    case 'Disputed':
      return deal.dispute_ends_at_ns ? BigInt(deal.dispute_ends_at_ns) : null;
    default:
      return null;
  }
}

/**
 * Mirrors the contract's `settle` checks on the payload (signatures are
 * checked by the caller). Returns an error message or null.
 */
export function precheckSettle(deal: DealView, payload: Record<string, unknown>, nowNs: bigint): string | null {
  const { split_bps, state, seq, expires_at_ns, nonce } = payload;
  if (!isCanonicalDecimal(split_bps, 5) || BigInt(split_bps) > 10_000n) return 'settle: split_bps must be 0..10000';
  if (!isU64(seq)) return 'settle: seq must be a canonical integer string';
  if (!isU64(expires_at_ns)) return 'settle: expires_at_ns must be a canonical integer string (u64)';
  if (typeof state !== 'string' || typeof nonce !== 'string' || !nonce) return 'settle: payload.state and payload.nonce are required';
  if (nowNs > BigInt(expires_at_ns)) return 'settle: signature expired';
  if (state !== deal.state) return `settle: the proposal was signed for ${state}, the deal is ${deal.state}`;
  if (BigInt(seq) !== BigInt(deal.settle_seq)) return 'settle: revoked (settle_seq changed)';
  const end = settleTimerEnd(deal);
  if (end === null) return `settle: deal is ${deal.state}`;
  if (nowNs > end) return 'settle: the deal timer is over; the timeout rules apply';
  return null;
}
