// The arbiter's side of the encrypted notes. The site
// encrypts the evidence to the arbiter's x25519 public key; only this tool,
// holding the private key (kept apart from the server), can read it.
// Format (must match web/src/lib/notes.ts): base64 of
//   ephemeral x25519 public key (32) ‖ AES-GCM nonce (12) ‖ ciphertext + tag (16)
// key = HKDF-SHA256(ECDH, salt = eph ‖ arbiter public key, info = "kept-note-v1|arbiter")
// associated data = "kept-note-v1|{contract}|{deal id}|{kind}"

import { createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const VERSION = 'kept-note-v1';

const privateKey = (raw: Buffer) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), format: 'der', type: 'pkcs8' });
const publicKey = (raw: Buffer) => createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' });

/** A new arbiter encryption key pair, both as hex of the 32 raw bytes. */
export function newNoteKey(): { priv: string; pub: string } {
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync('x25519');
  return {
    priv: (priv.export({ format: 'der', type: 'pkcs8' }) as Buffer).subarray(-32).toString('hex'),
    pub: (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex'),
  };
}

export function notePublicKey(privHex: string): string {
  const pub = createPublicKey(privateKey(Buffer.from(privHex, 'hex')));
  return (pub.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
}

export interface NoteContext {
  contractId: string;
  dealId: number;
  kind: string;
}

/** Decrypts a note written for the arbiter; throws if it is not for this key, deal and kind. */
export function openAsArbiter<T>(privHex: string, c: NoteContext, data: string): T {
  const box = Buffer.from(data, 'base64');
  if (box.length < 32 + 12 + 16) throw new Error('note is too short');
  const eph = box.subarray(0, 32);
  const nonce = box.subarray(32, 44);
  const ct = box.subarray(44, box.length - 16);
  const tag = box.subarray(box.length - 16);
  const priv = Buffer.from(privHex, 'hex');
  const shared = diffieHellman({ privateKey: privateKey(priv), publicKey: publicKey(eph) });
  const arbiterPub = Buffer.from(notePublicKey(privHex), 'hex');
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([eph, arbiterPub]), Buffer.from(`${VERSION}|arbiter`, 'utf8'), 32));
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(Buffer.from(`${VERSION}|${c.contractId}|${c.dealId}|${c.kind}`, 'utf8'));
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8')) as T;
}
