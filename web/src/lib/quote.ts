// Checks of every 1Click quote before the site shows a payment address or
// signs a withdraw. The quote comes through our server, so the
// browser verifies 1Click's own signature and that the quote is exactly for
// this deal. Reference: server/src/quoteSignature.ts.

import type { PayoutQuote, PayQuote, QuoteResponse } from './api';
import { base58Encode, utf8 } from './bytes';
import type { Net } from './config';
import { canonicalJson, implicitAccount, sha256Bytes, verifyBase58 } from './keys';

const SIGNED_REQUEST_FIELDS = [
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
  'deadline',
] as const;
/** Included only when truthy. */
const SIGNED_REQUEST_OPTIONAL = ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg'] as const;
const SIGNED_QUOTE_FIELDS = ['amountIn', 'amountInFormatted', 'amountInUsd', 'minAmountIn', 'amountOut', 'amountOutFormatted', 'amountOutUsd', 'minAmountOut'] as const;
/** Non-dry quotes only; a falsy value removes the key. */
const SIGNED_QUOTE_OPTIONAL = ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'] as const;

/** The exact string 1Click signs: base58(sha256(stable JSON)). */
export function quoteSigningMessage(res: QuoteResponse): string {
  const req = res.quoteRequest ?? {};
  const quote = res.quote ?? {};
  const signed: Record<string, unknown> = {};
  for (const k of SIGNED_REQUEST_FIELDS) signed[k] = req[k];
  for (const k of SIGNED_REQUEST_OPTIONAL) if (req[k]) signed[k] = req[k];
  for (const k of SIGNED_QUOTE_FIELDS) signed[k] = quote[k];
  if (!req.dry) {
    for (const k of SIGNED_QUOTE_OPTIONAL) signed[k] = quote[k] ? quote[k] : undefined;
  }
  signed.timestamp = res.timestamp;
  return base58Encode(sha256Bytes(utf8(canonicalJson(signed))));
}

export function verifyQuoteSignature(res: QuoteResponse, oneClickKey: string): boolean {
  if (typeof res?.signature !== 'string' || !res.quoteRequest || !res.quote) return false;
  try {
    return verifyBase58(oneClickKey, quoteSigningMessage(res), res.signature);
  } catch {
    return false;
  }
}

/** Why a quote was refused. `code` picks the text shown to the person. */
export class QuoteError extends Error {
  readonly code: 'signature' | 'stale' | 'mismatch' | 'too_late' | 'dry';
  constructor(code: QuoteError['code'], message: string) {
    super(message);
    this.name = 'QuoteError';
    this.code = code;
  }
}

const MAX_AGE_MS = 2 * 60_000;
const MAX_FUTURE_MS = 30_000;
/** A pay quote must leave at least this long to send the deposit. */
export const MIN_PAY_WINDOW_MS = 10 * 60_000;

function time(v: unknown, what: string): number {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(ms)) throw new QuoteError('mismatch', `the quote has no valid ${what}`);
  return ms;
}

function must(cond: boolean, what: string): void {
  if (!cond) throw new QuoteError('mismatch', `the quote does not match this deal (${what})`);
}

/** Signature and bindings that never go stale (also used when a stored quote is shown again). */
function checkSigned(res: QuoteResponse, net: Net): { req: Record<string, unknown>; quote: Record<string, unknown> } {
  if (!verifyQuoteSignature(res, net.oneClickKey)) {
    throw new QuoteError('signature', 'the quote is not signed by 1Click');
  }
  return { req: res.quoteRequest!, quote: res.quote! };
}

function checkFresh(res: QuoteResponse, nowMs: number): void {
  const age = nowMs - time(res.timestamp, 'timestamp');
  if (age > MAX_AGE_MS || age < -MAX_FUTURE_MS) throw new QuoteError('stale', 'the quote is not fresh');
}

export interface PayExpect {
  dealId: number;
  /** The full deal amount from the chain (USDC base units). */
  amount: string;
  /** What the person chose and typed. */
  originAsset: string;
  refundTo: string;
  /** `pay_by_ns` of the deal from the chain, in ms. */
  payByMs: number;
}

export interface VerifiedPayQuote {
  depositAddress: string;
  depositMemo: string | null;
  /** Amount to send, as 1Click formatted it (signed). */
  amountInFormatted: string;
  amountInUsd: string | null;
  /** Send before this (ms): the earliest of the quote's deadlines and the deal's pay-by. */
  sendByMs: number;
  /** The quote as received, to show the same address again after a reload. */
  response: QuoteResponse;
}

/**
 * "Before paying" checks. `fresh: false` re-checks a stored quote
 * (signature, bindings, deadlines) without the 2-minute timestamp rule.
 */
export function checkPayQuote(res: PayQuote['quote_response'], expect: PayExpect, net: Net, nowMs: number, fresh = true): VerifiedPayQuote {
  if (res?.quoteRequest?.dry === true) throw new QuoteError('dry', 'payments are switched off on this server');
  const { req, quote } = checkSigned(res, net);
  if (fresh) checkFresh(res, nowMs);
  must(req.dry === false, 'not a real quote');
  must(req.swapType === 'EXACT_OUTPUT', 'swap type');
  must(req.recipient === net.contractId, 'recipient');
  must(req.recipientType === 'DESTINATION_CHAIN', 'recipient type');
  must(req.destinationAsset === net.usdcAssetId, 'destination coin');
  must(req.customRecipientMsg === JSON.stringify({ deal_id: expect.dealId }), 'deal number');
  must(req.amount === expect.amount, 'amount');
  must(req.originAsset === expect.originAsset, 'coin');
  must(req.depositType === 'ORIGIN_CHAIN', 'deposit type');
  must(req.refundTo === expect.refundTo, 'refund address');
  must(req.refundType === 'ORIGIN_CHAIN', 'refund type');
  const depositAddress = quote.depositAddress;
  must(typeof depositAddress === 'string' && depositAddress.length > 0, 'no payment address');
  const memo = quote.depositMemo;
  must(memo === undefined || memo === null || typeof memo === 'string', 'memo');
  must(typeof quote.amountInFormatted === 'string' && typeof quote.amountIn === 'string', 'amount to send');

  // quote.deadline is signed; quoteRequest.deadline (what our server asked
  // for) binds at 1Click but is not signed in a real quote, so the earliest
  // one wins. Money after the deal's pay-by date would only come back.
  const limits = [time(quote.deadline, 'deadline'), expect.payByMs];
  if (quote.timeWhenInactive) limits.push(time(quote.timeWhenInactive, 'deadline'));
  if (req.deadline) limits.push(time(req.deadline, 'deadline'));
  const sendByMs = Math.min(...limits);
  if (sendByMs - nowMs < (fresh ? MIN_PAY_WINDOW_MS : 0)) throw new QuoteError('too_late', 'not enough time left to pay with this quote');

  return {
    depositAddress: depositAddress as string,
    depositMemo: memo ? (memo as string) : null,
    amountInFormatted: quote.amountInFormatted as string,
    amountInUsd: typeof quote.amountInUsd === 'string' ? quote.amountInUsd : null,
    sendByMs,
    response: res,
  };
}

export interface PayoutExpect {
  /** This browser's deal key. */
  ownPk: string;
  /** Own withdrawable payout from the chain (USDC base units). */
  amount: string;
  /** What the person chose. */
  destinationAsset: string;
  recipient: string;
  recipientType: 'DESTINATION_CHAIN' | 'CONFIDENTIAL_INTENTS';
}

export interface VerifiedPayout {
  /** Sign exactly this string as the `withdraw` payload. */
  withdrawPayload: string;
  amountOutFormatted: string | null;
}

/** "Before signing a withdraw" checks. */
export function checkPayoutQuote(res: PayoutQuote, expect: PayoutExpect, net: Net, nowMs: number): VerifiedPayout {
  const r = res.quote_response;
  if (r?.quoteRequest?.dry === true || res.withdraw_payload === null) {
    throw new QuoteError('dry', 'payouts are switched off on this server');
  }
  const { req, quote } = checkSigned(r, net);
  checkFresh(r, nowMs);
  must(req.dry === false, 'not a real quote');
  must(req.swapType === 'EXACT_INPUT', 'swap type');
  must(req.originAsset === net.usdcAssetId, 'origin coin');
  must(req.depositType === 'ORIGIN_CHAIN', 'deposit type');
  must(req.amount === expect.amount, 'amount');
  must(req.destinationAsset === expect.destinationAsset, 'coin');
  must(req.recipient === expect.recipient, 'address');
  must(req.recipientType === expect.recipientType, 'address type');
  must(req.refundType === 'INTENTS' || req.refundType === 'CONFIDENTIAL_INTENTS', 'refund type');
  must(req.refundTo === implicitAccount(expect.ownPk), 'refund account');
  must(!quote.depositMemo, 'memo');

  let w: Record<string, unknown>;
  try {
    w = JSON.parse(res.withdraw_payload) as Record<string, unknown>;
  } catch {
    throw new QuoteError('mismatch', 'the withdraw request is not readable');
  }
  must(Object.keys(w).sort().join(',') === 'amount,destination,expires_at_ns', 'withdraw fields');
  must(typeof quote.depositAddress === 'string' && w.destination === quote.depositAddress, 'destination');
  must(w.destination !== net.contractId && w.destination !== net.tokenAccountId, 'destination');
  must(w.amount === req.amount, 'withdraw amount');
  must(typeof w.expires_at_ns === 'string' && /^\d{1,20}$/.test(w.expires_at_ns), 'expiry');
  const expiresMs = Number(BigInt(w.expires_at_ns as string) / 1_000_000n);
  const limits = [time(quote.deadline, 'deadline')];
  if (quote.timeWhenInactive) limits.push(time(quote.timeWhenInactive, 'deadline'));
  if (expiresMs <= nowMs) throw new QuoteError('too_late', 'the withdraw request has expired');
  must(expiresMs < Math.min(...limits), 'expiry after the quote deadline');

  return {
    withdrawPayload: res.withdraw_payload,
    amountOutFormatted: typeof quote.amountOutFormatted === 'string' ? quote.amountOutFormatted : null,
  };
}
