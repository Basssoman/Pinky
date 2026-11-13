// What this browser remembers about a deal: the secret deal key and enough
// to keep working if our server is down. Kept in
// localStorage, never sent anywhere.

import type { ApiTerms, QuoteResponse } from './api';
import { randomHex } from './bytes';
import type { DeliveryNote, DisputeNote } from './notes';
import type { Sealed } from './passkey';

export type Role = 'creator' | 'client';

export interface LocalDeal {
  role: Role;
  /** The 128-bit link token (also in the client link). */
  token: string;
  /** sha256(token): how the API addresses the deal. */
  handle: string;
  /** The secret key (32 bytes, hex). */
  seed: string;
  /** The person saved the key file or the personal link. */
  saved: boolean;
  /** "Hide" on the unfinished-deal reminder: only hides the reminder, the key stays here. */
  hidden?: boolean;
  title: string;
  createdAt: number;
  /** Copy of what the server gave, checked when it was stored: lets the page work without the API. */
  cache?: { offer: string; offerSignature: string; terms: ApiTerms; dealId: number | null };
  /** Client: the payment address in use, re-checked every time it is shown. */
  payQuote?: { response: QuoteResponse; originAsset: string; refundTo: string; coin: string; network: string };
  /** Creator: own copy of what was delivered. */
  delivery?: DeliveryNote;
  /** Client: own copy of the dispute reason (and the files link as received). */
  dispute?: { reason: DisputeNote; delivery: DeliveryNote | null };
  /**
   * Protected with the passkey (passkey.ts): the key is stored only encrypted.
   * `seed` is then "" until Face ID / the key file unlocks it for this page.
   */
  sealed?: Sealed;
}

export interface KeyStore {
  get(handle: string): LocalDeal | null;
  put(deal: LocalDeal): void;
  remove(handle: string): void;
}

const PREFIX = 'kept.deal.';

/** Keys unlocked on this page (Face ID or the key file); never written anywhere. A reload locks them again. */
const unlocked = new Map<string, string>();

export function rememberUnlocked(handle: string, seed: string): void {
  unlocked.set(handle, seed);
}

export function forgetUnlocked(handle?: string): void {
  if (handle) unlocked.delete(handle);
  else unlocked.clear();
}

/** Protected and not unlocked on this page: the deal key cannot be used yet. */
export const isLocked = (d: LocalDeal | null): boolean => Boolean(d?.sealed) && !d!.seed;

/** One storage rule for both stores: a protected deal is written without its plain key. */
function keyStore(read: (k: string) => string | null, write: (k: string, v: string) => void, del: (k: string) => void): KeyStore {
  return {
    get(handle) {
      try {
        const raw = read(PREFIX + handle);
        if (!raw) return null;
        const d = JSON.parse(raw) as LocalDeal;
        return d.sealed ? { ...d, seed: unlocked.get(handle) ?? '' } : d;
      } catch {
        return null;
      }
    },
    put(deal) {
      if (deal.sealed) {
        if (deal.seed) unlocked.set(deal.handle, deal.seed);
        write(PREFIX + deal.handle, JSON.stringify({ ...deal, seed: '' }));
      } else {
        write(PREFIX + deal.handle, JSON.stringify(deal));
      }
    },
    remove(handle) {
      unlocked.delete(handle);
      del(PREFIX + handle);
    },
  };
}

export function browserStore(storage: Storage = window.localStorage): KeyStore {
  return keyStore(
    (k) => storage.getItem(k),
    (k, v) => storage.setItem(k, v),
    (k) => storage.removeItem(k),
  );
}

export function memoryStore(m: Map<string, string> = new Map()): KeyStore {
  return keyStore(
    (k) => m.get(k) ?? null,
    (k, v) => void m.set(k, v),
    (k) => void m.delete(k),
  );
}

export const newToken = (): string => randomHex(16);

/** The link the creator sends to the client. It carries no key. */
export const clientLink = (origin: string, token: string): string => `${origin}/d#${token}`;

/** The personal link = the deal key. Its own path, so it never looks like a deal link. */
export function personalLink(origin: string, d: Pick<LocalDeal, 'role' | 'token' | 'seed'>): string {
  return `${origin}/k#k1.${d.role}.${d.token}.${d.seed}`;
}

/** Reads a personal link (or just its part after #). null if it is not one. */
export function parsePersonalLink(text: string): Pick<LocalDeal, 'role' | 'token' | 'seed'> | null {
  const at = text.indexOf('#');
  const m = /^k1\.(creator|client)\.([0-9a-f]{32})\.([0-9a-f]{64})$/.exec((at >= 0 ? text.slice(at + 1) : text).trim());
  return m ? { role: m[1] as Role, token: m[2], seed: m[3] } : null;
}

/** A deal link token from `/d#<token>`. */
export function parseClientLink(hash: string): string | null {
  const t = hash.replace(/^#/, '').trim();
  return /^[0-9a-f]{32}$/.test(t) ? t : null;
}

/** The backup key code inside a key file (`k1.<role>.<token>.<seed>`), without the site address. */
export const backupCode = (d: Pick<LocalDeal, 'role' | 'token' | 'seed'>): string => `k1.${d.role}.${d.token}.${d.seed}`;

/**
 * Finds the deal key in the text of a key file: the old files hold the `k1`
 * personal link, files of a Face ID deal hold the `k2` link plus the `k1`
 * backup code. null if there is none.
 */
export function findKeyInFile(text: string): Pick<LocalDeal, 'role' | 'token' | 'seed'> | null {
  const m = /k1\.(creator|client)\.([0-9a-f]{32})\.([0-9a-f]{64})(?![0-9a-f])/.exec(text);
  return m ? { role: m[1] as Role, token: m[2], seed: m[3] } : null;
}

/** Every deal this browser remembers (newest first). Unreadable entries are skipped, never deleted. */
export function listLocalDeals(storage: Storage = window.localStorage): LocalDeal[] {
  const out: LocalDeal[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      try {
        const d = JSON.parse(storage.getItem(k) ?? 'null') as LocalDeal | null;
        if (d && typeof d.handle === 'string' && typeof d.token === 'string') out.push(d);
      } catch {
        /* not ours */
      }
    }
  } catch {
    /* blocked storage */
  }
  return out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** "Hide" on the reminder: marks the stored deal, never deletes it or its key. */
export function hideUnfinished(handle: string, storage: Storage = window.localStorage): void {
  try {
    const raw = storage.getItem(PREFIX + handle);
    if (!raw) return;
    storage.setItem(PREFIX + handle, JSON.stringify({ ...(JSON.parse(raw) as LocalDeal), hidden: true }));
  } catch {
    /* blocked storage: the reminder just stays */
  }
}

/** The way back after "Hide": the reminder shows the deal again. */
export function unhideUnfinished(handle: string, storage: Storage = window.localStorage): void {
  try {
    const raw = storage.getItem(PREFIX + handle);
    if (!raw) return;
    const { hidden: _gone, ...rest } = JSON.parse(raw) as LocalDeal;
    storage.setItem(PREFIX + handle, JSON.stringify(rest));
  } catch {
    /* blocked storage: nothing to show */
  }
}

/** Deals started here whose key was not saved yet, and whose link still works (the "continue" banner). */
export function unfinishedDeals(deals: LocalDeal[], nowMs: number): LocalDeal[] {
  return startedDeals(deals, nowMs).filter((d) => !d.hidden);
}

/** The same deals, but only the ones hidden with "Hide". */
export function hiddenUnfinished(deals: LocalDeal[], nowMs: number): LocalDeal[] {
  return startedDeals(deals, nowMs).filter((d) => d.hidden);
}

function startedDeals(deals: LocalDeal[], nowMs: number): LocalDeal[] {
  return deals.filter((d) => {
    if (d.saved || d.cache?.dealId != null) return false;
    try {
      const exp = BigInt((JSON.parse(d.cache?.offer ?? '{}') as { offer_expires_at_ns?: string }).offer_expires_at_ns ?? '0');
      return exp / 1_000_000n > BigInt(Math.floor(nowMs));
    } catch {
      return false;
    }
  });
}
