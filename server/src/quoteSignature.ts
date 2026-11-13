// Verification of 1Click quote signatures (pure functions, no secrets).
//
// Source: https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature
// and the reference implementation `verifyQuoteSignature()` in
// @defuse-protocol/one-click-sdk-typescript 0.1.26:
//   message   = base58( sha256( utf8( stableStringify({ ...signedRequest, ...signedQuote, timestamp }) ) ) )
//   signature = "ed25519:<base58 64 bytes>", ed25519 over the UTF-8 bytes of `message`
//   key       = 1Click manager key ONE_CLICK_MANAGER_PUBLIC_KEY (below)
// Only the fields listed in SIGNED_REQUEST_FIELDS / SIGNED_QUOTE_FIELDS are
// covered. NOTE: `confidentiality`, `appFees`, `depositMode`, `sessionId`
// are NOT covered by the signature.

import { createHash, createPublicKey, verify } from 'node:crypto';

import { base58Decode, base58Encode, canonicalJson } from './encoding.ts';

export const ONE_CLICK_MANAGER_PUBLIC_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';

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
/** Included only when truthy (same as the SDK). */
const SIGNED_REQUEST_OPTIONAL = ['quoteWaitingTimeMs', 'referral', 'virtualChainRecipient', 'virtualChainRefundRecipient', 'customRecipientMsg'] as const;
const SIGNED_QUOTE_FIELDS_DRY = [
  'amountIn',
  'amountInFormatted',
  'amountInUsd',
  'minAmountIn',
  'amountOut',
  'amountOutFormatted',
  'amountOutUsd',
  'minAmountOut',
] as const;
/** Non-dry only; included only when truthy. */
const SIGNED_QUOTE_OPTIONAL = ['depositAddress', 'depositMemo', 'deadline', 'timeWhenInactive', 'timeEstimate', 'refundFee', 'withdrawFee'] as const;

export interface SignedQuoteResponse {
  quoteRequest?: Record<string, unknown> | null;
  quote?: Record<string, unknown> | null;
  timestamp?: string | null;
  signature?: string | null;
}

/** The exact string 1Click signs (base58 of sha256 of the stable JSON). */
export function quoteSigningMessage(res: SignedQuoteResponse): string {
  const req = res.quoteRequest ?? {};
  const quote = res.quote ?? {};
  const signed: Record<string, unknown> = {};
  for (const k of SIGNED_REQUEST_FIELDS) signed[k] = req[k];
  for (const k of SIGNED_REQUEST_OPTIONAL) if (req[k]) signed[k] = req[k];
  // quote fields override request fields with the same name (deadline)
  for (const k of SIGNED_QUOTE_FIELDS_DRY) signed[k] = quote[k];
  if (!req.dry) {
    for (const k of SIGNED_QUOTE_OPTIONAL) signed[k] = quote[k] ? quote[k] : undefined;
  }
  signed.timestamp = res.timestamp;
  // canonicalJson == json-stable-stringify for this flat object (undefined keys dropped)
  const json = canonicalJson(signed);
  return base58Encode(createHash('sha256').update(json, 'utf8').digest());
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeEd25519(value: string): Buffer {
  return Buffer.from(base58Decode(value.startsWith('ed25519:') ? value.slice(8) : value));
}

/** true iff `res.signature` is a valid 1Click signature over the quote. */
export function verifyQuoteSignature(res: SignedQuoteResponse, publicKey: string = ONE_CLICK_MANAGER_PUBLIC_KEY): boolean {
  try {
    if (typeof res.signature !== 'string' || !res.quoteRequest || !res.quote) return false;
    const sig = decodeEd25519(res.signature);
    const pk = decodeEd25519(publicKey);
    if (sig.length !== 64 || pk.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(quoteSigningMessage(res), 'utf8'), key, sig);
  } catch {
    return false;
  }
}
