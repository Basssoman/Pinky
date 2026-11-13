// Encodings shared with the contract and the web app.

import { createHash, createPublicKey, verify } from 'node:crypto';

export const MESSAGE_PREFIX = 'escrow-v1';
export const USDC_DECIMALS = 6;
export const ACTIONS = ['cancel', 'deliver', 'refund', 'accept', 'dispute', 'withdraw', 'revoke_settle'] as const;
export type ActionName = (typeof ACTIONS)[number];
/** Server-only signed request types (never accepted by the contract). */
export const SERVER_ACTIONS = ['pay-quote', 'payout-quote', 'read', 'note'] as const;
export const MAX_HASH_LEN = 128;
/** Contract v2: the deliverable hash may carry a version prefix. */
export const MAX_DELIVERABLE_LEN = 192;
/** Contract v2 hard caps. */
export const MAX_FEE_BPS = 300;
export const MAX_DELIVERY_DURATION_NS = 90n * 86_400n * 1_000_000_000n;
export const MAX_REVIEW_PERIOD_NS = 90n * 86_400n * 1_000_000_000n;
/** What the submitter of `act(withdraw)` must attach (contract WITHDRAW_DEPOSIT). */
export const WITHDRAW_DEPOSIT_YOCTO = 2_250_000_000_000_000_000_000n;
/** What `revoke_offer` must attach (contract REVOKE_DEPOSIT). */
export const REVOKE_DEPOSIT_YOCTO = 1_000_000_000_000_000_000_000n;
/** What the relayer attaches to `create_deal` (contract DEAL_DEPOSIT, 0.01 NEAR):
 *  the deal's own storage, so the escrow's NEAR never pays for it. */
export const DEAL_DEPOSIT_YOCTO = 10_000_000_000_000_000_000_000n;
/** Smallest deal the contract accepts: 1 USDC (contract MIN_AMOUNT). */
export const MIN_DEAL_AMOUNT = 1_000_000n;
/** Withdraw destinations the contract refuses (plain ft_transfer would be lost). */
export const DENIED_DESTINATIONS = ['intents.near'];

export const U64_MAX = 2n ** 64n - 1n;
export const U128_MAX = 2n ** 128n - 1n;
/** true when the string has no lone UTF-16 surrogate (serde_json refuses them). */
function wellFormed(s: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

/** serde_json's recursion limit is 128; stay well below it. */
const MAX_JSON_DEPTH = 100;

/** Length in UTF-8 bytes: the contract measures `str.len()` in bytes. */
export function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Canonical decimal that fits in a u64 (`parse_u64_strict`). */
export function isU64(s: unknown): s is string {
  return isCanonicalDecimal(s, 20) && BigInt(s) <= U64_MAX;
}

/** Canonical decimal that fits in a u128 (`parse_u128_strict`). */
export function isU128(s: unknown): s is string {
  return isCanonicalDecimal(s, 39) && BigInt(s) <= U128_MAX;
}

/**
 * JSON.parse that refuses what the contract's serde_json refuses:
 * lone UTF-16 surrogates (also as `\uD800` escapes) and nesting deeper
 * than serde's recursion limit. Otherwise a payload that passes our checks
 * fails on-chain and burns relayer gas.
 */
export function parseJsonLikeContract(text: string): unknown {
  if (!wellFormed(text)) throw new Error('JSON has a lone surrogate');
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{' || c === '[') {
      if (++depth > MAX_JSON_DEPTH) throw new Error('JSON is nested too deeply');
    } else if (c === '}' || c === ']') depth--;
  }
  const v: unknown = JSON.parse(text);
  const walk = (x: unknown): void => {
    if (typeof x === 'string') {
      if (!wellFormed(x)) throw new Error('JSON has a lone surrogate');
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') {
      for (const [k, val] of Object.entries(x)) {
        if (!wellFormed(k)) throw new Error('JSON has a lone surrogate');
        walk(val);
      }
    }
  };
  walk(v);
  return v;
}

/** Canonical decimal string as the contract requires: digits, no sign, no leading zero. */
export function isCanonicalDecimal(s: unknown, maxLen = 39): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= maxLen && /^\d+$/.test(s) && (s === '0' || !s.startsWith('0'));
}

// ---------------------------------------------------------------- base58

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

// ---------------------------------------------------------------- keys & signatures

/**
 * Parses "ed25519:<base58 32 bytes>" -> raw bytes, or null if malformed or
 * not a safe key (not a canonical curve point, or a small-order point: for
 * those a trivial signature verifies for any message).
 */
export function parsePublicKey(pk: unknown): Uint8Array | null {
  if (typeof pk !== 'string' || !pk.startsWith('ed25519:')) return null;
  try {
    const raw = base58Decode(pk.slice('ed25519:'.length));
    return raw.length === 32 && isSafeEd25519Point(raw) ? raw : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- ed25519 point check

const P = 2n ** 255n - 19n;
const modP = (a: bigint) => ((a % P) + P) % P;
function powP(b: bigint, e: bigint): bigint {
  let r = 1n;
  b = modP(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
const invP = (a: bigint) => powP(a, P - 2n);
const ED_D = modP(-121665n * invP(121666n));
const SQRT_M1 = powP(2n, (P - 1n) / 4n);
const safePointCache = new Map<string, boolean>();

/**
 * true if the 32 bytes are the canonical encoding of a curve point whose
 * order is not small (8·P is not the identity). Small-order points are the
 * "weak keys" for which R = identity, s = 0 is a valid signature.
 */
export function isSafeEd25519Point(raw: Uint8Array): boolean {
  if (raw.length !== 32) return false;
  const hex = Buffer.from(raw).toString('hex');
  const cached = safePointCache.get(hex);
  if (cached !== undefined) return cached;
  const result = checkPoint(raw);
  if (safePointCache.size > 10_000) safePointCache.clear();
  safePointCache.set(hex, result);
  return result;
}

function checkPoint(raw: Uint8Array): boolean {
  const bytes = Buffer.from(raw);
  const sign = (bytes[31] >> 7) & 1;
  bytes[31] &= 0x7f;
  const y = BigInt('0x' + Buffer.from(bytes).reverse().toString('hex'));
  if (y >= P) return false; // non-canonical
  // x^2 = (y^2 - 1) / (d y^2 + 1)
  const u = modP(y * y - 1n);
  const v = modP(ED_D * y * y + 1n);
  const v3 = (v * v % P) * v % P;
  let x = (u * v3 % P) * powP((u * v3 % P) * v3 % P * v % P, (P - 5n) / 8n) % P;
  const vx2 = v * x % P * x % P;
  if (vx2 !== u) {
    if (vx2 === modP(-u)) x = x * SQRT_M1 % P;
    else return false; // not on the curve
  }
  if (x === 0n && sign === 1) return false;
  if (Number(x & 1n) !== sign) x = modP(-x);
  // 8·P via three doublings (complete twisted Edwards addition, a = -1).
  let px = x;
  let py = y;
  for (let i = 0; i < 3; i++) {
    const xy = px * py % P;
    const t = ED_D * xy % P * xy % P;
    const nx = 2n * xy % P * invP(modP(1n + t)) % P;
    const ny = modP(py * py + px * px) * invP(modP(1n - t)) % P;
    px = nx;
    py = ny;
  }
  return !(px === 0n && py === 1n);
}

/** NEAR implicit account id of a deal key (lowercase hex of the 32 bytes). */
export function implicitAccountId(pk: string): string {
  const raw = parsePublicKey(pk);
  if (!raw) throw new Error('bad public key');
  return Buffer.from(raw).toString('hex');
}

/**
 * Short key fingerprint for out-of-band comparison (same as the contract's
 * DealView fingerprints): first 12 hex chars of sha256(raw 32-byte key),
 * formatted "xxxx-xxxx-xxxx".
 */
export function keyFingerprint(pk: string): string {
  const raw = parsePublicKey(pk);
  if (!raw) throw new Error('bad public key');
  const h = createHash('sha256').update(raw).digest('hex');
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

/** Exact bytes every deal key signs for a deal action (UTF-8 of this string). */
export function signedMessage(contractId: string, dealId: number | bigint, action: string, payload: string): string {
  return `${MESSAGE_PREFIX}|${contractId}|${dealId}|${action}|${payload}`;
}

/** Exact bytes the creator signs for an offer. */
export function offerMessage(contractId: string, offer: string): string {
  return `${MESSAGE_PREFIX}|${contractId}|offer|${offer}`;
}

/** Creator-signed revocation of an offer (contract `revoke_offer`). */
export function revokeOfferMessage(contractId: string, offer: string): string {
  return `${MESSAGE_PREFIX}|${contractId}|revoke_offer|${offer}`;
}

/**
 * Canonical signature encoding: standard base64 WITH padding of exactly 64
 * bytes (88 chars, ends with "=="), and re-encoding must give the same string.
 */
export function isCanonicalSignature(sig: unknown): sig is string {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
  return Buffer.from(sig, 'base64').toString('base64') === sig;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Verifies a canonical base64 ed25519 signature against a NEAR-style public key. */
export function verifySignature(publicKey: string, message: string, signatureB64: string): boolean {
  const raw = parsePublicKey(publicKey);
  if (!raw || !isCanonicalSignature(signatureB64)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- hashing / canonical JSON

/** JSON with object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export interface HashedTerms {
  title: string;
  description: string;
  /** Agreed number of revisions, decimal string or "" if none set. */
  revisions: string;
  /** USDC base units, decimal string. */
  amount: string;
  /** Days of work counted from funding (contract v2). */
  delivery_duration_ns: string;
  review_period_ns: string;
  /** Random hex (>= 128 bits) chosen by the creator's browser. */
  salt: string;
}

/**
 * terms_hash = lowercase hex sha256 of the canonical JSON of exactly
 * { amount, delivery_duration_ns, description, review_period_ns, revisions, salt, title }.
 */
export function termsHash(t: HashedTerms): string {
  return sha256Hex(
    canonicalJson({
      title: t.title,
      description: t.description,
      revisions: t.revisions,
      amount: t.amount,
      delivery_duration_ns: t.delivery_duration_ns,
      review_period_ns: t.review_period_ns,
      salt: t.salt,
    }),
  );
}

// ---------------------------------------------------------------- offers

export interface Offer {
  creator_pk: string;
  amount: string;
  /** Fee in basis points, taken from the creator's share (<= 300). */
  fee_bps: string;
  /** Work time counted from funding (ns). */
  delivery_duration_ns: string;
  review_period_ns: string;
  terms_hash: string;
  offer_nonce: string;
  /** Joins are rejected after this time (ns). */
  offer_expires_at_ns: string;
}

const OFFER_KEYS = [
  'creator_pk',
  'amount',
  'fee_bps',
  'delivery_duration_ns',
  'review_period_ns',
  'terms_hash',
  'offer_nonce',
  'offer_expires_at_ns',
];

/** Parses an offer exactly like the contract (all fields strings, no extras). */
export function parseOffer(offer: string): Offer {
  if (utf8Len(offer) > 1024) throw new Error('offer is too long (max 1024 bytes)');
  let v: unknown;
  try {
    v = parseJsonLikeContract(offer);
  } catch {
    throw new Error('offer is not JSON the contract accepts');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('offer must be a JSON object');
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== OFFER_KEYS.length || !OFFER_KEYS.every((k) => keys.includes(k))) {
    throw new Error(`offer must have exactly: ${OFFER_KEYS.join(', ')}`);
  }
  for (const k of OFFER_KEYS) if (typeof o[k] !== 'string') throw new Error(`offer.${k} must be a string`);
  const r = o as unknown as Offer;
  if (!parsePublicKey(r.creator_pk)) throw new Error('offer.creator_pk must be ed25519:<base58>');
  // Canonical decimals exactly like the contract (no "+5", no "05").
  if (!isU128(r.amount) || BigInt(r.amount) <= 0n) throw new Error('offer.amount must be a positive canonical integer string');
  if (!isCanonicalDecimal(r.fee_bps, 5) || BigInt(r.fee_bps) > BigInt(MAX_FEE_BPS)) {
    throw new Error(`offer.fee_bps must be a canonical integer string <= ${MAX_FEE_BPS}`);
  }
  if (!isU64(r.delivery_duration_ns)) throw new Error('offer.delivery_duration_ns must be a canonical integer string');
  const duration = BigInt(r.delivery_duration_ns);
  if (duration <= 0n || duration > MAX_DELIVERY_DURATION_NS) throw new Error('offer.delivery_duration_ns must be 1 ns .. 90 days');
  if (!isU64(r.review_period_ns)) throw new Error('offer.review_period_ns must be a canonical integer string');
  if (BigInt(r.review_period_ns) > MAX_REVIEW_PERIOD_NS) throw new Error('offer.review_period_ns must be at most 90 days');
  if (!/^[0-9a-f]{64}$/.test(r.terms_hash)) throw new Error('offer.terms_hash must be 64 lowercase hex chars');
  // The contract counts bytes, not characters.
  if (utf8Len(r.offer_nonce) < 16 || utf8Len(r.offer_nonce) > 64) throw new Error('offer.offer_nonce must be 16..64 bytes');
  if (!isU64(r.offer_expires_at_ns)) throw new Error('offer.offer_expires_at_ns must be a canonical integer string');
  return r;
}

// ---------------------------------------------------------------- amounts / times

/** "12.5" | 12.5 -> "12500000" (6 decimals). Throws on bad input. */
export function usdcToBaseUnits(v: unknown): string {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('amount must be finite');
    s = String(v);
  } else if (typeof v === 'string') {
    s = v.trim();
  } else {
    throw new Error('amount must be a string or number');
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error('amount must be a positive decimal like "12.5"');
  const whole = m[1];
  const frac = m[2] ?? '';
  if (frac.length > USDC_DECIMALS) throw new Error(`amount has more than ${USDC_DECIMALS} decimals`);
  const units = BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, '0') || '0');
  if (units <= 0n) throw new Error('amount must be > 0');
  return units.toString();
}

export function baseUnitsToUsdc(units: string | bigint): string {
  const n = BigInt(units);
  const d = 10n ** BigInt(USDC_DECIMALS);
  const frac = (n % d).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${n / d}.${frac}` : `${n / d}`;
}

/** ISO date string or unix seconds (number or numeric string) -> ns bigint. */
export function toNanos(v: unknown): bigint {
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.floor(v)) * 1_000_000_000n;
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v) * 1_000_000_000n;
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return BigInt(ms) * 1_000_000n;
  }
  throw new Error('expected an ISO date string or unix seconds');
}

export function nanosToIso(ns: string | bigint): string {
  return new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();
}

/** NEAR account id syntax check (named or implicit). */
export function isAccountId(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length >= 2 &&
    s.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s)
  );
}
