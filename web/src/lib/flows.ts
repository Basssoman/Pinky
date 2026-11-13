// What the two browsers do in a deal: the creator seals an offer,
// the client checks it, joins with its own key and pays; both act on the deal
// with signed actions. Rule of this file: what our API says is checked
// against a signature or against the chain before it is used.

import { ApiError, type ActCall, type Api, type ApiTerms, type NoteRecord } from './api';
import { randomHex } from './bytes';
import { msToNs, nsToMs, type ChainPeriods, type ChainReader, type DealView } from './chain';
import { FEE_BPS, USDC_DECIMALS, type Net } from './config';
import { filesFingerprint, filesManifest, newFilesSalt, type FileLike } from './files';
import {
  fingerprint,
  keyFromSeed,
  newKey,
  offerMessage,
  parsePublicKey,
  revokeOfferMessage,
  sha256Hex,
  sign,
  signedMessage,
  termsHash,
  verify,
  type DealKey,
} from './keys';
import { newToken, type KeyStore, type LocalDeal } from './local';
import { sealDealLink, signRequestDeal } from './market';
import { openFromParty, sealForArbiter, sealForParty, type DeliveryNote, type DisputeArbiterNote, type DisputeNote } from './notes';
import { checkPayoutQuote, checkPayQuote, type VerifiedPayQuote } from './quote';

export interface Ctx {
  net: Net;
  api: Api;
  chain: ChainReader;
  store: KeyStore;
  /** Current time in ms, synced to the chain clock where possible. */
  now: () => number;
}

/** Something is wrong with the deal itself. `code` picks the screen. */
export class DealError extends Error {
  readonly code: 'not_found' | 'tampered' | 'used' | 'revoked' | 'expired' | 'wrong_key' | 'state';
  constructor(code: DealError['code'], message: string) {
    super(message);
    this.name = 'DealError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- amounts

/** "12.5" -> "12500000" (USDC base units). Throws on bad input. */
export function usdcToUnits(v: string): string {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(v.trim());
  if (!m) throw new Error('bad amount');
  const units = BigInt(m[1]) * 10n ** BigInt(USDC_DECIMALS) + BigInt((m[2] ?? '').padEnd(USDC_DECIMALS, '0') || '0');
  if (units <= 0n) throw new Error('bad amount');
  return units.toString();
}

/** "12500000" -> "12.5"; whole numbers stay whole, cents get two digits ("4.85", "291.00" -> "291"). */
export function unitsToUsdc(units: string | bigint): string {
  const n = BigInt(units);
  const d = 10n ** BigInt(USDC_DECIMALS);
  let frac = (n % d).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  if (frac.length === 1) frac += '0';
  return frac ? `${n / d}.${frac}` : `${n / d}`;
}

/** What the creator gets from a share after the fee (the contract's rounding). */
export function afterFee(creatorShare: bigint, feeBps = FEE_BPS): bigint {
  return creatorShare - (creatorShare * BigInt(feeBps)) / 10_000n;
}

// ---------------------------------------------------------------- terms text

/** "The work" and "The client gets" travel as ONE description (server limit). */
const GETS_MARK = '\n\n[The client gets]\n';

export function joinDescription(work: string, gets: string): string {
  return gets.trim() ? `${work.trim()}${GETS_MARK}${gets.trim()}` : work.trim();
}

export function splitDescription(description: string): { work: string; gets: string } {
  const at = description.indexOf(GETS_MARK);
  return at < 0 ? { work: description, gets: '' } : { work: description.slice(0, at), gets: description.slice(at + GETS_MARK.length) };
}

// ---------------------------------------------------------------- offer

export interface Offer {
  creator_pk: string;
  amount: string;
  fee_bps: string;
  delivery_duration_ns: string;
  review_period_ns: string;
  terms_hash: string;
  offer_nonce: string;
  offer_expires_at_ns: string;
}

const OFFER_KEYS = ['creator_pk', 'amount', 'fee_bps', 'delivery_duration_ns', 'review_period_ns', 'terms_hash', 'offer_nonce', 'offer_expires_at_ns'];
const isDecimal = (s: unknown): s is string => typeof s === 'string' && /^(0|[1-9]\d{0,38})$/.test(s);

function parseOffer(offer: string): Offer {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(offer) as Record<string, unknown>;
  } catch {
    throw new DealError('tampered', 'the offer is not readable');
  }
  const keys = o && typeof o === 'object' ? Object.keys(o) : [];
  if (keys.length !== OFFER_KEYS.length || !OFFER_KEYS.every((k) => typeof o[k] === 'string')) {
    throw new DealError('tampered', 'the offer has the wrong fields');
  }
  const r = o as unknown as Offer;
  if (!parsePublicKey(r.creator_pk)) throw new DealError('tampered', 'the offer has a bad creator key');
  for (const k of ['amount', 'fee_bps', 'delivery_duration_ns', 'review_period_ns', 'offer_expires_at_ns'] as const) {
    if (!isDecimal(r[k])) throw new DealError('tampered', `the offer has a bad ${k}`);
  }
  if (Number(r.fee_bps) > FEE_BPS) throw new DealError('tampered', 'the offer has a fee above 3%');
  return r;
}

export interface NewDealInput {
  title: string;
  work: string;
  gets: string;
  revisions: number;
  /** Price in USDC as typed ("300" or "12.5"). */
  price: string;
  deliverySeconds: number;
  reviewSeconds: number;
  /** How long the client link works. */
  linkSeconds: number;
  /**
   * The deal answers a marketplace request: the creator's PROFILE
   * key signs (request, this deal's creator key), and the deal link is
   * encrypted to the client's request key, so our server cannot read it.
   */
  fromRequest?: { handle: string; profileKey: { seed: string; pk: string }; clientBoxPk: string | null };
}

const SEC_NS = 1_000_000_000n;

/**
 * How long the client link works: the creator's choice, but never past the
 * contract's own limit (a short-period test contract allows less than a
 * day). The "works until" the creator sees comes from the offer itself.
 */
async function linkNs(ctx: Ctx, seconds: number): Promise<bigint> {
  const want = BigInt(seconds) * SEC_NS;
  const margin = 120n * SEC_NS; // the server's and the chain's clocks may differ a little
  try {
    const max = (await ctx.chain.getPeriods()).maxOfferTtlNs;
    if (max && max > 2n * margin && want > max - margin) return max - margin;
  } catch {
    // Chain not readable: keep the choice; the server refuses it if it is too long.
  }
  return want;
}

/**
 * The creator's browser makes the deal key, seals the terms and stores the
 * offer on the server. The key is saved in this browser BEFORE anything is
 * sent, so a deal never exists without its key.
 */
export async function createDeal(ctx: Ctx, input: NewDealInput): Promise<LocalDeal> {
  const key = newKey();
  const token = newToken();
  const handle = sha256Hex(token);
  const amount = usdcToUnits(input.price);
  const delivery_duration_ns = (BigInt(input.deliverySeconds) * SEC_NS).toString();
  const review_period_ns = (BigInt(input.reviewSeconds) * SEC_NS).toString();
  const terms: ApiTerms = {
    title: input.title.trim(),
    description: joinDescription(input.work, input.gets),
    revisions: String(input.revisions),
    salt: randomHex(16),
  };
  const offer = JSON.stringify({
    creator_pk: key.pk,
    amount,
    fee_bps: String(FEE_BPS),
    delivery_duration_ns,
    review_period_ns,
    terms_hash: termsHash({ ...terms, amount, delivery_duration_ns, review_period_ns }),
    offer_nonce: randomHex(16),
    offer_expires_at_ns: (msToNs(ctx.now()) + (await linkNs(ctx, input.linkSeconds))).toString(),
  } satisfies Offer);
  const offerSignature = sign(key, offerMessage(ctx.net.contractId, offer));
  const local: LocalDeal = {
    role: 'creator',
    token,
    handle,
    seed: key.seed,
    saved: false,
    title: terms.title,
    createdAt: ctx.now(),
    cache: { offer, offerSignature, terms, dealId: null },
  };
  ctx.store.put(local);
  try {
    const r = input.fromRequest;
    const linked = r
      ? {
          request_handle: r.handle,
          profile_pk: r.profileKey.pk,
          ...(({ expires_at_ns, sig }) => ({ request_expires_at_ns: expires_at_ns, request_sig: sig }))(
            signRequestDeal(ctx.net.contractId, r.profileKey, r.handle, key.pk, ctx.now()),
          ),
          deal_link_box: r.clientBoxPk ? await sealDealLink(r.clientBoxPk, r.handle, token) : null,
        }
      : {};
    await ctx.api.createDeal({ handle, offer, offer_signature: offerSignature, terms, ...linked });
  } catch (e) {
    ctx.store.remove(handle);
    throw e;
  }
  return local;
}

// ---------------------------------------------------------------- loading and checking a deal

export interface DealTerms {
  title: string;
  work: string;
  gets: string;
  /** null = not set. */
  revisions: number | null;
  /** USDC base units. */
  amount: string;
  feeBps: number;
  deliveryMs: number;
  reviewMs: number;
}

export interface LoadedDeal {
  token: string;
  handle: string;
  offerJson: string;
  offerSignature: string;
  offer: Offer;
  terms: DealTerms;
  rawTerms: ApiTerms;
  offerExpiresMs: number;
  /** Short codes of the two deal keys, compared in chat. */
  creatorCode: string;
  clientCode: string | null;
  /** The creator revoked the link before anyone joined. */
  revoked: boolean;
  dealId: number | null;
  /** The deal as it is ON-CHAIN (null until the client joined). */
  deal: DealView | null;
  local: LocalDeal | null;
  /**
   * creator / client: this browser holds that key. visitor: nobody joined yet
   * and this browser has no key. stranger: the deal belongs to other keys.
   */
  role: 'creator' | 'client' | 'visitor' | 'stranger';
  key: DealKey | null;
  periods: ChainPeriods;
  /** The terms came from this browser's copy because our server did not answer. */
  offline: boolean;
}

function checkTerms(offerJson: string, offerSignature: string, raw: ApiTerms, net: Net): { offer: Offer; terms: DealTerms } {
  const offer = parseOffer(offerJson);
  const revisions = raw.revisions ?? '';
  if (typeof raw.title !== 'string' || typeof raw.description !== 'string' || typeof revisions !== 'string' || typeof raw.salt !== 'string') {
    throw new DealError('tampered', 'the terms are not readable');
  }
  const hash = termsHash({
    title: raw.title,
    description: raw.description,
    revisions,
    salt: raw.salt,
    amount: offer.amount,
    delivery_duration_ns: offer.delivery_duration_ns,
    review_period_ns: offer.review_period_ns,
  });
  if (hash !== offer.terms_hash) throw new DealError('tampered', 'the terms do not match what the creator signed');
  // The signature covers the contract id hard-coded in this site: an offer
  // made for any other contract fails here.
  if (!verify(offer.creator_pk, offerMessage(net.contractId, offerJson), offerSignature)) {
    throw new DealError('tampered', 'the creator signature on the terms is not valid');
  }
  const { work, gets } = splitDescription(raw.description);
  return {
    offer,
    terms: {
      title: raw.title,
      work,
      gets,
      revisions: /^\d{1,3}$/.test(revisions) ? Number(revisions) : null,
      amount: offer.amount,
      feeBps: Number(offer.fee_bps),
      deliveryMs: nsToMs(offer.delivery_duration_ns),
      reviewMs: nsToMs(offer.review_period_ns),
    },
  };
}

/** The on-chain deal must be the one the creator signed (the API's own `deal` field is never used). */
function checkChainDeal(deal: DealView, offer: Offer): void {
  if (deal.creator_pk !== offer.creator_pk) throw new DealError('tampered', 'the deal on-chain has another creator key');
  if (deal.purged) return; // only the keys and the client's leftover money are left
  if (
    deal.terms_hash !== offer.terms_hash ||
    deal.amount !== offer.amount ||
    deal.fee_bps !== Number(offer.fee_bps) ||
    deal.delivery_duration_ns !== offer.delivery_duration_ns ||
    deal.review_period_ns !== offer.review_period_ns
  ) {
    throw new DealError('tampered', 'the deal on-chain does not match the signed terms');
  }
}

/**
 * Opens a deal by its link token: terms from our API (or this browser's
 * copy), every browser-side check, and the deal itself from the chain.
 */
export async function loadDeal(ctx: Ctx, token: string): Promise<LoadedDeal> {
  const handle = sha256Hex(token);
  const local = ctx.store.get(handle);
  let source: { offer: string; offerSignature: string; terms: ApiTerms; revoked: boolean };
  let offline = false;
  try {
    const a = await ctx.api.getDeal(handle, token);
    source = { offer: a.offer, offerSignature: a.offer_signature, terms: a.terms, revoked: a.revoked === true };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new DealError('not_found', 'this deal link is not known');
    if (!local?.cache) throw e;
    source = { ...local.cache, revoked: false };
    offline = true;
  }
  const { offer, terms } = checkTerms(source.offer, source.offerSignature, source.terms, ctx.net);

  const [dealId, revokedOnChain, periods] = await Promise.all([
    ctx.chain.getDealIdByOffer(source.offer),
    ctx.chain.isOfferRevoked(source.offer),
    ctx.chain.getPeriods(),
  ]);
  const deal = dealId === null ? null : await ctx.chain.getDeal(dealId);
  if (dealId !== null && !deal) throw new DealError('tampered', 'the deal is not on-chain');
  if (deal) checkChainDeal(deal, offer);

  const key = local ? keyFromSeed(local.seed) : null;
  let role: LoadedDeal['role'];
  if (local?.role === 'creator') {
    if (key!.pk !== offer.creator_pk) throw new DealError('wrong_key', 'the key in this browser is not the creator key of this deal');
    role = 'creator';
  } else if (local?.role === 'client') {
    role = !deal || deal.client_pk === key!.pk ? 'client' : 'stranger';
  } else {
    role = deal ? 'stranger' : 'visitor';
  }

  if (local && !offline) {
    ctx.store.put({ ...local, title: terms.title, cache: { offer: source.offer, offerSignature: source.offerSignature, terms: source.terms, dealId } });
  }
  return {
    token,
    handle,
    offerJson: source.offer,
    offerSignature: source.offerSignature,
    offer,
    terms,
    rawTerms: source.terms,
    offerExpiresMs: nsToMs(offer.offer_expires_at_ns),
    creatorCode: fingerprint(offer.creator_pk),
    clientCode: deal ? fingerprint(deal.client_pk) : key && local?.role === 'client' ? fingerprint(key.pk) : null,
    revoked: source.revoked || revokedOnChain,
    dealId,
    deal,
    local: ctx.store.get(handle),
    role,
    key,
    periods,
    offline,
  };
}

/** Re-reads only the chain (cheap; the page polls this). */
export async function refreshDeal(ctx: Ctx, d: LoadedDeal): Promise<LoadedDeal> {
  const dealId = d.dealId ?? (await ctx.chain.getDealIdByOffer(d.offerJson));
  if (dealId === null) {
    const revoked = d.revoked || (await ctx.chain.isOfferRevoked(d.offerJson));
    return { ...d, revoked, local: ctx.store.get(d.handle) };
  }
  const deal = await ctx.chain.getDeal(dealId);
  if (!deal) throw new DealError('tampered', 'the deal is not on-chain');
  checkChainDeal(deal, d.offer);
  let role = d.role;
  if (d.local?.role === 'client') role = deal.client_pk === d.key!.pk ? 'client' : 'stranger';
  else if (role === 'visitor') role = 'stranger';
  return { ...d, dealId, deal, role, clientCode: fingerprint(deal.client_pk), local: ctx.store.get(d.handle) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until the chain (final blocks lag a few seconds) shows what `ok` expects. */
async function waitChain(ctx: Ctx, d: LoadedDeal, ok: (d: LoadedDeal) => boolean, tries = 20, stepMs = 1000): Promise<LoadedDeal> {
  let cur = d;
  for (let i = 0; i < tries; i++) {
    cur = await refreshDeal(ctx, cur);
    if (ok(cur)) return cur;
    await sleep(stepMs);
  }
  return cur;
}

// ---------------------------------------------------------------- client: key and join

function mustHave(d: LoadedDeal, role: 'creator' | 'client'): { key: DealKey; local: LocalDeal } {
  if (d.role !== role || !d.key || !d.local) throw new DealError('wrong_key', `this browser does not hold the ${role} key of this deal`);
  return { key: d.key, local: d.local };
}

function mustBeJoined(d: LoadedDeal): { dealId: number; deal: DealView } {
  if (d.dealId === null || !d.deal) throw new DealError('state', 'the client has not accepted this deal yet');
  return { dealId: d.dealId, deal: d.deal };
}

/** The client accepted the terms: this browser makes its own key (it is not the deal's key until `joinDeal`). */
export function prepareClientKey(ctx: Ctx, d: LoadedDeal): LoadedDeal {
  if (d.role !== 'visitor') return d;
  const key = newKey();
  const local: LocalDeal = {
    role: 'client',
    token: d.token,
    handle: d.handle,
    seed: key.seed,
    saved: false,
    title: d.terms.title,
    createdAt: ctx.now(),
    cache: { offer: d.offerJson, offerSignature: d.offerSignature, terms: d.rawTerms, dealId: null },
  };
  ctx.store.put(local);
  return { ...d, local, key, role: 'client', clientCode: fingerprint(key.pk) };
}

export function markKeySaved(ctx: Ctx, d: LoadedDeal): LoadedDeal {
  if (!d.local) return d;
  const local = { ...d.local, saved: true };
  ctx.store.put(local);
  return { ...d, local };
}

/**
 * The client joins with its own key, then checks ON-CHAIN that the deal has
 * this key, the creator's key and the signed terms. If another key joined
 * first, the link was used: do not pay.
 */
export async function joinDeal(ctx: Ctx, d: LoadedDeal): Promise<LoadedDeal> {
  const { key } = mustHave(d, 'client');
  if (d.deal) return d;
  if (d.revoked) throw new DealError('revoked', 'the creator cancelled this link');
  try {
    await ctx.api.join(d.handle, d.token, key.pk);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'already_joined') throw new DealError('used', 'this link was already used by someone else');
    if (e instanceof ApiError && e.code === 'revoked') throw new DealError('revoked', 'the creator cancelled this link');
    if (e instanceof ApiError && e.code === 'offer_expired') throw new DealError('expired', 'this link has expired');
    // A timeout: the join may have landed anyway; the chain decides below.
    if (!(e instanceof ApiError && (e.status === 504 || e.status === 0))) throw e;
  }
  const joined = await waitChain(ctx, d, (x) => x.deal !== null);
  if (!joined.deal) throw new ApiError(504, 'relayer_timeout', 'The network is slow. Reload this page in a minute.');
  if (joined.deal.client_pk !== key.pk) throw new DealError('used', 'this link was already used by someone else');
  ctx.store.put({ ...joined.local!, cache: { ...joined.local!.cache!, dealId: joined.dealId } });
  return { ...joined, local: ctx.store.get(d.handle) };
}

// ---------------------------------------------------------------- signed requests and actions

function signedServerRequest(ctx: Ctx, key: DealKey, dealId: number, kind: string, fields: Record<string, string>) {
  // Fresh and single-use: the server refuses a replay.
  const payload = JSON.stringify({ ...fields, issued_at_ns: msToNs(ctx.now()).toString(), nonce: randomHex(8) });
  return { payload, signature: sign(key, signedMessage(ctx.net.contractId, dealId, kind, payload)) };
}

/** The exact `act` call any NEAR account can send itself; built here, without our API. */
export function actCall(net: Net, dealId: number, action: string, payload: string, signature: string): ActCall {
  const withdraw = action === 'withdraw';
  return {
    contract_id: net.contractId,
    method_name: 'act',
    args: { deal_id: dealId, action, payload, signature },
    gas: withdraw ? '150000000000000' : '30000000000000',
    deposit: withdraw ? '2250000000000000000000' : '0',
  };
}

/** An action that did not go through. `call` lets the person send it without our server. */
export class ActionError extends Error {
  readonly call: ActCall;
  readonly serverDown: boolean;
  readonly code: string;
  constructor(message: string, code: string, call: ActCall, serverDown: boolean) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
    this.call = call;
    this.serverDown = serverDown;
  }
}

async function submit(ctx: Ctx, d: LoadedDeal, action: string, payload: string, signature: string): Promise<void> {
  const call = actCall(ctx.net, d.dealId!, action, payload, signature);
  try {
    const res = await ctx.api.action(d.handle, { action, payload, signature });
    if (res.ok === false) throw new ActionError(res.message ?? 'the transfer failed; try again', 'failed', call, false);
  } catch (e) {
    if (e instanceof ActionError) throw e;
    if (e instanceof ApiError) throw new ActionError(e.message, e.code, call, e.serverDown || e.code === 'low_balance');
    throw e;
  }
}

/** Signs and relays one deal action with this browser's key. */
export async function act(
  ctx: Ctx,
  d: LoadedDeal,
  action: 'cancel' | 'deliver' | 'refund' | 'accept' | 'dispute',
  fields: Record<string, string> = {},
): Promise<void> {
  const { dealId } = mustBeJoined(d);
  if (!d.key) throw new DealError('wrong_key', 'this browser has no key for this deal');
  // A random nonce makes a retry after a temporary failure a new submission.
  const payload = JSON.stringify({ ...fields, nonce: randomHex(8) });
  await submit(ctx, d, action, payload, sign(d.key, signedMessage(ctx.net.contractId, dealId, action, payload)));
}

// ---------------------------------------------------------------- client: pay

/**
 * Asks for a payment address with a signed request, reads the deal from the
 * chain first, and returns the address only after every browser-side check.
 */
export async function requestPayQuote(
  ctx: Ctx,
  d: LoadedDeal,
  choice: { originAsset: string; refundTo: string; coin: string; network: string },
): Promise<VerifiedPayQuote> {
  const { key } = mustHave(d, 'client');
  const { dealId } = mustBeJoined(d);
  const deal = await ctx.chain.getDeal(dealId);
  if (!deal || deal.client_pk !== key.pk) throw new DealError('used', 'this deal belongs to another key');
  checkChainDeal(deal, d.offer);
  if (deal.state !== 'Created') throw new DealError('state', 'this deal can no longer be paid');
  const refundTo = choice.refundTo.trim();
  const res = await ctx.api.payQuote(d.handle, signedServerRequest(ctx, key, dealId, 'pay-quote', { origin_asset: choice.originAsset, refund_address: refundTo }));
  const verified = checkPayQuote(
    res.quote_response,
    { dealId, amount: deal.amount, originAsset: choice.originAsset, refundTo, payByMs: nsToMs(deal.pay_by_ns) },
    ctx.net,
    ctx.now(),
  );
  ctx.store.put({ ...ctx.store.get(d.handle)!, payQuote: { response: res.quote_response, originAsset: choice.originAsset, refundTo, coin: choice.coin, network: choice.network } });
  return verified;
}

/** The address requested earlier, checked again from scratch; null if there is none or it is no longer good. */
export function storedPayQuote(ctx: Ctx, d: LoadedDeal): (VerifiedPayQuote & { coin: string; network: string }) | null {
  const q = ctx.store.get(d.handle)?.payQuote;
  if (!q || !d.deal || d.dealId === null) return null;
  try {
    const v = checkPayQuote(
      q.response,
      { dealId: d.dealId, amount: d.deal.amount, originAsset: q.originAsset, refundTo: q.refundTo, payByMs: nsToMs(d.deal.pay_by_ns) },
      ctx.net,
      ctx.now(),
      false,
    );
    return { ...v, coin: q.coin, network: q.network };
  } catch {
    return null;
  }
}

export function forgetPayQuote(ctx: Ctx, d: LoadedDeal): void {
  const local = ctx.store.get(d.handle);
  if (local?.payQuote) ctx.store.put({ ...local, payQuote: undefined });
}

// ---------------------------------------------------------------- notes

async function postNote(ctx: Ctx, d: LoadedDeal, kind: string, data: string): Promise<void> {
  await ctx.api.postNote(d.handle, d.token, signedServerRequest(ctx, d.key!, d.dealId!, 'note', { kind, data }));
}

/** A note must not hold back a time-critical action: with our server down it is sent later. */
async function postNoteUnlessDown(ctx: Ctx, d: LoadedDeal, kind: string, data: string): Promise<void> {
  try {
    await postNote(ctx, d, kind, data);
  } catch (e) {
    if (!(e instanceof ApiError && e.serverDown)) throw e;
  }
}

/** A stored note counts only if the right deal key (as on-chain) signed it. */
function noteData(ctx: Ctx, d: LoadedDeal, notes: NoteRecord[], kind: string, signerPk: string): string | null {
  const n = notes.find((x) => x.kind === kind);
  if (!n || !verify(signerPk, signedMessage(ctx.net.contractId, d.dealId!, 'note', n.payload), n.signature)) return null;
  try {
    const p = JSON.parse(n.payload) as { kind?: unknown; data?: unknown };
    return p.kind === kind && typeof p.data === 'string' ? p.data : null;
  } catch {
    return null;
  }
}

export interface DealNotes {
  delivery: DeliveryNote | null;
  dispute: DisputeNote | null;
  arbiterCopy: { creator: boolean; client: boolean };
}

/** Reads and decrypts what the parties left for each other. */
export async function readNotes(ctx: Ctx, d: LoadedDeal): Promise<DealNotes> {
  const { dealId, deal } = mustBeJoined(d);
  if (!d.key || (d.role !== 'creator' && d.role !== 'client')) throw new DealError('wrong_key', 'this browser has no key for this deal');
  const other = d.role === 'creator' ? deal.client_pk : deal.creator_pk;
  const res = await ctx.api.notes(d.handle, d.token);
  const read = async <T>(kind: string, signerPk: string): Promise<T | null> => {
    const data = noteData(ctx, d, res.notes, kind, signerPk);
    if (!data) return null;
    try {
      return await openFromParty<T>(d.key!, other, { contractId: ctx.net.contractId, dealId, kind }, data);
    } catch {
      return null;
    }
  };
  return {
    delivery: await read<DeliveryNote>('delivery', deal.creator_pk),
    dispute: await read<DisputeNote>('dispute', deal.client_pk),
    arbiterCopy: res.has_arbiter_copy,
  };
}

// ---------------------------------------------------------------- creator: deliver

/**
 * Delivers the work: the files link goes to the client encrypted, the
 * fingerprint of the files goes on-chain.
 */
export async function deliver(ctx: Ctx, d: LoadedDeal, link: string, files: FileLike[], onProgress?: (done: number, total: number) => void): Promise<void> {
  const { key, local } = mustHave(d, 'creator');
  const { dealId, deal } = mustBeJoined(d);
  const note: DeliveryNote = { link: link.trim(), salt: newFilesSalt() };
  const hash = filesFingerprint(note.salt, await filesManifest(files, onProgress));
  const data = await sealForParty(key, deal.client_pk, { contractId: ctx.net.contractId, dealId, kind: 'delivery' }, note);
  // Own copy first: if our server is down the delivery still goes out (it is
  // time-critical) and the link is sent again later (`resendNotes`).
  ctx.store.put({ ...local, delivery: note });
  await postNoteUnlessDown(ctx, d, 'delivery', data);
  await act(ctx, d, 'deliver', { deliverable_hash: hash });
}

/** Client: are these the delivered files? Compares with the fingerprint ON-CHAIN. */
export async function filesMatch(d: LoadedDeal, note: DeliveryNote, files: FileLike[], onProgress?: (done: number, total: number) => void): Promise<boolean> {
  const { deal } = mustBeJoined(d);
  return filesFingerprint(note.salt, await filesManifest(files, onProgress)) === deal.deliverable_hash;
}

/**
 * In a dispute the creator's browser sends its own copy of the files link
 * to the arbiter, so the arbiter compares both sides.
 * Returns true when a copy was sent now.
 */
export async function sendCreatorArbiterCopy(ctx: Ctx, d: LoadedDeal, notes: DealNotes): Promise<boolean> {
  if (d.role !== 'creator' || d.deal?.state !== 'Disputed' || notes.arbiterCopy.creator || !ctx.net.arbiterNoteKey) return false;
  const note = d.local?.delivery ?? notes.delivery;
  if (!note) return false;
  const data = await sealForArbiter(ctx.net.arbiterNoteKey, { contractId: ctx.net.contractId, dealId: d.dealId!, kind: 'delivery_arbiter' }, note);
  await postNote(ctx, d, 'delivery_arbiter', data);
  return true;
}

// ---------------------------------------------------------------- client: dispute

/**
 * Opens a dispute: the unmet point and the text go to the creator
 * (encrypted to the two deal keys) and, with the files link as the client
 * got it, to the arbiter (encrypted to the arbiter key); then the on-chain
 * `dispute`, which stops the review timer.
 */
export async function openDispute(ctx: Ctx, d: LoadedDeal, reason: DisputeNote, delivery: DeliveryNote | null): Promise<void> {
  const { key } = mustHave(d, 'client');
  const { dealId, deal } = mustBeJoined(d);
  const nc = (kind: string) => ({ contractId: ctx.net.contractId, dealId, kind });
  // Kept in this browser too: with our server down the dispute itself still
  // goes out before the review ends, and the reason is sent later (`resendNotes`).
  ctx.store.put({ ...ctx.store.get(d.handle)!, dispute: { reason, delivery } });
  await postNoteUnlessDown(ctx, d, 'dispute', await sealForParty(key, deal.creator_pk, nc('dispute'), reason));
  if (ctx.net.arbiterNoteKey) {
    const forArbiter: DisputeArbiterNote = { ...reason, delivery };
    await postNoteUnlessDown(ctx, d, 'dispute_arbiter', await sealForArbiter(ctx.net.arbiterNoteKey, nc('dispute_arbiter'), forArbiter));
  }
  await act(ctx, d, 'dispute');
}

/**
 * Sends again what did not reach our server when the action went out
 * (server down, action sent by hand): the creator's files link, the client's
 * dispute reason and the copy for the arbiter. Returns true if anything was sent.
 */
export async function resendNotes(ctx: Ctx, d: LoadedDeal, notes: DealNotes): Promise<boolean> {
  const { dealId, deal } = mustBeJoined(d);
  if (!d.key || !d.local || deal.purged) return false;
  const nc = (kind: string) => ({ contractId: ctx.net.contractId, dealId, kind });
  let sent = false;
  if (d.role === 'creator' && d.local.delivery && !notes.delivery && (deal.state === 'Delivered' || deal.state === 'Disputed')) {
    await postNote(ctx, d, 'delivery', await sealForParty(d.key, deal.client_pk, nc('delivery'), d.local.delivery));
    sent = true;
  }
  if (d.role === 'client' && d.local.dispute && deal.state === 'Disputed') {
    const { reason, delivery } = d.local.dispute;
    if (!notes.dispute) {
      await postNote(ctx, d, 'dispute', await sealForParty(d.key, deal.creator_pk, nc('dispute'), reason));
      sent = true;
    }
    if (!notes.arbiterCopy.client && ctx.net.arbiterNoteKey) {
      await postNote(ctx, d, 'dispute_arbiter', await sealForArbiter(ctx.net.arbiterNoteKey, nc('dispute_arbiter'), { ...reason, delivery }));
      sent = true;
    }
  }
  return sent;
}

// ---------------------------------------------------------------- "work it out" (settle)

export interface SettleView {
  signer: 'creator' | 'client';
  /** Share of the deal amount that goes to the creator, 0..100. */
  creatorPct: number;
  expiresMs: number;
  payload: string;
  signature: string;
  /** This browser's own proposal. */
  mine: boolean;
}

/** The timer a settle must beat: delivery deadline, review end or dispute end (ms); null = settle impossible. */
export function settleTimerMs(deal: DealView): number | null {
  const ns =
    deal.state === 'Funded' ? deal.delivery_deadline_ns : deal.state === 'Delivered' ? deal.review_ends_at_ns : deal.state === 'Disputed' ? deal.dispute_ends_at_ns : null;
  return ns ? nsToMs(ns) : null;
}

const SETTLE_TTL_MS = 24 * 3600 * 1000;

/** One side signs a split and leaves it for the other side (off-chain until both signed). */
export async function proposeSettle(ctx: Ctx, d: LoadedDeal, creatorPct: number): Promise<void> {
  if (!d.key || (d.role !== 'creator' && d.role !== 'client')) throw new DealError('wrong_key', 'this browser has no key for this deal');
  const { dealId } = mustBeJoined(d);
  const deal = (await ctx.chain.getDeal(dealId))!;
  const timer = settleTimerMs(deal);
  if (timer === null || timer <= ctx.now()) throw new DealError('state', 'it is too late to agree on a split for this deal');
  const payload = JSON.stringify({
    split_bps: String(Math.round(creatorPct * 100)),
    state: deal.state,
    seq: String(deal.settle_seq),
    expires_at_ns: msToNs(Math.min(ctx.now() + SETTLE_TTL_MS, timer)).toString(),
    nonce: randomHex(8),
  });
  await ctx.api.settleProposal(d.handle, d.token, { payload, signature: sign(d.key, signedMessage(ctx.net.contractId, dealId, 'settle', payload)) });
}

/** Open proposals that are still valid for the deal as it is on-chain now, each checked against its signer's key. */
export async function readProposals(ctx: Ctx, d: LoadedDeal): Promise<SettleView[]> {
  const { dealId, deal } = mustBeJoined(d);
  const out: SettleView[] = [];
  for (const p of await ctx.api.settleProposals(d.handle, d.token)) {
    const pk = p.signer === 'creator' ? deal.creator_pk : p.signer === 'client' ? deal.client_pk : null;
    if (!pk || !verify(pk, signedMessage(ctx.net.contractId, dealId, 'settle', p.payload), p.signature)) continue;
    try {
      const v = JSON.parse(p.payload) as Record<string, unknown>;
      const bps = Number(v.split_bps);
      const expiresMs = nsToMs(String(v.expires_at_ns));
      if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) continue;
      if (v.state !== deal.state || v.seq !== String(deal.settle_seq) || expiresMs <= ctx.now()) continue;
      out.push({ signer: p.signer, creatorPct: bps / 100, expiresMs, payload: p.payload, signature: p.signature, mine: p.signer === d.role });
    } catch {
      /* unreadable: skip */
    }
  }
  return out;
}

/** Signs the other side's split as it is; with both signatures the deal settles on-chain. */
export async function acceptSettle(ctx: Ctx, d: LoadedDeal, p: SettleView): Promise<void> {
  if (!d.key || p.mine || (d.role !== 'creator' && d.role !== 'client')) throw new DealError('wrong_key', 'this proposal cannot be accepted from this browser');
  const { dealId } = mustBeJoined(d);
  const own = sign(d.key, signedMessage(ctx.net.contractId, dealId, 'settle', p.payload));
  await ctx.api.settle(d.handle, d.token, {
    payload: p.payload,
    creator_signature: d.role === 'creator' ? own : p.signature,
    client_signature: d.role === 'client' ? own : p.signature,
  });
}

/** Takes back every split this deal's keys signed so far (on-chain `revoke_settle`). */
export async function revokeProposals(ctx: Ctx, d: LoadedDeal): Promise<void> {
  const { dealId } = mustBeJoined(d);
  if (!d.key) throw new DealError('wrong_key', 'this browser has no key for this deal');
  const deal = (await ctx.chain.getDeal(dealId))!;
  const payload = JSON.stringify({ seq: String(deal.settle_seq) });
  await submit(ctx, d, 'revoke_settle', payload, sign(d.key, signedMessage(ctx.net.contractId, dealId, 'revoke_settle', payload)));
}

// ---------------------------------------------------------------- withdraw

export interface PayoutChoice {
  destinationAsset: string;
  recipient: string;
  recipientType: 'DESTINATION_CHAIN' | 'CONFIDENTIAL_INTENTS';
}

/** What this browser's key can withdraw right now, read from the chain (never decided by `state`). */
export function ownPayout(d: LoadedDeal): { payout: bigint; pending: bigint; withdrawn: bigint } {
  const deal = d.deal;
  if (!deal || (d.role !== 'creator' && d.role !== 'client')) return { payout: 0n, pending: 0n, withdrawn: 0n };
  return d.role === 'creator'
    ? { payout: BigInt(deal.creator_payout), pending: BigInt(deal.creator_pending), withdrawn: BigInt(deal.creator_withdrawn) }
    : { payout: BigInt(deal.client_payout), pending: BigInt(deal.client_pending), withdrawn: BigInt(deal.client_withdrawn) };
}

/**
 * Sends this key's whole payout where the person chose: a signed payout
 * quote, every "before signing a withdraw" check, then the
 * signed `withdraw` action.
 */
export async function withdraw(ctx: Ctx, d: LoadedDeal, choice: PayoutChoice): Promise<{ amountOutFormatted: string | null }> {
  if (!d.key || (d.role !== 'creator' && d.role !== 'client')) throw new DealError('wrong_key', 'this browser has no key for this deal');
  const { dealId } = mustBeJoined(d);
  const deal = (await ctx.chain.getDeal(dealId))!;
  const { payout, pending } = ownPayout({ ...d, deal });
  if (pending > 0n) throw new DealError('state', 'a withdrawal is already on its way');
  if (payout <= 0n) throw new DealError('state', 'there is nothing to withdraw');
  const recipient = choice.recipient.trim();
  const quote = await ctx.api.payoutQuote(
    d.handle,
    signedServerRequest(ctx, d.key, dealId, 'payout-quote', { destination_asset: choice.destinationAsset, recipient, recipient_type: choice.recipientType }),
  );
  const v = checkPayoutQuote(
    quote,
    { ownPk: d.key.pk, amount: payout.toString(), destinationAsset: choice.destinationAsset, recipient, recipientType: choice.recipientType },
    ctx.net,
    ctx.now(),
  );
  await submit(ctx, d, 'withdraw', v.withdrawPayload, sign(d.key, signedMessage(ctx.net.contractId, dealId, 'withdraw', v.withdrawPayload)));
  return { amountOutFormatted: v.amountOutFormatted };
}

// ---------------------------------------------------------------- creator: cancel the link / timers

/** The creator cancels a link nobody accepted yet. */
export async function revokeLink(ctx: Ctx, d: LoadedDeal): Promise<void> {
  const { key } = mustHave(d, 'creator');
  await ctx.api.revoke(d.handle, sign(key, revokeOfferMessage(ctx.net.contractId, d.offerJson)));
}

/** Which timer has run out, so anyone may finish the deal (`POST …/timeout`). */
export function timerOver(deal: DealView, nowMs: number): 'review' | 'dispute' | 'pay' | null {
  if (deal.state === 'Delivered' && deal.review_ends_at_ns && nowMs > nsToMs(deal.review_ends_at_ns)) return 'review';
  if (deal.state === 'Disputed' && deal.dispute_ends_at_ns && nowMs > nsToMs(deal.dispute_ends_at_ns)) return 'dispute';
  if (deal.state === 'Created' && !deal.purged && nowMs > nsToMs(deal.funding_cutoff_ns)) return 'pay';
  return null;
}

export async function finishTimer(ctx: Ctx, d: LoadedDeal): Promise<void> {
  await ctx.api.timeout(d.handle, d.token);
}

export { waitChain };
