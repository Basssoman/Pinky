// Test doubles: in-memory chain (mirrors the contract's state machine closely
// enough for API tests), a scripted 1Click client, and browser-side helpers
// (deal keys, offers, signed requests) as the web app would do them.

import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, type KeyObject } from 'node:crypto';

import type { Chain, DealView, TombstoneView, TxResult } from '../src/chain.ts';
import { ChainCallError, tombstoneAsDeal } from '../src/chain.ts';
import { readConfig, type Config } from '../src/config.ts';
import { base58Encode, keyFingerprint, offerMessage, parseOffer, sha256Hex, signedMessage, termsHash, verifySignature } from '../src/encoding.ts';
import { quoteSigningMessage } from '../src/quoteSignature.ts';
import type { OneClick, OneClickToken, QuoteRequest, QuoteResponse, StatusResponse } from '../src/oneclick.ts';

export const CONTRACT_ID = 'escrow.test.near';
/** Stand-in for the 1Click quote-signing key (FakeOneClick signs with it). */
const QUOTE_SIGNER_SEED = 0x51;
let quoteSignerCache: DealKey | null = null;
export function quoteSigner(): DealKey {
  quoteSignerCache ??= keyFromSeed(QUOTE_SIGNER_SEED);
  return quoteSignerCache;
}

const SEC = 1_000_000_000n;

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...readConfig({
      NEAR_NETWORK: 'sandbox',
      ESCROW_CONTRACT_ID: CONTRACT_ID,
      RELAYER_ACCOUNT_ID: 'relayer.test.near',
      RELAYER_PRIVATE_KEY: 'ed25519:unused',
      ONECLICK_API_KEY: 'test-key',
      ONECLICK_FORCE_DRY: 'false',
      DB_PATH: ':memory:',
      MIN_REVIEW_PERIOD_SECONDS: '60',
      MIN_DELIVERY_SECONDS: '60',
      MARKET_REFRESH_SECONDS: '0',
    }),
    oneClickQuotePublicKey: quoteSigner().pk,
    ...overrides,
  };
}

export interface DealKey {
  pk: string;
  priv: KeyObject;
  signRaw(message: string): string;
  sign(dealId: number, action: string, payload: string, contractId?: string): string;
}

function makeKey(priv: KeyObject): DealKey {
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x: string };
  const pk = `ed25519:${base58Encode(Buffer.from(jwk.x, 'base64url'))}`;
  const signRaw = (m: string) => edSign(null, Buffer.from(m, 'utf8'), priv).toString('base64');
  return {
    pk,
    priv,
    signRaw,
    sign: (dealId, action, payload, contractId = CONTRACT_ID) => signRaw(signedMessage(contractId, dealId, action, payload)),
  };
}

/** Fresh random ed25519 deal key (what the browser generates). */
export function randomKey(): DealKey {
  return makeKey(generateKeyPairSync('ed25519').privateKey);
}

/** Deterministic ed25519 key from a 32-byte seed (same as ed25519-dalek from_bytes). */
export function keyFromSeed(seedByte: number): DealKey {
  const seed = Buffer.alloc(32, seedByte);
  return makeKey(
    createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
      format: 'der',
      type: 'pkcs8',
    }),
  );
}

export interface OfferBundle {
  token: string;
  handle: string;
  offer: string;
  offer_signature: string;
  terms: { title: string; description: string; revisions: string; salt: string };
}

/** What the creator's browser does: terms hash with salt, offer, signature, link token. */
export function makeOffer(
  creator: DealKey,
  opts: {
    amount?: string;
    /** Work time counted from funding (contract v2). */
    durationNs?: bigint;
    reviewNs?: bigint;
    expiresNs?: bigint;
    feeBps?: string;
    revisions?: string;
    title?: string;
    description?: string;
    nowMs?: number;
    contractId?: string;
  } = {},
): OfferBundle {
  const nowNs = BigInt(opts.nowMs ?? Date.now()) * 1_000_000n;
  const amount = opts.amount ?? '5000000';
  const duration = (opts.durationNs ?? 7n * 86400n * SEC).toString();
  const review = (opts.reviewNs ?? 3600n * SEC).toString();
  const terms = {
    title: opts.title ?? 'Logo animation',
    description: opts.description ?? '10 seconds, 4k',
    revisions: opts.revisions ?? '2',
    salt: randomBytes(16).toString('hex'),
  };
  const terms_hash = termsHash({ ...terms, amount, delivery_duration_ns: duration, review_period_ns: review });
  const offer = JSON.stringify({
    creator_pk: creator.pk,
    amount,
    fee_bps: opts.feeBps ?? '300',
    delivery_duration_ns: duration,
    review_period_ns: review,
    terms_hash,
    offer_nonce: randomBytes(16).toString('hex'),
    offer_expires_at_ns: (opts.expiresNs ?? nowNs + 86400n * SEC).toString(),
  });
  const token = randomBytes(16).toString('hex');
  return {
    token,
    handle: sha256Hex(token),
    offer,
    offer_signature: creator.signRaw(offerMessage(opts.contractId ?? CONTRACT_ID, offer)),
    terms,
  };
}

/** A server-only signed request (pay-quote, payout-quote, read). */
export function signedRequest(
  key: DealKey,
  dealId: number,
  kind: string,
  fields: Record<string, string>,
  nowMs = Date.now(),
  contractId = CONTRACT_ID,
) {
  // a random nonce makes every signed request unique (they are single use)
  const payload = JSON.stringify({
    ...fields,
    issued_at_ns: (BigInt(nowMs) * 1_000_000n).toString(),
    nonce: randomBytes(8).toString('hex'),
  });
  return { payload, signature: key.sign(dealId, kind, payload, contractId) };
}

let txCounter = 0;
const tx = () => `tx${++txCounter}`;

/** Pay window and grace of the fake contract (same defaults as contract v2). */
export const FAKE_PAY_BY_NS = 7n * 86400n * SEC;
export const FAKE_GRACE_NS = 6n * 3600n * SEC;
export const FAKE_DISPUTE_NS = 7n * 86400n * SEC;

const nowNsReal = () => BigInt(Date.now()) * 1_000_000n;
const RESOLVED_STATES = ['Released', 'Refunded', 'Cancelled', 'Expired', 'PaidOut'];

export class FakeChain implements Chain {
  readonly contractId: string;
  deals: DealView[] = [];
  calls: { method: string; args: unknown[] }[] = [];
  usedOffers = new Map<string, number>();
  revokedOffers = new Set<string>();
  usedWithdraws = new Set<string>();
  /** When set, createDeal lands on-chain but then throws (simulated timeout). */
  failAfterCreate = false;
  /** Next act() result value override (e.g. false for a failed withdraw). */
  nextActValue: unknown = undefined;
  balances = { escrow: 10n ** 24n * 5n, relayer: 10n ** 24n * 5n };
  /** Clock of the fake chain (tests can move it). */
  nowNs: () => bigint = nowNsReal;

  constructor(contractId: string = CONTRACT_ID) {
    this.contractId = contractId;
  }

  /** Purged deals: only the tombstone is left (contract `purge`). */
  tombstones = new Map<number, TombstoneView>();

  async getDeal(id: number): Promise<DealView | null> {
    const tomb = this.tombstones.get(id);
    if (tomb) return tombstoneAsDeal(tomb);
    return this.deals[id] ? { ...this.deals[id] } : null;
  }

  /** Contract `purge`: the deal is removed, a tombstone keeps the keys and the client's leftover money. */
  purge(id: number): void {
    const d = this.deals[id];
    this.tombstones.set(id, {
      id,
      state: d.state,
      outcome: d.outcome,
      ended_at_ns: d.ended_at_ns ?? '0',
      creator_pk: d.creator_pk,
      client_pk: d.client_pk,
      client_payout: d.client_payout,
      client_pending: d.client_pending,
      client_withdrawn: d.client_withdrawn,
      creator_fingerprint: d.creator_fingerprint,
      client_fingerprint: d.client_fingerprint,
    });
  }

  async getNearBalances() {
    return this.balances;
  }

  async getDealIdByOffer(offer: string): Promise<number | null> {
    return this.usedOffers.get(offer) ?? null;
  }

  async isWithdrawUsed(dealId: number, payload: string, signerPk: string): Promise<boolean> {
    return this.usedWithdraws.has(`${dealId}|${payload}|${signerPk}`);
  }

  /** Named accounts listed here "do not exist". */
  missingAccounts = new Set<string>();
  async accountExists(accountId: string): Promise<boolean> {
    return !this.missingAccounts.has(accountId);
  }

  async createDeal(offer: string, offerSignature: string, clientPk: string): Promise<TxResult<number>> {
    this.calls.push({ method: 'create_deal', args: [offer, offerSignature, clientPk] });
    const o = parseOffer(offer);
    if (!verifySignature(o.creator_pk, offerMessage(this.contractId, offer), offerSignature)) {
      throw new ChainCallError('offer: invalid creator signature', tx());
    }
    if (this.usedOffers.has(offer) || this.revokedOffers.has(offer)) throw new ChainCallError('offer already used or revoked', tx());
    const now = this.nowNs();
    if (now > BigInt(o.offer_expires_at_ns)) throw new ChainCallError('offer expired', tx());
    if (BigInt(o.amount) < 1_000_000n) throw new ChainCallError('amount below the minimum (1 USDC)', tx());
    const id = this.deals.length;
    this.usedOffers.set(offer, id);
    this.deals.push({
      id,
      amount: o.amount,
      funded_amount: '0',
      state: 'Created',
      creator_pk: o.creator_pk,
      client_pk: clientPk,
      fee_bps: Number(o.fee_bps),
      fee_amount: '0',
      delivery_duration_ns: o.delivery_duration_ns,
      delivery_deadline_ns: null,
      review_period_ns: o.review_period_ns,
      pay_by_ns: (now + FAKE_PAY_BY_NS).toString(),
      funding_cutoff_ns: (now + FAKE_PAY_BY_NS + FAKE_GRACE_NS).toString(),
      funded_at_ns: null,
      delivered_at_ns: null,
      deliverable_hash: null,
      terms_hash: o.terms_hash,
      creator_payout: '0',
      client_payout: '0',
      created_at_ns: now.toString(),
      review_ends_at_ns: null,
      disputed_at_ns: null,
      dispute_ends_at_ns: null,
      ended_at_ns: null,
      outcome: null,
      settle_seq: 0,
      creator_pending: '0',
      client_pending: '0',
      creator_withdrawn: '0',
      client_withdrawn: '0',
      settled: true,
      creator_fingerprint: keyFingerprint(o.creator_pk),
      client_fingerprint: keyFingerprint(clientPk),
    });
    if (this.failAfterCreate) {
      this.failAfterCreate = false;
      throw new Error('timeout waiting for the transaction');
    }
    return { txHash: tx(), value: id };
  }

  /** Contract v2 funding: one payment >= amount before the cutoff funds; anything else goes to the client. */
  fund(id: number, amount: string): void {
    const d = this.deals[id];
    const now = this.nowNs();
    const a = BigInt(amount);
    if (d.state === 'Created' && now <= BigInt(d.funding_cutoff_ns) && a >= BigInt(d.amount)) {
      d.funded_amount = d.amount;
      d.client_payout = (BigInt(d.client_payout) + a - BigInt(d.amount)).toString();
      d.state = 'Funded';
      d.funded_at_ns = now.toString();
      d.delivery_deadline_ns = (now + BigInt(d.delivery_duration_ns)).toString();
    } else {
      d.client_payout = (BigInt(d.client_payout) + a).toString();
    }
    this.updateSettled(d);
  }

  private updateSettled(d: DealView): void {
    d.settled = d.creator_payout === '0' && d.client_payout === '0' && d.creator_pending === '0' && d.client_pending === '0';
    if (d.settled && RESOLVED_STATES.includes(d.state)) d.state = 'PaidOut';
  }

  private split(d: DealView, bps: number): void {
    const funded = BigInt(d.funded_amount);
    const creatorShare = (funded * BigInt(bps)) / 10_000n;
    const fee = (creatorShare * BigInt(d.fee_bps)) / 10_000n;
    d.creator_payout = (BigInt(d.creator_payout) + creatorShare - fee).toString();
    d.client_payout = (BigInt(d.client_payout) + funded - creatorShare).toString();
    d.fee_amount = fee.toString();
    d.state = bps === 0 ? 'Refunded' : 'Released';
    d.ended_at_ns = this.nowNs().toString();
    d.settled = false;
  }

  async act(dealId: number, action: string, payload: string, signature: string): Promise<TxResult<unknown>> {
    this.calls.push({ method: 'act', args: [dealId, action, payload, signature] });
    const d = this.deals[dealId];
    const fail = (m: string): never => {
      throw new ChainCallError(m, tx());
    };
    const tomb = this.tombstones.get(dealId);
    if (tomb) {
      // A purged deal: only the client key can withdraw what is left.
      if (action !== 'withdraw') fail('deal not found');
      if (!verifySignature(tomb.client_pk, signedMessage(this.contractId, dealId, action, payload), signature)) fail('invalid signature');
      const amount = BigInt(JSON.parse(payload).amount);
      this.usedWithdraws.add(`${dealId}|${payload}|${tomb.client_pk}`);
      tomb.client_payout = (BigInt(tomb.client_payout) - amount).toString();
      tomb.client_withdrawn = (BigInt(tomb.client_withdrawn) + amount).toString();
      return { txHash: tx(), value: true };
    }
    switch (action) {
      case 'cancel':
        if (d.state !== 'Created') fail('cancel: deal must be Created');
        d.state = 'Cancelled';
        d.outcome = 'Cancelled';
        d.ended_at_ns = this.nowNs().toString();
        break;
      case 'deliver':
        if (d.state !== 'Funded') fail('deliver: deal must be Funded');
        d.state = 'Delivered';
        d.delivered_at_ns = this.nowNs().toString();
        d.review_ends_at_ns = String(BigInt(d.delivered_at_ns) + BigInt(d.review_period_ns));
        d.deliverable_hash = JSON.parse(payload).deliverable_hash;
        break;
      case 'accept':
        if (d.state !== 'Delivered') fail('accept: deal must be Delivered');
        this.split(d, 10_000);
        d.outcome = 'Accepted';
        break;
      case 'dispute':
        if (d.state !== 'Delivered') fail('dispute: deal must be Delivered');
        d.state = 'Disputed';
        d.disputed_at_ns = this.nowNs().toString();
        d.dispute_ends_at_ns = (this.nowNs() + FAKE_DISPUTE_NS).toString();
        break;
      case 'refund': {
        if (d.state !== 'Funded') fail('refund: deal must be Funded');
        const byCreator = verifySignature(d.creator_pk, signedMessage(this.contractId, dealId, action, payload), signature);
        this.split(d, 0);
        d.outcome = byCreator ? 'RefundedByCreator' : 'RefundedAfterDeadline';
        break;
      }
      case 'revoke_settle': {
        // Contract v2: the payload names the current seq.
        const seq = JSON.parse(payload).seq;
        if (typeof seq !== 'string') fail('revoke_settle: payload.seq (string) required');
        if (BigInt(seq) !== BigInt(d.settle_seq)) fail('revoke_settle: seq is not the current settle_seq');
        d.settle_seq += 1;
        break;
      }
      case 'withdraw': {
        const isCreator = verifySignature(d.creator_pk, signedMessage(this.contractId, dealId, action, payload), signature);
        const signer = isCreator ? d.creator_pk : d.client_pk;
        this.usedWithdraws.add(`${dealId}|${payload}|${signer}`);
        if (this.nextActValue === false) {
          this.nextActValue = undefined;
          return { txHash: tx(), value: false };
        }
        const amount = BigInt(JSON.parse(payload).amount);
        if (isCreator) {
          d.creator_payout = (BigInt(d.creator_payout) - amount).toString();
          d.creator_withdrawn = (BigInt(d.creator_withdrawn) + amount).toString();
        } else {
          d.client_payout = (BigInt(d.client_payout) - amount).toString();
          d.client_withdrawn = (BigInt(d.client_withdrawn) + amount).toString();
        }
        this.updateSettled(d);
        break;
      }
      default:
        break;
    }
    return { txHash: tx(), value: true };
  }

  async settle(dealId: number, payload: string, creatorSignature: string, clientSignature: string): Promise<TxResult<unknown>> {
    this.calls.push({ method: 'settle', args: [dealId, payload, creatorSignature, clientSignature] });
    const d = this.deals[dealId];
    const bps = Number(JSON.parse(payload).split_bps);
    this.split(d, bps);
    d.outcome = { Settled: { creator_share_bps: bps } };
    return { txHash: tx(), value: null };
  }

  async revokeOffer(offer: string, signature: string): Promise<TxResult<unknown>> {
    this.calls.push({ method: 'revoke_offer', args: [offer, signature] });
    if (this.usedOffers.has(offer) || this.revokedOffers.has(offer)) throw new ChainCallError('offer already used or revoked', tx());
    this.revokedOffers.add(offer);
    return { txHash: tx(), value: null };
  }

  async releaseAfterTimeout(dealId: number, priorityNs?: bigint): Promise<TxResult<unknown>> {
    this.calls.push({ method: 'release_after_timeout', args: [dealId, priorityNs] });
    this.split(this.deals[dealId], 10_000);
    this.deals[dealId].outcome = 'AutoReleased';
    return { txHash: tx(), value: null };
  }

  async resolveDisputeTimeout(dealId: number, priorityNs?: bigint): Promise<TxResult<unknown>> {
    this.calls.push({ method: 'resolve_dispute_timeout', args: [dealId, priorityNs] });
    this.split(this.deals[dealId], 5_000);
    this.deals[dealId].outcome = { TimeoutSplit: { creator_share_bps: 5000 } };
    return { txHash: tx(), value: null };
  }

  async closeUnpaid(dealId: number, priorityNs?: bigint): Promise<TxResult<unknown>> {
    this.calls.push({ method: 'close_unpaid', args: [dealId, priorityNs] });
    const d = this.deals[dealId];
    d.state = 'Expired';
    d.outcome = 'ClosedUnpaid';
    d.ended_at_ns = this.nowNs().toString();
    return { txHash: tx(), value: null };
  }
}

export class FakeOneClick implements OneClick {
  quotes: QuoteRequest[] = [];
  statusCalls: { depositAddress: string; depositMemo?: string | null }[] = [];
  tokenCalls = 0;
  /** Override fields of the next quote's `quote` object. */
  nextQuoteOverride: Record<string, unknown> | null = null;
  /** Change the echoed (and signed) quoteRequest of the next quote. */
  nextEchoOverride: Record<string, unknown> | null = null;
  /** Return quotes with an invalid signature. */
  badSignature = false;
  tokens: OneClickToken[] = [
    { assetId: 'nep141:eth-0xa0b8.omft.near', symbol: 'USDC', blockchain: 'eth', decimals: 6, price: 1 },
    { assetId: 'nep141:sol-5ce3.omft.near', symbol: 'USDC', blockchain: 'sol', decimals: 6, price: 1 },
    { assetId: 'nep141:eth.omft.near', symbol: 'ETH', blockchain: 'eth', decimals: 18, price: 3000 },
    { assetId: 'nep141:pepe.omft.near', symbol: 'PEPE', blockchain: 'eth', decimals: 18, price: 0.00001 },
  ];
  statusResponse: StatusResponse = {
    status: 'PROCESSING',
    updatedAt: '2026-11-01T00:00:00Z',
    quoteResponse: { quoteRequest: { refundTo: '0xSECRETPAYER' } },
    swapDetails: {
      amountIn: '5010000',
      amountInFormatted: '5.01',
      amountOut: '5000000',
      amountOutFormatted: '5',
      originChainTxHashes: [{ hash: '0xpayer', explorerUrl: 'x' }],
    },
  };

  async getTokens(): Promise<OneClickToken[]> {
    this.tokenCalls++;
    return this.tokens;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    this.quotes.push(req);
    const n = this.quotes.length;
    const quote = {
      depositAddress: req.dry ? undefined : `${'d'.repeat(63)}${n % 10}`,
      depositMemo: null,
      amountIn: req.swapType === 'EXACT_OUTPUT' ? '5010000' : req.amount,
      amountInFormatted: '5.01',
      minAmountIn: '5000000',
      amountOut: req.swapType === 'EXACT_OUTPUT' ? req.amount : '4990000',
      amountOutFormatted: '4.99',
      minAmountOut: '4980000',
      // Like real 1Click (seen 2026-11-06): the deposit address stays active
      // 3 days after the requested deadline; dry quotes carry no deadline.
      deadline: req.dry || !req.deadline ? undefined : new Date(Date.parse(req.deadline) + 3 * 86400_000).toISOString(),
      timeEstimate: 30,
      ...(this.nextQuoteOverride ?? {}),
    };
    this.nextQuoteOverride = null;
    const res = {
      correlationId: `corr-${n}`,
      timestamp: '2026-11-02T00:00:00.000Z',
      quoteRequest: { ...req, ...(this.nextEchoOverride ?? {}) },
      quote,
    } as QuoteResponse;
    this.nextEchoOverride = null;
    const sig = edSign(null, Buffer.from(quoteSigningMessage(res as never), 'utf8'), quoteSigner().priv);
    res.signature = this.badSignature ? 'ed25519:1111' : `ed25519:${base58Encode(sig)}`;
    return res;
  }

  async status(depositAddress: string, depositMemo?: string | null): Promise<StatusResponse> {
    this.statusCalls.push({ depositAddress, depositMemo });
    return this.statusResponse;
  }
}
