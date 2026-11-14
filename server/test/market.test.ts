// Marketplace (marketplace/API.md): profiles, catalog, requests,
// inbox, decline / cancel, deal from request, reviews and their counters.
// Mocked chain (FakeChain), in-memory SQLite.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { parsePublicKey, sha256Hex } from '../src/encoding.ts';
import {
  declineMessage,
  inboxMessage,
  profileIdOf,
  profileWriteMessage,
  requestDealMessage,
  reviewMessage,
  reviewReplyMessage,
  type Market,
} from '../src/market.ts';
import { MarketStore } from '../src/market-store.ts';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey, type OfferBundle } from './helpers.ts';

let chain: FakeChain;
let app: FastifyInstance;
let store: SqliteStore;
let clock = Date.now();

async function setup(overrides: Partial<Config> = {}) {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  store = new SqliteStore(':memory:');
  app = await buildApp({
    config: { ...testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000 }), ...overrides },
    chain,
    oneClick: new FakeOneClick(),
    store,
    now: () => clock,
  });
}
beforeEach(async () => setup());

const market = () => (app as unknown as { market: Market }).market;

type PKey = DealKey & { id: string };
function profKey(seed: number): PKey {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
}
const alice = profKey(31);
const bob = profKey(32);
const creatorDeal = keyFromSeed(33);
const clientDeal = keyFromSeed(34);
const stranger = keyFromSeed(35);

/** Expiry `aheadMs` from the test clock; +1 ns each call, so two signatures are never byte-identical (ed25519 is deterministic). */
let seq = 0n;
const exp = (aheadMs = 5 * 60_000) => ((BigInt(clock) + BigInt(aheadMs)) * 1_000_000n + seq++).toString();

function baseProfile(over: Record<string, unknown> = {}) {
  return {
    nickname: 'Alice Motion',
    bio: 'Logo animations for crypto projects',
    categories: ['motion', 'video'],
    portfolio: ['https://www.behance.net/alice'],
    contacts: [{ kind: 'telegram', value: '@alice_motion' }],
    services: [
      { title: 'Logo animation', description: '10 s, 4k', price_from_usdc: 150, delivery_days: 5 },
      { title: 'Explainer video', description: '60 s', price_from_usdc: 600, delivery_days: 14 },
    ],
    ...over,
  };
}

function put(k: PKey, profile: unknown, o: { exp?: string; sig?: string; id?: string; pk?: string; ip?: string } = {}) {
  const e = o.exp ?? exp();
  const sig = o.sig ?? k.signRaw(profileWriteMessage(CONTRACT_ID, o.id ?? k.id, profile, e));
  return app.inject({
    method: 'PUT',
    url: `/api/profiles/${o.id ?? k.id}`,
    payload: { profile_pk: o.pk ?? k.pk, profile, expires_at_ns: e, sig },
    remoteAddress: o.ip,
  });
}

async function createProfile(k: PKey, over: Record<string, unknown> = {}, ip?: string) {
  const r = await put(k, baseProfile(over), { ip });
  assert.equal(r.statusCode, 201, r.body);
  return r.json();
}

function newRequest(profileId: string, over: Record<string, unknown> = {}, ip?: string) {
  const token = randomBytes(16).toString('hex');
  const handle = sha256Hex(token);
  const payload = {
    handle,
    profile_id: profileId,
    brief: 'Need a 10 s logo animation for our launch',
    wanted_deadline: new Date(clock + 7 * 86400_000).toISOString().slice(0, 10),
    client_contact: { kind: 'telegram', value: '@client_secret_contact' },
    client_box_pk: randomBytes(32).toString('hex'),
    ...over,
  };
  return { token, handle, payload, send: () => app.inject({ method: 'POST', url: '/api/requests', payload, remoteAddress: ip }) };
}

async function openRequest(profileId: string, over: Record<string, unknown> = {}) {
  const r = newRequest(profileId, over);
  const res = await r.send();
  assert.equal(res.statusCode, 201, res.body);
  // The answer carries the creator's profile key, which the client's browser pins.
  assert.deepEqual(res.json(), { handle: r.handle, profile_pk: (await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } })).json().profile.profile_pk });
  return r;
}

function inbox(k: PKey, o: { e?: string; sig?: string; signer?: DealKey } = {}) {
  const e = o.e ?? exp();
  const sig = o.sig ?? (o.signer ?? k).signRaw(inboxMessage(CONTRACT_ID, k.id, e));
  const q = new URLSearchParams({ profile_pk: k.pk, expires_at_ns: e, sig });
  return app.inject({ method: 'GET', url: `/api/profiles/${k.id}/requests?${q}` });
}

const BOX = { epk: 'a'.repeat(64), iv: 'b'.repeat(24), ct: 'c'.repeat(96) };

/** The creator's browser: a deal offer + the request link fields. */
async function dealFromRequest(k: PKey, requestHandle: string, o: { signer?: DealKey; e?: string; sig?: string; creator?: DealKey } = {}) {
  const creator = o.creator ?? creatorDeal;
  const b = makeOffer(creator, { nowMs: clock });
  const e = o.e ?? exp();
  const sig = o.sig ?? (o.signer ?? k).signRaw(requestDealMessage(CONTRACT_ID, requestHandle, creator.pk, e));
  const res = await app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: {
      handle: b.handle,
      offer: b.offer,
      offer_signature: b.offer_signature,
      terms: b.terms,
      request_handle: requestHandle,
      request_expires_at_ns: e,
      request_sig: sig,
      deal_link_box: BOX,
    },
  });
  return { b, res, sig };
}

async function join(b: OfferBundle, client = clientDeal): Promise<number> {
  const r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: client.pk } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().deal_id;
}

/** Ends a deal on the fake chain the way the contract would leave it. */
function finish(id: number, how: 'released' | 'refunded' | 'unpaid_refund') {
  const d = chain.deals[id];
  const ended_at_ns = chain.nowNs().toString();
  if (how === 'unpaid_refund') {
    Object.assign(d, { state: 'Refunded', funded_amount: '0', ended_at_ns });
    return;
  }
  chain.fund(id, d.amount);
  if (how === 'released') Object.assign(d, { state: 'Released', outcome: 'Accepted', creator_payout: '4850000', fee_amount: '150000', ended_at_ns });
  else Object.assign(d, { state: 'Refunded', outcome: 'RefundedByCreator', client_payout: d.amount, creator_payout: '0', ended_at_ns });
}

function postReview(b: OfferBundle, id: number, profileId: string, rating: number, text: string, o: { signer?: DealKey; e?: string; sig?: string; token?: string } = {}) {
  const e = o.e ?? exp();
  const sig = o.sig ?? (o.signer ?? clientDeal).signRaw(reviewMessage(CONTRACT_ID, id, profileId, rating, text, e));
  return app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/review`,
    headers: { 'x-deal-token': o.token ?? b.token },
    payload: { rating, text, expires_at_ns: e, sig },
  });
}

/** A finished, linked deal ready for a review. */
async function linkedDeal(k: PKey, how: 'released' | 'refunded' | 'unpaid_refund' | null = 'released', client = clientDeal) {
  const r = await openRequest(k.id);
  const { b, res } = await dealFromRequest(k, r.handle);
  assert.equal(res.statusCode, 201, res.body);
  const id = await join(b, client);
  if (how) finish(id, how);
  return { r, b, id };
}

// ---------------------------------------------------------------- profiles

test('profile: create, read, update keeps service ids, new service gets one', async () => {
  const created = await createProfile(alice);
  assert.equal(created.ok, true);
  assert.equal(created.profile_id, alice.id);
  assert.equal(created.services.length, 2);
  for (const s of created.services) assert.match(s.id, /^[0-9a-f]{8}$/);

  const g = await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` });
  assert.equal(g.statusCode, 200);
  const p = g.json();
  assert.equal(p.nickname, 'Alice Motion');
  assert.deepEqual(p.categories, ['motion', 'video']);
  assert.deepEqual(p.contacts, [{ kind: 'telegram', value: '@alice_motion' }]);
  assert.equal(p.finished_deals, 0);
  assert.equal(p.rating_avg, null);
  assert.equal(p.reviews_count, 0);
  assert.deepEqual(p.reviews, []);
  assert.match(p.updated_month, /^\d{4}-\d{2}$/);
  // No key, no exact dates in public output.
  assert.equal(p.profile_pk, undefined);
  assert.equal(p.created_at, undefined);
  assert.ok(!g.body.includes(alice.pk));

  const keep = created.services[0];
  const upd = await put(alice, baseProfile({ nickname: 'Alice M.', services: [keep, { title: 'GIF', description: '', price_from_usdc: 50, delivery_days: 2 }] }));
  assert.equal(upd.statusCode, 200, upd.body);
  const after = upd.json();
  assert.equal(after.nickname, 'Alice M.');
  assert.equal(after.services[0].id, keep.id);
  assert.notEqual(after.services[1].id, created.services[1].id);
  const cat = (await app.inject({ method: 'GET', url: '/api/profiles' })).json();
  assert.equal(cat.items[0].price_from_usdc, 50);
});

test('profile: signature, id and expiry checks', async () => {
  const prof = baseProfile();
  // Signed by another key.
  let r = await put(alice, prof, { sig: bob.signRaw(profileWriteMessage(CONTRACT_ID, alice.id, prof, exp())) });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, 'invalid_signature');
  // Signed over different content.
  r = await put(alice, prof, { sig: alice.signRaw(profileWriteMessage(CONTRACT_ID, alice.id, { ...prof, nickname: 'Other' }, exp())) });
  assert.equal(r.statusCode, 401);
  // The id must be the hash of the key.
  r = await put(alice, prof, { id: bob.id });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'id_mismatch');
  // Not a key.
  r = await put(alice, prof, { pk: 'ed25519:xyz' });
  assert.equal(r.statusCode, 400);
  // Expired / too far ahead / not a number.
  const past = ((BigInt(clock) - 1000n) * 1_000_000n).toString();
  r = await put(alice, prof, { exp: past });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, 'signature_expired');
  r = await put(alice, prof, { exp: exp(11 * 60_000) });
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, 'expiry_too_far');
  r = await put(alice, prof, { exp: '0012' });
  assert.equal(r.statusCode, 400);
  // Bad signature encoding.
  r = await put(alice, prof, { sig: 'abc' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'bad_signature_encoding');
  // A signature for another contract.
  r = await put(alice, prof, { sig: alice.signRaw(profileWriteMessage('other.near', alice.id, prof, exp())) });
  assert.equal(r.statusCode, 401);
  // Nothing was stored.
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).statusCode, 404);
});

test('profile: a signed write is single use (replay refused, also after the next write)', async () => {
  const prof = baseProfile();
  const e = exp();
  const sig = alice.signRaw(profileWriteMessage(CONTRACT_ID, alice.id, prof, e));
  assert.equal((await put(alice, prof, { exp: e, sig })).statusCode, 201);
  const again = await put(alice, prof, { exp: e, sig });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().error, 'replayed_request');
  // The replay cache is in the DB: a new app on the same store still refuses it.
  const app2 = await buildApp({ config: testConfig(), chain, oneClick: new FakeOneClick(), store, now: () => clock });
  const r2 = await app2.inject({ method: 'PUT', url: `/api/profiles/${alice.id}`, payload: { profile_pk: alice.pk, profile: prof, expires_at_ns: e, sig } });
  assert.equal(r2.statusCode, 401);
  assert.equal(r2.json().error, 'replayed_request');
});

test('profile: field limits (characters, not bytes) and strict fields', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['nickname 1 char', { nickname: 'A' }],
    ['nickname 33 chars', { nickname: 'x'.repeat(33) }],
    ['nickname newline', { nickname: 'Al\nice' }],
    ['nickname bidi override', { nickname: 'Ali‮ce' }],
    ['bio 401', { bio: 'b'.repeat(401) }],
    ['no categories', { categories: [] }],
    ['4 categories', { categories: ['video', 'motion', 'design', 'code'] }],
    ['unknown category', { categories: ['music'] }],
    ['repeated category', { categories: ['video', 'video'] }],
    ['http link', { portfolio: ['http://example.com/x'] }],
    ['javascript link', { portfolio: ['javascript:alert(1)'] }],
    ['link with password', { portfolio: ['https://u:p@example.com'] }],
    ['link 301 chars', { portfolio: [`https://example.com/${'a'.repeat(281)}`] }],
    ['9 links', { portfolio: Array(9).fill('https://example.com') }],
    ['6 contacts', { contacts: Array(6).fill({ kind: 'x', value: '@a' }) }],
    ['bad contact kind', { contacts: [{ kind: 'icq', value: '1' }] }],
    ['empty contact', { contacts: [{ kind: 'x', value: ' ' }] }],
    ['contact 101', { contacts: [{ kind: 'x', value: 'a'.repeat(101) }] }],
    ['11 services', { services: Array(11).fill({ title: 't', description: '', price_from_usdc: 1, delivery_days: 1 }) }],
    ['price 0', { services: [{ title: 't', description: '', price_from_usdc: 0, delivery_days: 1 }] }],
    ['price 2001', { services: [{ title: 't', description: '', price_from_usdc: 2001, delivery_days: 1 }] }],
    ['price 1.5', { services: [{ title: 't', description: '', price_from_usdc: 1.5, delivery_days: 1 }] }],
    ['price as string', { services: [{ title: 't', description: '', price_from_usdc: '5', delivery_days: 1 }] }],
    ['days 91', { services: [{ title: 't', description: '', price_from_usdc: 5, delivery_days: 91 }] }],
    ['title 81', { services: [{ title: 't'.repeat(81), description: '', price_from_usdc: 5, delivery_days: 1 }] }],
    ['description 601', { services: [{ title: 't', description: 'd'.repeat(601), price_from_usdc: 5, delivery_days: 1 }] }],
    ['unknown service id', { services: [{ id: 'deadbeef', title: 't', description: '', price_from_usdc: 5, delivery_days: 1 }] }],
    ['unknown field', { avatar: 'https://example.com/a.png' }],
    ['unknown service field', { services: [{ title: 't', description: '', price_from_usdc: 5, delivery_days: 1, budget: 9 }] }],
  ];
  for (const [name, over] of cases) {
    const r = await put(alice, baseProfile(over));
    assert.equal(r.statusCode, 400, `${name}: ${r.body}`);
    assert.equal(r.json().error, 'bad_profile', name);
  }
  // Limits count characters: 32 Cyrillic letters (64 bytes) and a 400-char emoji bio are fine.
  const ok = await put(alice, baseProfile({ nickname: 'Ж'.repeat(32), bio: '🎬'.repeat(400), categories: ['other'], portfolio: [], contacts: [], services: [] }));
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().price_from_usdc, undefined);
  const card = (await app.inject({ method: 'GET', url: '/api/profiles' })).json().items[0];
  assert.equal(card.price_from_usdc, null);
});

test('profile: per-profile and per-IP write limits', async () => {
  await createProfile(alice);
  let last = 0;
  for (let i = 0; i < 10; i++) last = (await put(alice, baseProfile({ bio: `v${i}` }))).statusCode;
  assert.equal(last, 429);
  clock += 61_000;
  assert.equal((await put(alice, baseProfile({ bio: 'later' }))).statusCode, 200);

  await setup({ rateWritesPerMin: 3 });
  for (let i = 0; i < 3; i++) assert.notEqual((await put(alice, baseProfile({ bio: `w${i}` }))).statusCode, 429);
  assert.equal((await put(alice, baseProfile({ bio: 'w4' }))).statusCode, 429);
});

test('profile: new profiles per network per day are capped', async () => {
  for (let i = 0; i < 20; i++) {
    const k = profKey(100 + i);
    assert.equal((await put(k, baseProfile(), { ip: '10.1.1.5' })).statusCode, 201);
  }
  const r = await put(profKey(200), baseProfile(), { ip: '10.1.1.77' });
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, 'daily_cap');
  assert.equal((await put(profKey(201), baseProfile(), { ip: '10.9.9.9' })).statusCode, 201);
});

test('profile: DELETE hides own profile (signed); a later PUT shows it again; operator hide stays', async () => {
  await createProfile(alice);
  const del = (k: PKey, signer: DealKey, e = exp()) =>
    app.inject({
      method: 'DELETE',
      url: `/api/profiles/${k.id}`,
      payload: { profile_pk: k.pk, delete: true, expires_at_ns: e, sig: signer.signRaw(profileWriteMessage(CONTRACT_ID, k.id, { delete: true }, e)) },
    });
  assert.equal((await del(alice, bob)).statusCode, 401);
  const r = await del(alice, alice);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true, profile_id: alice.id, hidden: true });
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/profiles' })).json().items.length, 0);
  // Requests to a hidden profile are refused.
  assert.equal((await newRequest(alice.id).send()).statusCode, 404);

  const back = await put(alice, baseProfile());
  assert.equal(back.statusCode, 200);
  assert.equal(back.json().hidden, false);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).statusCode, 200);

  assert.equal(market().store.setOperatorHidden(alice.id, true), true);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).statusCode, 404);
  const still = await put(alice, baseProfile({ bio: 'edit while hidden' }));
  assert.equal(still.statusCode, 200);
  assert.equal(still.json().hidden, true);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).statusCode, 404);
  // DELETE of a missing profile.
  assert.equal((await del(bob, bob)).statusCode, 404);
});

// ---------------------------------------------------------------- catalog

test('catalog: category filter, search (any case, Cyrillic), pages of 24', async () => {
  await createProfile(alice);
  await createProfile(bob, { nickname: 'Борис Дизайн', categories: ['design'], services: [{ title: 'Баннер для X', description: '', price_from_usdc: 20, delivery_days: 3 }] });
  const get = async (qs: string) => {
    const r = await app.inject({ method: 'GET', url: `/api/profiles${qs}` });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  assert.deepEqual((await get('?category=design')).items.map((c: { nickname: string }) => c.nickname), ['Борис Дизайн']);
  assert.equal((await get('?category=motion')).items[0].nickname, 'Alice Motion');
  assert.equal((await get(`?q=${encodeURIComponent('баннер')}`)).items[0].profile_id, bob.id);
  assert.equal((await get('?q=LOGO')).items[0].profile_id, alice.id);
  assert.equal((await get('?q=%25')).items.length, 0);
  const card = (await get('?category=motion')).items[0];
  assert.deepEqual(Object.keys(card).sort(), ['avatar', 'categories', 'finished_deals', 'nickname', 'price_from_usdc', 'profile_id', 'rating_avg', 'reviews_count', 'since_month']);
  assert.equal(card.price_from_usdc, 150);
  assert.equal((await app.inject({ method: 'GET', url: '/api/profiles?category=music' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles?q=${'x'.repeat(65)}` })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/profiles?cursor=abc' })).statusCode, 400);

  for (let i = 0; i < 28; i++) await createProfile(profKey(60 + i), { nickname: `Creator ${i}` }, `10.50.${i}.1`);
  const p1 = await get('');
  assert.equal(p1.items.length, 24);
  assert.equal(p1.next_cursor, '24');
  const p2 = await get(`?cursor=${p1.next_cursor}`);
  assert.equal(p2.items.length, 6);
  assert.equal(p2.next_cursor, null);
  const ids = new Set([...p1.items, ...p2.items].map((c: { profile_id: string }) => c.profile_id));
  assert.equal(ids.size, 30);
});

// ---------------------------------------------------------------- requests

test('request: create and read with the token; no client contact outside the inbox', async () => {
  const prof = await createProfile(alice);
  const r = await openRequest(alice.id, { service_id: prof.services[0].id });
  const g = await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } });
  assert.equal(g.statusCode, 200, g.body);
  const v = g.json();
  assert.equal(v.status, 'open');
  assert.deepEqual(v.profile, { profile_id: alice.id, nickname: 'Alice Motion', avatar: null, profile_pk: alice.pk, recent_change: null, key_changing: false });
  assert.deepEqual(v.service, { id: prof.services[0].id, title: 'Logo animation', price_from_usdc: 150, delivery_days: 5 });
  assert.equal(v.brief, 'Need a 10 s logo animation for our launch');
  assert.equal(v.deal_link_box, null);
  assert.ok(!g.body.includes('client_secret_contact'));
  assert.equal(v.client_contact, undefined);
  // Without / with a wrong token: 404 (no oracle).
  assert.equal((await app.inject({ method: 'GET', url: `/api/requests/${r.handle}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': 'f'.repeat(32) } })).statusCode, 404);
  // The public profile and catalog never show it either.
  assert.ok(!(await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).body.includes('client_secret_contact'));
  assert.ok(!(await app.inject({ method: 'GET', url: '/api/profiles' })).body.includes('client_secret_contact'));
  // The service snapshot stays when the creator later changes the service.
  await put(alice, baseProfile({ services: [] }));
  const g2 = (await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } })).json();
  assert.equal(g2.service.title, 'Logo animation');
});

test('request: validation', async () => {
  await createProfile(alice);
  const cases: [string, Record<string, unknown>, number][] = [
    ['unknown profile', { profile_id: bob.id }, 404],
    ['bad profile id', { profile_id: 'xyz' }, 404],
    ['unknown service', { service_id: 'deadbeef' }, 400],
    ['empty brief', { brief: '   ' }, 400],
    ['brief 2001', { brief: 'b'.repeat(2001) }, 400],
    ['no contact', { client_contact: undefined }, 400],
    ['bad contact kind', { client_contact: { kind: 'fax', value: '1' } }, 400],
    ['contact 101', { client_contact: { kind: 'x', value: 'a'.repeat(101) } }, 400],
    ['bad date', { wanted_deadline: '2026-02-30' }, 400],
    ['date format', { wanted_deadline: '12.11.2026' }, 400],
    ['date in the past', { wanted_deadline: '2020-01-01' }, 400],
    ['bad handle', { handle: 'abc' }, 400],
    ['bad box key', { client_box_pk: 'zz' }, 400],
  ];
  for (const [name, over, status] of cases) {
    const r = await newRequest(alice.id, over).send();
    assert.equal(r.statusCode, status, `${name}: ${r.body}`);
  }
  // Brief limit counts characters: 2000 Cyrillic letters are fine, no wanted date is fine.
  const ok = await newRequest(alice.id, { brief: 'щ'.repeat(2000), wanted_deadline: undefined }).send();
  assert.equal(ok.statusCode, 201, ok.body);
  // The same handle twice.
  const r = newRequest(alice.id);
  assert.equal((await r.send()).statusCode, 201);
  assert.equal((await r.send()).statusCode, 409);
});

test('request: daily caps per network+creator, per network, per creator', async () => {
  await createProfile(alice);
  await createProfile(bob, { nickname: 'Bob' });
  for (let i = 0; i < 5; i++) assert.equal((await newRequest(alice.id, {}, '10.2.2.2').send()).statusCode, 201);
  const sixth = await newRequest(alice.id, {}, '10.2.2.3').send();
  assert.equal(sixth.statusCode, 429);
  assert.equal(sixth.json().error, 'daily_cap');
  // Another creator from the same network is still fine; another network to Alice too.
  assert.equal((await newRequest(bob.id, {}, '10.2.2.2').send()).statusCode, 201);
  assert.equal((await newRequest(alice.id, {}, '10.3.3.3').send()).statusCode, 201);
  // After a day the pair cap is free again.
  clock += 24 * 3600_000 + 1000;
  assert.equal((await newRequest(alice.id, {}, '10.2.2.2').send()).statusCode, 201);
});

// ---------------------------------------------------------------- inbox, decline, cancel

test('inbox: signed by the profile key; has the client contact; single use', async () => {
  const prof = await createProfile(alice);
  const r = await openRequest(alice.id, { service_id: prof.services[1].id });
  const e = exp();
  const sig = alice.signRaw(inboxMessage(CONTRACT_ID, alice.id, e));
  const ok = await inbox(alice, { e, sig });
  assert.equal(ok.statusCode, 200, ok.body);
  const items = ok.json().items;
  assert.equal(items.length, 1);
  assert.equal(items[0].handle, r.handle);
  assert.equal(items[0].status, 'open');
  assert.deepEqual(items[0].client_contact, { kind: 'telegram', value: '@client_secret_contact' });
  assert.equal(items[0].service.title, 'Explainer video');
  assert.equal(items[0].client_box_pk, r.payload.client_box_pk);
  assert.match(items[0].created_at, /^\d{4}-\d{2}-\d{2}T/);
  // Replay, wrong key, expired, missing.
  assert.equal((await inbox(alice, { e, sig })).json().error, 'replayed_request');
  assert.equal((await inbox(alice, { signer: bob })).statusCode, 401);
  assert.equal((await inbox(alice, { e: ((BigInt(clock) - 1n) * 1_000_000n).toString() })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/requests` })).statusCode, 400);
  // Bob's inbox does not have Alice's requests (and needs Bob's key).
  await createProfile(bob, { nickname: 'Bob' });
  assert.equal((await inbox(bob)).json().items.length, 0);
  assert.equal((await inbox(bob, { signer: alice })).statusCode, 401);
  // Another profile_pk in the query.
  const q = new URLSearchParams({ profile_pk: bob.pk, expires_at_ns: e, sig });
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/requests?${q}` })).statusCode, 403);
});

function decline(k: PKey, handle: string, signer: DealKey = k, e = exp()) {
  return app.inject({
    method: 'POST',
    url: `/api/requests/${handle}/decline`,
    payload: { profile_pk: k.pk, expires_at_ns: e, sig: signer.signRaw(declineMessage(CONTRACT_ID, handle, e)) },
  });
}
const cancel = (r: { handle: string; token: string }, token = r.token) =>
  app.inject({ method: 'POST', url: `/api/requests/${r.handle}/cancel`, headers: { 'x-request-token': token }, payload: {} });
const status = async (r: { handle: string; token: string }) =>
  (await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } })).json().status;

test('decline (creator) and cancel (client)', async () => {
  await createProfile(alice);
  await createProfile(bob, { nickname: 'Bob' });
  const r1 = await openRequest(alice.id);
  assert.equal((await decline(alice, r1.handle, bob)).statusCode, 401);
  const d = await decline(alice, r1.handle);
  assert.equal(d.statusCode, 200, d.body);
  assert.deepEqual(d.json(), { ok: true, handle: r1.handle, status: 'declined' });
  assert.equal(await status(r1), 'declined');
  assert.equal((await cancel(r1)).statusCode, 409);
  assert.equal((await decline(alice, r1.handle)).statusCode, 200); // idempotent
  // Another profile's key cannot decline.
  assert.equal((await decline(bob, r1.handle)).statusCode, 403);

  const r2 = await openRequest(alice.id);
  assert.equal((await cancel(r2, 'a'.repeat(32))).statusCode, 404);
  const c = await cancel(r2);
  assert.equal(c.statusCode, 200, c.body);
  assert.equal(await status(r2), 'cancelled');
  assert.equal((await cancel(r2)).statusCode, 200); // idempotent
  assert.equal((await decline(alice, r2.handle)).json().error, 'cancelled');
  // A deal cannot be made from a declined / cancelled request.
  assert.equal((await dealFromRequest(alice, r1.handle)).res.json().error, 'request_closed');
  assert.equal((await dealFromRequest(alice, r2.handle)).res.json().error, 'request_closed');
  assert.equal((await decline(alice, 'f'.repeat(64))).statusCode, 404);
});

// ---------------------------------------------------------------- deal from request

test('deal from request: linked, request shows the encrypted link; cancel/decline then refused', async () => {
  await createProfile(alice);
  const r = await openRequest(alice.id);
  const { b, res } = await dealFromRequest(alice, r.handle);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().request_linked, true);
  const v = (await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } })).json();
  assert.equal(v.status, 'deal_ready');
  assert.deepEqual(v.deal_link_box, BOX);
  const c = await cancel(r);
  assert.equal(c.statusCode, 409);
  assert.equal(c.json().error, 'deal_created');
  assert.equal((await decline(alice, r.handle)).json().error, 'deal_created');
  // The deal itself is a normal deal.
  const g = await app.inject({ method: 'GET', url: `/api/deals/${b.handle}`, headers: { 'x-deal-token': b.token } });
  assert.equal(g.statusCode, 200);
  // A second deal from the same request only after the first link was cancelled; it replaces the link shown.
  assert.equal((await dealFromRequest(alice, r.handle)).res.json().error, 'deal_live');
  store.markRevoked(b.handle);
  const second = await dealFromRequest(alice, r.handle);
  assert.equal(second.res.statusCode, 201, second.res.body);
});

test('deal from request: bad signatures store nothing', async () => {
  await createProfile(alice);
  await createProfile(bob, { nickname: 'Bob' });
  const r = await openRequest(alice.id);
  const check = async (o: Parameters<typeof dealFromRequest>[2], code: number, error: string) => {
    const { b, res } = await dealFromRequest(alice, r.handle, o);
    assert.equal(res.statusCode, code, res.body);
    assert.equal(res.json().error, error);
    assert.equal((await app.inject({ method: 'GET', url: `/api/deals/${b.handle}`, headers: { 'x-deal-token': b.token } })).statusCode, 404);
  };
  await check({ signer: bob }, 401, 'invalid_signature');
  // Signed for another deal key than the one in the offer.
  await check({ sig: alice.signRaw(requestDealMessage(CONTRACT_ID, r.handle, stranger.pk, exp())) }, 401, 'invalid_signature');
  await check({ e: ((BigInt(clock) - 1n) * 1_000_000n).toString() }, 401, 'signature_expired');
  await check({ e: exp(20 * 60_000) }, 401, 'expiry_too_far');
  // Replay of a used request signature on a new deal.
  const ok = await dealFromRequest(alice, r.handle);
  assert.equal(ok.res.statusCode, 201);
  store.markRevoked(ok.b.handle);
  const e = exp();
  const sig = alice.signRaw(requestDealMessage(CONTRACT_ID, r.handle, creatorDeal.pk, e));
  const used = await dealFromRequest(alice, r.handle, { e, sig });
  assert.equal(used.res.statusCode, 201);
  store.markRevoked(used.b.handle);
  await check({ e, sig }, 401, 'replayed_request');
  // Unknown request.
  const { res } = await dealFromRequest(alice, 'e'.repeat(64));
  assert.equal(res.statusCode, 404);
  // A bad box.
  const b = makeOffer(creatorDeal, { nowMs: clock });
  const e2 = exp();
  const bad = await app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: {
      handle: b.handle,
      offer: b.offer,
      offer_signature: b.offer_signature,
      terms: b.terms,
      request_handle: r.handle,
      request_expires_at_ns: e2,
      request_sig: alice.signRaw(requestDealMessage(CONTRACT_ID, r.handle, creatorDeal.pk, e2)),
      deal_link_box: { epk: 'x', iv: '', ct: '' },
    },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'bad_box');
});

test('deal from request: deal_link_box limits; the box is stored opaque and returned only with the request token', async () => {
  await createProfile(alice);
  const r = await openRequest(alice.id);
  const send = (box: unknown) => {
    const b = makeOffer(creatorDeal, { nowMs: clock });
    const e = exp();
    return app.inject({
      method: 'POST',
      url: '/api/deals',
      payload: {
        handle: b.handle,
        offer: b.offer,
        offer_signature: b.offer_signature,
        terms: b.terms,
        request_handle: r.handle,
        request_expires_at_ns: e,
        request_sig: alice.signRaw(requestDealMessage(CONTRACT_ID, r.handle, creatorDeal.pk, e)),
        deal_link_box: box,
      },
    });
  };
  const bads: [string, unknown][] = [
    ['not an object', 'abc'],
    ['epk short', { ...BOX, epk: 'a'.repeat(62) }],
    ['epk upper case', { ...BOX, epk: 'A'.repeat(64) }],
    ['iv 16 hex', { ...BOX, iv: 'b'.repeat(16) }],
    ['ct 16 bytes (no room for the tag)', { ...BOX, ct: 'c'.repeat(32) }],
    ['ct 257 bytes', { ...BOX, ct: 'c'.repeat(514) }],
    ['ct odd length', { ...BOX, ct: 'c'.repeat(97) }],
    ['ct not hex', { ...BOX, ct: 'z'.repeat(96) }],
  ];
  for (const [name, box] of bads) {
    const res = await send(box);
    assert.equal(res.statusCode, 400, `${name}: ${res.body}`);
    assert.equal(res.json().error, 'bad_box', name);
  }
  // Still open: nothing was linked.
  assert.equal(await status(r), 'open');
  const big = { epk: 'd'.repeat(64), iv: 'e'.repeat(24), ct: 'f'.repeat(512) };
  assert.equal((await send(big)).statusCode, 201);
  const g = await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } });
  assert.deepEqual(g.json().deal_link_box, big);
  assert.equal(g.json().deal_link, undefined);
  // Without the token: 404, no box; the inbox never carries the box either.
  for (const headers of [{}, { 'x-request-token': 'a'.repeat(32) }, { 'x-request-token': sha256Hex(r.token) }]) {
    const n = await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers });
    assert.equal(n.statusCode, 404);
    assert.ok(!n.body.includes('f'.repeat(64)));
  }
  assert.ok(!(await inbox(alice)).body.includes('f'.repeat(64)));
});

test('deal from request: at most 5 deals per request', async () => {
  await createProfile(alice);
  const r = await openRequest(alice.id);
  for (let i = 0; i < 5; i++) {
    const d = await dealFromRequest(alice, r.handle);
    assert.equal(d.res.statusCode, 201);
    // One live deal at a time: the creator cancels the link before the next one.
    store.markRevoked(d.b.handle);
  }
  const sixth = await dealFromRequest(alice, r.handle);
  assert.equal(sixth.res.statusCode, 409);
  assert.equal(sixth.res.json().error, 'too_many_deals');
});

// ---------------------------------------------------------------- reviews

test('review: only for a linked, fully paid, finished deal, signed by its client key', async () => {
  await createProfile(alice);
  // A deal not made from a request.
  const plain = makeOffer(creatorDeal, { nowMs: clock });
  await app.inject({ method: 'POST', url: '/api/deals', payload: { handle: plain.handle, offer: plain.offer, offer_signature: plain.offer_signature, terms: plain.terms } });
  const plainId = await join(plain);
  finish(plainId, 'released');
  const gl = await app.inject({ method: 'GET', url: `/api/deals/${plain.handle}/review`, headers: { 'x-deal-token': plain.token } });
  assert.deepEqual(gl.json(), { linked: false });
  assert.equal((await postReview(plain, plainId, alice.id, 5, 'great')).json().error, 'not_from_request');

  const { b, id } = await linkedDeal(alice, null);
  // Joined, not paid / not finished.
  let r = await postReview(b, id, alice.id, 5, 'great');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'not_finished');
  chain.fund(id, chain.deals[id].amount);
  assert.equal((await postReview(b, id, alice.id, 5, 'great')).json().error, 'not_finished');
  Object.assign(chain.deals[id], { state: 'Delivered' });
  assert.equal((await postReview(b, id, alice.id, 5, 'great')).json().error, 'not_finished');
  Object.assign(chain.deals[id], { state: 'Released', outcome: 'Accepted', creator_payout: '4850000' });

  // Wrong keys / wrong content / wrong profile / no token.
  assert.equal((await postReview(b, id, alice.id, 5, 'great', { signer: creatorDeal })).statusCode, 401);
  assert.equal((await postReview(b, id, alice.id, 5, 'great', { signer: stranger })).statusCode, 401);
  assert.equal((await postReview(b, id, alice.id, 5, 'great', { sig: clientDeal.signRaw(reviewMessage(CONTRACT_ID, id, alice.id, 4, 'great', exp())) })).statusCode, 401);
  assert.equal((await postReview(b, id, alice.id, 5, 'great', { sig: clientDeal.signRaw(reviewMessage(CONTRACT_ID, id, bob.id, 5, 'great', exp())) })).statusCode, 401);
  assert.equal((await postReview(b, id, alice.id, 5, 'great', { token: 'a'.repeat(32) })).statusCode, 404);
  assert.equal((await postReview(b, id, alice.id, 5, 'great', { e: exp(-1000) })).json().error, 'signature_expired');
  // Bad fields.
  assert.equal((await postReview(b, id, alice.id, 6, 'x')).statusCode, 400);
  assert.equal((await postReview(b, id, alice.id, 0, 'x')).statusCode, 400);
  assert.equal((await postReview(b, id, alice.id, 5, 'x'.repeat(501))).statusCode, 400);
  assert.equal((await postReview(b, id, alice.id, 5, ' padded ')).statusCode, 400);

  const e = exp();
  const sig = clientDeal.signRaw(reviewMessage(CONTRACT_ID, id, alice.id, 5, 'Отличная работа, быстро!', e));
  const ok = await postReview(b, id, alice.id, 5, 'Отличная работа, быстро!', { e, sig });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().review.rating, 5);
  assert.equal(ok.json().review.refunded, false);
  // Single use: the same signature again is refused (caught as not newer than the saved one).
  const replay = await postReview(b, id, alice.id, 5, 'Отличная работа, быстро!', { e, sig });
  assert.equal(replay.statusCode, 409);
  assert.equal(replay.json().error, 'stale_review');

  const p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(p.finished_deals, 1);
  assert.equal(p.rating_avg, 5);
  assert.equal(p.reviews_count, 1);
  assert.deepEqual(Object.keys(p.reviews[0]).sort(), ['month', 'outcome', 'rating', 'refunded', 'reply', 'review_id', 'text']);
  assert.match(p.reviews[0].review_id, /^[0-9a-f]{16}$/);
  assert.equal(p.reviews[0].outcome, 'paid');
  assert.equal(p.reviews[0].reply, null);
  assert.match(p.reviews[0].month, /^\d{4}-\d{2}$/);

  // Edit with the same key (a newer signature); an older one is refused.
  clock += 1000;
  const edit = await postReview(b, id, alice.id, 4, 'Good');
  assert.equal(edit.statusCode, 200, edit.body);
  const older = clientDeal.signRaw(reviewMessage(CONTRACT_ID, id, alice.id, 1, 'bad', (BigInt(e) - 1n).toString()));
  const stale = await postReview(b, id, alice.id, 1, 'bad', { e: (BigInt(e) - 1n).toString(), sig: older });
  assert.equal(stale.json().error, 'stale_review');
  const p2 = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(p2.rating_avg, 4);
  assert.equal(p2.reviews_count, 1);
  assert.equal(p2.reviews[0].text, 'Good');

  const gr = (await app.inject({ method: 'GET', url: `/api/deals/${b.handle}/review`, headers: { 'x-deal-token': b.token } })).json();
  assert.equal(gr.linked, true);
  assert.equal(gr.profile_id, alice.id);
  assert.equal(gr.can_review, true);
  assert.equal(gr.review.rating, 4);
  assert.equal((await app.inject({ method: 'GET', url: `/api/deals/${b.handle}/review` })).statusCode, 404);
});

test('review: public output has no amounts, deal ids, handles, keys or exact dates', async () => {
  await createProfile(alice);
  const { b, id } = await linkedDeal(alice, 'released');
  assert.equal((await postReview(b, id, alice.id, 5, 'Nice')).statusCode, 201);
  const bodies = [
    (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).body,
    (await app.inject({ method: 'GET', url: '/api/profiles' })).body,
  ];
  const d = chain.deals[id];
  for (const body of bodies) {
    for (const secret of [b.handle, b.token, clientDeal.pk, creatorDeal.pk, d.amount, '4850000', d.client_fingerprint, d.creator_fingerprint]) {
      assert.ok(!body.includes(secret), `leaked ${secret}`);
    }
    assert.ok(!/"deal_id"|"amount"|"created_at"|"\d{4}-\d{2}-\d{2}/.test(body), body);
  }
});

test('review: refunded deals are labelled and can only lower the rating', async () => {
  await createProfile(alice);
  // No paid review yet: a refund review shows, but gives no average.
  const k1 = keyFromSeed(41);
  const ref1 = await linkedDeal(alice, 'refunded', k1);
  let r = await postReview(ref1.b, ref1.id, alice.id, 5, 'self refund', { signer: k1 });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().review.refunded, true);
  let p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(p.rating_avg, null);
  assert.equal(p.reviews_count, 1);
  assert.equal(p.finished_deals, 0);
  assert.equal(p.reviews[0].refunded, true);

  const k2 = keyFromSeed(42);
  const paid = await linkedDeal(alice, 'released', k2);
  assert.equal((await postReview(paid.b, paid.id, alice.id, 4, 'ok', { signer: k2 })).statusCode, 201);
  p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  // The 5★ refund review does not raise the 4★ average.
  assert.equal(p.rating_avg, 4);
  assert.equal(p.finished_deals, 1);
  assert.equal(p.reviews_count, 2);

  const k3 = keyFromSeed(43);
  const ref2 = await linkedDeal(alice, 'refunded', k3);
  assert.equal((await postReview(ref2.b, ref2.id, alice.id, 1, 'vanished', { signer: k3 })).statusCode, 201);
  p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  // A lower refund review does count: (4 + 1) / 2.
  assert.equal(p.rating_avg, 2.5);
  assert.equal(p.finished_deals, 1);
  assert.equal(p.reviews_count, 3);

  // A deal refunded without full payment cannot be reviewed.
  const k4 = keyFromSeed(44);
  const unpaid = await linkedDeal(alice, 'unpaid_refund', k4);
  assert.equal((await postReview(unpaid.b, unpaid.id, alice.id, 1, 'x', { signer: k4 })).json().error, 'not_finished');

  // Operator hides a review: counters follow.
  assert.equal(market().store.setReviewHidden(ref2.b.handle, true), alice.id);
  p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(p.rating_avg, 4);
  assert.equal(p.reviews_count, 2);
});

test('review: a purged deal keeps its review rights if they were seen before', async () => {
  await createProfile(alice);
  const { b, id } = await linkedDeal(alice, 'released');
  // Seen by the refresher before the purge.
  clock += 31_000;
  assert.equal(await market().refreshLinks(), 1);
  chain.purge(id);
  const r = await postReview(b, id, alice.id, 5, 'late but fine');
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().review.refunded, false);

  // Never seen before the purge: refused (the tombstone has no amounts).
  const k = keyFromSeed(45);
  const other = await linkedDeal(alice, 'released', k);
  chain.purge(other.id);
  assert.equal((await postReview(other.b, other.id, alice.id, 5, 'x', { signer: k })).json().error, 'not_finished');
});

test('counters: the refresher counts finished deals without a review; unpaid and cancelled do not count', async () => {
  await createProfile(alice);
  const k1 = keyFromSeed(46);
  const k2 = keyFromSeed(47);
  const k3 = keyFromSeed(48);
  await linkedDeal(alice, 'released', k1);
  await linkedDeal(alice, 'refunded', k2);
  const c = await linkedDeal(alice, null, k3);
  Object.assign(chain.deals[c.id], { state: 'Cancelled', outcome: 'Cancelled' });
  // A linked deal the client never joined.
  const r = await openRequest(alice.id);
  await dealFromRequest(alice, r.handle);
  clock += 31_000;
  assert.equal(await market().refreshLinks(), 4);
  const p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(p.finished_deals, 1);
  assert.equal(p.reviews_count, 0);
  const card = (await app.inject({ method: 'GET', url: '/api/profiles' })).json().items[0];
  assert.equal(card.finished_deals, 1);
  // Final links are not re-read; the unjoined one is (until its offer expires).
  clock += 31_000;
  assert.equal(await market().refreshLinks(), 1);
});

// ---------------------------------------------------------------- review rules

const DAY = 24 * 3600_000;
const getReview = (b: OfferBundle) =>
  app.inject({ method: 'GET', url: `/api/deals/${b.handle}/review`, headers: { 'x-deal-token': b.token } }).then((r) => r.json());
const getProfile = (id: string) => app.inject({ method: 'GET', url: `/api/profiles/${id}` }).then((r) => r.json());

test('review window: write and edit until 3 days after the deal ended on-chain, then locked', async () => {
  await createProfile(alice);
  const { b, id } = await linkedDeal(alice, 'released');
  let g = await getReview(b);
  assert.equal(g.can_review, true);
  assert.equal(g.locked, false);
  assert.equal(g.outcome, 'paid');
  assert.equal(Date.parse(g.review_until), clock + 3 * DAY);

  clock += 2 * DAY;
  assert.equal((await postReview(b, id, alice.id, 2, 'slow')).statusCode, 201);
  clock += DAY - 60_000;
  const edit = await postReview(b, id, alice.id, 4, 'slow, but fine in the end');
  assert.equal(edit.statusCode, 200, edit.body);

  clock += 60_000; // exactly 3 days after the end
  const late = await postReview(b, id, alice.id, 5, 'changed my mind');
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error, 'review_locked');
  g = await getReview(b);
  assert.equal(g.can_review, false);
  assert.equal(g.locked, true);
  assert.equal(g.review.rating, 4);
  assert.equal((await getProfile(alice.id)).reviews[0].text, 'slow, but fine in the end');

  // A deal that ended on-chain 4 days before anyone looked: the window counts from the chain's end time, not from the first read.
  const k = keyFromSeed(51);
  const old = await linkedDeal(alice, 'released', k);
  chain.deals[old.id].ended_at_ns = ((BigInt(clock) - BigInt(4 * DAY)) * 1_000_000n).toString();
  const r = await postReview(old.b, old.id, alice.id, 5, 'x', { signer: k });
  assert.equal(r.json().error, 'review_locked');
  assert.equal((await getReview(old.b)).locked, true);

  // Not finished yet: no window, nothing locked.
  const k2 = keyFromSeed(52);
  const open = await linkedDeal(alice, null, k2);
  g = await getReview(open.b);
  assert.deepEqual([g.can_review, g.locked, g.review_until, g.outcome], [false, false, null, null]);

  // For the bot reminder: window end + whether a review exists.
  assert.deepEqual(market().reviewWindow(b.handle), { until_ms: Date.parse((await getReview(b)).review_until), open: false, reviewed: true });
  assert.equal(market().reviewWindow(open.b.handle), null);
});

test('review window: an old final link without an end time gets it from the chain (first-release rows)', async () => {
  await createProfile(alice);
  const { b, id } = await linkedDeal(alice, 'released');
  chain.deals[id].ended_at_ns = ((BigInt(clock) - BigInt(DAY)) * 1_000_000n).toString();
  clock += 31_000;
  await market().refreshLinks();
  // Simulate a row from before the column existed.
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare('UPDATE market_request_deals SET ended_ms = NULL, outcome = NULL WHERE deal_handle = ?').run(b.handle);
  const g = await getReview(b);
  assert.equal(g.can_review, true);
  assert.equal(Date.parse(g.review_until), Number(BigInt(chain.deals[id].ended_at_ns!) / 1_000_000n) + 3 * DAY);
  assert.equal(g.outcome, 'paid');
});

test('outcome label on every review: paid / money went back / dispute', async () => {
  await createProfile(alice);
  const cases: { seed: number; set: (id: number) => void; outcome: string; refunded: boolean }[] = [
    { seed: 61, set: (id) => finish(id, 'released'), outcome: 'paid', refunded: false },
    { seed: 62, set: (id) => finish(id, 'refunded'), outcome: 'refunded', refunded: true },
    {
      // The arbiter split 50/50.
      seed: 63,
      set: (id) => {
        finish(id, 'released');
        Object.assign(chain.deals[id], { disputed_at_ns: chain.nowNs().toString(), outcome: { ArbiterSplit: { creator_share_bps: 5000 } }, creator_payout: '2425000' });
      },
      outcome: 'dispute',
      refunded: false,
    },
    {
      // The client won the dispute: the label says dispute; the creator got nothing, so it also counts as "money went back".
      seed: 64,
      set: (id) => {
        finish(id, 'refunded');
        Object.assign(chain.deals[id], { disputed_at_ns: chain.nowNs().toString(), outcome: { ArbiterSplit: { creator_share_bps: 0 } } });
      },
      outcome: 'dispute',
      refunded: true,
    },
    {
      // Dispute timeout 50/50 (no disputed_at in this fake, the outcome alone says it).
      seed: 65,
      set: (id) => {
        finish(id, 'released');
        Object.assign(chain.deals[id], { outcome: { TimeoutSplit: { creator_share_bps: 5000 } } });
      },
      outcome: 'dispute',
      refunded: false,
    },
    {
      // Agreed split without a dispute: the creator got part of the money.
      seed: 66,
      set: (id) => {
        finish(id, 'released');
        Object.assign(chain.deals[id], { outcome: { Settled: { creator_share_bps: 3000 } } });
      },
      outcome: 'paid',
      refunded: false,
    },
  ];
  for (const [i, c] of cases.entries()) {
    // At most 5 requests a day from one network to one creator.
    if (i === 4) clock += DAY + 60_000;
    const k = keyFromSeed(c.seed);
    const d = await linkedDeal(alice, null, k);
    c.set(d.id);
    assert.equal((await getReview(d.b)).outcome, c.outcome, `seed ${c.seed}`);
    const r = await postReview(d.b, d.id, alice.id, 3, `case ${c.seed}`, { signer: k });
    assert.equal(r.statusCode, 201, r.body);
    assert.equal(r.json().review.outcome, c.outcome, `seed ${c.seed}`);
    assert.equal(r.json().review.refunded, c.refunded, `seed ${c.seed}`);
  }
  const p = await getProfile(alice.id);
  const byText = Object.fromEntries(p.reviews.map((r: { text: string; outcome: string }) => [r.text, r.outcome]));
  for (const c of cases) assert.equal(byText[`case ${c.seed}`], c.outcome);
});

function postReply(k: PKey, reviewId: string, text: string, o: { signer?: DealKey; e?: string; sig?: string; profileId?: string } = {}) {
  const pid = o.profileId ?? k.id;
  const e = o.e ?? exp();
  const sig = o.sig ?? (o.signer ?? k).signRaw(reviewReplyMessage(CONTRACT_ID, pid, reviewId, text, e));
  return app.inject({ method: 'POST', url: `/api/profiles/${pid}/reviews/${reviewId}/reply`, payload: { profile_pk: k.pk, text, expires_at_ns: e, sig } });
}

test('creator answer: once per review, public, signed by the profile key', async () => {
  await createProfile(alice);
  await createProfile(bob, { nickname: 'Bob Design' });
  const { b, id } = await linkedDeal(alice, 'released');
  assert.equal((await postReview(b, id, alice.id, 2, 'Late by a week')).statusCode, 201);
  const rid: string = (await getProfile(alice.id)).reviews[0].review_id;

  // Wrong key, wrong profile, unknown review, bad text.
  assert.equal((await postReply(alice, rid, 'Sorry', { signer: bob })).statusCode, 401);
  assert.equal((await postReply(alice, rid, 'Sorry', { signer: creatorDeal })).statusCode, 401);
  assert.equal((await postReply(bob, rid, 'Not mine')).statusCode, 404);
  assert.equal((await postReply(alice, 'f'.repeat(16), 'Sorry')).statusCode, 404);
  assert.equal((await postReply(alice, 'nothex', 'Sorry')).statusCode, 404);
  assert.equal((await postReply(alice, rid, '')).json().error, 'bad_reply');
  assert.equal((await postReply(alice, rid, ' padded ')).json().error, 'bad_reply');
  assert.equal((await postReply(alice, rid, 'x'.repeat(501))).json().error, 'bad_reply');
  assert.equal((await postReply(alice, rid, 'Sorry', { e: exp(-1000) })).json().error, 'signature_expired');
  // A signature over other text.
  const e0 = exp();
  assert.equal((await postReply(alice, rid, 'Sorry', { e: e0, sig: alice.signRaw(reviewReplyMessage(CONTRACT_ID, alice.id, rid, 'Other', e0)) })).statusCode, 401);

  const ok = await postReply(alice, rid, 'Sorry — the client changed the brief twice.\nThanks for the patience.');
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().review.reply.text, 'Sorry — the client changed the brief twice.\nThanks for the patience.');
  assert.match(ok.json().review.reply.month, /^\d{4}-\d{2}$/);

  // Once: a second answer is refused, the first stays.
  const again = await postReply(alice, rid, 'Edited answer');
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, 'already_replied');
  const p = await getProfile(alice.id);
  assert.equal(p.reviews[0].reply.text.startsWith('Sorry'), true);
  // The client sees the answer on the deal page too.
  assert.equal((await getReview(b)).review.reply.text.startsWith('Sorry'), true);
  // Public output still has no keys or exact dates.
  const body = JSON.stringify(p);
  for (const secret of [alice.pk, b.handle, b.token]) assert.ok(!body.includes(secret));
  assert.ok(!/"\d{4}-\d{2}-\d{2}/.test(body));

  // A hidden review cannot be answered.
  const k = keyFromSeed(71);
  const d2 = await linkedDeal(alice, 'released', k);
  assert.equal((await postReview(d2.b, d2.id, alice.id, 1, 'spam', { signer: k })).statusCode, 201);
  const rid2: string = (await getProfile(alice.id)).reviews.find((r: { text: string }) => r.text === 'spam').review_id;
  market().store.setReviewHidden(d2.b.handle, true);
  assert.equal((await postReply(alice, rid2, 'hm')).statusCode, 404);
});

test('"on Pinky since <month>" on cards and profiles', async () => {
  await createProfile(alice);
  const month = new Date(clock).toISOString().slice(0, 7);
  assert.equal((await getProfile(alice.id)).since_month, month);
  const card = (await app.inject({ method: 'GET', url: '/api/profiles' })).json().items[0];
  assert.equal(card.since_month, month);
  // An edit later does not move it.
  clock += 40 * DAY;
  assert.equal((await put(alice, baseProfile({ bio: 'new bio' }))).statusCode, 200);
  assert.equal((await getProfile(alice.id)).since_month, month);
});

test('market store: a database from the first release gets the new review columns and review ids', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE market_reviews (deal_handle TEXT PRIMARY KEY, profile_id TEXT NOT NULL, rating INTEGER NOT NULL, text TEXT NOT NULL,
    refunded INTEGER NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, signed_expires_ns TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE market_request_deals (deal_handle TEXT PRIMARY KEY, request_handle TEXT NOT NULL, profile_id TEXT NOT NULL, deal_link_box TEXT,
    created_at TEXT NOT NULL, final INTEGER NOT NULL DEFAULT 0, reviewable INTEGER NOT NULL DEFAULT 0, counted INTEGER NOT NULL DEFAULT 0,
    checked_at INTEGER NOT NULL DEFAULT 0);`);
  db.prepare(`INSERT INTO market_reviews VALUES ('h1', 'p1', 5, 'ok', 0, 0, '1', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')`).run();
  db.prepare(`INSERT INTO market_reviews VALUES ('h2', 'p1', 1, 'no', 1, 0, '1', '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')`).run();
  const ms = new MarketStore(db);
  const r1 = ms.getReview('h1')!;
  const r2 = ms.getReview('h2')!;
  assert.match(r1.review_id, /^[0-9a-f]{16}$/);
  assert.notEqual(r1.review_id, r2.review_id);
  assert.deepEqual([r1.outcome, r2.outcome, r1.reply_text], ['paid', 'refunded', null]);
  // A second start changes nothing.
  const again = new MarketStore(db);
  assert.equal(again.getReview('h1')!.review_id, r1.review_id);
});

test('market routes answer CORS preflight for PUT / DELETE and the request token header', async () => {
  const r = await app.inject({
    method: 'OPTIONS',
    url: `/api/profiles/${alice.id}`,
    headers: { origin: 'http://localhost:5175', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type,x-request-token' },
  });
  assert.ok(r.statusCode === 204 || r.statusCode === 200, r.body);
  assert.match(String(r.headers['access-control-allow-methods']), /PUT/);
  assert.match(String(r.headers['access-control-allow-methods']), /DELETE/);
  assert.match(String(r.headers['access-control-allow-headers']).toLowerCase(), /x-request-token/);
});
