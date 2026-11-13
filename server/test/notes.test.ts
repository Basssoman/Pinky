// Encrypted party notes, purged-deal leftovers, the arbiter
// tool routes and the public dispute log. Mocked chain and 1Click.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import { SqliteStore } from '../src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, signedRequest, testConfig, type DealKey, type OfferBundle } from './helpers.ts';

const creator = keyFromSeed(21);
const client = keyFromSeed(22);
const stranger = keyFromSeed(23);
const arbiterApi = keyFromSeed(24);

let chain: FakeChain;
let app: FastifyInstance;
let clock = Date.now();

async function setup(overrides: Partial<Config> = {}) {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  app = await buildApp({
    config: testConfig({ arbiterApiPublicKey: arbiterApi.pk, ...overrides }),
    chain,
    oneClick: new FakeOneClick(),
    store: new SqliteStore(':memory:'),
    now: () => clock,
  });
}
beforeEach(async () => setup());

async function joinedDeal() {
  const b = makeOffer(creator);
  let r = await app.inject({ method: 'POST', url: '/api/deals', payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms } });
  assert.equal(r.statusCode, 201, r.body);
  r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: client.pk } });
  assert.equal(r.statusCode, 201, r.body);
  return { b, id: r.json().deal_id as number };
}

const DATA = Buffer.from('ciphertext, the server cannot read it').toString('base64');

function postNote(b: OfferBundle, id: number, key: DealKey, kind: string, data = DATA, token = b.token) {
  return app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/notes`,
    headers: { 'x-deal-token': token },
    payload: signedRequest(key, id, 'note', { kind, data }, clock),
  });
}

function getNotes(b: OfferBundle, token = b.token) {
  return app.inject({ method: 'GET', url: `/api/deals/${b.handle}/notes`, headers: { 'x-deal-token': token } });
}

function act(b: OfferBundle, id: number, key: DealKey, action: string, payload: string) {
  return app.inject({ method: 'POST', url: `/api/deals/${b.handle}/actions`, payload: { action, payload, signature: key.sign(id, action, payload) } });
}

function arbiter(op: string, fields: Record<string, unknown>, key: DealKey = arbiterApi) {
  const payload = JSON.stringify({ ...fields, issued_at_ns: (BigInt(clock) * 1_000_000n).toString(), nonce: Math.random().toString(16).slice(2) });
  return app.inject({
    method: 'POST',
    url: `/api/arbiter/${op}`,
    payload: { payload, signature: key.signRaw(`escrow-v1|${CONTRACT_ID}|arbiter|${op}|${payload}`) },
  });
}

test('the creator stores the encrypted files link before delivering; the client reads it with the link token', async () => {
  const { b, id } = await joinedDeal();
  assert.equal((await postNote(b, id, creator, 'delivery')).statusCode, 409, 'not while the deal is unpaid');
  chain.fund(id, '5000000');
  assert.equal((await postNote(b, id, client, 'delivery')).statusCode, 403, 'only the creator key');
  assert.equal((await postNote(b, id, stranger, 'delivery')).statusCode, 401);
  assert.equal((await postNote(b, id, creator, 'delivery', DATA, 'wrong-token')).statusCode, 404);
  assert.equal((await postNote(b, id, creator, 'delivery', 'not base64 !')).statusCode, 400);
  assert.equal((await postNote(b, id, creator, 'delivery', 'A'.repeat(6001))).statusCode, 400, 'size cap');
  assert.equal((await postNote(b, id, creator, 'nonsense')).statusCode, 400);

  let r = await postNote(b, id, creator, 'delivery');
  assert.equal(r.statusCode, 201, r.body);
  // Replaceable while still Funded (e.g. the deliver transaction failed and the creator retries).
  const second = Buffer.from('another link').toString('base64');
  assert.equal((await postNote(b, id, creator, 'delivery', second)).statusCode, 201);

  assert.equal((await getNotes(b, 'wrong-token')).statusCode, 404);
  r = await getNotes(b);
  assert.equal(r.statusCode, 200);
  const notes = r.json().notes as { kind: string; signer: string; payload: string; signature: string }[];
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'delivery');
  assert.equal(notes[0].signer, 'creator');
  assert.equal(JSON.parse(notes[0].payload).data, second);
  // The reader can check the writer itself: the stored signature is the creator's.
  assert.equal(notes[0].signature, creator.sign(id, 'note', notes[0].payload));

  assert.equal((await act(b, id, creator, 'deliver', '{"deliverable_hash":"v1:abc","nonce":"1"}')).statusCode, 200);
  r = await postNote(b, id, creator, 'delivery');
  assert.equal(r.statusCode, 409, 'locked once the delivery is on-chain');
  assert.equal(r.json().error, 'note_locked');
});

test('a creator who delivered without a note can still add it once', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  assert.equal((await act(b, id, creator, 'deliver', '{"deliverable_hash":"v1:abc","nonce":"1"}')).statusCode, 200);
  assert.equal((await postNote(b, id, creator, 'delivery')).statusCode, 201);
  assert.equal((await postNote(b, id, creator, 'delivery')).statusCode, 409);
});

test('dispute notes of the client, the creator copy for the arbiter; arbiter copies are not served with the link', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  assert.equal((await postNote(b, id, client, 'dispute')).statusCode, 409, 'nothing to dispute before delivery');
  await postNote(b, id, creator, 'delivery');
  await act(b, id, creator, 'deliver', '{"deliverable_hash":"v1:abc","nonce":"1"}');
  assert.equal((await postNote(b, id, creator, 'delivery_arbiter')).statusCode, 409, 'only once a dispute is open');
  assert.equal((await postNote(b, id, creator, 'dispute')).statusCode, 403);

  assert.equal((await postNote(b, id, client, 'dispute')).statusCode, 201);
  assert.equal((await postNote(b, id, client, 'dispute_arbiter')).statusCode, 201);
  assert.equal((await postNote(b, id, client, 'dispute')).statusCode, 201, 'replaceable until the dispute is on-chain');
  assert.equal((await act(b, id, client, 'dispute', '{"nonce":"2"}')).statusCode, 200);
  chain.deals[id].state = 'Disputed'; // the fake chain does not model dispute
  assert.equal((await postNote(b, id, client, 'dispute')).statusCode, 409, 'locked after the dispute is open');
  assert.equal((await postNote(b, id, creator, 'delivery_arbiter')).statusCode, 201);
  assert.equal((await postNote(b, id, creator, 'delivery_arbiter')).statusCode, 409);

  const r = await getNotes(b);
  assert.deepEqual(
    (r.json().notes as { kind: string }[]).map((n) => n.kind),
    ['delivery', 'dispute'],
  );
  assert.deepEqual(r.json().has_arbiter_copy, { creator: true, client: true });
});

test('notes: a signed note request cannot be replayed and must be fresh', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  const body = signedRequest(creator, id, 'note', { kind: 'delivery', data: DATA }, clock);
  const send = () => app.inject({ method: 'POST', url: `/api/deals/${b.handle}/notes`, headers: { 'x-deal-token': b.token }, payload: body });
  assert.equal((await send()).statusCode, 201);
  assert.equal((await send()).statusCode, 401);
  const old = signedRequest(creator, id, 'note', { kind: 'delivery', data: DATA }, clock - 5 * 60_000);
  const r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/notes`, headers: { 'x-deal-token': b.token }, payload: old });
  assert.equal(r.statusCode, 401);
});

test('the arbiter tool reads a case with its own key; nobody else can', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  await postNote(b, id, creator, 'delivery');
  await act(b, id, creator, 'deliver', '{"deliverable_hash":"v1:abc","nonce":"1"}');
  await postNote(b, id, client, 'dispute_arbiter');

  let r = await arbiter('case', { deal_id: id });
  assert.equal(r.statusCode, 200, r.body);
  const body = r.json();
  assert.equal(body.terms.title, b.terms.title);
  assert.equal(body.terms_verified, true);
  assert.deepEqual(
    (body.notes as { kind: string }[]).map((n) => n.kind),
    ['delivery', 'dispute_arbiter'],
  );
  assert.equal(body.deal.state, 'Delivered');

  assert.equal((await arbiter('case', { deal_id: id }, stranger)).statusCode, 404, 'another key gets nothing');
  assert.equal((await arbiter('case', { deal_id: 999 })).statusCode, 404);
  // A request signed for one operation cannot be used for another.
  const payload = JSON.stringify({ deal_id: id, outcome: 'creator', reason: 'x', issued_at_ns: (BigInt(clock) * 1_000_000n).toString(), nonce: 'n' });
  r = await app.inject({
    method: 'POST',
    url: '/api/arbiter/decision',
    payload: { payload, signature: arbiterApi.signRaw(`escrow-v1|${CONTRACT_ID}|arbiter|case|${payload}`) },
  });
  assert.equal(r.statusCode, 404);

  await setup({ arbiterApiPublicKey: '' });
  assert.equal((await arbiter('case', { deal_id: 0 })).statusCode, 404, 'routes are off without a configured key');
});

test('decisions go to a public log with the month only, visible from the next day', async () => {
  const { id } = await joinedDeal();
  assert.equal((await arbiter('decision', { deal_id: id, outcome: 'maybe', reason: 'x' })).statusCode, 400);
  assert.equal((await arbiter('decision', { deal_id: id, outcome: 'creator', reason: '   ' })).statusCode, 400);
  const r = await arbiter('decision', { deal_id: id, outcome: 'creator', reason: 'The work was delivered\non every point of the terms.' });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().reason, 'The work was delivered on every point of the terms.');

  let log = await app.inject({ method: 'GET', url: '/api/dispute-log' });
  assert.deepEqual(log.json().entries, [], 'not shown on the day it was written');
  clock += 24 * 3600 * 1000;
  log = await app.inject({ method: 'GET', url: '/api/dispute-log' });
  const entries = log.json().entries as Record<string, unknown>[];
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['month', 'outcome', 'reason'], 'no deal id, amount or day');
  assert.match(String(entries[0].month), /^\d{4}-\d{2}$/);
});

test('the client still withdraws leftover money from a purged deal', async () => {
  const { b, id } = await joinedDeal();
  // An underpayment: it never funds the deal and belongs to the client.
  chain.fund(id, '2000000');
  chain.deals[id].state = 'Expired';
  chain.deals[id].outcome = 'ClosedUnpaid';
  chain.deals[id].ended_at_ns = chain.nowNs().toString();
  chain.purge(id);

  let r = await app.inject({ method: 'GET', url: `/api/deals/${b.handle}`, headers: { 'x-deal-token': b.token } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().purged, true);
  assert.equal(r.json().deal.client_payout, '2000000');
  assert.equal(r.json().terms_verified, null);
  assert.equal(r.json().terms.title, b.terms.title, 'the terms text is still served');

  const fields = { destination_asset: 'nep141:eth-0xa0b8.omft.near', recipient: '0x1111111111111111111111111111111111111111', recipient_type: 'DESTINATION_CHAIN' };
  r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/payout-quote`, payload: signedRequest(client, id, 'payout-quote', fields, clock) });
  assert.equal(r.statusCode, 200, r.body);
  const payload = r.json().withdraw_payload as string;
  assert.equal(JSON.parse(payload).amount, '2000000');
  r = await act(b, id, client, 'withdraw', payload);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(chain.tombstones.get(id)!.client_payout, '0');

  // The creator has nothing there, and other actions are refused before any gas.
  r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/payout-quote`, payload: signedRequest(creator, id, 'payout-quote', fields, clock) });
  assert.equal(r.statusCode, 409);
  r = await act(b, id, creator, 'cancel', '{"nonce":"1"}');
  assert.equal(r.statusCode, 409);
  assert.equal((await postNote(b, id, creator, 'delivery')).statusCode, 409);
});
