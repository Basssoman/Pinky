// Fastify app: the REST API (see server/README.md).
//
// Addressing: every deal is reached through `handle` = sha256(link token).
// The 128-bit token lives in the link fragment; reads need it in the
// `X-Deal-Token` header (or a fresh, single-use deal-key signature). Writes
// that move or quote money need a deal-key signature.
//
// Abuse limits: invalid / unauthenticated write requests count
// against a per-IP bucket; signed requests that fail the pre-check count
// against a bucket of THAT signer key only; a valid, pre-checked action is
// never rate-limited. `act` is permissionless on-chain: every action
// response carries the exact `act_call` so anyone can submit it directly.

import cors from '@fastify/cors';
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';

import { actCall, ChainCallError, DeadlinePassedError, RelayerTimeoutError, type Chain, type DealView } from './chain.ts';
import type { Config } from './config.ts';
import { HttpError, plainDuration } from './errors.ts';
import { registerBrief } from './brief.ts';
import { registerMarket } from './market.ts';
import { registerNotify } from './notify.ts';
import { registerReports } from './reports.ts';
import type { TelegramApi } from './telegram.ts';
import {
  ACTIONS,
  baseUnitsToUsdc,
  implicitAccountId,
  isAccountId,
  isCanonicalDecimal,
  isCanonicalSignature,
  keyFingerprint,
  nanosToIso,
  offerMessage,
  parseJsonLikeContract,
  parseOffer,
  parsePublicKey,
  revokeOfferMessage,
  sha256Hex,
  signedMessage,
  termsHash,
  utf8Len,
  verifySignature,
  type ActionName,
} from './encoding.ts';
import {
  actionDeadline,
  actionHardDeadline,
  DailyCounter,
  DedupeCache,
  ipKey,
  ipPrefix,
  isPermanentRejection,
  isTimeCritical,
  KeyedLock,
  NO_DEADLINE,
  PERSISTED_COUNTERS,
  precheckAction,
  precheckSettle,
  RateLimiter,
  settleTimerEnd,
} from './guards.ts';
import { OneClickError, type OneClick, type OneClickToken, type QuoteRequest, type QuoteResponse } from './oneclick.ts';
import { verifyQuoteSignature } from './quoteSignature.ts';
import type { DealRecord, Store } from './store.ts';

export interface AppDeps {
  config: Config;
  chain: Chain;
  oneClick: OneClick;
  store: Store;
  /** Fastify logger option (false in tests). */
  logger?: boolean | object;
  now?: () => number;
  /** Fake Telegram API for tests (the real one is made from TELEGRAM_BOT_TOKEN). */
  telegram?: TelegramApi;
  /** Waits between chain re-reads after a join send timed out (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** fetch for the AI brief helper (NEAR AI, NVIDIA NRAS, TDX verifier); tests pass a fake. */
  briefFetch?: typeof fetch;
}

export { HttpError };

const SEC_NS = 1_000_000_000n;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 5000;
const MAX_REVIEW_SECONDS = 90 * 24 * 3600;
/** Contract v2 hard cap of the delivery duration. */
const MAX_DELIVERY_SECONDS = 90 * 24 * 3600;
/** Max agreed revisions accepted in the terms. */
const MAX_REVISIONS = 100;
const MAX_PAYLOAD = 1024;
/** Encrypted notes: ciphertext as base64 inside a signed payload. */
const MAX_NOTE_DATA = 6000;
const MAX_NOTE_PAYLOAD = 6400;
/**
 * Who may store which note, and in which deal states. A note can be replaced
 * only in `replaceIn` (before the action it belongs to is on-chain); later it
 * is write-once, so nobody can swap evidence after the fact.
 */
const NOTE_RULES: Record<string, { signer: 'creator' | 'client'; states: readonly string[]; replaceIn?: string }> = {
  // The files link for the client (written just before `deliver`).
  delivery: { signer: 'creator', states: ['Funded', 'Delivered', 'Disputed'], replaceIn: 'Funded' },
  // The creator's own copy of the files link, for the arbiter only.
  delivery_arbiter: { signer: 'creator', states: ['Disputed'] },
  // The unmet point and the text, readable by the creator.
  dispute: { signer: 'client', states: ['Delivered', 'Disputed'], replaceIn: 'Delivered' },
  // The same plus the client's copy of the files link, for the arbiter only.
  dispute_arbiter: { signer: 'client', states: ['Delivered', 'Disputed'], replaceIn: 'Delivered' },
};
const ARBITER_OUTCOMES = ['creator', 'client', 'split'] as const;
/** Signed server requests: at most 2 min old, at most 30 s in the future, single use. */
const SIGNED_MAX_AGE_NS = 120n * SEC_NS;
const SIGNED_MAX_FUTURE_NS = 30n * SEC_NS;
const RECIPIENT_TYPES = ['DESTINATION_CHAIN', 'CONFIDENTIAL_INTENTS'] as const;
const TOKENS_TTL_MS = 10 * 60 * 1000;
const HANDLE_RE = /^[0-9a-f]{64}$/;
/** Request fields that must come back unchanged in the signed quote. */
const QUOTE_ECHO_FIELDS = [
  'dry',
  'swapType',
  'slippageTolerance',
  'originAsset',
  'depositType',
  'destinationAsset',
  'amount',
  'refundTo',
  'refundType',
  'recipient',
  'recipientType',
  'customRecipientMsg',
  'confidentiality',
  // The deadline we asked for: after it 1Click refunds the deposit. Real
  // 1Click returns quote.deadline = this + 3 days (when the deposit address
  // goes inactive), so the binding deadline is this signed echo
  // (checked live 2026-11-06).
  'deadline',
] as const;
const DAY_MS = 24 * 3600 * 1000;
/**
 * A pay quote's deposit deadline ends at least this long before `pay_by`
 * (contract v2; slow swaps still land inside the grace window).
 */
const PAY_DEADLINE_MARGIN_NS = 3600n * SEC_NS;
/** Pay quotes with less time than this to deposit are refused (too late to pay). */
const MIN_PAY_WINDOW_NS = 5n * 60n * SEC_NS;
/**
 * After a join send timed out (or the RPC errored after sending), the deal is
 * re-read this often, this many times, before answering 504: on 2026-11-11 every
 * first join on mainnet answered 504 although it landed a few seconds later.
 * 10 x 2 s keeps the request under the site's 150 s fetch limit even after the
 * full 120 s send timeout.
 */
const JOIN_RECOVER_TRIES = 10;
const JOIN_RECOVER_INTERVAL_MS = 2000;
/** Chain reads are reused this long for requests from an IP over its invalid-request budget. */
const FLOOD_CACHE_MS = 2000;
/** NEAR balances (health, reserves) are re-read at most this often. */
const BALANCE_CACHE_MS = 15_000;
/**
 * After a pay quote's deadline the swap may still be settling; cancel stays
 * blocked this much longer.
 */
const SWAP_SETTLE_MS = 3600 * 1000;

/** NEAR implicit account (64 hex) or ETH-style implicit account: exists implicitly. */
const IMPLICIT_ACCOUNT_RE = /^(?:[0-9a-f]{64}|0x[0-9a-f]{40})$/;
/** Statuses that count against the per-IP "invalid request" bucket. */
const INVALID_STATUSES = new Set([400, 401, 403, 404]);

/** Which deal key may sign which action (mirrors the contract). */
const ACTION_SIGNERS: Record<ActionName, readonly ('creator' | 'client')[]> = {
  cancel: ['creator'],
  deliver: ['creator'],
  refund: ['creator', 'client'],
  accept: ['client'],
  dispute: ['client'],
  withdraw: ['creator', 'client'],
  revoke_settle: ['creator', 'client'],
};

type Body = Record<string, unknown>;
type Party = 'creator' | 'client';
type ActOutcome = { kind: 'ok'; body: Record<string, unknown> } | { kind: 'rejected'; message: string; tx_hash: string | null };

function bad(message: string, code = 'bad_request'): HttpError {
  return new HttpError(400, code, message);
}
const notFound = () => new HttpError(404, 'not_found', 'deal not found');

function str(body: Body, key: string, opts: { max?: number; optional?: boolean } = {}): string {
  const v = body[key];
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw bad(`${key} is required`);
  }
  if (typeof v !== 'string') throw bad(`${key} must be a string`);
  if (opts.max && v.length > opts.max) throw bad(`${key} is too long (max ${opts.max})`);
  return v;
}

function termsView(r: DealRecord, deal: DealView | null) {
  return {
    title: r.title,
    description: r.description,
    revisions: r.revisions,
    salt: r.salt,
    amount: r.amount,
    amount_usdc: baseUnitsToUsdc(r.amount),
    fee_bps: Number(r.fee_bps),
    delivery_duration_ns: r.delivery_duration_ns,
    delivery_duration_seconds: Number(BigInt(r.delivery_duration_ns) / SEC_NS),
    // Contract v2: the deadline exists only once the deal is funded.
    delivery_deadline: deal?.delivery_deadline_ns ? nanosToIso(deal.delivery_deadline_ns) : null,
    review_period_ns: r.review_period_ns,
    review_period_seconds: Number(BigInt(r.review_period_ns) / SEC_NS),
    terms_hash: r.terms_hash,
  };
}

/** Keep only status fields the UI needs (drop refund addresses / origin tx links). */
export function sanitizeStatus(s: Record<string, unknown>) {
  const d = (s.swapDetails ?? {}) as Record<string, unknown>;
  return {
    status: s.status ?? null,
    updated_at: s.updatedAt ?? null,
    swap_details: {
      amount_in: d.amountIn ?? null,
      amount_in_formatted: d.amountInFormatted ?? null,
      amount_out: d.amountOut ?? null,
      amount_out_formatted: d.amountOutFormatted ?? null,
      deposited_amount: d.depositedAmount ?? null,
      deposited_amount_formatted: d.depositedAmountFormatted ?? null,
      refunded_amount: d.refundedAmount ?? null,
      refunded_amount_formatted: d.refundedAmountFormatted ?? null,
      refund_reason: d.refundReason ?? null,
    },
  };
}

function quoteBody(res: QuoteResponse) {
  return {
    correlationId: res.correlationId ?? null,
    timestamp: res.timestamp ?? null,
    signature: res.signature ?? null,
    quoteRequest: res.quoteRequest ?? null,
    quote: res.quote,
  };
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, chain, oneClick, store } = deps;
  const now = deps.now ?? Date.now;
  const nowNs = () => BigInt(now()) * 1_000_000n;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limiter = new RateLimiter(60_000, now);
  const dedupe = new DedupeCache<ActOutcome>(10 * 60_000, now);
  const usedSignedRequests = new Map<string, number>(); // signature -> expiry ms
  let lastPrune = 0;
  const joining = new Set<string>();
  /** At most one relayer tx per deal queued or in flight. */
  const dealLock = new KeyedLock();
  // Deal-scoped daily budgets survive a restart; IP-prefix ones stay in memory.
  const daily = new DailyCounter(now, store, (k) => PERSISTED_COUNTERS.test(k));
  /** Contract rejections per deal (and per join handle), 10 min window. */
  const chainFails = new RateLimiter(10 * 60_000, now);
  /** Queued / in-flight time-critical txs per IP prefix. */
  const criticalQueued = new Map<string, number>();
  /** Handles with a pay quote being fetched, and with a cancel queued / in flight. */
  const quoting = new Set<string>();
  const cancelling = new Set<string>();
  /** Per-minute bucket keys: IPv4 address / IPv6 /64; invalid traffic per IPv6 /48. */
  const netKey = (ip: string) => ipKey(ip);
  const badKey = (ip: string) => (ip.includes(':') && !ip.startsWith('::ffff:') ? ipPrefix(ip) : ipKey(ip));
  /** Actions/act-call: the IP bucket applies only after the deal-key signature failed. */
  const SIGNED_ROUTE = /\/api\/deals\/[0-9a-f]{64}\/(actions|act-call)$/;

  // Request logs: method + path only. No query string (pay-status carries a
  // deposit address there), no IP, no headers.
  const logger = deps.logger
    ? {
        ...(typeof deps.logger === 'object' ? deps.logger : {}),
        serializers: {
          req: (r: { method?: string; url?: string }) => ({ method: r.method, url: String(r.url ?? '').split('?')[0] }),
        },
      }
    : false;
  // Fastify's own request logs (incl. its 404 line) print the full URL with
  // the query string; we log method + path + status ourselves.
  // trustProxy as a number = trust that many proxy hops (Fastify supports it; its typings omit it).
  const app = Fastify({
    logger,
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy as unknown as string | boolean,
    // Same as the old top-level `disableRequestLogging: true` (deprecated,
    // FSTDEP023): Fastify's own per-request lines are off.
    logController: new LogController({ disableRequestLogging: true }),
  });
  if (logger) {
    app.addHook('onResponse', async (req, reply) => {
      req.log.info({ method: req.method, url: String(req.url ?? '').split('?')[0], status: reply.statusCode }, 'request');
    });
  }
  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-Deal-Token', 'X-Deal-Payload', 'X-Deal-Signature', 'X-Request-Token'],
  });

  // Write requests from an IP that keeps sending invalid requests are refused early.
  app.addHook('onRequest', async (req) => {
    if (SIGNED_ROUTE.test(req.url.split('?')[0])) return;
    if (req.method === 'POST' && limiter.exhausted(`bad:${badKey(req.ip)}`, config.rateInvalidPerMin)) {
      throw new HttpError(429, 'rate_limited', 'too many invalid requests from this address');
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status =
      err instanceof HttpError ? err.statusCode : err instanceof ChainCallError ? 422 : err instanceof OneClickError ? 0 : (err.statusCode ?? 500);
    if (req.method === 'POST' && INVALID_STATUSES.has(status)) limiter.take(`bad:${badKey(req.ip)}`, Number.MAX_SAFE_INTEGER);
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, ...err.details });
    }
    if (err instanceof ChainCallError) {
      return reply.status(422).send({ error: 'contract_rejected', message: err.message, tx_hash: err.txHash ?? null });
    }
    if (err instanceof DeadlinePassedError) {
      return reply.status(409).send({ error: 'deadline_passed', message: err.message });
    }
    if (err instanceof RelayerTimeoutError) {
      // Outcome unknown: the browser re-reads the deal.
      return reply.status(504).send({ error: 'relayer_timeout', message: err.message });
    }
    if (err instanceof OneClickError) {
      const s = err.status >= 400 && err.status < 500 ? 422 : 502;
      return reply.status(s).send({ error: 'oneclick_error', message: err.message, upstream_status: err.status });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    }
    if (err.name === 'NotEnoughBalanceError') {
      // The relayer cannot cover the (pessimistic) prepaid gas: an operator problem.
      req.log.error({ err: { message: err.message, name: err.name } }, 'relayer out of NEAR');
      return reply.status(503).send({ error: 'relayer_out_of_funds', message: 'the relayer account needs more NEAR for gas' });
    }
    req.log.error({ err: { message: err.message, name: err.name } }, 'unhandled error');
    return reply.status(500).send({ error: 'internal', message: 'internal error' });
  });

  // Marketplace routes: profiles, requests, reviews. Off-chain only.
  const market = registerMarket(app, { config, chain, store, now, limiter });
  app.decorate('market', market);
  // Telegram deal notifications. Off without TELEGRAM_BOT_TOKEN + TELEGRAM_BOT_USERNAME.
  const notify = registerNotify(app, { config, chain, store, now, limiter, log: app.log, telegram: deps.telegram, market });
  app.decorate('notify', notify);
  // "Report" button: stored; sent to TELEGRAM_REPORTS_CHAT_ID by our bot when set.
  const reports = registerReports(app, { config, market: market.store, store, now, log: app.log, telegram: deps.telegram });
  app.decorate('reports', reports);
  // AI brief helper on NEAR AI Cloud. Off without NEARAI_API_KEY.
  registerBrief(app, { config, limiter, now, fetch: deps.briefFetch });

  // ------------------------------------------------------------ helpers

  function readLimit(req: FastifyRequest): void {
    if (!limiter.take(`read:${netKey(req.ip)}`, config.rateReadsPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
  }

  /** Per-network limit for quote routes, checked BEFORE any chain read. */
  function quoteIpLimit(req: FastifyRequest): void {
    if (!limiter.take(`quoteip:${netKey(req.ip)}`, config.rateQuotesPerMin * 3)) {
      throw new HttpError(429, 'rate_limited', 'too many quote requests from this address; wait a minute');
    }
  }

  /** Charges the per-IP invalid bucket for a request that did not fail with 4xx (e.g. 409 not_joined). */
  function chargeBad(req: FastifyRequest): void {
    limiter.take(`bad:${badKey(req.ip)}`, Number.MAX_SAFE_INTEGER);
  }

  let balanceCache: { at: number; value: { escrow: bigint; relayer: bigint } } | null = null;
  /** NEAR balances, re-read at most every 15 s (health and reserves). */
  async function balances(): Promise<{ escrow: bigint; relayer: bigint }> {
    if (balanceCache && now() - balanceCache.at < BALANCE_CACHE_MS) return balanceCache.value;
    const value = await chain.getNearBalances();
    balanceCache = { at: now(), value };
    return value;
  }

  /**
   * Non-time-critical relayer txs are refused while the relayer is low on
   * NEAR, so deliver / dispute always have gas left. An
   * unreadable balance does not block (the tx then fails on its own).
   */
  async function requireRelayerReserve(): Promise<void> {
    let b: { relayer: bigint } | null = null;
    try {
      b = await balances();
    } catch {
      return;
    }
    if (b.relayer < config.actionReserveRelayer) {
      throw new HttpError(503, 'low_balance', 'the relayer is low on NEAR; only time-critical actions are relayed now. Submit act_call yourself or retry later');
    }
  }

  /** Cool-down after repeated contract rejections for one deal or join handle. */
  function requireNoChainFailStreak(key: string, extra?: Record<string, unknown>): void {
    if (chainFails.exhausted(key, config.chainFailsPerDeal)) {
      throw new HttpError(429, 'rate_limited', 'the contract rejected several transactions here; wait 10 minutes', extra);
    }
  }

  /** Per-deal daily budget of relayed non-time-critical txs. */
  function takeDealTx(dealId: number, extra?: Record<string, unknown>): void {
    const k = `tx:${dealId}`;
    if (daily.count(k) >= config.dailyTxPerDeal) {
      throw new HttpError(429, 'daily_cap', 'too many relayed transactions for this deal today; submit act_call yourself or retry tomorrow', extra);
    }
    daily.add(k);
  }

  function record(req: FastifyRequest): DealRecord {
    const handle = (req.params as { handle?: string }).handle ?? '';
    if (!HANDLE_RE.test(handle)) throw notFound();
    const rec = store.getDeal(handle);
    if (!rec) throw notFound();
    return rec;
  }

  function hasToken(req: FastifyRequest, rec: DealRecord): boolean {
    const token = req.headers['x-deal-token'];
    return typeof token === 'string' && token.length <= 128 && sha256Hex(token) === rec.handle;
  }

  /**
   * Short-lived cache of chain reads, used ONLY for requests from an IP that
   * is over its invalid-request budget, so junk floods cannot turn into RPC
   * floods. Normal requests always read fresh state.
   */
  const floodCache = new Map<string, { at: number; value: unknown }>();
  async function viewMaybeCached<T>(key: string, useCache: boolean, load: () => Promise<T>): Promise<T> {
    if (useCache) {
      const e = floodCache.get(key);
      if (e && now() - e.at < FLOOD_CACHE_MS) return e.value as T;
    }
    const value = await load();
    if (useCache) {
      if (floodCache.size > 5000) floodCache.clear();
      floodCache.set(key, { at: now(), value });
    }
    return value;
  }

  /** Maps handle -> deal id if a join landed on-chain but was not recorded. */
  async function recoverDealId(rec: DealRecord, useCache = false): Promise<DealRecord> {
    if (rec.deal_id !== null) return rec;
    try {
      const id = await viewMaybeCached(`offer:${rec.handle}`, useCache, () => chain.getDealIdByOffer(rec.offer));
      if (id !== null) {
        store.setDealId(rec.handle, id);
        return { ...rec, deal_id: id };
      }
    } catch {
      /* chain unreachable: keep unmapped */
    }
    return rec;
  }

  async function loadDeal(rec: DealRecord, useCache = false): Promise<DealView> {
    if (rec.deal_id === null) throw new HttpError(409, 'not_joined', 'the client has not joined this deal yet');
    const id = rec.deal_id;
    const deal = await viewMaybeCached(`deal:${id}`, useCache, () => chain.getDeal(id));
    if (!deal) throw new HttpError(502, 'chain_mismatch', 'deal not found on chain');
    return deal;
  }

  function signerOf(deal: DealView, message: string, signature: string): Party | null {
    if (verifySignature(deal.creator_pk, message, signature)) return 'creator';
    if (verifySignature(deal.client_pk, message, signature)) return 'client';
    return null;
  }

  /** Verifies a single-use server-only signed request `{payload, signature}`. */
  function signedRequest(rec: DealRecord, deal: DealView, kind: string, payload: unknown, signature: unknown, maxLen = MAX_PAYLOAD) {
    if (typeof payload !== 'string' || utf8Len(payload) > maxLen) throw bad('payload must be a JSON string');
    if (!isCanonicalSignature(signature)) throw bad('signature must be canonical base64 of 64 bytes', 'bad_signature_encoding');
    let data: Body;
    try {
      data = JSON.parse(payload);
    } catch {
      throw bad('payload must be a JSON string');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('payload must be a JSON object');
    const issued = data.issued_at_ns;
    if (typeof issued !== 'string' || !/^\d{1,20}$/.test(issued)) throw bad('payload.issued_at_ns is required');
    const age = nowNs() - BigInt(issued);
    if (age > SIGNED_MAX_AGE_NS || age < -SIGNED_MAX_FUTURE_NS) {
      throw new HttpError(401, 'stale_request', 'payload.issued_at_ns must be within the last 2 minutes');
    }
    const message = signedMessage(chain.contractId, rec.deal_id!, kind, payload);
    const signer = signerOf(deal, message, signature);
    if (!signer) throw new HttpError(401, 'invalid_signature', 'signature does not match any key of this deal');
    const t = now();
    // Pruned at most once a second, not on every request.
    if (t - lastPrune > 1000) {
      lastPrune = t;
      for (const [k, exp] of usedSignedRequests) if (exp < t) usedSignedRequests.delete(k);
    }
    if ((usedSignedRequests.get(signature) ?? 0) > t) throw new HttpError(401, 'replayed_request', 'this signed request was already used');
    usedSignedRequests.set(signature, t + Number((SIGNED_MAX_AGE_NS + SIGNED_MAX_FUTURE_NS) / 1_000_000n));
    return { signer, data };
  }

  /** Token holder, or a fresh single-use `read` signature by a deal key. 404 otherwise. */
  async function authorizeRead(req: FastifyRequest, rec: DealRecord): Promise<void> {
    if (hasToken(req, rec)) return;
    const payload = req.headers['x-deal-payload'];
    const signature = req.headers['x-deal-signature'];
    if (rec.deal_id !== null && typeof payload === 'string' && typeof signature === 'string') {
      // A chain read per signed GET: limited per network first, and a flooding
      // network reads from the short cache.
      if (!limiter.take(`sigread:${netKey(req.ip)}`, config.rateInvalidPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
      const flooding = limiter.exhausted(`bad:${badKey(req.ip)}`, config.rateInvalidPerMin);
      try {
        const deal = await loadDeal(rec, flooding);
        const { data } = signedRequest(rec, deal, 'read', payload, signature);
        if (data.handle === rec.handle) return;
      } catch {
        /* fall through to 404 */
      }
      chargeBad(req);
    }
    throw notFound();
  }

  function quoteLimit(rec: DealRecord, signer: Party): void {
    if (!limiter.take(`quote:${rec.handle}:${signer}`, config.rateQuotesPerMin)) {
      throw new HttpError(429, 'rate_limited', 'too many quotes for this key; wait a minute');
    }
  }

  /**
   * The quote must be signed by 1Click AND be a quote for exactly what we
   * asked (R5b): 1Click echoes the request inside the signed payload.
   */
  function checkQuote(res: QuoteResponse, sent: QuoteRequest): void {
    if (!verifyQuoteSignature(res as never, config.oneClickQuotePublicKey)) {
      throw new HttpError(502, 'bad_quote_signature', '1Click quote signature did not verify');
    }
    const echo = (res.quoteRequest ?? {}) as Record<string, unknown>;
    for (const k of QUOTE_ECHO_FIELDS) {
      const want = (sent as unknown as Record<string, unknown>)[k];
      if (want !== undefined && echo[k] !== want) {
        throw new HttpError(502, 'quote_mismatch', `1Click quote does not match the request (${k})`);
      }
    }
  }

  const since24h = () => new Date(now() - DAY_MS).toISOString();

  // ------------------------------------------------------------ meta

  /** Busy-day counters go to the server log (at most once an hour), never to the public health answer. */
  let activityLoggedAt = -Infinity;
  function logActivity(): void {
    if (now() - activityLoggedAt < 60 * 60_000) return;
    const offers = store.countOffersSince(since24h());
    const joins = store.countJoinsSince(since24h());
    // Offers are off-chain: alert only, never refuse globally.
    const busy = offers >= config.offerAlertThreshold || joins >= config.dailyJoinCap * 0.8;
    if (!busy) return;
    activityLoggedAt = now();
    app.log.warn({ offers_24h: offers, offer_alert_threshold: config.offerAlertThreshold, joins_24h: joins, join_cap: config.dailyJoinCap }, 'unusually many new deals in the last 24h');
  }

  // Public: only what anyone can read anyway (network, contract, its NEAR balances
  // are on chain). No daily counters, thresholds or caps: those go to the log.
  app.get('/api/health', async () => {
    const warnings: string[] = [];
    let nearBalances: Record<string, string> | null = null;
    try {
      const b = await balances();
      nearBalances = { escrow_yocto: b.escrow.toString(), relayer_yocto: b.relayer.toString() };
      if (b.relayer < config.lowBalanceRelayer) warnings.push('relayer NEAR balance is low (gas)');
      if (b.escrow < config.lowBalanceEscrow) warnings.push('escrow NEAR balance is low (storage deposits)');
    } catch {
      warnings.push('could not read NEAR balances');
    }
    try {
      logActivity();
    } catch {
      /* the log line is best effort */
    }
    return {
      ok: warnings.length === 0,
      network: config.network,
      contract_id: chain.contractId,
      balances: nearBalances,
      warnings,
    };
  });

  app.get('/api/config', async () => ({
    network: config.network,
    contract_id: chain.contractId,
    usdc_asset_id: config.usdcAssetId,
    token_account_id: config.tokenAccountId,
    message_prefix: 'escrow-v1',
    oneclick_dry_run: config.oneClickForceDry,
    oneclick_quote_public_key: config.oneClickQuotePublicKey,
    min_review_period_seconds: config.minReviewPeriodSeconds,
    min_delivery_seconds: config.minDeliverySeconds,
    max_offer_ttl_seconds: config.maxOfferTtlSeconds,
    max_deal_amount: config.maxDealAmount.toString(),
    min_deal_amount: config.minDealAmount.toString(),
    max_delivery_seconds: MAX_DELIVERY_SECONDS,
    max_review_seconds: MAX_REVIEW_SECONDS,
    fee_bps: config.feeBps,
    payout_refund_type: config.payoutRefundType,
    withdraw_expiry_margin_seconds: config.withdrawExpiryMarginSeconds,
    withdraw_deposit_yocto: actCall(chain.contractId, 0, 'withdraw', '{}', '').deposit,
    // The one official notification bot (username, no "@"), or null: the site then hides the button.
    telegram_bot: notify.bot,
  }));

  // ------------------------------------------------------------ creator: offer

  app.post('/api/deals', async (req, reply) => {
    if (!limiter.take(`write:${netKey(req.ip)}`, config.rateWritesPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
    const offerKey = `offer:${ipPrefix(req.ip)}`;
    if (daily.count(offerKey) >= config.dailyOffersPerIp) {
      throw new HttpError(429, 'daily_cap', 'too many new deals from this network today; try again later');
    }
    const body = (req.body ?? {}) as Body;
    const handle = str(body, 'handle');
    if (!HANDLE_RE.test(handle)) throw bad('handle must be sha256(token) as 64 lowercase hex chars');
    const offer = str(body, 'offer', { max: MAX_PAYLOAD });
    if (utf8Len(offer) > MAX_PAYLOAD) throw bad(`offer is too long (max ${MAX_PAYLOAD} bytes)`, 'bad_offer');
    const offerSignature = body.offer_signature;
    let o;
    try {
      o = parseOffer(offer);
    } catch (e) {
      throw bad((e as Error).message, 'bad_offer');
    }
    if (!isCanonicalSignature(offerSignature)) throw bad('offer_signature must be canonical base64 of 64 bytes', 'bad_signature_encoding');
    if (!verifySignature(o.creator_pk, offerMessage(chain.contractId, offer), offerSignature)) {
      throw new HttpError(401, 'invalid_signature', 'offer_signature does not match offer.creator_pk');
    }
    const terms = (body.terms ?? {}) as Body;
    if (typeof terms !== 'object') throw bad('terms must be an object');
    const title = str(terms, 'title', { max: MAX_TITLE });
    if (!title.trim()) throw bad('terms.title is required');
    const description = str(terms, 'description', { max: MAX_DESCRIPTION, optional: true });
    const revisions = terms.revisions === undefined || terms.revisions === null ? '' : terms.revisions;
    if (revisions !== '' && (!isCanonicalDecimal(revisions, 3) || Number(revisions) > MAX_REVISIONS)) {
      throw bad(`revisions must be empty or a whole number from 0 to ${MAX_REVISIONS}`);
    }
    const salt = str(terms, 'salt');
    if (!/^[0-9a-f]{32,64}$/.test(salt)) throw bad('terms.salt must be 32..64 lowercase hex chars (>= 128 bits)');
    const hashed = {
      title,
      description,
      revisions: revisions as string,
      amount: o.amount,
      delivery_duration_ns: o.delivery_duration_ns,
      review_period_ns: o.review_period_ns,
      salt,
    };
    if (termsHash(hashed) !== o.terms_hash) throw bad('offer.terms_hash does not match the terms', 'terms_mismatch');

    if (BigInt(o.amount) > config.maxDealAmount) {
      throw bad(`the deal amount is above the maximum of ${baseUnitsToUsdc(config.maxDealAmount)} USDC`);
    }
    if (BigInt(o.amount) < config.minDealAmount) {
      throw bad(`the deal amount is below the minimum of ${baseUnitsToUsdc(config.minDealAmount)} USDC`, 'amount_too_small');
    }
    // The fee is in each offer; the server decides the tier.
    if (Number(o.fee_bps) !== config.feeBps) throw bad(`offer.fee_bps must be ${config.feeBps} (a ${config.feeBps / 100}% fee)`, 'bad_fee');
    const n = nowNs();
    const duration = BigInt(o.delivery_duration_ns);
    if (duration < BigInt(config.minDeliverySeconds) * SEC_NS || duration > BigInt(MAX_DELIVERY_SECONDS) * SEC_NS) {
      throw bad(`delivery duration must be between ${plainDuration(config.minDeliverySeconds)} and ${plainDuration(MAX_DELIVERY_SECONDS)}`);
    }
    const review = BigInt(o.review_period_ns);
    if (review < BigInt(config.minReviewPeriodSeconds) * SEC_NS || review > BigInt(MAX_REVIEW_SECONDS) * SEC_NS) {
      throw bad(`review period must be between ${plainDuration(config.minReviewPeriodSeconds)} and ${plainDuration(MAX_REVIEW_SECONDS)}`);
    }
    const expires = BigInt(o.offer_expires_at_ns);
    if (expires <= n || expires > n + BigInt(config.maxOfferTtlSeconds) * SEC_NS) {
      throw bad(`the link must expire in the future and at most ${plainDuration(config.maxOfferTtlSeconds)} from now`);
    }
    if (store.getDeal(handle)) throw new HttpError(409, 'handle_taken', 'handle already exists');
    if (store.offerExists(offer)) throw new HttpError(409, 'offer_taken', 'this exact offer is already stored under another link');
    // Optional: a deal made from a catalog request, checked before anything is stored.
    const linkRequest = market.prepareDealLink(body, o.creator_pk);
    store.insertDeal({
      handle,
      offer,
      offer_signature: offerSignature,
      creator_pk: o.creator_pk,
      title,
      description,
      salt,
      amount: o.amount,
      delivery_duration_ns: o.delivery_duration_ns,
      review_period_ns: o.review_period_ns,
      revisions: revisions as string,
      fee_bps: o.fee_bps,
      terms_hash: o.terms_hash,
    });
    daily.add(offerKey);
    if (linkRequest) linkRequest(handle);
    reply.status(201);
    return {
      handle,
      offer_hash: sha256Hex(offer),
      creator_fingerprint: keyFingerprint(o.creator_pk),
      ...(linkRequest ? { request_linked: true } : {}),
    };
  });

  // ------------------------------------------------------------ read

  app.get('/api/deals/:handle', async (req) => {
    readLimit(req);
    let rec = record(req);
    await authorizeRead(req, rec);
    rec = await recoverDealId(rec);
    const deal = rec.deal_id === null ? null : await chain.getDeal(rec.deal_id);
    const o = parseOffer(rec.offer);
    return {
      handle: rec.handle,
      contract_id: chain.contractId,
      offer: rec.offer,
      offer_signature: rec.offer_signature,
      offer_expires_at_ns: o.offer_expires_at_ns,
      creator_pk: rec.creator_pk,
      creator_fingerprint: keyFingerprint(rec.creator_pk),
      terms: termsView(rec, deal),
      deal_id: rec.deal_id,
      deal,
      // A purged deal keeps no terms hash on-chain (only the keys and the client's leftover money).
      terms_verified: deal && !deal.purged ? deal.terms_hash === rec.terms_hash && deal.creator_pk === rec.creator_pk : null,
      purged: deal?.purged === true,
      revoked: rec.revoked_at !== null,
    };
  });

  // ------------------------------------------------------------ client: join

  app.post('/api/deals/:handle/join', async (req, reply) => {
    let rec = record(req);
    if (!hasToken(req, rec)) throw notFound();
    const body = (req.body ?? {}) as Body;
    const clientPk = str(body, 'client_pk');
    if (!parsePublicKey(clientPk)) throw bad('client_pk must be "ed25519:<base58 of 32 bytes>"');
    if (clientPk === rec.creator_pk) throw bad('client_pk must differ from the creator key');

    const alreadyJoined = async (r: DealRecord) => {
      const deal = await chain.getDeal(r.deal_id!);
      if (deal && deal.client_pk === clientPk) {
        // Same client retrying after a timeout: recovered.
        return { deal_id: r.deal_id, client_pk: clientPk, client_fingerprint: deal.client_fingerprint, recovered: true };
      }
      throw new HttpError(409, 'already_joined', 'this offer was already accepted by another key; do not pay with this link', {
        deal_id: r.deal_id,
        client_fingerprint: deal?.client_fingerprint ?? null,
      });
    };

    rec = await recoverDealId(rec);
    if (rec.deal_id !== null) return alreadyJoined(rec);
    if (rec.revoked_at) throw new HttpError(410, 'revoked', 'the creator revoked this link; do not pay with it');
    if (joining.has(rec.handle)) throw new HttpError(409, 'join_in_progress', 'a join for this link is in progress');
    const offer = parseOffer(rec.offer);
    if (nowNs() > BigInt(offer.offer_expires_at_ns)) throw new HttpError(409, 'offer_expired', 'this offer has expired');
    requireNoChainFailStreak(`join:${rec.handle}`);
    requireNoChainFailStreak(`joinip:${ipPrefix(req.ip)}`);
    const joinKey = `join:${ipPrefix(req.ip)}`;
    if (daily.count(joinKey) >= config.dailyJoinsPerIp) {
      throw new HttpError(429, 'daily_cap', 'too many new deals from this network today; try again later');
    }
    if (store.countJoinsSince(since24h()) >= config.dailyJoinCap) {
      throw new HttpError(429, 'daily_cap', 'the daily limit for new deals is reached; try again later');
    }
    // Free joins never eat the NEAR that existing deals need.
    let near: { escrow: bigint; relayer: bigint } | null = null;
    try {
      near = await chain.getNearBalances();
    } catch {
      /* chain unreachable: create_deal will fail on its own */
    }
    if (near && (near.escrow < config.joinReserveEscrow || near.relayer < config.joinReserveRelayer)) {
      req.log.error('new joins paused: escrow or relayer NEAR is below the join reserve');
      throw new HttpError(503, 'low_balance', 'new deals are paused for a moment (service fee balance is low); try again later');
    }
    joining.add(rec.handle);
    try {
      const { txHash, value } = await chain.createDeal(rec.offer, rec.offer_signature, clientPk);
      const dealId = Number(value);
      if (!Number.isInteger(dealId)) throw new Error('create_deal returned no deal id');
      store.setDealId(rec.handle, dealId);
      daily.add(joinKey);
      reply.status(201);
      return { deal_id: dealId, tx_hash: txHash, client_pk: clientPk, client_fingerprint: keyFingerprint(clientPk) };
    } catch (e) {
      // Timed out or "offer already used": the deal may exist anyway.
      let r = await recoverDealId(rec);
      // A send whose answer was lost usually lands a few seconds later: keep
      // reading the chain (offer -> deal id) before answering 504.
      for (let i = 0; r.deal_id === null && e instanceof RelayerTimeoutError && i < JOIN_RECOVER_TRIES; i++) {
        await sleep(JOIN_RECOVER_INTERVAL_MS);
        r = await recoverDealId(rec);
      }
      if (r.deal_id !== null) {
        const joined = await alreadyJoined(r);
        daily.add(joinKey); // it is a new deal from this network all the same
        if (e instanceof RelayerTimeoutError) req.log.info({ deal_id: r.deal_id }, 'join landed after a send timeout');
        return joined;
      }
      if (e instanceof ChainCallError && /already used or revoked/.test(e.message)) {
        // Revoked on-chain but not in our DB (e.g. a restored backup): remember it.
        store.markRevoked(rec.handle);
        throw new HttpError(410, 'revoked', 'the creator revoked this link; do not pay with it');
      }
      if (e instanceof ChainCallError) {
        chainFails.take(`join:${rec.handle}`, Number.MAX_SAFE_INTEGER);
        chainFails.take(`joinip:${ipPrefix(req.ip)}`, Number.MAX_SAFE_INTEGER);
      }
      throw e;
    } finally {
      joining.delete(rec.handle);
    }
  });

  // ------------------------------------------------------------ client: pay (signed)

  app.post('/api/deals/:handle/pay-quote', async (req) => {
    quoteIpLimit(req);
    const rec = await recoverDealId(record(req));
    if (rec.deal_id === null) chargeBad(req);
    const body = (req.body ?? {}) as Body;
    const deal = await loadDeal(rec);
    const { signer, data } = signedRequest(rec, deal, 'pay-quote', body.payload, body.signature);
    if (signer !== 'client') throw new HttpError(403, 'wrong_key', 'pay-quote must be signed by the client key');
    quoteLimit(rec, signer);
    // Never hand out a payment address while the creator's cancel is on its
    // way: the payment would land in a Cancelled deal.
    if (cancelling.has(rec.handle)) throw new HttpError(409, 'cancel_pending', 'the creator is cancelling this deal; do not pay');
    const quotesKey = `payquote:${rec.handle}`;
    if (daily.count(quotesKey) >= config.dailyPayQuotesPerDeal) {
      throw new HttpError(429, 'daily_cap', 'too many payment quotes for this deal today; try again tomorrow');
    }
    const originAsset = str(data, 'origin_asset', { max: 200 });
    const refundAddress = str(data, 'refund_address', { max: 200 });
    if (deal.state !== 'Created') {
      throw new HttpError(409, 'wrong_state', `deal is ${deal.state}; payment is only possible while Created`);
    }
    // Contract v2: one payment must cover the WHOLE amount (partial money
    // goes back to the client), so the quote is always for the full amount.
    const fullAmount = BigInt(deal.amount);
    // The deposit must be due well before pay_by: money after the funding
    // cutoff only goes back to the client.
    const lastDepositNs = BigInt(deal.pay_by_ns) - PAY_DEADLINE_MARGIN_NS;
    const quoteEndNs = nowNs() + BigInt(config.quoteDeadlineSeconds) * SEC_NS;
    const depositDeadlineNs = quoteEndNs < lastDepositNs ? quoteEndNs : lastDepositNs;
    if (depositDeadlineNs - nowNs() < MIN_PAY_WINDOW_NS) {
      throw new HttpError(409, 'too_late', 'the time to pay this deal is over; ask the creator for a new deal');
    }

    const request: QuoteRequest = {
      dry: config.oneClickForceDry,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: config.slippageBps,
      originAsset,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: config.usdcAssetId,
      amount: fullAmount.toString(),
      refundTo: refundAddress,
      refundType: 'ORIGIN_CHAIN',
      recipient: chain.contractId,
      recipientType: 'DESTINATION_CHAIN',
      customRecipientMsg: JSON.stringify({ deal_id: rec.deal_id }),
      confidentiality: 'basic',
      deadline: new Date(Number(depositDeadlineNs / 1_000_000n)).toISOString(),
      quoteWaitingTimeMs: 3000,
    };
    quoting.add(rec.handle); // a cancel is refused while this is in flight
    let res: QuoteResponse;
    try {
      res = await oneClick.quote(request);
    } finally {
      quoting.delete(rec.handle);
    }
    // checkQuote also verifies that 1Click signed OUR deposit deadline
    // (quoteRequest.deadline): after it 1Click refunds, so the client cannot
    // pay into the deal after the funding cutoff.
    checkQuote(res, request);
    const q = res.quote;
    if (!request.dry && !q.depositAddress) throw new HttpError(502, 'unsupported_quote', '1Click returned no deposit address');
    // The cancel block uses our deadline, not quote.deadline (+3 days).
    if (q.depositAddress) store.saveQuoteRef(rec.handle, 'pay', sha256Hex(q.depositAddress), request.deadline);
    daily.add(quotesKey);
    return {
      quote_response: quoteBody(res),
      deposit_address: q.depositAddress ?? null,
      deposit_memo: q.depositMemo ?? null,
      amount_in: q.amountIn,
      amount_in_formatted: q.amountInFormatted,
      min_amount_in: q.minAmountIn ?? null,
      amount_out: q.amountOut,
      // Pay before this; later deposits are refunded by 1Click.
      deadline: request.deadline,
      address_inactive_at: q.deadline ?? null,
      time_estimate: q.timeEstimate ?? null,
      dry: request.dry,
    };
  });

  app.get('/api/deals/:handle/pay-status', async (req) => {
    readLimit(req);
    const rec = record(req);
    if (!hasToken(req, rec)) throw notFound();
    const q = req.query as { deposit_address?: string; deposit_memo?: string };
    const depositAddress = q.deposit_address ?? '';
    if (!depositAddress || depositAddress.length > 200) throw bad('deposit_address query parameter is required');
    if (!store.hasQuoteRef(rec.handle, 'pay', sha256Hex(depositAddress))) throw notFound();
    const status = await oneClick.status(depositAddress, q.deposit_memo || null);
    return sanitizeStatus(status);
  });

  // ------------------------------------------------------------ signed actions (relayer)

  /**
   * Validates an action request and identifies the signer (no chain writes).
   * The per-IP "invalid request" bucket applies only when this fails; a
   * request with a valid deal-key signature is never blocked by it.
   */
  async function verifyAction(req: FastifyRequest) {
    try {
      return await verifyActionInner(req);
    } catch (e) {
      if (e instanceof HttpError && INVALID_STATUSES.has(e.statusCode) && limiter.exhausted(`bad:${badKey(req.ip)}`, config.rateInvalidPerMin)) {
        throw new HttpError(429, 'rate_limited', 'too many invalid requests from this address');
      }
      throw e;
    }
  }

  async function verifyActionInner(req: FastifyRequest) {
    const rec0 = record(req);
    // Over its invalid-request budget: chain reads come from a 2 s cache.
    const flooding = limiter.exhausted(`bad:${badKey(req.ip)}`, config.rateInvalidPerMin);
    const body = (req.body ?? {}) as Body;
    const action = str(body, 'action');
    if (!(ACTIONS as readonly string[]).includes(action)) throw bad(`action must be one of ${ACTIONS.join(', ')}`);
    const payload = str(body, 'payload', { max: MAX_PAYLOAD });
    // Bytes and parser rules exactly like the contract.
    if (utf8Len(payload) > MAX_PAYLOAD) throw bad(`payload is too long (max ${MAX_PAYLOAD} bytes)`);
    let parsed: unknown;
    try {
      parsed = parseJsonLikeContract(payload);
    } catch {
      throw bad('payload must be JSON the contract accepts (no lone surrogates, not nested too deeply)');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('payload must be a JSON object');
    const signature = body.signature;
    if (!isCanonicalSignature(signature)) {
      throw bad('signature must be canonical (padded) base64 of 64 bytes', 'bad_signature_encoding');
    }
    // Chain reads only after every cheap check passed.
    const rec = await recoverDealId(rec0, flooding);
    const deal = await loadDeal(rec, flooding);
    const message = signedMessage(chain.contractId, rec.deal_id!, action, payload);
    const signer = signerOf(deal, message, signature);
    // The signed message is not echoed back.
    if (!signer) throw new HttpError(401, 'invalid_signature', 'signature does not match any key of this deal');
    const allowed = ACTION_SIGNERS[action as ActionName];
    if (!allowed.includes(signer)) {
      throw new HttpError(403, 'wrong_key', `${action} must be signed by the ${allowed.join(' or ')} key`);
    }
    const call = actCall(chain.contractId, rec.deal_id!, action, payload, signature);
    return { rec, deal, fromCache: flooding, action: action as ActionName, payload, parsed: parsed as Body, signature, signer, call };
  }

  type Verified = Awaited<ReturnType<typeof verifyActionInner>>;

  /** Pre-check against the given deal state; charges the signer's own bucket on failure. */
  async function precheckOrThrow(v: Verified, deal: DealView): Promise<void> {
    let problem = precheckAction(deal, v.action, v.parsed, v.signer, nowNs(), chain.contractId, config.tokenAccountId);
    // A cancel while the client still has a live payment address would send
    // that payment back and cost the client the swap fees twice.
    if (!problem && v.action === 'cancel') {
      // A swap may still be settling after the quote deadline: wait one more hour.
      const live = store.liveQuoteDeadline(v.rec.handle, 'pay', new Date(now() - SWAP_SETTLE_MS).toISOString());
      if (live) {
        const until = new Date(Date.parse(live) + SWAP_SETTLE_MS).toISOString();
        problem = `cancel: the client may still be paying (payment address open until ${live}); try again after ${until}`;
      } else if (quoting.has(v.rec.handle)) {
        problem = 'cancel: the client is getting a payment address right now; try again in a minute';
      }
    }
    if (!problem && v.action === 'withdraw') {
      const pk = v.signer === 'creator' ? deal.creator_pk : deal.client_pk;
      if (await chain.isWithdrawUsed(v.rec.deal_id!, v.payload, pk)) {
        problem = 'withdraw: this signature was already used; get a new quote and sign a new withdraw';
      }
      // A named account that does not exist: the tokens would sit there for
      // whoever registers the name later, and a failing
      // transfer could be repeated to burn gas.
      const dest = String(v.parsed.destination);
      if (!problem && !IMPLICIT_ACCOUNT_RE.test(dest) && !(await chain.accountExists(dest))) {
        problem = 'withdraw: the destination account does not exist';
      }
    }
    if (!problem) return;
    chargeSigner(v);
    throw new HttpError(409, 'precheck_failed', problem, { act_call: v.call });
  }

  /** Only this signer's own failing requests are limited. */
  function chargeSigner(v: Verified): void {
    if (!limiter.take(`signer:${v.rec.handle}:${v.signer}`, config.rateSignerPerMin)) {
      throw new HttpError(429, 'rate_limited', 'too many rejected requests from this key; wait a minute', { act_call: v.call });
    }
  }

  /** The exact `act` call for a signed action; anyone can submit it on-chain. */
  app.post('/api/deals/:handle/act-call', async (req) => {
    const v = await verifyAction(req);
    return { act_call: v.call, signer: v.signer };
  });

  app.post('/api/deals/:handle/actions', async (req) => {
    const v = await verifyAction(req);
    const key = `${v.rec.deal_id}|${v.action}|${v.payload}|${v.signature}`;
    const seen = dedupe.get(key);
    if (seen?.state === 'pending') {
      throw new HttpError(409, 'duplicate', 'this exact action is already being submitted', { act_call: v.call });
    }
    if (seen?.state === 'done') {
      if (seen.value.kind === 'ok') return { ...seen.value.body, duplicate: true };
      throw new HttpError(422, 'contract_rejected', seen.value.message, { tx_hash: seen.value.tx_hash, cached: true, act_call: v.call });
    }
    const extra = { act_call: v.call };
    // A signer whose requests keep failing is refused BEFORE anything is sent
    // (before, the bucket was only charged afterwards).
    if (limiter.exhausted(`signer:${v.rec.handle}:${v.signer}`, config.rateSignerPerMin)) {
      throw new HttpError(429, 'rate_limited', 'too many rejected requests from this key; wait a minute', extra);
    }
    requireNoChainFailStreak(`deal:${v.rec.deal_id}`, extra);
    // Cheap early check on the state we already loaded (skipped for a cached
    // read: the fresh check under the lock decides).
    if (!v.fromCache) await precheckOrThrow(v, v.deal);
    const critical = isTimeCritical(v.action);
    const prefix = ipPrefix(req.ip);
    if (critical) {
      // One network cannot fill the time-critical lane ahead of others.
      if ((criticalQueued.get(prefix) ?? 0) >= config.maxQueuedCriticalPerPrefix) {
        throw new HttpError(429, 'rate_limited', 'too many pending deliveries/disputes from this network; retry in a moment', extra);
      }
    } else {
      // Repeatable actions have budgets and leave NEAR for time-critical ones.
      await requireRelayerReserve();
      if (v.action === 'revoke_settle' && daily.count(`revoke_settle:${v.rec.deal_id}`) >= config.dailyRevokeSettlePerDeal) {
        throw new HttpError(429, 'daily_cap', 'too many revoke_settle for this deal today', extra);
      }
    }
    // Each party gets a few relayed withdraws per deal per day (failed
    // transfers may be retried, but not looped to burn gas), and
    // one network a few per day over all its deals.
    const withdrawKey = `withdraw:${v.rec.deal_id}:${v.signer}`;
    const withdrawNetKey = `withdrawnet:${prefix}`;
    if (v.action === 'withdraw' && (daily.count(withdrawKey) >= config.dailyWithdrawsPerParty || daily.count(withdrawNetKey) >= config.dailyWithdrawsPerPrefix)) {
      throw new HttpError(429, 'daily_cap', 'too many withdraw attempts today; try again tomorrow or submit act_call yourself', extra);
    }

    // At most one relayer tx per deal queued or in flight; earliest deadline first.
    dedupe.start(key);
    if (critical) criticalQueued.set(prefix, (criticalQueued.get(prefix) ?? 0) + 1);
    if (v.action === 'cancel') cancelling.add(v.rec.handle);
    const release = await dealLock.acquire(`deal:${v.rec.deal_id}`, actionDeadline(v.deal, v.action));
    try {
      const fresh = await chain.getDeal(v.rec.deal_id!);
      if (!fresh) throw new HttpError(502, 'chain_mismatch', 'deal not found on chain');
      await precheckOrThrow(v, fresh); // re-check against fresh chain state
      if (!critical) takeDealTx(v.rec.deal_id!, extra);
      if (v.action === 'withdraw') {
        daily.add(withdrawKey);
        daily.add(withdrawNetKey);
      }
      if (v.action === 'revoke_settle') daily.add(`revoke_settle:${v.rec.deal_id}`);
      const { txHash, value } = await chain.act(
        v.rec.deal_id!,
        v.action,
        v.payload,
        v.signature,
        actionDeadline(fresh, v.action),
        actionHardDeadline(fresh, v.action, v.parsed),
      );
      const ok = value !== false;
      const body: Record<string, unknown> = {
        tx_hash: txHash,
        ok,
        result: value,
        signer: v.signer,
        act_call: v.call,
        ...(v.action === 'withdraw' && !ok
          ? { message: 'token transfer failed; the payout was restored. Get a new quote and sign a new withdraw.' }
          : {}),
      };
      dedupe.finish(key, { kind: 'ok', body });
      return body;
    } catch (e) {
      if (e instanceof ChainCallError) {
        // Only permanently-final rejections are cached; every on-chain
        // rejection is charged to the signer.
        if (isPermanentRejection(e.message)) dedupe.finish(key, { kind: 'rejected', message: e.message, tx_hash: e.txHash ?? null });
        else dedupe.forget(key);
        chainFails.take(`deal:${v.rec.deal_id}`, Number.MAX_SAFE_INTEGER);
        try {
          chargeSigner(v);
        } catch {
          /* already over the limit: still report the rejection itself */
        }
        throw new HttpError(422, 'contract_rejected', e.message, { tx_hash: e.txHash ?? null, act_call: v.call });
      }
      dedupe.forget(key); // pre-check failure, network error etc.: may be retried
      throw e;
    } finally {
      release();
      if (critical) {
        const n = (criticalQueued.get(prefix) ?? 1) - 1;
        if (n > 0) criticalQueued.set(prefix, n);
        else criticalQueued.delete(prefix);
      }
      if (v.action === 'cancel') cancelling.delete(v.rec.handle);
    }
  });

  /** Anyone with the link: auto-release after review, or default split after the dispute period. */
  app.post('/api/deals/:handle/timeout', async (req) => {
    const rec0 = record(req);
    if (!hasToken(req, rec0)) throw notFound(); // before any chain read
    const rec = await recoverDealId(rec0);
    await loadDeal(rec);
    requireNoChainFailStreak(`deal:${rec.deal_id}`);
    await requireRelayerReserve();
    // Same per-deal lock as actions: re-read state when it is our turn.
    const release = await dealLock.acquire(`deal:${rec.deal_id}`, NO_DEADLINE);
    try {
      const deal = await loadDeal(rec);
      const n = nowNs();
      // Timeouts queue behind deliver/dispute: once due, a later timeout costs
      // nobody anything (the contract refuses the competing actions), while a
      // timeout queued at its past due time outranked a dispute.
      const run = async (send: () => Promise<{ txHash: string }>, outcome: string) => {
        takeDealTx(rec.deal_id!);
        try {
          const { txHash } = await send();
          return { tx_hash: txHash, ok: true, outcome };
        } catch (e) {
          if (e instanceof ChainCallError) chainFails.take(`deal:${rec.deal_id}`, Number.MAX_SAFE_INTEGER);
          throw e;
        }
      };
      if (deal.state === 'Delivered') {
        const ends = BigInt(deal.review_ends_at_ns ?? '0');
        if (n <= ends) throw new HttpError(409, 'too_early', 'review period is not over yet', { ends_at_ns: ends.toString() });
        return await run(() => chain.releaseAfterTimeout(rec.deal_id!), 'released');
      }
      if (deal.state === 'Disputed') {
        const ends = BigInt(deal.dispute_ends_at_ns ?? '0');
        if (n <= ends) throw new HttpError(409, 'too_early', 'dispute period is not over yet', { ends_at_ns: ends.toString() });
        return await run(() => chain.resolveDisputeTimeout(rec.deal_id!), 'split_50_50');
      }
      if (deal.state === 'Created') {
        // Contract v2: never fully paid before the funding cutoff.
        const cutoff = BigInt(deal.funding_cutoff_ns);
        if (n <= cutoff) throw new HttpError(409, 'too_early', 'the funding window is not over yet', { ends_at_ns: cutoff.toString() });
        return await run(() => chain.closeUnpaid(rec.deal_id!), 'closed_unpaid');
      }
      throw new HttpError(409, 'wrong_state', `deal is ${deal.state}`);
    } finally {
      release();
    }
  });

  // ------------------------------------------------------------ settle ("Agree on a split")

  /** Parses a settle payload and returns which deal key signed it (or throws). */
  function settleSigner(deal: DealView, dealId: number, payload: unknown, signature: unknown): { signer: Party; data: Body } {
    if (typeof payload !== 'string' || utf8Len(payload) > MAX_PAYLOAD) throw bad('payload must be a JSON string (max 1024 bytes)');
    if (!isCanonicalSignature(signature)) throw bad('signature must be canonical base64 of 64 bytes', 'bad_signature_encoding');
    let data: Body;
    try {
      data = parseJsonLikeContract(payload) as Body;
    } catch {
      throw bad('payload must be JSON the contract accepts');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('payload must be a JSON object');
    const signer = signerOf(deal, signedMessage(chain.contractId, dealId, 'settle', payload), signature);
    if (!signer) throw new HttpError(401, 'invalid_signature', 'signature does not match any key of this deal');
    return { signer, data };
  }

  /** One party publishes a signed proposal; the other side reads it with the link. */
  app.post('/api/deals/:handle/settle-proposal', async (req, reply) => {
    if (!limiter.take(`write:${netKey(req.ip)}`, config.rateWritesPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
    const rec0 = record(req);
    if (!hasToken(req, rec0)) throw notFound(); // before any chain read
    const rec = await recoverDealId(rec0);
    const deal = await loadDeal(rec);
    const body = (req.body ?? {}) as Body;
    const { signer, data } = settleSigner(deal, rec.deal_id!, body.payload, body.signature);
    const problem = precheckSettle(deal, data, nowNs());
    if (problem) throw new HttpError(409, 'precheck_failed', problem);
    store.saveSettleProposal({ handle: rec.handle, signer, payload: body.payload as string, signature: body.signature as string });
    reply.status(201);
    return { signer, timer_ends_at_ns: settleTimerEnd(deal)?.toString() ?? null };
  });

  app.get('/api/deals/:handle/settle-proposals', async (req) => {
    readLimit(req);
    const rec0 = record(req);
    if (!hasToken(req, rec0)) throw notFound();
    const rec = await recoverDealId(rec0);
    return { proposals: store.getSettleProposals(rec.handle).map(({ handle: _h, ...p }) => p) };
  });

  /** Both signatures over the same payload: the relayer submits `settle`. */
  app.post('/api/deals/:handle/settle', async (req) => {
    if (!limiter.take(`write:${netKey(req.ip)}`, config.rateWritesPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
    const rec0 = record(req);
    if (!hasToken(req, rec0)) throw notFound(); // before any chain read
    const rec = await recoverDealId(rec0);
    const body = (req.body ?? {}) as Body;
    const deal0 = await loadDeal(rec);
    const a = settleSigner(deal0, rec.deal_id!, body.payload, body.creator_signature);
    const b = settleSigner(deal0, rec.deal_id!, body.payload, body.client_signature);
    if (a.signer !== 'creator' || b.signer !== 'client') {
      throw new HttpError(403, 'wrong_key', 'creator_signature must be the creator key and client_signature the client key');
    }
    requireNoChainFailStreak(`deal:${rec.deal_id}`);
    const release = await dealLock.acquire(`deal:${rec.deal_id}`, settleTimerEnd(deal0) ?? NO_DEADLINE);
    try {
      const deal = await loadDeal(rec);
      const problem = precheckSettle(deal, a.data, nowNs());
      if (problem) throw new HttpError(409, 'precheck_failed', problem);
      const end = settleTimerEnd(deal);
      // Never sent after the signed expiry or the timer.
      const expires = BigInt(a.data.expires_at_ns as string);
      const hard = end === null || expires < end ? expires : end;
      takeDealTx(rec.deal_id!);
      try {
        const { txHash } = await chain.settle(
          rec.deal_id!,
          body.payload as string,
          body.creator_signature as string,
          body.client_signature as string,
          end ?? NO_DEADLINE,
          hard,
        );
        return { tx_hash: txHash, ok: true };
      } catch (e) {
        if (e instanceof ChainCallError) chainFails.take(`deal:${rec.deal_id}`, Number.MAX_SAFE_INTEGER);
        throw e;
      }
    } finally {
      release();
    }
  });

  // ------------------------------------------------------------ encrypted notes

  /**
   * A party stores a small encrypted note: the files link, the dispute
   * point and text, the copies for the arbiter. The server sees
   * ciphertext only. Signed by the party's deal key (single-use request), so
   * the reader checks who wrote it against the keys on-chain.
   */
  app.post('/api/deals/:handle/notes', async (req, reply) => {
    if (!limiter.take(`write:${netKey(req.ip)}`, config.rateWritesPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
    const rec0 = record(req);
    if (!hasToken(req, rec0)) throw notFound(); // before any chain read
    const rec = await recoverDealId(rec0);
    const deal = await loadDeal(rec);
    const body = (req.body ?? {}) as Body;
    const { signer, data } = signedRequest(rec, deal, 'note', body.payload, body.signature, MAX_NOTE_PAYLOAD);
    const kind = str(data, 'kind', { max: 32 });
    const rule = NOTE_RULES[kind];
    if (!rule) throw bad(`kind must be one of ${Object.keys(NOTE_RULES).join(', ')}`);
    if (signer !== rule.signer) throw new HttpError(403, 'wrong_key', `a ${kind} note must be signed by the ${rule.signer} key`);
    const text = str(data, 'data', { max: MAX_NOTE_DATA });
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw bad('data must be base64');
    if (deal.purged || !rule.states.includes(deal.state)) {
      throw new HttpError(409, 'wrong_state', `a ${kind} note cannot be stored while the deal is ${deal.state}`);
    }
    const exists = store.getNotes(rec.handle).some((n) => n.kind === kind);
    if (exists && deal.state !== rule.replaceIn) {
      throw new HttpError(409, 'note_locked', `the ${kind} note can no longer be changed`);
    }
    const dayKey = `note:${rec.handle}`;
    if (daily.count(dayKey) >= 30) throw new HttpError(429, 'daily_cap', 'too many notes for this deal today');
    daily.add(dayKey);
    store.saveNote({ handle: rec.handle, kind, signer, payload: body.payload as string, signature: body.signature as string });
    reply.status(201);
    return { kind, signer };
  });

  app.get('/api/deals/:handle/notes', async (req) => {
    readLimit(req);
    const rec = record(req);
    if (!hasToken(req, rec)) throw notFound();
    const all = store.getNotes(rec.handle);
    // The arbiter copies are for the arbiter tool only.
    return {
      notes: all.filter((n) => !n.kind.endsWith('_arbiter')).map(({ handle: _h, ...n }) => n),
      has_arbiter_copy: {
        creator: all.some((n) => n.kind === 'delivery_arbiter'),
        client: all.some((n) => n.kind === 'dispute_arbiter'),
      },
    };
  });

  // ------------------------------------------------------------ arbiter tool + public dispute log

  /**
   * Requests of the arbiter tool: `{ payload, signature }`, signed with the
   * arbiter API key over `escrow-v1|{contract}|arbiter|{op}|{payload}`
   * (fresh, single use). The key is separate from every server secret; with
   * no `ARBITER_API_PUBLIC_KEY` these routes do not exist.
   */
  function arbiterRequest(req: FastifyRequest, op: string): Body {
    if (!config.arbiterApiPublicKey) throw notFound();
    if (!limiter.take(`arbiter:${netKey(req.ip)}`, config.rateInvalidPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
    const body = (req.body ?? {}) as Body;
    const { payload, signature } = body;
    if (typeof payload !== 'string' || utf8Len(payload) > MAX_PAYLOAD) throw bad('payload must be a JSON string');
    if (!isCanonicalSignature(signature)) throw bad('signature must be canonical base64 of 64 bytes', 'bad_signature_encoding');
    let data: Body;
    try {
      data = JSON.parse(payload);
    } catch {
      throw bad('payload must be a JSON string');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('payload must be a JSON object');
    const issued = data.issued_at_ns;
    if (typeof issued !== 'string' || !/^[0-9]{1,20}$/.test(issued)) throw bad('payload.issued_at_ns is required');
    const age = nowNs() - BigInt(issued);
    if (age > SIGNED_MAX_AGE_NS || age < -SIGNED_MAX_FUTURE_NS) {
      throw new HttpError(401, 'stale_request', 'payload.issued_at_ns must be within the last 2 minutes');
    }
    if (!verifySignature(config.arbiterApiPublicKey, `escrow-v1|${chain.contractId}|arbiter|${op}|${payload}`, signature)) throw notFound();
    const t = now();
    if ((usedSignedRequests.get(signature) ?? 0) > t) throw new HttpError(401, 'replayed_request', 'this signed request was already used');
    usedSignedRequests.set(signature, t + Number((SIGNED_MAX_AGE_NS + SIGNED_MAX_FUTURE_NS) / 1_000_000n));
    return data;
  }

  function arbiterDealId(data: Body): number {
    const id = data.deal_id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) throw bad('payload.deal_id must be a number');
    return id;
  }

  /** Everything the arbiter needs for one dispute: the terms and both parties' notes. */
  app.post('/api/arbiter/case', async (req) => {
    const data = arbiterRequest(req, 'case');
    const dealId = arbiterDealId(data);
    const rec = store.getDealById(dealId);
    if (!rec) throw new HttpError(404, 'unknown_deal', 'this deal was not made through this server');
    const deal = await chain.getDeal(dealId);
    return {
      deal_id: dealId,
      deal,
      terms: termsView(rec, deal),
      terms_verified: deal && !deal.purged ? deal.terms_hash === rec.terms_hash && deal.creator_pk === rec.creator_pk : null,
      notes: store.getNotes(rec.handle).map(({ handle: _h, ...n }) => n),
    };
  });

  /** The arbiter records one public log line for a decided dispute. */
  app.post('/api/arbiter/decision', async (req, reply) => {
    const data = arbiterRequest(req, 'decision');
    const dealId = arbiterDealId(data);
    const outcome = str(data, 'outcome', { max: 16 });
    if (!(ARBITER_OUTCOMES as readonly string[]).includes(outcome)) throw bad(`outcome must be one of ${ARBITER_OUTCOMES.join(', ')}`);
    const reason = str(data, 'reason', { max: 200 }).replace(/[ \t\r\n]+/g, ' ').trim();
    if (!reason) throw bad('reason is required');
    if (!store.getDealById(dealId)) throw new HttpError(404, 'unknown_deal', 'this deal was not made through this server');
    const month = new Date(now()).toISOString().slice(0, 7);
    store.saveDisputeDecision(dealId, month, outcome, reason);
    reply.status(201);
    return { month, outcome, reason };
  });

  /**
   * Public: month, outcome and a one-line reason per decided dispute, no
   * names, amounts, deal ids or days. A line shows up the day AFTER it was
   * written, so it cannot be matched to an on-chain decision by its time.
   */
  app.get('/api/dispute-log', async (req) => {
    readLimit(req);
    const todayUtc = `${new Date(now()).toISOString().slice(0, 10)}T00:00:00.000Z`;
    return { entries: store.getDisputeLog(todayUtc, 500) };
  });

  // ------------------------------------------------------------ creator: revoke an unjoined link

  /**
   * The creator revokes a link nobody joined
   * yet. The relayer submits the creator-signed `revoke_offer`, so the offer
   * can never start a deal (also if our DB is restored later).
   */
  app.post('/api/deals/:handle/revoke', async (req) => {
    if (!limiter.take(`write:${netKey(req.ip)}`, config.rateWritesPerMin)) throw new HttpError(429, 'rate_limited', 'too many requests');
    let rec = record(req);
    const body = (req.body ?? {}) as Body;
    const signature = body.signature;
    if (!isCanonicalSignature(signature)) throw bad('signature must be canonical base64 of 64 bytes', 'bad_signature_encoding');
    if (!verifySignature(rec.creator_pk, revokeOfferMessage(chain.contractId, rec.offer), signature)) {
      throw new HttpError(401, 'invalid_signature', 'signature does not match the creator key of this offer');
    }
    if (rec.revoked_at) throw new HttpError(409, 'revoked', 'this link is already revoked');
    rec = await recoverDealId(rec);
    if (rec.deal_id !== null) throw new HttpError(409, 'already_joined', 'the client already joined; cancel the deal instead');
    if (joining.has(rec.handle)) throw new HttpError(409, 'join_in_progress', 'a join for this link is in progress');
    // Our DB already refuses the join (create_deal is relayer-only). The
    // on-chain revoke (0.001 NEAR + gas, paid by the relayer) only guards
    // against a restored old DB, so it has a daily budget.
    let onchain = daily.count('revoke:onchain') < config.dailyOnchainRevokes;
    if (onchain) {
      try {
        await requireRelayerReserve();
      } catch {
        onchain = false;
      }
    }
    if (!onchain) {
      store.markRevoked(rec.handle);
      return { tx_hash: null, ok: true, onchain: false };
    }
    joining.add(rec.handle); // blocks a join racing the revocation
    try {
      daily.add('revoke:onchain');
      const { txHash } = await chain.revokeOffer(rec.offer, signature);
      store.markRevoked(rec.handle);
      return { tx_hash: txHash, ok: true, onchain: true };
    } catch (e) {
      // "already used or revoked": joined meanwhile, or revoked earlier (DB restored).
      if (e instanceof ChainCallError && /already used or revoked/.test(e.message)) {
        const r = await recoverDealId(rec);
        if (r.deal_id !== null) throw new HttpError(409, 'already_joined', 'the client already joined; cancel the deal instead');
        store.markRevoked(rec.handle);
        throw new HttpError(409, 'revoked', 'this link is already revoked');
      }
      throw e;
    } finally {
      joining.delete(rec.handle);
    }
  });

  // ------------------------------------------------------------ payout (signed)

  app.post('/api/deals/:handle/payout-quote', async (req) => {
    quoteIpLimit(req);
    const rec = await recoverDealId(record(req));
    if (rec.deal_id === null) chargeBad(req);
    const body = (req.body ?? {}) as Body;
    const deal = await loadDeal(rec);
    const { signer: party, data } = signedRequest(rec, deal, 'payout-quote', body.payload, body.signature);
    quoteLimit(rec, party);
    const destinationAsset = str(data, 'destination_asset', { max: 200 });
    const recipient = str(data, 'recipient', { max: 200 });
    const recipientType = str(data, 'recipient_type');
    if (!(RECIPIENT_TYPES as readonly string[]).includes(recipientType)) {
      throw bad(`recipient_type must be one of ${RECIPIENT_TYPES.join(', ')}`);
    }
    const amount = BigInt(party === 'creator' ? deal.creator_payout : deal.client_payout);
    const pending = BigInt(party === 'creator' ? deal.creator_pending : deal.client_pending);
    if (amount <= 0n) throw new HttpError(409, 'nothing_to_withdraw', `no withdrawable ${party} payout on this deal`);
    if (pending > 0n) throw new HttpError(409, 'withdraw_in_progress', 'another withdrawal is in progress');
    const partyPk = party === 'creator' ? deal.creator_pk : deal.client_pk;
    const refundTo = implicitAccountId(partyPk);

    const request: QuoteRequest = {
      dry: config.oneClickForceDry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: config.slippageBps,
      originAsset: config.usdcAssetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset,
      amount: amount.toString(),
      refundTo,
      refundType: config.payoutRefundType,
      recipient,
      recipientType: recipientType as QuoteRequest['recipientType'],
      confidentiality: 'basic',
      deadline: new Date(now() + config.quoteDeadlineSeconds * 1000).toISOString(),
      quoteWaitingTimeMs: 3000,
    };
    const res = await oneClick.quote(request);
    checkQuote(res, request);
    const q = res.quote;
    if (q.depositMemo) throw new HttpError(502, 'unsupported_quote', 'payout quotes with a deposit memo are not supported');
    let expiresAtNs: string | null = null;
    let withdrawPayload: string | null = null;
    if (!request.dry) {
      if (!q.depositAddress || !isAccountId(q.depositAddress)) {
        throw new HttpError(502, 'unsupported_quote', '1Click did not return a NEAR deposit account');
      }
      // Our requested deadline binds (1Click refunds a deposit after it);
      // quote.deadline / timeWhenInactive are later on real 1Click (+3 days).
      const limits = [request.deadline, q.deadline, q.timeWhenInactive].filter(Boolean).map((d) => Date.parse(d as string));
      if (!limits.length || limits.some(Number.isNaN)) throw new HttpError(502, 'unsupported_quote', 'quote has no deadline');
      const expiresMs = Math.min(...limits) - config.withdrawExpiryMarginSeconds * 1000;
      if (expiresMs <= now()) throw new HttpError(502, 'unsupported_quote', 'quote deadline is too short');
      expiresAtNs = (BigInt(expiresMs) * 1_000_000n).toString();
      withdrawPayload = JSON.stringify({ destination: q.depositAddress, amount: amount.toString(), expires_at_ns: expiresAtNs });
      store.saveQuoteRef(rec.handle, 'payout', sha256Hex(q.depositAddress), request.deadline);
    }
    return {
      quote_response: quoteBody(res),
      party,
      deposit_address: q.depositAddress ?? null,
      amount: amount.toString(),
      refund_to: refundTo,
      refund_type: request.refundType,
      expires_at_ns: expiresAtNs,
      withdraw_payload: withdrawPayload,
      dry: request.dry,
    };
  });

  // ------------------------------------------------------------ tokens

  let tokenCache: { at: number; tokens: OneClickToken[] } | null = null;
  app.get('/api/tokens', async (req) => {
    readLimit(req);
    if (!tokenCache || now() - tokenCache.at > TOKENS_TTL_MS) {
      tokenCache = { at: now(), tokens: await oneClick.getTokens() };
    }
    const symbols = new Set(config.tokenSymbols.map((s) => s.toUpperCase()));
    const chains = new Set(config.tokenChains.map((s) => s.toLowerCase()));
    return tokenCache.tokens
      .filter((t) => symbols.size === 0 || symbols.has(String(t.symbol).toUpperCase()))
      .filter((t) => chains.size === 0 || chains.has(String(t.blockchain).toLowerCase()))
      .map((t) => ({
        assetId: t.assetId,
        symbol: t.symbol,
        blockchain: t.blockchain,
        decimals: t.decimals,
        price: t.price ?? null,
        priceUpdatedAt: t.priceUpdatedAt ?? null,
        contractAddress: t.contractAddress ?? null,
      }));
  });

  return app;
}
