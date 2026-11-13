// "Protect with Face ID / fingerprint" : the deal
// key is encrypted with a key that only the person's passkey can give back
// (WebAuthn PRF). No server or contract change: the deal key itself is the
// same one-time ed25519 key.
//
// - One passkey per browser profile for this site, reused for every deal; a
//   random 32-byte PRF salt per deal. Wrapping key = HKDF-SHA256(PRF output,
//   info "pinky deal key v1") -> AES-GCM-256 over the 32-byte seed, with
//   AAD "k2|<role>|<token>" (a blob only opens for its own deal).
// - Where the blob lives: this browser's deal record (`LocalDeal.sealed`; the
//   plain seed is then not stored, only kept in memory after an unlock) and
//   the protected personal link `/k#k2.<role>.<token>.<cred>.<salt>.<iv>.<ct>`
//   (base64url), which opens on any device with the synced passkey.
// - The key file stays the plain `k1` link: the way in without the passkey.
// - A cancelled or wrong passkey only throws; nothing stored is ever changed.

import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { hex, randomBytes, unhex, utf8 } from './bytes';
import { keyFromSeed } from './keys';
import type { LocalDeal, Role } from './local';

export interface Sealed {
  v: 1;
  /** Passkey credential id, base64url. */
  cred: string;
  /** PRF salt for this deal, base64url (32 bytes). */
  salt: string;
  /** AES-GCM nonce, base64url (12 bytes). */
  iv: string;
  /** Encrypted 32-byte seed + tag, base64url. */
  ct: string;
  /** The deal key's public key (local records only: lets a `k1` key file unlock it). */
  pk?: string;
}

export class PasskeyError extends Error {
  readonly code: 'unsupported' | 'cancelled' | 'wrong';
  constructor(code: PasskeyError['code'], message: string) {
    super(message);
    this.name = 'PasskeyError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- base64url

export function b64u(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64u(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const raw = atob(pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------- crypto

const INFO = utf8('pinky deal key v1');
const aad = (role: Role, token: string) => utf8(`k2|${role}|${token}`);
const buf = (u: Uint8Array): ArrayBuffer => u.slice().buffer as ArrayBuffer;

async function aesKey(prf: Uint8Array): Promise<CryptoKey> {
  const raw = hkdf(sha256, prf, new Uint8Array(0), INFO, 32);
  return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** Encrypts the seed with the passkey's PRF output for this deal. */
export async function seal(seed: string, prf: Uint8Array, role: Role, token: string, cred: Uint8Array, salt: Uint8Array): Promise<Sealed> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(aad(role, token)) }, await aesKey(prf), buf(unhex(seed))),
  );
  return { v: 1, cred: b64u(cred), salt: b64u(salt), iv: b64u(iv), ct: b64u(ct), pk: keyFromSeed(seed).pk };
}

/** The seed back, or PasskeyError('wrong') (another passkey, another deal, a changed blob). */
export async function unseal(s: Sealed, prf: Uint8Array, role: Role, token: string): Promise<string> {
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: buf(unb64u(s.iv)), additionalData: buf(aad(role, token)) },
        await aesKey(prf),
        buf(unb64u(s.ct)),
      ),
    );
  } catch {
    throw new PasskeyError('wrong', 'this passkey does not open this deal key');
  }
  const seed = hex(plain);
  if (plain.length !== 32 || (s.pk && keyFromSeed(seed).pk !== s.pk)) throw new PasskeyError('wrong', 'this passkey does not open this deal key');
  return seed;
}

// ---------------------------------------------------------------- WebAuthn

/** The part of WebAuthn we use; tests pass a fake. */
export interface WebAuthnLike {
  /** Makes a passkey; `prf` is the PRF output for `salt` when the authenticator gives it at creation. */
  create(o: { rpId: string; salt: Uint8Array }): Promise<{ credId: Uint8Array; prfEnabled: boolean; prf: Uint8Array | null }>;
  /** Asks one of `credIds` (Face ID / fingerprint) for the PRF output for `salt`. */
  get(o: { rpId: string; credIds: Uint8Array[]; salt: Uint8Array }): Promise<{ credId: Uint8Array; prf: Uint8Array | null }>;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } } };
const prfOut = (r: PrfResults): Uint8Array | null => (r.prf?.results?.first ? new Uint8Array(r.prf.results.first as ArrayBuffer) : null);

/** The real `navigator.credentials`. */
export function browserWebAuthn(): WebAuthnLike {
  return {
    async create({ rpId, salt }) {
      const cred = (await navigator.credentials.create({
        publicKey: {
          rp: { id: rpId, name: 'Pinky' },
          user: { id: buf(randomBytes(16)), name: 'Pinky deals', displayName: 'Pinky deals' },
          challenge: buf(randomBytes(32)),
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
          timeout: 120_000,
          extensions: { prf: { eval: { first: buf(salt) } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new PasskeyError('cancelled', 'no passkey was made');
      const ext = cred.getClientExtensionResults() as PrfResults;
      return { credId: new Uint8Array(cred.rawId), prfEnabled: ext.prf?.enabled === true || prfOut(ext) !== null, prf: prfOut(ext) };
    },
    async get({ rpId, credIds, salt }) {
      const cred = (await navigator.credentials.get({
        publicKey: {
          rpId,
          challenge: buf(randomBytes(32)),
          allowCredentials: credIds.map((id) => ({ type: 'public-key' as const, id: buf(id) })),
          userVerification: 'required',
          timeout: 120_000,
          extensions: { prf: { eval: { first: buf(salt) } } } as AuthenticationExtensionsClientInputs,
        },
      })) as PublicKeyCredential | null;
      if (!cred) throw new PasskeyError('cancelled', 'the passkey was not used');
      return { credId: new Uint8Array(cred.rawId), prf: prfOut(cred.getClientExtensionResults() as PrfResults) };
    },
  };
}

/** Whether to offer the button at all: WebAuthn + PRF (or, when the browser cannot say, a built-in authenticator). */
export async function passkeySupport(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.isSecureContext) return false;
  const PKC = window.PublicKeyCredential as
    | (typeof PublicKeyCredential & { getClientCapabilities?: () => Promise<Record<string, boolean | undefined>> })
    | undefined;
  if (!PKC || !navigator.credentials) return false;
  if (typeof PKC.getClientCapabilities === 'function') {
    try {
      const caps = await PKC.getClientCapabilities();
      if (caps['extension:prf'] === true) return true;
      if (caps['extension:prf'] === false) return false;
    } catch {
      /* fall through */
    }
  }
  try {
    return await PKC.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

const isCancel = (e: unknown) => e instanceof PasskeyError || (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError'));

/** This browser's passkey for the site (id only; reused for every deal). */
export interface PasskeyMemo {
  load(): string | null;
  save(cred: string | null): void;
}

export function browserMemo(storage: Storage = window.localStorage): PasskeyMemo {
  const KEY = 'kept.passkey';
  return {
    load: () => {
      try {
        return storage.getItem(KEY);
      } catch {
        return null;
      }
    },
    save: (cred) => {
      try {
        if (cred) storage.setItem(KEY, cred);
        else storage.removeItem(KEY);
      } catch {
        /* blocked storage: a new passkey is made next time */
      }
    },
  };
}

/**
 * Seals this deal's key with the passkey (making the passkey the first time).
 * Returns the sealed blob after a test unwrap; the caller stores it. On any
 * failure nothing is stored and the key stays as it was.
 */
export async function protectKey(
  wa: WebAuthnLike,
  memo: PasskeyMemo,
  rpId: string,
  local: Pick<LocalDeal, 'role' | 'token' | 'seed'>,
): Promise<Sealed> {
  const salt = randomBytes(32);
  let cred: Uint8Array;
  let prf: Uint8Array | null = null;
  const known = memo.load();
  try {
    if (known) {
      const r = await wa.get({ rpId, credIds: [unb64u(known)], salt });
      cred = r.credId;
      prf = r.prf;
    } else {
      const c = await wa.create({ rpId, salt });
      if (!c.prfEnabled) throw new PasskeyError('unsupported', 'this passkey cannot protect keys (no PRF)');
      cred = c.credId;
      memo.save(b64u(cred));
      // Some browsers give the PRF output only when the passkey is used, not when it is made.
      prf = c.prf ?? (await wa.get({ rpId, credIds: [cred], salt })).prf;
    }
  } catch (e) {
    // The remembered passkey may have been deleted: next time a new one is made.
    if (known) memo.save(null);
    if (e instanceof PasskeyError) throw e;
    throw isCancel(e) ? new PasskeyError('cancelled', 'Face ID / fingerprint was cancelled') : e;
  }
  if (!prf || prf.length < 32) throw new PasskeyError('unsupported', 'this passkey cannot protect keys (no PRF)');
  const sealed = await seal(local.seed, prf, local.role, local.token, cred, salt);
  if ((await unseal(sealed, prf, local.role, local.token)) !== local.seed) throw new PasskeyError('wrong', 'test unlock failed');
  return sealed;
}

/** Face ID / fingerprint -> the seed. Throws PasskeyError; never changes anything. */
export async function unlockKey(wa: WebAuthnLike, rpId: string, s: Sealed, role: Role, token: string): Promise<string> {
  let prf: Uint8Array | null;
  try {
    prf = (await wa.get({ rpId, credIds: [unb64u(s.cred)], salt: unb64u(s.salt) })).prf;
  } catch (e) {
    throw isCancel(e) ? new PasskeyError('cancelled', 'Face ID / fingerprint was cancelled') : e;
  }
  if (!prf) throw new PasskeyError('wrong', 'this passkey gave no key');
  return unseal(s, prf, role, token);
}

// ---------------------------------------------------------------- the protected link

/** `/k#k2.…`: the personal link that only opens with the passkey. */
export function sealedLink(origin: string, d: Pick<LocalDeal, 'role' | 'token'> & { sealed: Sealed }): string {
  const s = d.sealed;
  return `${origin}/k#k2.${d.role}.${d.token}.${s.cred}.${s.salt}.${s.iv}.${s.ct}`;
}

/** Reads a protected personal link (or its part after #); null if it is not one. */
export function parseSealedLink(text: string): { role: Role; token: string; sealed: Sealed } | null {
  const at = text.indexOf('#');
  const m = /^k2\.(creator|client)\.([0-9a-f]{32})\.([A-Za-z0-9_-]{16,700})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{64})$/.exec(
    (at >= 0 ? text.slice(at + 1) : text).trim(),
  );
  if (!m) return null;
  return { role: m[1] as Role, token: m[2], sealed: { v: 1, cred: m[3], salt: m[4], iv: m[5], ct: m[6] } };
}

// ---------------------------------------------------------------- pretend passkeys (tests, dev preview)

/**
 * A stand-in for WebAuthn with PRF: each "passkey" is a random secret, the
 * PRF output is HMAC-SHA256(secret, salt) like the real hmac-secret. Pass the
 * same `vault` to two fakes to play a passkey synced to a second device.
 * `next` lets a test make the next call fail ("cancel") or report no PRF.
 */
export function fakeWebAuthn(vault: Map<string, Uint8Array> = new Map(), opts: { prfOnCreate?: boolean } = {}) {
  const state = { next: null as null | 'cancel' | 'noprf', calls: 0 };
  const prfFor = (id: Uint8Array, salt: Uint8Array) => {
    const secret = vault.get(b64u(id));
    return secret ? hmac(sha256, secret, salt) : null;
  };
  const fail = () => {
    const n = state.next;
    state.next = null;
    if (n === 'cancel') throw Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' });
    return n;
  };
  const wa: WebAuthnLike = {
    async create({ salt }) {
      state.calls++;
      const n = fail();
      const id = randomBytes(16);
      vault.set(b64u(id), randomBytes(32));
      if (n === 'noprf') return { credId: id, prfEnabled: false, prf: null };
      return { credId: id, prfEnabled: true, prf: opts.prfOnCreate === false ? null : prfFor(id, salt) };
    },
    async get({ credIds, salt }) {
      state.calls++;
      fail();
      const id = credIds.find((c) => vault.has(b64u(c)));
      if (!id) throw Object.assign(new Error('no such passkey'), { name: 'NotAllowedError' });
      return { credId: id, prf: prfFor(id, salt) };
    },
  };
  return { wa, state, vault };
}

/** The ONE personal link of this party: the Face ID link once protected, else the plain one (which is the key). */
export function ownLink(origin: string, d: Pick<LocalDeal, 'role' | 'token' | 'seed'> & { sealed?: Sealed }): string {
  return d.sealed ? sealedLink(origin, { ...d, sealed: d.sealed }) : `${origin}/k#k1.${d.role}.${d.token}.${d.seed}`;
}
