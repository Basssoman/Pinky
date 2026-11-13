// Deal keys, signatures and hashes, made in the browser.
// A private key never leaves this device: it is only ever passed to `sign`.

import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha2';
import { base58Decode, base58Encode, base64Decode, base64Encode, hex, randomBytes, unhex, utf8 } from './bytes';

export const MESSAGE_PREFIX = 'escrow-v1';

/** A one-time deal key. `seed` is the secret (32 bytes as hex). */
export interface DealKey {
  seed: string;
  /** NEAR style "ed25519:<base58 of 32 bytes>". */
  pk: string;
}

export function keyFromSeed(seed: string): DealKey {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('bad key');
  return { seed, pk: `ed25519:${base58Encode(ed25519.getPublicKey(unhex(seed)))}` };
}

export function newKey(): DealKey {
  return keyFromSeed(hex(randomBytes(32)));
}

/**
 * "ed25519:<base58 32 bytes>" -> raw bytes, or null when malformed or unsafe
 * (not a canonical curve point, or a small-order point, for which a trivial
 * signature verifies for any message).
 */
export function parsePublicKey(pk: unknown): Uint8Array | null {
  if (typeof pk !== 'string' || !pk.startsWith('ed25519:')) return null;
  try {
    const raw = base58Decode(pk.slice('ed25519:'.length));
    if (raw.length !== 32) return null;
    const point = ed25519.ExtendedPoint.fromHex(raw, false);
    return point.isSmallOrder() ? null : raw;
  } catch {
    return null;
  }
}

/** Canonical signature encoding: padded base64 of exactly 64 bytes (88 chars). */
export function isCanonicalSignature(sig: unknown): sig is string {
  if (typeof sig !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(sig)) return false;
  try {
    return base64Encode(base64Decode(sig)) === sig;
  } catch {
    return false;
  }
}

/** Signs the UTF-8 bytes of `message`; returns canonical padded base64. */
export function sign(key: DealKey, message: string): string {
  return base64Encode(ed25519.sign(utf8(message), unhex(key.seed)));
}

export function verify(pk: string, message: string, signature: unknown): boolean {
  const raw = parsePublicKey(pk);
  if (!raw || !isCanonicalSignature(signature)) return false;
  try {
    return ed25519.verify(base64Decode(signature), utf8(message), raw, { zip215: false });
  } catch {
    return false;
  }
}

/** Raw ed25519 check for 1Click quote signatures ("ed25519:<base58 64 bytes>"). */
export function verifyBase58(pk: string, message: string, signature: string): boolean {
  try {
    const strip = (v: string) => base58Decode(v.startsWith('ed25519:') ? v.slice(8) : v);
    const sig = strip(signature);
    const key = strip(pk);
    if (sig.length !== 64 || key.length !== 32) return false;
    return ed25519.verify(sig, utf8(message), key, { zip215: false });
  } catch {
    return false;
  }
}

export function sha256Bytes(data: Uint8Array): Uint8Array {
  return sha256(data);
}

export const sha256Hex = (s: string): string => hex(sha256(utf8(s)));

/** Short key code people compare in chat: first 12 hex of sha256(key) as xxxx-xxxx-xxxx. */
export function fingerprint(pk: string): string {
  const raw = parsePublicKey(pk);
  if (!raw) throw new Error('bad public key');
  const h = hex(sha256(raw));
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}`;
}

/** NEAR implicit account of a deal key (hex of the 32 key bytes). */
export function implicitAccount(pk: string): string {
  const raw = parsePublicKey(pk);
  if (!raw) throw new Error('bad public key');
  return hex(raw);
}

// ---------------------------------------------------------------- signed messages

export const offerMessage = (contractId: string, offer: string) => `${MESSAGE_PREFIX}|${contractId}|offer|${offer}`;
export const revokeOfferMessage = (contractId: string, offer: string) =>
  `${MESSAGE_PREFIX}|${contractId}|revoke_offer|${offer}`;
/** What a deal key signs for an action or a signed server request. */
export const signedMessage = (contractId: string, dealId: number, action: string, payload: string) =>
  `${MESSAGE_PREFIX}|${contractId}|${dealId}|${action}|${payload}`;

// ---------------------------------------------------------------- canonical JSON / terms

/** JSON with object keys sorted recursively, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface HashedTerms {
  title: string;
  description: string;
  /** Agreed number of revisions as a decimal string, or "". */
  revisions: string;
  /** USDC base units. */
  amount: string;
  delivery_duration_ns: string;
  review_period_ns: string;
  /** Random hex (128+ bits) from the creator's browser. */
  salt: string;
}

/** Fingerprint of the deal terms stored on-chain. */
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
