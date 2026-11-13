// Marketplace: creator profiles, requests, reviews.
// Everything here is off-chain and never touches money. The binding field
// names are in the shared API contract (marketplace/API.md).
//
// Profile key: one ed25519 key per creator, made in this browser, kept in
// localStorage `kept.profile` (+ a recovery file). Never used on-chain and
// never as a deal key. Every profile write is signed with it, with an expiry.

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { concat, fromUtf8, hex, randomBytes, unhex, utf8 } from './bytes';
import type { LoadedDeal } from './flows';
import { canonicalJson, keyFromSeed, MESSAGE_PREFIX, newKey, parsePublicKey, sha256Hex, sign, verify, type DealKey } from './keys';

export const CATEGORIES = ['video', 'motion', 'design', 'editing', 'code', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CONTACT_KINDS = ['telegram', 'x', 'discord', 'whatsapp', 'email', 'other'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export interface Contact {
  kind: ContactKind;
  value: string;
}

export interface Service {
  /** Server-assigned (8 hex); missing on a new service. */
  id?: string;
  title: string;
  description: string;
  price_from_usdc: number;
  delivery_days: number;
}

/** What the creator writes (PUT body `profile`). */
export interface ProfileFields {
  nickname: string;
  bio: string;
  categories: Category[];
  portfolio: string[];
  contacts: Contact[];
  services: Service[];
}

/** A creator in the catalog. */
export interface Card {
  profile_id: string;
  nickname: string;
  categories: Category[];
  price_from_usdc: number | null;
  finished_deals: number;
  rating_avg: number | null;
  reviews_count: number;
  /** "On Pinky since <month>", "2026-11". */
  since_month?: string;
  /** Version of the uploaded picture; null / missing = the pixel pattern. */
  avatar?: string | null;
}

/** "paid" / "money went back to the client" / "dispute". */
export type ReviewOutcome = 'paid' | 'refunded' | 'dispute';

export interface PublicReview {
  /** Random public id (the creator's answer is sent to it). */
  review_id?: string;
  rating: number;
  text: string;
  /** "2026-11": never finer than a month (privacy). */
  month: string;
  /** The creator got nothing from this deal: labelled "money went back to the client". */
  refunded?: boolean;
  outcome?: ReviewOutcome;
  /** The creator's one public answer. */
  reply?: { text: string; month: string } | null;
}

/** The label of a review: the outcome, or (older servers) "money went back" from `refunded`. */
export const outcomeOf = (r: Pick<PublicReview, 'outcome' | 'refunded'>): ReviewOutcome => r.outcome ?? (r.refunded ? 'refunded' : 'paid');

/** A service as it was when the request was sent. */
export interface ServiceSnapshot {
  id: string;
  title: string;
  price_from_usdc?: number;
  delivery_days?: number;
}

export interface Profile extends ProfileFields {
  profile_id: string;
  finished_deals: number;
  rating_avg: number | null;
  reviews_count: number;
  reviews: PublicReview[];
  updated_month: string;
  since_month?: string;
  /** Version of the uploaded picture; null / missing = the pixel pattern. */
  avatar?: string | null;
  /** The profile key or contact changed in the last 14 days. */
  recent_change?: RecentChange | null;
  /** Support is changing the key of this profile. */
  key_changing?: boolean;
}

export interface RecentChange {
  what: 'key' | 'contact';
  days_ago: number;
}

/** Sent → viewed → in talks → deal ready / declined / cancelled / closed (no answer in 7 days). */
export type RequestStatus = 'open' | 'viewed' | 'discussing' | 'declined' | 'cancelled' | 'deal_ready' | 'closed';

/** The deal token, encrypted to the client's request key: the server cannot read it. */
export interface LinkBox {
  epk: string;
  iv: string;
  ct: string;
}

/** The last profile write as the creator signed it: the nickname is taken from it after the check. */
export interface ProfileProof {
  profile: { nickname?: unknown } & Record<string, unknown>;
  expires_at_ns: string;
  sig: string;
}

/** The profile key's signature over (request, the deal's creator key). */
export interface DealProof {
  creator_pk: string;
  profile_pk: string;
  expires_at_ns: string;
  sig: string;
}

/** The client's view of own request (`GET /api/requests/:handle`). */
export interface RequestView {
  status: RequestStatus;
  profile: {
    profile_id: string;
    nickname: string;
    avatar?: string | null;
    /** The creator's profile key now (compared with the pinned one). */
    profile_pk?: string | null;
    recent_change?: RecentChange | null;
    key_changing?: boolean;
  };
  profile_proof?: ProfileProof | null;
  service?: ServiceSnapshot | null;
  brief: string;
  wanted_deadline: string | null;
  /** The creator's reason with "no" (optional). */
  decline_reason?: string | null;
  /** When an unanswered request closes by itself (ISO). */
  closes_at?: string | null;
  deal_link?: string | null;
  deal_link_box?: LinkBox | null;
  deal_proof?: DealProof | null;
}

/** One request in the creator's inbox (signed read). */
export interface InboxItem {
  handle: string;
  status: RequestStatus;
  service?: ServiceSnapshot | null;
  brief: string;
  wanted_deadline: string | null;
  client_contact: Contact;
  created_at: string;
  /** x25519 public key (hex) the deal link is encrypted to. */
  client_box_pk?: string | null;
  decline_reason?: string | null;
  /** When it closes by itself if not answered (ISO). */
  closes_at?: string | null;
}

/** A key change by support in progress (the owner's signed inbox only). */
export interface KeyChange {
  reset_id: string;
  effective_at: string;
}

export interface ReviewLink {
  linked: boolean;
  profile_id?: string;
  nickname?: string;
  /** Fully paid and finished on-chain (the server read the contract) AND inside the 3-day window. */
  can_review?: boolean;
  /** The 3-day window is over: no new review, no edits. */
  locked?: boolean;
  /** ISO time the window closes (deal-token holder only). */
  review_until?: string | null;
  outcome?: ReviewOutcome | null;
  review?: PublicReview | null;
}

// ---------------------------------------------------------------- limits (same as the server)

export const LIMITS = {
  nickname: [2, 32],
  bio: 400,
  categories: [1, 3],
  portfolio: 8,
  link: 300,
  contacts: 5,
  contact: 100,
  services: 10,
  serviceTitle: 80,
  serviceDescription: 600,
  price: [1, 2000],
  days: [1, 90],
  brief: 2000,
  review: 500,
  reply: 500,
  report: 500,
  declineReason: 300,
} as const;

// ---------------------------------------------------------------- profile key

export interface ProfileKey {
  seed: string;
  pk: string;
  /** The person saved the recovery file or link. */
  saved: boolean;
  createdAt: number;
  /**
   * The profile this key controls when support moved an older profile to it
   *: then the id is not the hash of this key. Missing = the hash.
   */
  profileId?: string;
}

/** `profile_id` = first 12 bytes of sha256(raw 32-byte public key), lowercase hex. */
export function profileIdOf(pk: string): string {
  const raw = parsePublicKey(pk);
  if (!raw) throw new Error('bad public key');
  return hex(sha256(raw)).slice(0, 24);
}

/** The profile this browser's key writes to (after a key reset it is the old profile's id). */
export const profileIdOfKey = (k: Pick<ProfileKey, 'pk' | 'profileId'>): string =>
  k.profileId && isProfileId(k.profileId) ? k.profileId : profileIdOf(k.pk);

/**
 * The short fingerprint of a profile key pinned in the request link:
 * 12 bytes of sha256, the same shape as a profile id.
 */
export const keyFingerprint = (pk: string): string => profileIdOf(pk);

export const isProfileId = (s: string): boolean => /^[0-9a-f]{24}$/.test(s);

const PROFILE_KEY = 'kept.profile';

export function loadProfileKey(storage: Storage | null = safeStorage()): ProfileKey | null {
  try {
    const raw = storage?.getItem(PROFILE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ProfileKey>;
    if (typeof v.seed !== 'string') return null;
    const k = keyFromSeed(v.seed);
    return {
      seed: k.seed,
      pk: k.pk,
      saved: v.saved === true,
      createdAt: Number(v.createdAt) || 0,
      ...(typeof v.profileId === 'string' && isProfileId(v.profileId) ? { profileId: v.profileId } : {}),
    };
  } catch {
    return null;
  }
}

export function storeProfileKey(k: ProfileKey, storage: Storage | null = safeStorage()): void {
  storage?.setItem(PROFILE_KEY, JSON.stringify(k));
  keyListeners.forEach((f) => f());
}

export function newProfileKey(now = Date.now()): ProfileKey {
  const k = newKey();
  return { seed: k.seed, pk: k.pk, saved: false, createdAt: now };
}

const keyListeners = new Set<() => void>();
export function onProfileKeyChange(f: () => void): () => void {
  keyListeners.add(f);
  return () => keyListeners.delete(f);
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The recovery link = the profile key. Its own path, so it never looks like a deal or request link. */
export const profileRecoveryLink = (origin: string, seed: string): string => `${origin}/p#p1.${seed}`;

/** Finds a profile recovery link (or just its `p1.` part) in any text, e.g. the recovery file. */
export function parseProfileRecovery(text: string): string | null {
  const m = /(?:^|[#\s])p1\.([0-9a-f]{64})(?![0-9a-f])/.exec(text.trim());
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- signed messages

const NS_PER_MS = 1_000_000n;
/**
 * Expiry for a profile signature: 5 minutes ahead (the server accepts ≤ 10).
 * A random part below one millisecond makes every signature unique, so two
 * reads in the same millisecond never look like a replay to the server.
 */
export const expiresNs = (nowMs: number): string =>
  ((BigInt(Math.floor(nowMs)) + 5n * 60_000n) * NS_PER_MS + BigInt(Math.floor(Math.random() * 1_000_000))).toString();

const dealKeyOf = (k: Pick<ProfileKey, 'seed' | 'pk'>): DealKey => ({ seed: k.seed, pk: k.pk });

export const profileWriteMessage = (contractId: string, profileId: string, body: unknown, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile|${profileId}|${sha256Hex(canonicalJson(body))}|${exp}`;
export const inboxMessage = (contractId: string, profileId: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-inbox|${profileId}|${exp}`;
export const declineMessage = (contractId: string, handle: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-decline|${handle}|${exp}`;
/** A decline with a reason signs sha256 of the reason too, exactly as sent. */
export const declineReasonMessage = (contractId: string, handle: string, reason: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-decline|${handle}|${sha256Hex(reason)}|${exp}`;
export const discussMessage = (contractId: string, handle: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-discuss|${handle}|${exp}`;
export const keyResetCancelMessage = (contractId: string, profileId: string, resetId: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-key-reset-cancel|${profileId}|${resetId}|${exp}`;
export const requestDealMessage = (contractId: string, handle: string, creatorPk: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-deal|${handle}|${creatorPk}|${exp}`;
/** Signed by the deal's CLIENT key. `text` is hashed exactly as sent (trimmed). An edit needs a later expiry. */
export const reviewMessage = (contractId: string, dealId: number, profileId: string, rating: number, text: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|review|${dealId}|${profileId}|${rating}|${sha256Hex(text)}|${exp}`;

/**
 * The review body (`POST /api/deals/:handle/review`): text trimmed and signed
 * exactly as sent, with an expiry (a later edit has a later expiry).
 */
export function signReview(contractId: string, clientKey: DealKey, dealId: number, profileId: string, rating: number, text: string, nowMs: number) {
  const body = text.trim();
  const exp = expiresNs(nowMs);
  return { rating, text: body, expires_at_ns: exp, sig: sign(clientKey, reviewMessage(contractId, dealId, profileId, rating, body, exp)) };
}

/** The creator's one public answer to a review, signed by the profile key. */
export const reviewReplyMessage = (contractId: string, profileId: string, reviewId: string, text: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|review-reply|${profileId}|${reviewId}|${sha256Hex(text)}|${exp}`;

/** The answer body (`POST /api/profiles/:id/reviews/:review_id/reply`): trimmed, signed exactly as sent. */
export function signReply(contractId: string, k: ProfileKey, reviewId: string, text: string, nowMs: number) {
  const body = text.trim();
  const exp = expiresNs(nowMs);
  return { profile_pk: k.pk, text: body, expires_at_ns: exp, sig: sign(dealKeyOf(k), reviewReplyMessage(contractId, profileIdOfKey(k), reviewId, body, exp)) };
}

const FINISHED = ['Released', 'Refunded', 'PaidOut'];

/** Whether this browser may offer a review: client key, fully paid, finished on-chain (the server checks the same). */
export function reviewable(d: Pick<LoadedDeal, 'role' | 'key' | 'deal'>): boolean {
  const deal = d.deal;
  return d.role === 'client' && d.key !== null && deal !== null && FINISHED.includes(deal.state) && BigInt(deal.funded_amount) >= BigInt(deal.amount);
}

export interface SignedWrite {
  expires_at_ns: string;
  sig: string;
}

export function signProfileWrite(contractId: string, k: ProfileKey, body: unknown, nowMs: number): SignedWrite {
  const exp = expiresNs(nowMs);
  return { expires_at_ns: exp, sig: sign(dealKeyOf(k), profileWriteMessage(contractId, profileIdOfKey(k), body, exp)) };
}
export function signInbox(contractId: string, k: ProfileKey, nowMs: number): SignedWrite {
  const exp = expiresNs(nowMs);
  return { expires_at_ns: exp, sig: sign(dealKeyOf(k), inboxMessage(contractId, profileIdOfKey(k), exp)) };
}
/** A "no", with an optional reason (trimmed; signed exactly as sent). */
export function signDecline(contractId: string, k: ProfileKey, handle: string, nowMs: number, reason = ''): SignedWrite & { reason?: string } {
  const exp = expiresNs(nowMs);
  const why = reason.trim();
  if (!why) return { expires_at_ns: exp, sig: sign(dealKeyOf(k), declineMessage(contractId, handle, exp)) };
  return { reason: why, expires_at_ns: exp, sig: sign(dealKeyOf(k), declineReasonMessage(contractId, handle, why, exp)) };
}
export function signDiscuss(contractId: string, k: ProfileKey, handle: string, nowMs: number): SignedWrite {
  const exp = expiresNs(nowMs);
  return { expires_at_ns: exp, sig: sign(dealKeyOf(k), discussMessage(contractId, handle, exp)) };
}
export function signKeyResetCancel(contractId: string, k: ProfileKey, resetId: string, nowMs: number): SignedWrite {
  const exp = expiresNs(nowMs);
  return { expires_at_ns: exp, sig: sign(dealKeyOf(k), keyResetCancelMessage(contractId, profileIdOfKey(k), resetId, exp)) };
}
export function signRequestDeal(contractId: string, k: Pick<ProfileKey, 'seed' | 'pk'>, handle: string, creatorPk: string, nowMs: number): SignedWrite {
  const exp = expiresNs(nowMs);
  return { expires_at_ns: exp, sig: sign(dealKeyOf(k), requestDealMessage(contractId, handle, creatorPk, exp)) };
}

// ---------------------------------------------------------------- the deal link, encrypted to the client
// The client's request key is derived from the request token (which only the
// client holds), so the `/r#token` page can always open the box and nothing
// extra has to be stored. The creator encrypts the deal token to its public
// part with a one-time key; the server keeps the box and cannot read it.

const BOX_VERSION = 'pinky-request-box-v1';

export function requestBoxPriv(requestToken: string): Uint8Array {
  return sha256(utf8(`${BOX_VERSION}|${requestToken}`));
}
export const requestBoxPub = (requestToken: string): string => hex(x25519.getPublicKey(requestBoxPriv(requestToken)));

function boxKey(shared: Uint8Array, epk: Uint8Array, pub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concat(epk, pub), utf8(BOX_VERSION), 32);
}

export async function sealDealLink(clientBoxPkHex: string, requestHandle: string, dealToken: string): Promise<LinkBox> {
  const pub = unhex(clientBoxPkHex);
  if (pub.length !== 32) throw new Error('bad request key');
  const ephPriv = randomBytes(32);
  const epk = x25519.getPublicKey(ephPriv);
  const key = await crypto.subtle.importKey('raw', boxKey(x25519.getSharedSecret(ephPriv, pub), epk, pub), 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(`${BOX_VERSION}|${requestHandle}`) }, key, utf8(dealToken)),
  );
  return { epk: hex(epk), iv: hex(iv), ct: hex(ct) };
}

/** Opens the box; returns the deal token, or null when it is not for this request. */
export async function openDealLink(requestToken: string, requestHandle: string, box: LinkBox): Promise<string | null> {
  try {
    const priv = requestBoxPriv(requestToken);
    const epk = unhex(box.epk);
    const key = await crypto.subtle.importKey(
      'raw',
      boxKey(x25519.getSharedSecret(priv, epk), epk, x25519.getPublicKey(priv)),
      'AES-GCM',
      false,
      ['decrypt'],
    );
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unhex(box.iv), additionalData: utf8(`${BOX_VERSION}|${requestHandle}`) },
      key,
      unhex(box.ct),
    );
    const token = fromUtf8(new Uint8Array(plain));
    return /^[0-9a-f]{32}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/** A deal token from whatever the server gives: the encrypted box, or (older server) a plain `/d#…` link. */
export async function dealTokenFrom(requestToken: string, requestHandle: string, v: Pick<RequestView, 'deal_link' | 'deal_link_box'>): Promise<string | null> {
  if (v.deal_link_box) return openDealLink(requestToken, requestHandle, v.deal_link_box);
  if (v.deal_link) {
    const m = /#([0-9a-f]{32})$/.exec(v.deal_link.trim());
    return m ? m[1] : null;
  }
  return null;
}

// ---------------------------------------------------------------- what the client's browser checks

/**
 * The result of checking a request against the creator's profile key that
 * this browser pinned when it sent the request:
 * - `key`: "same" (the key now is the pinned one), "changed" (it is not:
 *   big warning, no "open the deal"), "unpinned" (no pin here: an old request;
 *   the key is only compared with the profile id);
 * - `nickname`: the nickname from the profile write the pinned key signed,
 *   null when there is none to check;
 * - `deal`: for "deal ready": "ok" (the profile key signed this request + the
 *   deal's creator key), "bad" (it did not: warning, no "open the deal"),
 *   "none" (no deal yet). `creatorPk` = the deal key the signature covers;
 *   the deal page shows the creator only for a deal with exactly this key.
 */
export interface RequestCheck {
  key: 'same' | 'changed' | 'unpinned';
  nickname: string | null;
  deal: 'ok' | 'bad' | 'none';
  creatorPk: string | null;
}

export function checkRequest(contractId: string, handle: string, v: RequestView, pin: { pk?: string | null; fp?: string | null }): RequestCheck {
  const now = v.profile.profile_pk ?? null;
  let key: RequestCheck['key'];
  let pk: string | null;
  if (pin.pk) {
    key = now === pin.pk ? 'same' : 'changed';
    pk = pin.pk;
  } else if (pin.fp) {
    key = now !== null && safeFp(now) === pin.fp ? 'same' : 'changed';
    pk = key === 'same' ? now : null;
  } else {
    // Older request without a pin: at least the key must be the one the profile id was made from.
    key = 'unpinned';
    pk = now !== null && safeFp(now) === v.profile.profile_id ? now : null;
  }
  let nickname: string | null = null;
  const pp = v.profile_proof;
  if (pk && pp && typeof pp.profile?.nickname === 'string' && verify(pk, profileWriteMessage(contractId, v.profile.profile_id, pp.profile, pp.expires_at_ns), pp.sig)) {
    nickname = pp.profile.nickname;
  }
  let deal: RequestCheck['deal'] = 'none';
  let creatorPk: string | null = null;
  if (v.status === 'deal_ready') {
    const dp = v.deal_proof;
    const good = !!pk && !!dp && parsePublicKey(dp.creator_pk) !== null && verify(pk, requestDealMessage(contractId, handle, dp.creator_pk, dp.expires_at_ns), dp.sig);
    deal = good ? 'ok' : 'bad';
    creatorPk = good ? dp!.creator_pk : null;
  }
  return { key, nickname, deal, creatorPk };
}

const safeFp = (pk: string): string | null => {
  try {
    return keyFingerprint(pk);
  } catch {
    return null;
  }
};

/**
 * What the deal page may show about the creator: written only by the
 * request page after the checks above passed; the deal page shows it only
 * when the deal's creator key is the one that was checked.
 */
export interface CheckedCreator {
  profileId: string;
  nickname: string;
  creatorPk: string;
}

const CHECKED_PREFIX = 'kept.dealCreator.';

export function rememberCheckedCreator(dealHandle: string, c: CheckedCreator, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(CHECKED_PREFIX + dealHandle, JSON.stringify(c));
  } catch {
    /* blocked storage: the deal page shows the creator code only */
  }
}

/** The checked creator of this deal, or null (unknown, or the deal's creator key is another one). */
export function checkedCreator(dealHandle: string, creatorPk: string, storage: Storage | null = safeStorage()): CheckedCreator | null {
  try {
    const raw = storage?.getItem(CHECKED_PREFIX + dealHandle);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<CheckedCreator>;
    if (typeof c.nickname !== 'string' || typeof c.profileId !== 'string' || !isProfileId(c.profileId) || c.creatorPk !== creatorPk) return null;
    return { profileId: c.profileId, nickname: c.nickname, creatorPk: c.creatorPk };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- requests this browser sent

export interface LocalRequest {
  token: string;
  handle: string;
  profileId: string;
  nickname: string;
  service: string | null;
  createdAt: number;
  /** The creator's profile key when the request was sent (pinned). Missing on older entries. */
  profilePk?: string;
}

/** This browser's own record of a request, if it sent it. */
export function localRequest(handle: string, storage: Storage | null = safeStorage()): LocalRequest | null {
  try {
    const raw = storage?.getItem(REQ_PREFIX + handle);
    return raw ? (JSON.parse(raw) as LocalRequest) : null;
  } catch {
    return null;
  }
}

const REQ_PREFIX = 'kept.request.';

export function rememberRequest(r: LocalRequest, storage: Storage | null = safeStorage()): void {
  try {
    storage?.setItem(REQ_PREFIX + r.handle, JSON.stringify(r));
  } catch {
    /* blocked storage: the link itself is still shown */
  }
}

export function myRequests(storage: Storage | null = safeStorage()): LocalRequest[] {
  const out: LocalRequest[] = [];
  try {
    if (!storage) return out;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k?.startsWith(REQ_PREFIX)) continue;
      try {
        out.push(JSON.parse(storage.getItem(k)!) as LocalRequest);
      } catch {
        /* skip a broken entry */
      }
    }
  } catch {
    /* blocked storage */
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The request link. With the creator's key fingerprint after a dot
 * (`/r#<token>.<fp>`), so another device checks the same key.
 */
export const requestLink = (origin: string, token: string, fp?: string | null): string => `${origin}/r#${token}${fp ? `.${fp}` : ''}`;

const REQUEST_LINK_RE = /^([0-9a-f]{32})(?:\.([0-9a-f]{24}))?$/;

export function parseRequestLink(hash: string): string | null {
  const m = REQUEST_LINK_RE.exec(hash.replace(/^#/, '').trim());
  return m ? m[1] : null;
}

/** The pinned key fingerprint in a request link, or null (older links have none). */
export function parseRequestPin(hash: string): string | null {
  const m = REQUEST_LINK_RE.exec(hash.replace(/^#/, '').trim());
  return m?.[2] ?? null;
}

// ---------------------------------------------------------------- checks of what people type

export type FieldProblem =
  | 'nickname'
  | 'bio'
  | 'categories'
  | 'portfolio'
  | 'contacts'
  | 'services';

export const isHttpsLink = (s: string): boolean => {
  if (s.length > LIMITS.link) return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === 'https:' && u.hostname.includes('.');
  } catch {
    return false;
  }
};

const intIn = (n: number, [min, max]: readonly [number, number]) => Number.isInteger(n) && n >= min && n <= max;

export function serviceProblems(s: Service): ('title' | 'description' | 'price' | 'days')[] {
  const p: ('title' | 'description' | 'price' | 'days')[] = [];
  if (!s.title.trim() || s.title.length > LIMITS.serviceTitle) p.push('title');
  if (s.description.length > LIMITS.serviceDescription) p.push('description');
  if (!intIn(s.price_from_usdc, LIMITS.price)) p.push('price');
  if (!intIn(s.delivery_days, LIMITS.days)) p.push('days');
  return p;
}

export function profileProblems(f: ProfileFields): Set<FieldProblem> {
  const p = new Set<FieldProblem>();
  const n = f.nickname.trim().length;
  if (n < LIMITS.nickname[0] || n > LIMITS.nickname[1]) p.add('nickname');
  if (f.bio.length > LIMITS.bio) p.add('bio');
  if (f.categories.length < LIMITS.categories[0] || f.categories.length > LIMITS.categories[1]) p.add('categories');
  if (f.portfolio.length > LIMITS.portfolio || f.portfolio.some((l) => !isHttpsLink(l))) p.add('portfolio');
  if (f.contacts.length > LIMITS.contacts || f.contacts.some((c) => !c.value.trim() || c.value.length > LIMITS.contact)) p.add('contacts');
  if (f.services.length > LIMITS.services || f.services.some((s) => serviceProblems(s).length > 0)) p.add('services');
  return p;
}

/** The profile as it is sent: trimmed, empty rows dropped. */
export function cleanProfile(f: ProfileFields): ProfileFields {
  return {
    nickname: f.nickname.trim(),
    bio: f.bio.trim(),
    categories: f.categories,
    portfolio: f.portfolio.map((l) => l.trim()).filter(Boolean),
    contacts: f.contacts.map((c) => ({ kind: c.kind, value: c.value.trim() })).filter((c) => c.value),
    services: f.services.map((s) => ({
      ...(s.id ? { id: s.id } : {}),
      title: s.title.trim(),
      description: s.description.trim(),
      price_from_usdc: s.price_from_usdc,
      delivery_days: s.delivery_days,
    })),
  };
}

// ---------------------------------------------------------------- identicon

/**
 * A 7 × 7 pixel picture from a profile id, mirrored left to right (5 drawn
 * columns inside a 1-cell margin). '#' = ink, '*' = accent. Same id → same picture.
 */
export function identicon(profileId: string): string[] {
  const bytes = sha256(utf8(`pinky-identicon|${profileId}`));
  const rows: string[] = [];
  for (let y = 0; y < 5; y++) {
    const half: string[] = [];
    for (let x = 0; x < 3; x++) {
      const b = bytes[y * 3 + x];
      half.push(b % 3 === 0 ? '.' : b % 5 === 0 ? '*' : b % 2 === 0 ? '#' : '.');
    }
    const row = [...half, half[1], half[0]].join('');
    rows.push(`.${row}.`);
  }
  // never an empty picture
  if (!rows.some((r) => /[#*]/.test(r))) rows[2] = '..#*#..';
  return ['.......', ...rows, '.......'];
}
