// Encrypted notes between the two parties and for the arbiter.
// The server stores ciphertext only.
//
// Party notes: both deal keys are ed25519; converted to x25519 they give the
// same shared secret on both sides (ECDH), so only the two deal keys can
// read. Arbiter copies: a one-time x25519 key + the arbiter's public key
// (hard-coded in the site), so only the arbiter can read, not even the
// writer's counterparty or our server.
//
// Cipher: AES-256-GCM (WebCrypto), key = HKDF-SHA256(shared secret), the
// deal and the note kind are bound as associated data.

import { edwardsToMontgomeryPriv, edwardsToMontgomeryPub, x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { base64Decode, base64Encode, concat, fromUtf8, randomBytes, unhex, utf8 } from './bytes';
import { parsePublicKey, type DealKey } from './keys';

const VERSION = 'kept-note-v1';

export interface NoteContext {
  contractId: string;
  dealId: number;
  kind: string;
}

const aad = (c: NoteContext) => utf8(`${VERSION}|${c.contractId}|${c.dealId}|${c.kind}`);

async function seal(key: Uint8Array, c: NoteContext, plain: Uint8Array): Promise<Uint8Array> {
  const nonce = randomBytes(12);
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad(c) }, k, plain));
  return concat(nonce, ct);
}

async function open(key: Uint8Array, c: NoteContext, box: Uint8Array): Promise<Uint8Array> {
  if (box.length < 12 + 16) throw new Error('note is too short');
  const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.slice(0, 12), additionalData: aad(c) }, k, box.slice(12)));
}

function partyKey(own: DealKey, otherPk: string, c: NoteContext): Uint8Array {
  const other = parsePublicKey(otherPk);
  if (!other) throw new Error('bad public key');
  const shared = x25519.getSharedSecret(edwardsToMontgomeryPriv(unhex(own.seed)), edwardsToMontgomeryPub(other));
  return hkdf(sha256, shared, utf8(`${c.contractId}|${c.dealId}`), utf8(`${VERSION}|party`), 32);
}

/** Encrypts a JSON value so that only the two deal keys can read it. Returns base64. */
export async function sealForParty(own: DealKey, otherPk: string, c: NoteContext, value: unknown): Promise<string> {
  return base64Encode(await seal(partyKey(own, otherPk, c), c, utf8(JSON.stringify(value))));
}

/** Decrypts a party note; throws if it was not written with these two keys for this deal and kind. */
export async function openFromParty<T>(own: DealKey, otherPk: string, c: NoteContext, data: string): Promise<T> {
  return JSON.parse(fromUtf8(await open(partyKey(own, otherPk, c), c, base64Decode(data)))) as T;
}

function arbiterKey(shared: Uint8Array, ephPub: Uint8Array, arbiterPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(ephPub, arbiterPub), utf8(`${VERSION}|arbiter`), 32);
}

/** Encrypts a JSON value for the arbiter only. `arbiterPubHex` = x25519 public key (hex). Returns base64. */
export async function sealForArbiter(arbiterPubHex: string, c: NoteContext, value: unknown): Promise<string> {
  const arbiterPub = unhex(arbiterPubHex);
  if (arbiterPub.length !== 32) throw new Error('bad arbiter key');
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = arbiterKey(x25519.getSharedSecret(ephPriv, arbiterPub), ephPub, arbiterPub);
  return base64Encode(concat(ephPub, await seal(key, c, utf8(JSON.stringify(value)))));
}

/** The arbiter's side (used by the arbiter tool and the tests). */
export async function openAsArbiter<T>(arbiterPrivHex: string, c: NoteContext, data: string): Promise<T> {
  const box = base64Decode(data);
  const priv = unhex(arbiterPrivHex);
  const ephPub = box.slice(0, 32);
  const key = arbiterKey(x25519.getSharedSecret(priv, ephPub), ephPub, x25519.getPublicKey(priv));
  return JSON.parse(fromUtf8(await open(key, c, box.slice(32)))) as T;
}

// ---------------------------------------------------------------- note contents

/** What the creator hands over. `salt` makes the on-chain fingerprint unmatchable to public files. */
export interface DeliveryNote {
  link: string;
  salt: string;
}

/** The client's dispute: which line of the sealed terms was not met, and why. */
export interface DisputeNote {
  point: string;
  pointText: string;
  text: string;
}

/** For the arbiter: the dispute plus the files link as the client received it. */
export interface DisputeArbiterNote extends DisputeNote {
  delivery: DeliveryNote | null;
}
