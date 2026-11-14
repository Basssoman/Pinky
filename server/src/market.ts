// Marketplace routes.
// Everything here is off-chain and never touches money: creator profiles with
// services (catalog), client requests (request link /r#token), the creator's
// signed inbox, "deal from request" and reviews that cannot be faked.
//
// Keys:
// - The PROFILE key (ed25519, made in the creator's browser) signs every
//   profile write, the inbox read, a decline and the request -> deal link.
//   It is never a deal key and never goes on-chain.
// - A review is signed by the deal's CLIENT key, read from the contract.
// Every signed message carries `expires_at_ns` (<= now + 10 min)
// and is single use (replay cache in the DB).
//
// Privacy: public output (catalog, profile, reviews) has no amounts,
// deal ids, wallets, keys or dates finer than a month. The client contact
// leaves the server only in the creator's signed inbox.

import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { Chain, DealView } from './chain.ts';
import type { Config } from './config.ts';
import { canonicalJson, isCanonicalSignature, isU64, MESSAGE_PREFIX, parseOffer, parsePublicKey, sha256Hex, verifySignature } from './encoding.ts';
import { HttpError } from './errors.ts';
import { DailyCounter, ipKey, ipPrefix, type RateLimiter } from './guards.ts';
import {
  MarketStore,
  type ContactV,
  type LinkBox,
  type LinkFacts,
  type LinkRow,
  type ProfileIn,
  type ProfileRow,
  type RequestRow,
  type ReviewOutcome,
  type ReviewRow,
  type ServiceIn,
  type KeyResetRow,
  UNANSWERED,
} from './market-store.ts';
import type { Store } from './store.ts';
import { AVATAR, AvatarError, bytesSha256Hex, reencodeAvatar, sniffImage } from './market-avatar.ts';
import { AUTO_PLATFORMS, parseAccountUrl, processChecker, verifyCode, type AccountChecker } from './accounts.ts';
import type { AccountRow } from './market-store.ts';

export const CATEGORIES = ['video', 'motion', 'design', 'editing', 'code', 'other'] as const;
export const CONTACT_KINDS = ['telegram', 'x', 'discord', 'whatsapp', 'email', 'other'] as const;

/** Limits in characters (Unicode code points), same as the web editor. */
export const MARKET_LIMITS = {
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
  query: 64,
  declineReason: 300,
} as const;

const DAY_MS = 24 * 3600 * 1000;
/** A request without an answer (sent / viewed) closes after 7 days. */
export const REQUEST_AUTO_CLOSE_MS = 7 * DAY_MS;
/** A key replaced by support takes effect after 72 h; meanwhile the current key can cancel it. */
export const KEY_RESET_DELAY_MS = 72 * 3600 * 1000;
/** "contact or profile key changed N days ago" is shown for 14 days. */
const RECENT_CHANGE_MS = 14 * DAY_MS;
/** A "nobody acted" deal: the review window starts at the client's first open, at most this long after the end. */
export const IDLE_OPEN_MAX_MS = 30 * DAY_MS;
/** Outcomes where nobody acted: the review timer released the money, or the delivery deadline passed. */
const IDLE_OUTCOMES = ['AutoReleased', 'RefundedAfterDeadline'];
const RESET_LOG_LIMIT = 100;
/** Accounts with a verification code per profile. */
export const MAX_ACCOUNTS = 3;
/**
 * A reset code in the bio of a CONFIRMED account beats the current
 * key only when the account was confirmed this long before the reset: a thief
 * holding the key could add and confirm an account of their own, and it
 * shows on the public profile for 14 days before it could be used.
 */
export const VERIFIED_PROOF_MIN_AGE_MS = 14 * DAY_MS;
const ACCOUNT_CHECKS_PER_MIN = 3;
const DAILY_ACCOUNT_CHECKS_PER_PROFILE = 30;

const SEC_NS = 1_000_000_000n;
/** A signed message may expire at most this far ahead (API.md: 10 min, + 30 s clock skew). */
const MAX_EXPIRY_AHEAD_NS = 10n * 60n * SEC_NS + 30n * SEC_NS;
const PAGE = 24;
const INBOX_LIMIT = 200;
const PROFILE_REVIEWS = 50;
/** Deals that may be made from one request in all (only one of them live at a time). */
const MAX_DEALS_PER_REQUEST = 5;
const HANDLE_RE = /^[0-9a-f]{64}$/;
const PROFILE_ID_RE = /^[0-9a-f]{24}$/;
const SERVICE_ID_RE = /^[0-9a-f]{8}$/;
const REVIEW_ID_RE = /^[0-9a-f]{16}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const FINAL_PAID = ['Released', 'Refunded', 'PaidOut'];
const FINAL_UNPAID = ['Cancelled', 'Expired'];
/** A linked deal not yet final is re-read from the chain at most this often on page views. */
const LINK_RECHECK_MS = 30_000;

// Rate limits (per minute unless noted).
const PROFILE_WRITES_PER_MIN = 10;
const INBOX_READS_PER_MIN = 30;
const REVIEW_WRITES_PER_MIN = 10;
const DAILY_NEW_PROFILES_PER_PREFIX = 20;
const DAILY_REQUESTS_PER_PREFIX = 20;
const DAILY_REQUESTS_PER_PROFILE = 50;
const DAILY_REQUESTS_PER_PAIR = 5;
const AVATAR_WRITES_PER_MIN = 5;
const DAILY_AVATARS_PER_PROFILE = 30;
/** Picture reads per IP: a catalog page shows up to 24 at once (the browser caches them for a year). */
const AVATAR_READS_PER_MIN = 600;
const AVATAR_VERSION_RE = /^[0-9a-f]{16}$/;
/** base64 of AVATAR.maxBytes, padded. */
const AVATAR_B64_MAX = Math.ceil(AVATAR.maxBytes / 3) * 4;
const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// ---------------------------------------------------------------- signed messages

export const profileIdOf = (raw: Uint8Array): string => createHash('sha256').update(raw).digest('hex').slice(0, 24);

/** Every profile write (PUT; DELETE signs the body `{"delete":true}`). */
export const profileWriteMessage = (contractId: string, profileId: string, body: unknown, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile|${profileId}|${sha256Hex(canonicalJson(body))}|${exp}`;
/**
 * Upload of the profile picture: signs sha256 of the exact file
 * bytes (hex); removal signs the word "remove" in its place.
 */
export const avatarMessage = (contractId: string, profileId: string, imageSha256OrRemove: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-avatar|${profileId}|${imageSha256OrRemove}|${exp}`;
export const inboxMessage = (contractId: string, profileId: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-inbox|${profileId}|${exp}`;
export const declineMessage = (contractId: string, handle: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-decline|${handle}|${exp}`;
/** A decline with a reason also signs sha256 of the reason, exactly as sent. */
export const declineReasonMessage = (contractId: string, handle: string, reason: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-decline|${handle}|${sha256Hex(reason)}|${exp}`;
/** The creator marks a request "in discussion". */
export const discussMessage = (contractId: string, handle: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-discuss|${handle}|${exp}`;
/** The current profile key cancels a key reset in progress. */
export const keyResetCancelMessage = (contractId: string, profileId: string, resetId: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-key-reset-cancel|${profileId}|${resetId}|${exp}`;
/** Add an account to the profile; signs sha256 of the link exactly as sent. */
export const accountAddMessage = (contractId: string, profileId: string, url: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-account-add|${profileId}|${sha256Hex(url)}|${exp}`;
/** The owner reads the accounts with their codes. */
export const accountsReadMessage = (contractId: string, profileId: string, exp: string) => `${MESSAGE_PREFIX}|${contractId}|profile-accounts|${profileId}|${exp}`;
/** "Check now": the site reads the account's bio. */
export const accountCheckMessage = (contractId: string, profileId: string, accountId: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-account-check|${profileId}|${accountId}|${exp}`;
export const accountRemoveMessage = (contractId: string, profileId: string, accountId: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-account-remove|${profileId}|${accountId}|${exp}`;
export const requestDealMessage = (contractId: string, handle: string, creatorPk: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|request-deal|${handle}|${creatorPk}|${exp}`;
/** The client opened a deal that ended by itself (signed by the deal's client key; starts the review window). */
export const reviewOpenMessage = (contractId: string, dealId: number, exp: string) => `${MESSAGE_PREFIX}|${contractId}|review-open|${dealId}|${exp}`;
/** Signed by the deal's client key. `expires_at_ns` was added to the API.md message (Changes, 11-12). */
export const reviewMessage = (contractId: string, dealId: number, profileId: string, rating: number, text: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|review|${dealId}|${profileId}|${rating}|${sha256Hex(text)}|${exp}`;
/** The creator's one public answer to a review, signed by the profile key. */
export const reviewReplyMessage = (contractId: string, profileId: string, reviewId: string, text: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|review-reply|${profileId}|${reviewId}|${sha256Hex(text)}|${exp}`;

// ---------------------------------------------------------------- text checks

type Body = Record<string, unknown>;

const chars = (s: string) => [...s].length;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Control chars; bidi overrides (could flip how a nickname reads). */
const BAD_LINE = /[\u0000-\u001F\u007F‪-‮⁦-⁩]/;
const BAD_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;

const bad = (message: string, code = 'bad_request') => new HttpError(400, code, message);

function isObj(v: unknown): v is Body {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function onlyKeys(o: Body, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad(`${where}.${k} is not a known field`, 'bad_profile');
}

/** A text field: string, `min..max` characters, no control characters (multi-line allows \n \r \t). */
function text(v: unknown, where: string, max: number, opts: { min?: number; multiline?: boolean; code?: string } = {}): string {
  const code = opts.code ?? 'bad_request';
  if (typeof v !== 'string') throw bad(`${where} must be a string`, code);
  const s = v.trim();
  const n = chars(s);
  const min = opts.min ?? 0;
  if (n < min || n > max) throw bad(min > 0 ? `${where} must be ${min}-${max} characters` : `${where} is too long (max ${max} characters)`, code);
  if (LONE_SURROGATE.test(s) || (opts.multiline ? BAD_TEXT : BAD_LINE).test(s)) throw bad(`${where} has characters that are not allowed`, code);
  return s;
}

function int(v: unknown, where: string, [min, max]: readonly [number, number], code = 'bad_profile'): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad(`${where} must be a whole number ${min}-${max}`, code);
  return v;
}

function contact(v: unknown, where: string, code: string): ContactV {
  if (!isObj(v)) throw bad(`${where} must be {kind, value}`, code);
  for (const k of Object.keys(v)) if (k !== 'kind' && k !== 'value') throw bad(`${where}.${k} is not a known field`, code);
  if (typeof v.kind !== 'string' || !(CONTACT_KINDS as readonly string[]).includes(v.kind)) {
    throw bad(`${where}.kind must be one of ${CONTACT_KINDS.join(', ')}`, code);
  }
  return { kind: v.kind, value: text(v.value, `${where}.value`, MARKET_LIMITS.contact, { min: 1, code }) };
}

/**
 * Portfolio links open from the site only for these hosts
 * (YouTube, Behance, X, Google Drive). Any other https link is kept but
 * shown as plain text with its domain, so a look-alike site cannot be one
 * click away.
 */
export const KNOWN_LINK_HOSTS: readonly string[] = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'behance.net',
  'www.behance.net',
  'x.com',
  'www.x.com',
  'mobile.x.com',
  'twitter.com',
  'www.twitter.com',
  'mobile.twitter.com',
  'drive.google.com',
];

/** An https link to one of the known hosts (exact host, default port, no user name). */
export function isKnownLink(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.port && !u.username && !u.password && KNOWN_LINK_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

function httpsLink(v: unknown, where: string): string {
  const s = text(v, where, MARKET_LIMITS.link, { min: 1, code: 'bad_profile' });
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad(`${where} must be an https link`, 'bad_profile');
  }
  if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) throw bad(`${where} must be an https link`, 'bad_profile');
  return s;
}

/** The profile as the editor sends it. Strict: unknown fields are refused (they would be signed but ignored). */
export function parseProfile(raw: unknown, existingServiceIds: ReadonlySet<string>): ProfileIn {
  if (!isObj(raw)) throw bad('profile must be an object', 'bad_profile');
  onlyKeys(raw, ['nickname', 'bio', 'categories', 'portfolio', 'contacts', 'services'], 'profile');
  const L = MARKET_LIMITS;
  const nickname = text(raw.nickname, 'profile.nickname', L.nickname[1], { min: L.nickname[0], code: 'bad_profile' });
  const bio = raw.bio === undefined ? '' : text(raw.bio, 'profile.bio', L.bio, { multiline: true, code: 'bad_profile' });

  const cats = raw.categories;
  if (!Array.isArray(cats) || cats.length < L.categories[0] || cats.length > L.categories[1]) {
    throw bad(`profile.categories must list ${L.categories[0]}-${L.categories[1]} of ${CATEGORIES.join(', ')}`, 'bad_profile');
  }
  for (const c of cats) if (typeof c !== 'string' || !(CATEGORIES as readonly string[]).includes(c)) throw bad(`profile.categories: unknown "${String(c)}"`, 'bad_profile');
  if (new Set(cats).size !== cats.length) throw bad('profile.categories has a repeat', 'bad_profile');

  const list = (v: unknown, where: string, max: number): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > max) throw bad(`${where} must be a list of at most ${max}`, 'bad_profile');
    return v;
  };
  const portfolio = list(raw.portfolio, 'profile.portfolio', L.portfolio).map((v, i) => httpsLink(v, `profile.portfolio[${i}]`));
  const contacts = list(raw.contacts, 'profile.contacts', L.contacts).map((v, i) => contact(v, `profile.contacts[${i}]`, 'bad_profile'));

  const seen = new Set<string>();
  const services = list(raw.services, 'profile.services', L.services).map((v, i): ServiceIn => {
    const w = `profile.services[${i}]`;
    if (!isObj(v)) throw bad(`${w} must be an object`, 'bad_profile');
    onlyKeys(v, ['id', 'title', 'description', 'price_from_usdc', 'delivery_days'], w);
    let id: string | undefined;
    if (v.id !== undefined && v.id !== null && v.id !== '') {
      if (typeof v.id !== 'string' || !SERVICE_ID_RE.test(v.id) || !existingServiceIds.has(v.id)) {
        throw bad(`${w}.id is not a service of this profile (leave it out for a new service)`, 'bad_profile');
      }
      if (seen.has(v.id)) throw bad(`${w}.id is repeated`, 'bad_profile');
      seen.add(v.id);
      id = v.id;
    }
    return {
      ...(id ? { id } : {}),
      title: text(v.title, `${w}.title`, L.serviceTitle, { min: 1, code: 'bad_profile' }),
      description: v.description === undefined ? '' : text(v.description, `${w}.description`, L.serviceDescription, { multiline: true, code: 'bad_profile' }),
      price_from_usdc: int(v.price_from_usdc, `${w}.price_from_usdc`, L.price),
      delivery_days: int(v.delivery_days, `${w}.delivery_days`, L.days),
    };
  });
  return { nickname, bio, categories: cats as string[], portfolio, contacts, services };
}

function parseBox(v: unknown): LinkBox | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw bad('deal_link_box must be {epk, iv, ct} (hex)', 'bad_box');
  const { epk, iv, ct } = v;
  if (typeof epk !== 'string' || !HEX64_RE.test(epk)) throw bad('deal_link_box.epk must be 64 hex chars', 'bad_box');
  if (typeof iv !== 'string' || !/^[0-9a-f]{24}$/.test(iv)) throw bad('deal_link_box.iv must be 24 hex chars', 'bad_box');
  // The deal token (32 chars) + the 16-byte GCM tag = 96 hex; some room for a longer link later.
  if (typeof ct !== 'string' || !/^(?:[0-9a-f]{2}){17,256}$/.test(ct)) throw bad('deal_link_box.ct must be hex (17-256 bytes)', 'bad_box');
  return { epk, iv, ct };
}

/**
 * Which lines of the brief the AI helper wrote, as the client’s
 * browser marks them: 0-based line numbers (the brief as stored, split on
 * a line break), rising, each a line with text. Missing or empty = none.
 */
export function parseAiLines(v: unknown, brief: string): number[] {
  if (v === undefined || v === null) return [];
  const lines = brief.split('\n');
  if (!Array.isArray(v) || v.length > lines.length) throw bad('ai_lines must be a list of line numbers of the brief', 'bad_ai_lines');
  let last = -1;
  for (const n of v) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n <= last || n >= lines.length || !lines[n].trim()) {
      throw bad('ai_lines must be rising numbers of brief lines that have text (0-based)', 'bad_ai_lines');
    }
    last = n;
  }
  return v as number[];
}

/** "YYYY-MM-DD", a real date, from yesterday (time zones) to a year ahead. */
function parseDeadline(v: unknown, nowMs: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('wanted_deadline must be a date "YYYY-MM-DD"');
  const t = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) throw bad('wanted_deadline must be a real date');
  const day = 24 * 3600 * 1000;
  if (t < nowMs - 2 * day || t > nowMs + 366 * day) throw bad('wanted_deadline must be from today to a year ahead');
  return v;
}

const endedMs = (deal: DealView): number | null => {
  const e = deal.ended_at_ns;
  return e && /^\d+$/.test(e) && e !== '0' ? Number(BigInt(e) / 1_000_000n) : null;
};

/**
 * The outcome label of a review: "dispute" when a dispute was
 * opened (arbiter / timeout split, or an agreed split after a dispute),
 * else "paid" when the creator got money, else "refunded" ("money
 * went back to the client").
 */
export function reviewOutcome(deal: DealView, creatorGot: bigint): ReviewOutcome {
  const o = deal.outcome;
  const split = !!o && typeof o === 'object' && ('ArbiterSplit' in o || 'TimeoutSplit' in o);
  if (split || deal.disputed_at_ns) return 'dispute';
  return creatorGot > 0n ? 'paid' : 'refunded';
}

/** What a linked deal's on-chain state means for reviews and the counter. */
export function linkFacts(deal: DealView): LinkFacts | null {
  if (deal.purged) return { final: true, reviewable: false, counted: false, ended_ms: endedMs(deal) };
  const amount = BigInt(deal.amount || '0');
  const paid = amount > 0n && BigInt(deal.funded_amount || '0') >= amount;
  if (FINAL_PAID.includes(deal.state)) {
    if (!paid) return { final: true, reviewable: false, counted: false, ended_ms: endedMs(deal) };
    const creatorGot = BigInt(deal.creator_payout) + BigInt(deal.creator_pending) + BigInt(deal.creator_withdrawn);
    const o = deal.outcome;
    const idle = typeof o === 'string' && IDLE_OUTCOMES.includes(o);
    return { final: true, reviewable: true, counted: creatorGot > 0n, ended_ms: endedMs(deal), outcome: reviewOutcome(deal, creatorGot), idle };
  }
  if (FINAL_UNPAID.includes(deal.state)) return { final: true, reviewable: false, counted: false, ended_ms: endedMs(deal) };
  return null;
}

/**
 * When the review window ends (ms), null while the deal has not ended.
 * For a deal that ended by itself the window starts at the client's
 * first open after the end, at most 30 days after the end; until that open the
 * end of the window is the latest it can be.
 */
export function reviewUntilMs(l: { ended_ms: number | null; idle_end?: boolean; opened_ms?: number | null }, windowMs: number): number | null {
  if (l.ended_ms === null) return null;
  if (!l.idle_end) return l.ended_ms + windowMs;
  const latest = l.ended_ms + IDLE_OPEN_MAX_MS;
  const start = l.opened_ms === null || l.opened_ms === undefined ? latest : Math.min(Math.max(l.opened_ms, l.ended_ms), latest);
  return start + windowMs;
}

/**
 * The confirmed account of this profile at `accountUrl`, if it was
 * confirmed at least 14 days before `atMs` and is still confirmed; else null.
 */
export function verifiedProof(ms: MarketStore, profileId: string, accountUrl: string, atMs: number): AccountRow | null {
  const ref = parseAccountUrl(accountUrl);
  const a = ref ? ms.accountByUrl(profileId, ref.url) : null;
  if (!a || a.status !== 'confirmed' || !a.confirmed_at) return null;
  return atMs - Date.parse(a.confirmed_at) >= VERIFIED_PROOF_MIN_AGE_MS ? a : null;
}

// ---------------------------------------------------------------- routes

export interface MarketDeps {
  config: Config;
  chain: Chain;
  store: Store;
  now: () => number;
  /** The app's per-minute limiter (shared buckets). */
  limiter: RateLimiter;
  /** Reads account bios; default: a separate process per check. */
  accountChecker?: AccountChecker;
}

export interface Market {
  store: MarketStore;
  /**
   * POST /api/deals with `request_handle`: checks the request and the
   * profile-key signature BEFORE the deal is stored. Returns null when the
   * body has no request, else a function that links the stored deal.
   */
  prepareDealLink(body: Body, creatorPk: string): ((dealHandle: string) => void) | null;
  /** Re-reads not yet final linked deals from the chain (counters). */
  refreshLinks(limit?: number): Promise<number>;
  /**
   * For the bot reminder "leave a review, 2 days left": null when
   * the deal is not from a request or not reviewable; else when the window
   * ends (ms) and whether the client already wrote a review.
   */
  reviewWindow(dealHandle: string): { until_ms: number; open: boolean; reviewed: boolean } | null;
  /** Closes requests without an answer for 7 days and applies key resets whose 72 h passed. */
  upkeep(): void;
  /** Re-reads the bios of confirmed accounts not read for ACCOUNT_RECHECK_HOURS; returns how many. */
  recheckAccounts(limit?: number): Promise<number>;
}

export function registerMarket(app: FastifyInstance, deps: MarketDeps): Market {
  const { config, chain, store, now, limiter } = deps;
  const checker = deps.accountChecker ?? processChecker();
  const db = (store as { db?: DatabaseSync }).db ?? new DatabaseSync(':memory:');
  const ms = new MarketStore(db, now);
  // Profile-scoped daily caps survive a restart; IP ones stay in memory (no IPs on disk).
  const daily = new DailyCounter(now, store, (k) => k.startsWith('mreqp:'));
  const nowNs = () => BigInt(now()) * 1_000_000n;
  const cid = chain.contractId;

  function perMin(key: string, limit: number, message = 'too many requests; wait a minute'): void {
    if (!limiter.take(key, limit)) throw new HttpError(429, 'rate_limited', message);
  }
  /** A per-owner bucket, taken only AFTER the owner's signature checked out. */
  const ownerLimit = (key: string, limit: number, message: string) => perMin(key, limit, message);
  const readLimit = (req: FastifyRequest) => perMin(`mread:${ipKey(req.ip)}`, config.rateReadsPerMin);
  const writeLimit = (req: FastifyRequest) => perMin(`mwrite:${ipKey(req.ip)}`, config.rateWritesPerMin);
  function dailyCap(key: string, limit: number, message: string): void {
    if (daily.count(key) >= limit) throw new HttpError(429, 'daily_cap', message);
  }

  /** `expires_at_ns`: in the future, at most 10 minutes ahead. */
  function expiry(v: unknown, field = 'expires_at_ns'): string {
    if (!isU64(v)) throw bad(`${field} must be a canonical integer string (ns)`, 'bad_expiry');
    const e = BigInt(v);
    const n = nowNs();
    if (e <= n) throw new HttpError(401, 'signature_expired', `${field} has passed; sign again`);
    if (e > n + MAX_EXPIRY_AHEAD_NS) throw new HttpError(401, 'expiry_too_far', `${field} must be at most 10 minutes ahead`);
    return v;
  }

  function sigOf(v: unknown, field = 'sig'): string {
    if (!isCanonicalSignature(v)) throw bad(`${field} must be canonical base64 of 64 bytes`, 'bad_signature_encoding');
    return v;
  }

  /** Verifies, then marks the signature used (single use until it expires). */
  function checkSigned(pk: string, message: string, sig: string, exp: string): void {
    if (!verifySignature(pk, message, sig)) throw new HttpError(401, 'invalid_signature', 'the signature does not match');
    if (!ms.useSignature(sig, Number(BigInt(exp) / 1_000_000n) + 60_000)) {
      throw new HttpError(401, 'replayed_request', 'this signed request was already used; sign again');
    }
  }

  function profileParam(req: FastifyRequest): string {
    const id = (req.params as { id?: string }).id ?? '';
    if (!PROFILE_ID_RE.test(id)) throw new HttpError(404, 'profile_not_found', 'profile not found');
    return id;
  }

  const visible = (p: ProfileRow | null): p is ProfileRow => !!p && !p.hidden && !p.self_hidden;

  /** Time-driven changes, done lazily on reads (and by the refresh timer). */
  function upkeep(): void {
    ms.closeStale(new Date(now() - REQUEST_AUTO_CLOSE_MS).toISOString());
    ms.applyDueResets();
  }

  /**
   * "contact or profile key changed N days ago", for 14 days after
   * the newest change. Whole days only (public output has no exact dates).
   */
  function recentChange(p: ProfileRow): { what: 'key' | 'contact'; days_ago: number } | null {
    const cands = [
      { what: 'key' as const, at: p.key_changed_at },
      { what: 'contact' as const, at: p.contacts_changed_at },
    ].filter((c): c is { what: 'key' | 'contact'; at: string } => !!c.at && now() - Date.parse(c.at) < RECENT_CHANGE_MS);
    cands.sort((a, b) => b.at.localeCompare(a.at));
    const c = cands[0];
    return c ? { what: c.what, days_ago: Math.floor((now() - Date.parse(c.at)) / DAY_MS) } : null;
  }

  /**
   * "the key of this profile is being changed" until the time it takes effect.
   * `cancellable` false = proved through a confirmed account: only support can stop it.
   */
  function keyChange(profileId: string): { reset_id: string; effective_at: string; cancellable: boolean } | null {
    const r = ms.openReset(profileId);
    return r && r.status === 'pending' && r.effective_at ? { reset_id: r.reset_id, effective_at: r.effective_at, cancellable: r.proof !== 'verified' } : null;
  }

  /** "account confirmed: @handle" (control of the account, not authorship of every work). */
  const publicAccounts = (profileId: string) =>
    ms
      .accountsOf(profileId)
      .filter((a) => a.status === 'confirmed')
      .map((a) => ({ platform: a.platform, handle: a.handle, url: a.url }));

  /** What the owner sees: the code to put in the bio and where it stands. How the mark was made stays in the log. */
  const ownerAccount = (a: AccountRow) => ({
    account_id: a.account_id,
    platform: a.platform,
    url: a.url,
    handle: a.handle,
    code: a.code,
    status: a.status,
    // The site cannot read this account's bio itself (X): a person of the team looks.
    by_hand: !AUTO_PLATFORMS.includes(a.platform as (typeof AUTO_PLATFORMS)[number]),
  });

  /** The client's browser checks this against the profile key it pinned. */
  function profileProof(p: ProfileRow) {
    return p.signed ? { profile: JSON.parse(p.signed.profile) as unknown, expires_at_ns: p.signed.expires_at_ns, sig: p.signed.sig } : null;
  }

  function card(p: ProfileRow) {
    return {
      profile_id: p.profile_id,
      nickname: p.nickname,
      categories: p.categories,
      price_from_usdc: p.min_price,
      finished_deals: p.finished_deals,
      rating_avg: p.rating_avg,
      reviews_count: p.reviews_count,
      // "On Pinky since <month>".
      since_month: p.created_at.slice(0, 7),
      avatar: p.avatar,
    };
  }

  /** A review as everyone sees it: month only, never a deal, an amount or a day. */
  const publicReview = (r: ReviewRow) => ({
    review_id: r.review_id,
    rating: r.rating,
    text: r.text,
    month: r.created_at.slice(0, 7),
    refunded: r.refunded,
    outcome: r.outcome,
    reply: r.reply_text === null ? null : { text: r.reply_text, month: (r.reply_at ?? r.created_at).slice(0, 7) },
  });

  function profileView(p: ProfileRow) {
    return {
      profile_id: p.profile_id,
      nickname: p.nickname,
      bio: p.bio,
      categories: p.categories,
      portfolio: p.portfolio,
      // Per portfolio link, true = a known host (the site may make it clickable); others are shown as text.
      portfolio_known: p.portfolio.map(isKnownLink),
      contacts: p.contacts,
      services: ms.getServices(p.profile_id),
      finished_deals: p.finished_deals,
      rating_avg: p.rating_avg,
      reviews_count: p.reviews_count,
      reviews: ms.reviewsOf(p.profile_id, PROFILE_REVIEWS).map(publicReview),
      updated_month: p.updated_at.slice(0, 7),
      since_month: p.created_at.slice(0, 7),
      // The picture's version: GET /api/profiles/<id>/avatar/<version>; null = the pixel pattern.
      avatar: p.avatar,
      recent_change: recentChange(p),
      // "the key of this profile is being changed" (the time and the id only in the owner's signed inbox).
      key_changing: keyChange(p.profile_id) !== null,
      // Confirmed accounts (the code is in their bio).
      accounts: publicAccounts(p.profile_id),
    };
  }

  // ------------------------------------------------------------ profiles

  app.get('/api/profiles', async (req) => {
    readLimit(req);
    const q = (req.query ?? {}) as Record<string, unknown>;
    const category = typeof q.category === 'string' ? q.category : '';
    if (category && !(CATEGORIES as readonly string[]).includes(category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
    const search = typeof q.q === 'string' ? q.q.trim() : '';
    if (chars(search) > MARKET_LIMITS.query) throw bad(`q is too long (max ${MARKET_LIMITS.query} characters)`);
    const cursor = typeof q.cursor === 'string' && q.cursor !== '' ? q.cursor : '0';
    if (!/^\d{1,6}$/.test(cursor)) throw bad('cursor must be the next_cursor of the previous page');
    const offset = Number(cursor);
    const rows = ms.catalog({ category: category || undefined, q: search || undefined, offset, limit: PAGE + 1 });
    return {
      items: rows.slice(0, PAGE).map(card),
      next_cursor: rows.length > PAGE ? String(offset + PAGE) : null,
    };
  });

  // Which profile this key controls (after a key reset the profile id is no longer the hash of the key).
  app.get('/api/profiles/by-key', async (req) => {
    readLimit(req);
    upkeep();
    const pk = ((req.query ?? {}) as Record<string, unknown>).pk;
    if (typeof pk !== 'string' || !parsePublicKey(pk)) throw bad('pk must be "ed25519:<base58 of 32 bytes>"', 'bad_key');
    const p = ms.profileByKey(pk);
    if (!p || p.hidden) {
      const pending = ms.resetForNewKey(pk);
      if (pending) return { profile_id: null, pending: { profile_id: pending.profile_id, status: pending.status, effective_at: pending.effective_at } };
      throw new HttpError(404, 'profile_not_found', 'no profile has this key');
    }
    return { profile_id: p.profile_id, pending: null };
  });

  // Public log of key resets by support: month, profile and what happened; never the code, the keys or the account.
  app.get('/api/key-resets', async (req) => {
    readLimit(req);
    upkeep();
    const q = (req.query ?? {}) as Record<string, unknown>;
    const pid = typeof q.profile_id === 'string' && PROFILE_ID_RE.test(q.profile_id) ? q.profile_id : undefined;
    return {
      items: ms
        .resets(RESET_LOG_LIMIT, pid)
        .filter((r) => r.status !== 'issued')
        .map((r: KeyResetRow) => {
          const p = ms.getProfile(r.profile_id);
          return {
            month: (r.confirmed_at ?? r.issued_at).slice(0, 7),
            profile_id: r.profile_id,
            nickname: visible(p) ? p.nickname : null,
            status: r.status === 'pending' ? 'pending' : r.status === 'applied' ? 'changed' : 'cancelled',
            effective_at: r.status === 'pending' ? r.effective_at : null,
          };
        }),
    };
  });

  app.get('/api/profiles/:id', async (req) => {
    readLimit(req);
    upkeep();
    const p = ms.getProfile(profileParam(req));
    if (!visible(p)) throw new HttpError(404, 'profile_not_found', 'profile not found');
    return profileView(p);
  });

  app.put('/api/profiles/:id', async (req, reply) => {
    writeLimit(req);
    const id = profileParam(req);
    const body = (req.body ?? {}) as Body;
    const pk = body.profile_pk;
    const raw = parsePublicKey(pk);
    if (!raw || typeof pk !== 'string') throw bad('profile_pk must be "ed25519:<base58 of 32 bytes>"', 'bad_key');
    upkeep();
    const existing = ms.getProfile(id);
    // A new profile: id = hash of its key. An existing one: its current key (support may have replaced it).
    if (!existing && profileIdOf(raw) !== id) throw bad('the profile id must be sha256(profile_pk) (first 12 bytes, hex)', 'id_mismatch');
    if (existing && existing.profile_pk !== pk) throw new HttpError(403, 'wrong_key', 'this profile belongs to another key');
    if (!existing && (ms.profileByKey(pk) || ms.resetForNewKey(pk))) {
      throw new HttpError(409, 'key_in_use', 'this key already belongs to a profile (or is replacing the key of one)');
    }
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    // Shape first (bounded), then the signature over exactly what was sent.
    const profile = parseProfile(body.profile, new Set(existing ? ms.getServices(id).map((s) => s.id) : []));
    const newKey = `mnewp:${ipPrefix(req.ip)}`;
    if (!existing) dailyCap(newKey, DAILY_NEW_PROFILES_PER_PREFIX, 'too many new profiles from this network today; try again later');
    checkSigned(pk, profileWriteMessage(cid, id, body.profile, exp), sig, exp);
    // Counted only for valid signed writes, so junk cannot lock a creator out (junk counts per IP).
    ownerLimit(`mprofile:${id}`, PROFILE_WRITES_PER_MIN, 'too many changes of this profile; wait a minute');
    const { created } = ms.saveProfile(id, pk, profile, { profile: JSON.stringify(body.profile), expires_at_ns: exp, sig });
    if (created) daily.add(newKey);
    ms.recomputeStats(id);
    const saved = ms.getProfile(id)!;
    reply.status(created ? 201 : 200);
    return { ok: true, ...profileView(saved), hidden: saved.hidden || saved.self_hidden };
  });

  app.delete('/api/profiles/:id', async (req) => {
    writeLimit(req);
    const id = profileParam(req);
    const p = ms.getProfile(id);
    if (!p) throw new HttpError(404, 'profile_not_found', 'profile not found');
    const body = (req.body ?? {}) as Body;
    if (body.profile_pk !== undefined && body.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this profile belongs to another key');
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, profileWriteMessage(cid, id, { delete: true }, exp), sig, exp);
    ownerLimit(`mprofile:${id}`, PROFILE_WRITES_PER_MIN, 'too many changes of this profile; wait a minute');
    ms.setSelfHidden(id, true);
    return { ok: true, profile_id: id, hidden: true };
  });

  // ------------------------------------------------------------ profile picture

  /** The owner of an existing profile, not hidden by the operator (moderation cannot be undone by a new picture). */
  function avatarOwner(req: FastifyRequest, body: Body): ProfileRow {
    const id = profileParam(req);
    const p = ms.getProfile(id);
    if (!p || p.hidden) throw new HttpError(404, 'profile_not_found', 'save the profile first, then add a picture');
    if (body.profile_pk !== undefined && body.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this profile belongs to another key');
    return p;
  }

  // Body: {profile_pk, image: base64 of the file, expires_at_ns, sig}. JSON like every other write; the route allows a bigger body.
  app.put('/api/profiles/:id/avatar', { bodyLimit: AVATAR_B64_MAX + 4096 }, async (req) => {
    writeLimit(req);
    const body = (req.body ?? {}) as Body;
    const p = avatarOwner(req, body);
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    const b64 = body.image;
    if (typeof b64 !== 'string' || b64.length === 0) throw bad('image must be the picture file as base64', 'bad_image');
    if (b64.length > AVATAR_B64_MAX) throw new HttpError(413, 'image_too_big', `the picture must be at most ${AVATAR.maxBytes / (1024 * 1024)} MB`);
    if (!B64_RE.test(b64)) throw bad('image must be standard base64', 'bad_image');
    const raw = new Uint8Array(Buffer.from(b64, 'base64'));
    if (raw.length > AVATAR.maxBytes) throw new HttpError(413, 'image_too_big', `the picture must be at most ${AVATAR.maxBytes / (1024 * 1024)} MB`);
    const kind = sniffImage(raw);
    if (!kind) throw new HttpError(415, 'bad_image_type', 'the picture must be JPEG, PNG or WebP');
    // The signature covers the exact bytes; checked before the (costly) decoding.
    checkSigned(p.profile_pk, avatarMessage(cid, p.profile_id, bytesSha256Hex(raw), exp), sig, exp);
    ownerLimit(`mavatar:${p.profile_id}`, AVATAR_WRITES_PER_MIN, 'too many picture changes; wait a minute');
    const dayKey = `mavatarp:${p.profile_id}`;
    dailyCap(dayKey, DAILY_AVATARS_PER_PROFILE, 'too many picture changes today; try again tomorrow');
    let out: Uint8Array;
    try {
      out = await reencodeAvatar(raw, kind);
    } catch (e) {
      if (e instanceof AvatarError) {
        if (e.code === 'bad_image') throw bad(e.message, 'bad_image');
        throw new HttpError(503, e.code === 'busy' ? 'busy' : 'avatars_unavailable', e.message);
      }
      throw e;
    }
    daily.add(dayKey);
    const version = bytesSha256Hex(out).slice(0, 16);
    ms.setAvatar(p.profile_id, version, out);
    return { ok: true, profile_id: p.profile_id, avatar: version };
  });

  // Body: {profile_pk, expires_at_ns, sig}; the signed message has "remove" in place of the file hash.
  app.delete('/api/profiles/:id/avatar', async (req) => {
    writeLimit(req);
    const body = (req.body ?? {}) as Body;
    const p = avatarOwner(req, body);
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, avatarMessage(cid, p.profile_id, 'remove', exp), sig, exp);
    ownerLimit(`mavatar:${p.profile_id}`, AVATAR_WRITES_PER_MIN, 'too many picture changes; wait a minute');
    ms.removeAvatar(p.profile_id);
    return { ok: true, profile_id: p.profile_id, avatar: null };
  });

  // The picture itself: only for a visible profile and its current version (the URL changes with every new picture).
  app.get('/api/profiles/:id/avatar/:v', async (req, reply) => {
    perMin(`mimg:${ipKey(req.ip)}`, AVATAR_READS_PER_MIN);
    const id = profileParam(req);
    const v = (req.params as { v?: string }).v ?? '';
    const p = ms.getProfile(id);
    const a = visible(p) && AVATAR_VERSION_RE.test(v) && p.avatar === v ? ms.getAvatar(id) : null;
    if (!a || a.version !== v) {
      reply.header('Cache-Control', 'no-store');
      throw new HttpError(404, 'avatar_not_found', 'picture not found');
    }
    return reply
      .header('Content-Type', 'image/webp')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Content-Disposition', 'inline; filename="avatar.webp"')
      .send(Buffer.from(a.image));
  });

  // ------------------------------------------------------------ requests (client)

  function requestParam(req: FastifyRequest): string {
    const handle = (req.params as { handle?: string }).handle ?? '';
    if (!HANDLE_RE.test(handle)) throw new HttpError(404, 'request_not_found', 'request not found');
    return handle;
  }

  /** The client: holds the request token (link fragment). 404 otherwise, never "wrong token". */
  function clientRequest(req: FastifyRequest): RequestRow {
    const handle = requestParam(req);
    const token = req.headers['x-request-token'];
    const r = typeof token === 'string' && token.length <= 128 && sha256Hex(token) === handle ? ms.getRequest(handle) : null;
    if (!r) throw new HttpError(404, 'request_not_found', 'request not found');
    return r;
  }

  app.post('/api/requests', async (req, reply) => {
    writeLimit(req);
    const body = (req.body ?? {}) as Body;
    const handle = body.handle;
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) throw bad('handle must be sha256(token) as 64 lowercase hex chars');
    const boxPk = body.client_box_pk;
    if (typeof boxPk !== 'string' || !HEX64_RE.test(boxPk)) throw bad('client_box_pk must be an x25519 public key (64 hex chars)', 'bad_box');
    const profileId = body.profile_id;
    const p = typeof profileId === 'string' && PROFILE_ID_RE.test(profileId) ? ms.getProfile(profileId) : null;
    if (!visible(p)) throw new HttpError(404, 'profile_not_found', 'profile not found');
    let service: RequestRow['service'] = null;
    if (body.service_id !== undefined && body.service_id !== null && body.service_id !== '') {
      const s = ms.getServices(p.profile_id).find((x) => x.id === body.service_id);
      if (!s) throw bad('service_id is not a service of this profile', 'unknown_service');
      service = { id: s.id, title: s.title, price_from_usdc: s.price_from_usdc, delivery_days: s.delivery_days };
    }
    const brief = text(body.brief, 'brief', MARKET_LIMITS.brief, { min: 1, multiline: true });
    const aiLines = parseAiLines(body.ai_lines, brief);
    const wanted = parseDeadline(body.wanted_deadline, now());
    if (body.client_contact === undefined || body.client_contact === null) throw bad('client_contact is required', 'bad_contact');
    const c = contact(body.client_contact, 'client_contact', 'bad_contact');
    // No budget field: the price is agreed in chat, the creator sets it in the deal.
    const prefix = ipPrefix(req.ip);
    const keys = { ip: `mreqip:${prefix}`, profile: `mreqp:${p.profile_id}`, pair: `mreqpair:${prefix}:${p.profile_id}` };
    dailyCap(keys.ip, DAILY_REQUESTS_PER_PREFIX, 'too many requests from this network today; try again tomorrow');
    dailyCap(keys.profile, DAILY_REQUESTS_PER_PROFILE, 'this creator got too many requests today; try again tomorrow');
    dailyCap(keys.pair, DAILY_REQUESTS_PER_PAIR, 'too many requests to this creator today; try again tomorrow');
    if (ms.getRequest(handle)) throw new HttpError(409, 'handle_taken', 'handle already exists');
    ms.insertRequest({
      handle,
      profile_id: p.profile_id,
      service,
      brief,
      wanted_deadline: wanted,
      contact_kind: c.kind,
      contact_value: c.value,
      client_box_pk: boxPk,
      ai_lines: aiLines,
    });
    for (const k of Object.values(keys)) daily.add(k);
    reply.status(201);
    // The client's browser pins this key now; "deal ready" and the nickname are checked against it later.
    return { handle, profile_pk: p.profile_pk };
  });

  function serviceView(s: RequestRow['service']) {
    return s ? { id: s.id, title: s.title, price_from_usdc: s.price_from_usdc, delivery_days: s.delivery_days } : null;
  }

  /** A linked deal that may have ended: joined (the chain decides), or never joined and its link expired / was revoked. */
  function maybeEnded(link: LinkRow): boolean {
    const rec = store.getDeal(link.deal_handle);
    if (!rec || rec.deal_id !== null || rec.revoked_at !== null) return true;
    try {
      return nowNs() > BigInt(parseOffer(rec.offer).offer_expires_at_ns);
    } catch {
      return true;
    }
  }

  /**
   * The deal of this link can never be paid: never joined and its link was
   * cancelled or expired, or joined and it ended unpaid on-chain (cancelled,
   * expired). Read from what the server already knows, without a chain call.
   */
  function linkDead(link: LinkRow): boolean {
    const rec = store.getDeal(link.deal_handle);
    if (!rec) return true;
    if (rec.deal_id === null) {
      if (rec.revoked_at !== null) return true;
      try {
        return nowNs() > BigInt(parseOffer(rec.offer).offer_expires_at_ns);
      } catch {
        return true;
      }
    }
    return link.final && !link.reviewable && !link.counted;
  }

  /** USDC base units (6 decimals) as a short decimal text: "12500000" -> "12.5". */
  const usdcText = (units: string): string => {
    const v = BigInt(units);
    const whole = v / 1_000_000n;
    const frac = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole.toString();
  };

  /**
   * Deals of this request that must not be paid: every deal except the one
   * the request page shows now. The client's browser opens each box to show
   * the start of its link, so the client can match it with what they got.
   */
  function oldDeals(r: RequestRow, shown: LinkRow | null) {
    return ms
      .linksOf(r.handle)
      .filter((l) => l.deal_handle !== shown?.deal_handle)
      .map((l) => {
        const rec = store.getDeal(l.deal_handle);
        let amount: string | null = null;
        try {
          amount = rec ? usdcText(rec.amount) : null;
        } catch {
          amount = null;
        }
        return { made_on: l.created_at.slice(0, 10), title: rec?.title ?? null, amount_usdc: amount, deal_link_box: l.deal_link_box };
      });
  }

  /** When an unanswered request closes by itself (null once answered). */
  const closesAt = (r: RequestRow): string | null =>
    UNANSWERED.includes(r.status) ? new Date(Date.parse(r.created_at) + REQUEST_AUTO_CLOSE_MS).toISOString() : null;

  app.get('/api/requests/:handle', async (req) => {
    readLimit(req);
    upkeep();
    let r = clientRequest(req);
    let link = r.status === 'deal_ready' ? ms.latestLink(r.handle) : null;
    // The deal may have ended unpaid since the last look: read the chain (the request may go back to "discussing").
    // Only for a joined deal, or a link that expired / was revoked: a fresh link is not read here (no chain call per poll).
    if (link && !link.final && now() - link.checked_at > LINK_RECHECK_MS && maybeEnded(link)) {
      try {
        await refreshLink(link);
        r = ms.getRequest(r.handle)!;
        link = r.status === 'deal_ready' ? ms.latestLink(r.handle) : null;
      } catch {
        /* chain unreachable: last known status */
      }
    }
    const p = ms.getProfile(r.profile_id);
    // No client contact here (only the creator's signed inbox has it).
    return {
      handle: r.handle,
      status: r.status,
      profile: {
        profile_id: r.profile_id,
        nickname: p?.nickname ?? '',
        avatar: visible(p) ? p.avatar : null,
        // The client's browser compares it with the key it pinned when it sent the request.
        profile_pk: p?.profile_pk ?? null,
        recent_change: p ? recentChange(p) : null,
        key_changing: p ? keyChange(p.profile_id) !== null : false,
      },
      // The last profile write as the creator signed it: the browser takes the nickname from it after checking it.
      profile_proof: p ? profileProof(p) : null,
      service: serviceView(r.service),
      brief: r.brief,
      wanted_deadline: r.wanted_deadline,
      decline_reason: r.decline_reason,
      closes_at: closesAt(r),
      // The deal token encrypted in the creator's browser to the client's request key; only the client opens it.
      deal_link_box: link?.deal_link_box ?? null,
      // The profile key's signature over (this request, the deal's creator key); the browser checks it before "pay".
      deal_proof: link?.proof ?? null,
      // Older deals of this request (newest first): not valid, the client must not pay them.
      old_deals: oldDeals(r, link),
    };
  });

  app.post('/api/requests/:handle/cancel', async (req) => {
    writeLimit(req);
    upkeep();
    const r = clientRequest(req);
    // Only while no deal is waiting (a deal that ended unpaid put the request back to "discussing").
    if (r.status === 'deal_ready') throw new HttpError(409, 'deal_created', 'a deal was already created from this request');
    if (r.status === 'declined') throw new HttpError(409, 'declined', 'the creator already declined this request');
    if (r.status === 'closed') throw new HttpError(409, 'closed', 'this request closed after 7 days without an answer');
    if (r.status !== 'cancelled') ms.setRequestStatus(r.handle, 'cancelled');
    return { ok: true, handle: r.handle, status: 'cancelled' };
  });

  // ------------------------------------------------------------ requests (creator, signed by the profile key)

  app.get('/api/profiles/:id/requests', async (req) => {
    readLimit(req);
    const id = profileParam(req);
    const p = ms.getProfile(id);
    if (!p) throw new HttpError(404, 'profile_not_found', 'profile not found');
    // Query string (the web's choice): request logs never contain the query.
    const q = (req.query ?? {}) as Record<string, unknown>;
    if (q.profile_pk !== undefined && q.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this profile belongs to another key');
    const exp = expiry(q.expires_at_ns);
    const sig = sigOf(q.sig);
    checkSigned(p.profile_pk, inboxMessage(cid, id, exp), sig, exp);
    ownerLimit(`minbox:${id}`, INBOX_READS_PER_MIN, 'too many inbox reads; wait a minute');
    upkeep();
    // The last deal of a request can no longer be paid (link cancelled or expired): back to "in talks" now,
    // so the creator can make the one new deal without waiting for the refresh timer.
    for (const r of ms.inbox(id, INBOX_LIMIT)) {
      if (r.status !== 'deal_ready') continue;
      const last = ms.latestLink(r.handle);
      if (last && linkDead(last)) ms.reopenAfterDeadDeal(last.deal_handle);
    }
    const items = ms.inbox(id, INBOX_LIMIT).map((r) => ({
      handle: r.handle,
      // As it was before this read: the creator sees "new" once; the client sees "viewed" from now on.
      status: r.status,
      service: serviceView(r.service),
      brief: r.brief,
      wanted_deadline: r.wanted_deadline,
      client_contact: { kind: r.contact_kind, value: r.contact_value },
      created_at: r.created_at,
      client_box_pk: r.client_box_pk,
      decline_reason: r.decline_reason,
      closes_at: closesAt(r),
      // Brief lines the AI helper wrote (the creator checks them with the client). Never on the client's page.
      ai_lines: r.ai_lines,
    }));
    ms.markViewed(id);
    return { items, key_change: keyChange(id) };
  });

  /** The creator of this request (signed write by the profile key). */
  function creatorRequest(req: FastifyRequest): { r: RequestRow; p: ProfileRow; body: Body } {
    const handle = requestParam(req);
    upkeep();
    const r = ms.getRequest(handle);
    const p = r ? ms.getProfile(r.profile_id) : null;
    if (!r || !p) throw new HttpError(404, 'request_not_found', 'request not found');
    const body = (req.body ?? {}) as Body;
    if (body.profile_pk !== undefined && body.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this request is for another profile');
    return { r, p, body };
  }

  /** 409 for a request the creator can no longer answer. */
  function stillOpen(r: RequestRow): void {
    if (r.status === 'deal_ready') throw new HttpError(409, 'deal_created', 'a deal was already created from this request');
    if (r.status === 'cancelled') throw new HttpError(409, 'cancelled', 'the client already cancelled this request');
    if (r.status === 'closed') throw new HttpError(409, 'closed', 'this request closed after 7 days without an answer');
  }

  // "in discussion" (the creator is talking to the client in the messenger).
  app.post('/api/requests/:handle/discuss', async (req) => {
    writeLimit(req);
    const { r, p, body } = creatorRequest(req);
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, discussMessage(cid, r.handle, exp), sig, exp);
    if (r.status === 'declined') throw new HttpError(409, 'declined', 'you already declined this request');
    stillOpen(r);
    if (r.status !== 'discussing') ms.setRequestStatus(r.handle, 'discussing');
    return { ok: true, handle: r.handle, status: 'discussing' };
  });

  app.post('/api/requests/:handle/decline', async (req) => {
    writeLimit(req);
    const { r, p, body } = creatorRequest(req);
    const handle = r.handle;
    // Optional reason, signed exactly as sent.
    let reason: string | null = null;
    if (body.reason !== undefined && body.reason !== null && body.reason !== '') {
      if (typeof body.reason !== 'string') throw bad('reason must be a string', 'bad_reason');
      if (body.reason !== body.reason.trim()) throw bad('reason must not start or end with spaces', 'bad_reason');
      reason = text(body.reason, 'reason', MARKET_LIMITS.declineReason, { multiline: true, code: 'bad_reason' });
    }
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, reason === null ? declineMessage(cid, handle, exp) : declineReasonMessage(cid, handle, reason, exp), sig, exp);
    stillOpen(r);
    if (r.status !== 'declined') ms.setRequestStatus(handle, 'declined', reason);
    return { ok: true, handle, status: 'declined' };
  });

  // The current key cancels a key reset in progress with one signature.
  app.post('/api/profiles/:id/key-reset/cancel', async (req) => {
    writeLimit(req);
    const id = profileParam(req);
    upkeep();
    const p = ms.getProfile(id);
    if (!p) throw new HttpError(404, 'profile_not_found', 'profile not found');
    const body = (req.body ?? {}) as Body;
    if (body.profile_pk !== undefined && body.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this profile belongs to another key');
    const rid = body.reset_id;
    if (typeof rid !== 'string' || !/^[0-9a-f]{16}$/.test(rid)) throw bad('reset_id must be 16 hex chars', 'bad_reset');
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, keyResetCancelMessage(cid, id, rid, exp), sig, exp);
    const r = ms.getReset(rid);
    if (!r || r.profile_id !== id) throw new HttpError(404, 'reset_not_found', 'no such key change for this profile');
    if (r.status !== 'issued' && r.status !== 'pending') throw new HttpError(409, 'reset_done', `this key change is already ${r.status}`);
    // Proved through an account confirmed on this profile long before: a stolen key cannot stop it.
    if (r.proof === 'verified') {
      throw new HttpError(403, 'verified_proof', 'this key change was proved through a confirmed account of this profile; only support can stop it');
    }
    ms.cancelReset(rid, 'owner_key');
    return { ok: true, profile_id: id, reset_id: rid, status: 'cancelled' };
  });

  // ------------------------------------------------------------ verified accounts

  /** An existing profile, not hidden by the operator, and a request signed by its key. */
  function accountOwner(req: FastifyRequest, body: Body): ProfileRow {
    const id = profileParam(req);
    const p = ms.getProfile(id);
    if (!p || p.hidden) throw new HttpError(404, 'profile_not_found', 'save the profile first, then add an account');
    if (body.profile_pk !== undefined && body.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this profile belongs to another key');
    return p;
  }

  function accountParam(req: FastifyRequest, p: ProfileRow): AccountRow {
    const aid = (req.params as { aid?: string }).aid ?? '';
    const a = /^[0-9a-f]{16}$/.test(aid) ? ms.getAccount(aid) : null;
    if (!a || a.profile_id !== p.profile_id) throw new HttpError(404, 'account_not_found', 'no such account on this profile');
    return a;
  }

  // The owner's list, with the codes (query string like the inbox: logs never contain it).
  app.get('/api/profiles/:id/accounts', async (req) => {
    readLimit(req);
    const q = (req.query ?? {}) as Body;
    const p = accountOwner(req, q);
    const exp = expiry(q.expires_at_ns);
    const sig = sigOf(q.sig);
    checkSigned(p.profile_pk, accountsReadMessage(cid, p.profile_id, exp), sig, exp);
    ownerLimit(`maccread:${p.profile_id}`, INBOX_READS_PER_MIN, 'too many reads; wait a minute');
    return { items: ms.accountsOf(p.profile_id).map(ownerAccount) };
  });

  // Body {profile_pk, url, expires_at_ns, sig}: a YouTube channel, an X account or a Behance profile.
  app.post('/api/profiles/:id/accounts', async (req, reply) => {
    writeLimit(req);
    const body = (req.body ?? {}) as Body;
    const p = accountOwner(req, body);
    const raw = body.url;
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MARKET_LIMITS.link) throw bad('url must be a link to your account', 'bad_account');
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, accountAddMessage(cid, p.profile_id, raw, exp), sig, exp);
    ownerLimit(`mprofile:${p.profile_id}`, PROFILE_WRITES_PER_MIN, 'too many changes of this profile; wait a minute');
    const ref = parseAccountUrl(raw);
    if (!ref) throw bad('use the link of your YouTube channel, X account or Behance profile (https)', 'bad_account');
    const same = ms.accountByUrl(p.profile_id, ref.url);
    if (same) return { ok: true, account: ownerAccount(same) };
    if (ms.accountsOf(p.profile_id).length >= MAX_ACCOUNTS) throw new HttpError(409, 'too_many_accounts', `at most ${MAX_ACCOUNTS} accounts per profile`);
    // A random code per (profile, account), unlike the key-reset code.
    const a = ms.insertAccount({ account_id: randomBytes(8).toString('hex'), profile_id: p.profile_id, platform: ref.platform, url: ref.url, handle: ref.handle, code: verifyCode() });
    reply.status(201);
    return { ok: true, account: ownerAccount(a) };
  });

  // "Check now": the site reads the bio (a separate process); X waits for a person of the team.
  app.post('/api/profiles/:id/accounts/:aid/check', async (req) => {
    writeLimit(req);
    const body = (req.body ?? {}) as Body;
    const p = accountOwner(req, body);
    const a = accountParam(req, p);
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, accountCheckMessage(cid, p.profile_id, a.account_id, exp), sig, exp);
    ownerLimit(`maccheck:${a.account_id}`, ACCOUNT_CHECKS_PER_MIN, 'too many checks; wait a minute');
    const dayKey = `maccheckp:${p.profile_id}`;
    dailyCap(dayKey, DAILY_ACCOUNT_CHECKS_PER_PROFILE, 'too many checks today; try again tomorrow');
    daily.add(dayKey);
    const result = await checker.check({ platform: a.platform as never, url: a.url, handle: a.handle, codes: [a.code] });
    const after = ms.recordCheck(a.account_id, result === 'refused' ? 'unreadable' : result)!;
    return { ok: true, result, account: ownerAccount(after) };
  });

  app.delete('/api/profiles/:id/accounts/:aid', async (req) => {
    writeLimit(req);
    const body = (req.body ?? {}) as Body;
    const p = accountOwner(req, body);
    const a = accountParam(req, p);
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    checkSigned(p.profile_pk, accountRemoveMessage(cid, p.profile_id, a.account_id, exp), sig, exp);
    ownerLimit(`mprofile:${p.profile_id}`, PROFILE_WRITES_PER_MIN, 'too many changes of this profile; wait a minute');
    ms.deleteAccount(a.account_id);
    return { ok: true, account_id: a.account_id };
  });

  /** Re-reads confirmed accounts; the mark goes when the code is gone (2 reads in a row). */
  async function recheckAccounts(limit = 20): Promise<number> {
    const period = config.accountRecheckHours * 3600 * 1000;
    let n = 0;
    for (const a of ms.accountsToRecheck(AUTO_PLATFORMS, now() - period, limit)) {
      const result = await checker.check({ platform: a.platform as never, url: a.url, handle: a.handle, codes: [a.code] });
      ms.recordCheck(a.account_id, result === 'refused' ? 'unreadable' : result);
      n++;
    }
    return n;
  }

  if (config.accountRecheckHours > 0) {
    let busy = false;
    const timer = setInterval(
      () => {
        if (busy) return;
        busy = true;
        void recheckAccounts()
          .catch(() => {
            /* next round */
          })
          .finally(() => {
            busy = false;
          });
      },
      Math.min(config.accountRecheckHours, 1) * 3600 * 1000,
    );
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  // ------------------------------------------------------------ deal from request

  function prepareDealLink(body: Body, creatorPk: string): ((dealHandle: string) => void) | null {
    const rh = body.request_handle;
    if (rh === undefined || rh === null || rh === '') return null;
    if (typeof rh !== 'string' || !HANDLE_RE.test(rh)) throw bad('request_handle must be 64 lowercase hex chars', 'bad_request_handle');
    upkeep();
    const r = ms.getRequest(rh);
    const p = r ? ms.getProfile(r.profile_id) : null;
    if (!r || !p) throw new HttpError(404, 'request_not_found', 'request not found');
    if (r.status === 'declined' || r.status === 'cancelled' || r.status === 'closed') throw new HttpError(409, 'request_closed', `the request is ${r.status}`);
    if (body.profile_pk !== undefined && body.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this request is for another profile');
    if (ms.countLinks(rh) >= MAX_DEALS_PER_REQUEST) throw new HttpError(409, 'too_many_deals', `at most ${MAX_DEALS_PER_REQUEST} deals per request`);
    // One live deal per request: a new one only after the newest one was cancelled or its link expired.
    const newest = ms.latestLink(rh);
    if (newest && !linkDead(newest)) {
      throw new HttpError(409, 'deal_live', 'the last deal of this request is still open; cancel its link or wait until it expires, then make a new one');
    }
    const box = parseBox(body.deal_link_box);
    const exp = expiry(body.request_expires_at_ns, 'request_expires_at_ns');
    const sig = sigOf(body.request_sig, 'request_sig');
    checkSigned(p.profile_pk, requestDealMessage(cid, rh, creatorPk, exp), sig, exp);
    // Kept as sent: the client's browser checks it against the profile key it pinned.
    const proof = { creator_pk: creatorPk, profile_pk: p.profile_pk, expires_at_ns: exp, sig };
    return (dealHandle) => ms.linkDeal(dealHandle, rh, r.profile_id, box, proof);
  }

  // ------------------------------------------------------------ linked deals: chain facts

  /** Deal id of a stored deal (recovers a join that landed but was not recorded). */
  async function dealIdOf(dealHandle: string): Promise<number | null> {
    const rec = store.getDeal(dealHandle);
    if (!rec) return null;
    if (rec.deal_id !== null) return rec.deal_id;
    const id = await chain.getDealIdByOffer(rec.offer);
    if (id !== null) store.setDealId(dealHandle, id);
    return id;
  }

  /** Re-reads one linked deal; returns the deal view (null if not on-chain). */
  async function refreshLink(link: LinkRow): Promise<DealView | null> {
    const id = await dealIdOf(link.deal_handle);
    if (id === null) {
      const rec = store.getDeal(link.deal_handle);
      // Never joined and can no longer be: final, counts for nothing.
      const dead = !rec || rec.revoked_at !== null || nowNs() > BigInt(parseOffer(rec.offer).offer_expires_at_ns);
      if (ms.setLinkFacts(link.deal_handle, dead ? { final: true, reviewable: false, counted: false } : null)) ms.recomputeStats(link.profile_id);
      // Never joined and can no longer be: the request goes back to "discussing".
      if (dead) ms.reopenAfterDeadDeal(link.deal_handle);
      return null;
    }
    const deal = await chain.getDeal(id);
    if (ms.setLinkFacts(link.deal_handle, deal ? linkFacts(deal) : null)) ms.recomputeStats(link.profile_id);
    // Expired unpaid or cancelled: back to "discussing" (the creator can make a new deal).
    if (deal && !deal.purged && FINAL_UNPAID.includes(deal.state)) ms.reopenAfterDeadDeal(link.deal_handle);
    return deal;
  }

  async function refreshLinks(limit = 50): Promise<number> {
    let n = 0;
    for (const link of ms.openLinks(now() - LINK_RECHECK_MS, limit)) {
      try {
        await refreshLink(link);
        n++;
      } catch {
        /* chain unreachable: next round */
      }
    }
    return n;
  }

  if (config.marketRefreshSeconds > 0) {
    const timer = setInterval(() => {
      try {
        upkeep();
      } catch {
        /* database busy: next round */
      }
      void refreshLinks();
    }, config.marketRefreshSeconds * 1000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  // ------------------------------------------------------------ reviews

  /** The deal page: deal-token holder only (the link deal -> profile stays private). */
  function dealWithToken(req: FastifyRequest) {
    const handle = (req.params as { handle?: string }).handle ?? '';
    const token = req.headers['x-deal-token'];
    const rec = HANDLE_RE.test(handle) && typeof token === 'string' && token.length <= 128 && sha256Hex(token) === handle ? store.getDeal(handle) : null;
    if (!rec) throw new HttpError(404, 'not_found', 'deal not found');
    return rec;
  }

  /** A review can be written or edited until this moment (ms), then it is locked. null = not ended yet. */
  const reviewUntil = (link: LinkRow): number | null => reviewUntilMs(link, config.reviewWindowSeconds * 1000);
  /** The window of this deal starts when the client opens it (not opened yet, and still inside the 30 days). */
  const startsOnOpen = (link: LinkRow): boolean =>
    link.reviewable && link.idle_end && link.opened_ms === null && link.ended_ms !== null && now() < link.ended_ms + IDLE_OPEN_MAX_MS;
  const windowOpen = (link: LinkRow): boolean => {
    const until = reviewUntil(link);
    return link.reviewable && until !== null && now() < until;
  };

  app.get('/api/deals/:handle/review', async (req) => {
    readLimit(req);
    const rec = dealWithToken(req);
    let link = ms.getLink(rec.handle);
    if (!link) return { linked: false };
    // Not final yet, or final before the end time was stored (rows from the first release): read the chain.
    if ((!link.final && now() - link.checked_at > LINK_RECHECK_MS) || (link.final && link.ended_ms === null)) {
      try {
        await refreshLink(link);
        link = ms.getLink(rec.handle)!;
      } catch {
        /* chain unreachable: last known facts */
      }
    }
    const p = ms.getProfile(link.profile_id);
    const review = ms.getReview(rec.handle);
    const until = link.reviewable ? reviewUntil(link) : null;
    return {
      linked: true,
      profile_id: link.profile_id,
      nickname: p?.nickname ?? '',
      // Fully paid and finished on-chain (Released / Refunded / PaidOut) AND inside the 3-day window.
      can_review: windowOpen(link),
      // The window is over: the review (or its absence) is final. Only the deal-token holder sees the exact time.
      locked: link.reviewable && !windowOpen(link),
      review_until: until === null ? null : new Date(until).toISOString(),
      // The deal ended by itself; the 3 days start when the client opens it (POST …/review/open, signed).
      starts_on_open: startsOnOpen(link),
      outcome: link.reviewable ? (link.outcome ?? (link.counted ? 'paid' : 'refunded')) : null,
      review: review ? publicReview(review) : null,
    };
  });

  app.post('/api/deals/:handle/review', async (req, reply) => {
    writeLimit(req);
    const rec = dealWithToken(req);
    const link = ms.getLink(rec.handle);
    if (!link) throw new HttpError(409, 'not_from_request', 'reviews are only for deals made from a request in the catalog');
    const body = (req.body ?? {}) as Body;
    const rating = int(body.rating, 'rating', [1, 5], 'bad_review');
    const raw = body.text === undefined ? '' : body.text;
    if (typeof raw !== 'string') throw bad('text must be a string', 'bad_review');
    // The signature covers the text exactly as sent; it is checked untrimmed.
    if (raw !== raw.trim()) throw bad('text must not start or end with spaces', 'bad_review');
    const reviewText = text(raw, 'text', MARKET_LIMITS.review, { multiline: true, code: 'bad_review' });
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    const id = await dealIdOf(rec.handle);
    if (id === null) throw new HttpError(409, 'not_joined', 'the client has not joined this deal yet');
    const deal = await chain.getDeal(id);
    if (!deal) throw new HttpError(502, 'chain_mismatch', 'deal not found on chain');
    if (ms.setLinkFacts(rec.handle, linkFacts(deal))) ms.recomputeStats(link.profile_id);
    const facts = ms.getLink(rec.handle)!;
    // Fully paid and finished, whatever the outcome.
    if (!facts.reviewable) {
      throw new HttpError(409, 'not_finished', 'a review is possible once the deal is fully paid and finished (released, refunded or paid out)');
    }
    // 3 days after the deal ended, then locked (no new review, no edits).
    if (!windowOpen(facts)) throw new HttpError(409, 'review_locked', 'the review window is over (3 days after the deal ended); the review is locked');
    const existing = ms.getReview(rec.handle);
    if (existing && BigInt(existing.signed_expires_ns) >= BigInt(exp)) {
      throw new HttpError(409, 'stale_review', 'a newer review of this deal is already saved');
    }
    // Signed by the deal's client key (from the contract; a purged deal keeps it in the tombstone).
    checkSigned(deal.client_pk, reviewMessage(cid, id, link.profile_id, rating, reviewText, exp), sig, exp);
    // After the client's signature: the creator also holds the deal token and must not be able to block it.
    ownerLimit(`mreview:${rec.handle}`, REVIEW_WRITES_PER_MIN, 'too many review changes; wait a minute');
    const { created } = ms.saveReview({
      deal_handle: rec.handle,
      profile_id: link.profile_id,
      rating,
      text: reviewText,
      refunded: !facts.counted,
      outcome: facts.outcome ?? (facts.counted ? 'paid' : 'refunded'),
      signed_expires_ns: exp,
    });
    // A signed review is also the client's first open.
    if (facts.idle_end) ms.markOpened(rec.handle, now());
    ms.recomputeStats(link.profile_id);
    reply.status(created ? 201 : 200);
    return { ok: true, profile_id: link.profile_id, review: publicReview(ms.getReview(rec.handle)!) };
  });

  // The client opened a deal that ended by itself: the 3-day review window starts now (at most 30 days after the end).
  // Body {expires_at_ns, sig}; signed by the deal's client key (read from the contract), so the creator cannot start it.
  app.post('/api/deals/:handle/review/open', async (req) => {
    writeLimit(req);
    const rec = dealWithToken(req);
    const link = ms.getLink(rec.handle);
    if (!link) throw new HttpError(409, 'not_from_request', 'reviews are only for deals made from a request in the catalog');
    const body = (req.body ?? {}) as Body;
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    const id = await dealIdOf(rec.handle);
    if (id === null) throw new HttpError(409, 'not_joined', 'the client has not joined this deal yet');
    const deal = await chain.getDeal(id);
    if (!deal) throw new HttpError(502, 'chain_mismatch', 'deal not found on chain');
    if (ms.setLinkFacts(rec.handle, linkFacts(deal))) ms.recomputeStats(link.profile_id);
    checkSigned(deal.client_pk, reviewOpenMessage(cid, id, exp), sig, exp);
    const facts = ms.getLink(rec.handle)!;
    const first = facts.reviewable && facts.idle_end && facts.ended_ms !== null ? ms.markOpened(rec.handle, now()) : false;
    const after = ms.getLink(rec.handle)!;
    const until = after.reviewable ? reviewUntil(after) : null;
    return { ok: true, started: first, can_review: windowOpen(after), review_until: until === null ? null : new Date(until).toISOString() };
  });

  // The creator may answer each review ONCE, publicly, signed by the profile key.
  app.post('/api/profiles/:id/reviews/:review_id/reply', async (req, reply) => {
    writeLimit(req);
    const id = profileParam(req);
    const rid = (req.params as { review_id?: string }).review_id ?? '';
    const p = ms.getProfile(id);
    const r = REVIEW_ID_RE.test(rid) ? ms.getReviewById(rid) : null;
    if (!p || p.hidden || !r || r.profile_id !== id || r.hidden) throw new HttpError(404, 'review_not_found', 'review not found');
    const body = (req.body ?? {}) as Body;
    if (body.profile_pk !== undefined && body.profile_pk !== p.profile_pk) throw new HttpError(403, 'wrong_key', 'this profile belongs to another key');
    const raw = body.text;
    if (typeof raw !== 'string') throw bad('text must be a string', 'bad_reply');
    // Signed exactly as sent, like a review.
    if (raw !== raw.trim()) throw bad('text must not start or end with spaces', 'bad_reply');
    const replyText = text(raw, 'text', MARKET_LIMITS.reply, { min: 1, multiline: true, code: 'bad_reply' });
    const exp = expiry(body.expires_at_ns);
    const sig = sigOf(body.sig);
    if (r.reply_text !== null) throw new HttpError(409, 'already_replied', 'this review already has your answer (one answer per review)');
    checkSigned(p.profile_pk, reviewReplyMessage(cid, id, rid, replyText, exp), sig, exp);
    ownerLimit(`mreply:${id}`, REVIEW_WRITES_PER_MIN, 'too many answers; wait a minute');
    if (!ms.saveReply(rid, replyText)) throw new HttpError(409, 'already_replied', 'this review already has your answer (one answer per review)');
    reply.status(201);
    return { ok: true, profile_id: id, review: publicReview(ms.getReviewById(rid)!) };
  });

  function reviewWindow(dealHandle: string) {
    const link = ms.getLink(dealHandle);
    const until = link?.reviewable ? reviewUntil(link) : null;
    if (!link || until === null) return null;
    return { until_ms: until, open: windowOpen(link), reviewed: !!ms.getReview(dealHandle) };
  }

  return { store: ms, prepareDealLink, refreshLinks, reviewWindow, upkeep, recheckAccounts };
}
