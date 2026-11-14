// Marketplace fixes before the freeze: one live deal per request (older deals
// listed to the client as not valid), brief lines written by the AI helper
// (stored and shown to the creator only), and which portfolio links the site
// may open (known hosts only). Mocked chain (FakeChain), in-memory SQLite.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { parsePublicKey, sha256Hex } from '../src/encoding.ts';
import { inboxMessage, isKnownLink, parseAiLines, profileIdOf, profileWriteMessage, requestDealMessage } from '../src/market.ts';
import { SqliteStore } from '../src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey } from './helpers.ts';

let chain: FakeChain;
let app: FastifyInstance;
let store: SqliteStore;
let clock = Date.now();

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  store = new SqliteStore(':memory:');
  app = await buildApp({
    config: testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000 }),
    chain,
    oneClick: new FakeOneClick(),
    store,
    now: () => clock,
  });
});

type PKey = DealKey & { id: string };
const profKey = (seed: number): PKey => {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
};
const alice = profKey(71);
const creatorDeal = keyFromSeed(72);

let seq = 0n;
const exp = (aheadMs = 5 * 60_000) => ((BigInt(clock) + BigInt(aheadMs)) * 1_000_000n + seq++).toString();

const profileBody = (portfolio: string[] = ['https://www.behance.net/alice']) => ({
  nickname: 'Alice Motion',
  bio: 'Logo animations',
  categories: ['motion'],
  portfolio,
  contacts: [{ kind: 'telegram', value: '@alice_motion' }],
  services: [{ title: 'Logo animation', description: '10 s', price_from_usdc: 150, delivery_days: 5 }],
});

function put(k: PKey, profile: unknown) {
  const e = exp();
  return app.inject({
    method: 'PUT',
    url: `/api/profiles/${k.id}`,
    payload: { profile_pk: k.pk, profile, expires_at_ns: e, sig: k.signRaw(profileWriteMessage(CONTRACT_ID, k.id, profile, e)) },
  });
}

function sendRequest(over: Record<string, unknown> = {}) {
  const token = randomBytes(16).toString('hex');
  const handle = sha256Hex(token);
  const payload = {
    handle,
    profile_id: alice.id,
    brief: 'A logo animation',
    client_contact: { kind: 'telegram', value: '@client' },
    client_box_pk: randomBytes(32).toString('hex'),
    ...over,
  };
  return { token, handle, res: app.inject({ method: 'POST', url: '/api/requests', payload }) };
}

async function openRequest(over: Record<string, unknown> = {}) {
  const r = sendRequest(over);
  const res = await r.res;
  assert.equal(res.statusCode, 201, res.body);
  return { token: r.token, handle: r.handle };
}

const view = async (r: { handle: string; token: string }) =>
  (await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } })).json();

async function inbox() {
  const e = exp();
  const q = new URLSearchParams({ profile_pk: alice.pk, expires_at_ns: e, sig: alice.signRaw(inboxMessage(CONTRACT_ID, alice.id, e)) });
  const res = await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/requests?${q}` });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { items: Record<string, unknown>[] };
}

/** "Make a deal from this request" in the creator's browser. */
async function dealFrom(requestHandle: string, o: { expiresMs?: number; title?: string; amount?: string } = {}) {
  const b = makeOffer(creatorDeal, { nowMs: clock, expiresNs: BigInt(clock + (o.expiresMs ?? 3600_000)) * 1_000_000n, title: o.title, amount: o.amount });
  const e = exp();
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
      request_sig: alice.signRaw(requestDealMessage(CONTRACT_ID, requestHandle, creatorDeal.pk, e)),
      deal_link_box: { epk: 'a'.repeat(64), iv: 'b'.repeat(24), ct: randomBytes(48).toString('hex') },
    },
  });
  return { b, res };
}

// ---------------------------------------------------------------- one live deal per request

test('one live deal per request: a new deal is refused while the last link can still be paid', async () => {
  await put(alice, profileBody());
  const r = await openRequest();
  const first = await dealFrom(r.handle, { title: 'Logo v1', amount: '12500000' });
  assert.equal(first.res.statusCode, 201, first.res.body);

  // Fresh link: refused, nothing stored for the second offer.
  const second = await dealFrom(r.handle);
  assert.equal(second.res.statusCode, 409);
  assert.equal(second.res.json().error, 'deal_live');
  assert.equal((await app.inject({ method: 'GET', url: `/api/deals/${second.b.handle}`, headers: { 'x-deal-token': second.b.token } })).statusCode, 404);

  // The creator cancels the link: a new deal is allowed and replaces the one shown.
  store.markRevoked(first.b.handle);
  const third = await dealFrom(r.handle, { title: 'Logo v2', amount: '15000000' });
  assert.equal(third.res.statusCode, 201, third.res.body);
  const v = await view(r);
  assert.equal(v.status, 'deal_ready');
  // The older deal is listed for the client: day, title, amount; never the one shown now.
  assert.equal(v.old_deals.length, 1);
  assert.deepEqual(
    { ...v.old_deals[0], deal_link_box: undefined },
    { made_on: new Date(clock).toISOString().slice(0, 10), title: 'Logo v1', amount_usdc: '12.5', deal_link_box: undefined },
  );
  assert.equal(typeof v.old_deals[0].deal_link_box.ct, 'string');
  assert.notDeepEqual(v.old_deals[0].deal_link_box, v.deal_link_box);

  // The link expires without a join: allowed again, and both older deals are listed, newest first.
  clock += 3600_000 + 1_000;
  const fourth = await dealFrom(r.handle, { title: 'Logo v3' });
  assert.equal(fourth.res.statusCode, 201, fourth.res.body);
  assert.deepEqual(
    (await view(r)).old_deals.map((d: { title: string }) => d.title),
    ['Logo v2', 'Logo v1'],
  );
});

test('one live deal per request: a joined deal blocks a new one until it ends unpaid on-chain', async () => {
  await put(alice, profileBody());
  const r = await openRequest();
  const d = await dealFrom(r.handle);
  assert.equal(d.res.statusCode, 201);
  const j = await app.inject({ method: 'POST', url: `/api/deals/${d.b.handle}/join`, headers: { 'x-deal-token': d.b.token }, payload: { client_pk: keyFromSeed(73).pk } });
  assert.equal(j.statusCode, 201, j.body);
  const id = j.json().deal_id as number;
  // Joined (and even after its link time ran out): still the live deal.
  clock += 3600_000 + 1_000;
  assert.equal((await dealFrom(r.handle)).res.json().error, 'deal_live');
  // Paid and in progress: still refused.
  chain.fund(id, chain.deals[id].amount);
  assert.equal((await dealFrom(r.handle)).res.json().error, 'deal_live');
  // Ended unpaid on-chain and read by the refresher: a new deal is allowed; the old one is listed.
  Object.assign(chain.deals[id], { state: 'Cancelled', funded_amount: '0' });
  clock += 31_000;
  await (app as unknown as { market: { refreshLinks(): Promise<number> } }).market.refreshLinks();
  assert.equal((await view(r)).status, 'discussing');
  assert.equal((await view(r)).old_deals.length, 1);
  assert.equal((await dealFrom(r.handle)).res.statusCode, 201);
});

test('one live deal per request: the inbox shows "in talks" as soon as the last link is cancelled', async () => {
  await put(alice, profileBody());
  const r = await openRequest();
  const d = await dealFrom(r.handle);
  assert.equal(d.res.statusCode, 201);
  assert.equal((await inbox()).items[0].status, 'deal_ready');
  store.markRevoked(d.b.handle);
  assert.equal((await inbox()).items[0].status, 'discussing');
  // While nothing is shown on the request page, every deal made from it is listed as not valid.
  const v = await view(r);
  assert.equal(v.deal_link_box, null);
  assert.equal(v.old_deals.length, 1);
});

test('one live deal per request: a request without deals lists none', async () => {
  await put(alice, profileBody());
  const r = await openRequest();
  assert.deepEqual((await view(r)).old_deals, []);
});

// ---------------------------------------------------------------- brief lines written by the AI helper

test('AI lines: stored with the request, shown in the creator inbox only', async () => {
  await put(alice, profileBody());
  const brief = 'My own words\n- 10 s logo animation\n\n- 4k MP4 file';
  const r = await openRequest({ brief, ai_lines: [1, 3] });
  const item = (await inbox()).items.find((i) => i.handle === r.handle)!;
  assert.deepEqual(item.ai_lines, [1, 3]);
  assert.equal(item.brief, brief);
  // The client's own page does not carry it (the client knows which lines they kept).
  assert.equal((await view(r)).ai_lines, undefined);
  // Without the field (or an empty list): nothing is marked.
  const plain = await openRequest({ brief: 'Just my words' });
  const empty = await openRequest({ brief: 'Also mine', ai_lines: [] });
  const items = (await inbox()).items;
  assert.deepEqual(items.find((i) => i.handle === plain.handle)!.ai_lines, []);
  assert.deepEqual(items.find((i) => i.handle === empty.handle)!.ai_lines, []);
});

test('AI lines: line numbers count in the brief as stored (trimmed)', async () => {
  await put(alice, profileBody());
  // The server trims the brief: the line numbers are those of the trimmed text.
  const r = await openRequest({ brief: '\n\n  - first AI line\nmine  \n', ai_lines: [0] });
  assert.deepEqual((await inbox()).items.find((i) => i.handle === r.handle)!.ai_lines, [0]);
});

test('AI lines: bad lists are refused, nothing is stored', async () => {
  await put(alice, profileBody());
  const brief = 'one\ntwo\n\nfour';
  const bads: [string, unknown][] = [
    ['not a list', '1,2'],
    ['a text number', ['1']],
    ['not whole', [0.5]],
    ['negative', [-1]],
    ['past the last line', [4]],
    ['a blank line', [2]],
    ['repeated', [1, 1]],
    ['not rising', [3, 1]],
    ['longer than the brief', [0, 1, 2, 3, 4]],
  ];
  for (const [name, ai] of bads) {
    const r = sendRequest({ brief, ai_lines: ai });
    const res = await r.res;
    assert.equal(res.statusCode, 400, `${name}: ${res.body}`);
    assert.equal(res.json().error, 'bad_ai_lines', name);
  }
  assert.equal((await inbox()).items.length, 0);
  assert.deepEqual(parseAiLines(null, brief), []);
  assert.deepEqual(parseAiLines([0, 3], brief), [0, 3]);
});

// ---------------------------------------------------------------- which portfolio links open

test('portfolio: every https link is saved; only known hosts are marked to open', async () => {
  const portfolio = [
    'https://www.youtube.com/@alice',
    'https://youtu.be/abc',
    'https://www.behance.net/alice',
    'https://x.com/alice',
    'https://drive.google.com/drive/folders/abc',
    'https://alice-portfolio.example.com/work',
    'https://youtube.com.evil.example/@alice',
    'https://docs.google.com/forms/d/abc',
  ];
  const saved = await put(alice, profileBody(portfolio));
  assert.equal(saved.statusCode, 201, saved.body);
  const p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.deepEqual(p.portfolio, portfolio);
  assert.deepEqual(p.portfolio_known, [true, true, true, true, true, false, false, false]);
  // The answer to the save carries the same marks.
  assert.deepEqual(saved.json().portfolio_known, p.portfolio_known);
});

test('portfolio: known host check is exact', () => {
  for (const ok of ['https://www.youtube.com/watch?v=1', 'https://m.youtube.com/@a', 'https://behance.net/a', 'https://twitter.com/a', 'https://mobile.x.com/a']) {
    assert.equal(isKnownLink(ok), true, ok);
  }
  for (const no of [
    'http://www.youtube.com/@a',
    'https://www.youtube.com:8443/@a',
    'https://user@www.youtube.com/@a',
    'https://youtube.co/@a',
    'https://notyoutube.com/@a',
    'https://www.youtube.com.example.org/',
    'https://google.com/drive',
    'javascript:alert(1)',
    'not a link',
  ]) {
    assert.equal(isKnownLink(no), false, no);
  }
});
