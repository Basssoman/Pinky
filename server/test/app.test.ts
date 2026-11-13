// API tests with a mocked chain and mocked 1Click (no network).

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { ChainCallError, RelayerTimeoutError } from '../src/chain.ts';
import { plainDuration } from '../src/errors.ts';
import { readConfig, type Config } from '../src/config.ts';
import { implicitAccountId, keyFingerprint, offerMessage, revokeOfferMessage, termsHash } from '../src/encoding.ts';
import { OneClickError } from '../src/oneclick.ts';
import { verifyQuoteSignature } from '../src/quoteSignature.ts';
import { SqliteStore } from '../src/store.ts';
import {
  CONTRACT_ID,
  FakeChain,
  FakeOneClick,
  keyFromSeed,
  makeOffer,
  quoteSigner,
  signedRequest,
  testConfig,
  type OfferBundle,
} from './helpers.ts';

const creator = keyFromSeed(11);
const client = keyFromSeed(12);
const stranger = keyFromSeed(13);

let chain: FakeChain;
let oneClick: FakeOneClick;
let app: FastifyInstance;
let config: Config;
let clock = Date.now();

async function setup(overrides: Partial<Config> = {}) {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n; // the fake chain follows the test clock
  oneClick = new FakeOneClick();
  config = testConfig(overrides);
  app = await buildApp({ config, chain, oneClick, store: new SqliteStore(':memory:'), now: () => clock });
}

beforeEach(async () => setup());

function postOffer(b: OfferBundle, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms, ...extra },
  });
}

function get(b: OfferBundle, headers: Record<string, string> = { 'x-deal-token': b.token }) {
  return app.inject({ method: 'GET', url: `/api/deals/${b.handle}`, headers });
}

function join(b: OfferBundle, clientPk = client.pk, token = b.token) {
  return app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': token }, payload: { client_pk: clientPk } });
}

/** Offer posted and joined by the client; returns the bundle and deal id. */
async function joinedDeal(opts: Parameters<typeof makeOffer>[1] = {}) {
  const b = makeOffer(creator, opts);
  assert.equal((await postOffer(b)).statusCode, 201);
  const r = await join(b);
  assert.equal(r.statusCode, 201, r.body);
  return { b, id: r.json().deal_id as number };
}

function act(b: OfferBundle, id: number, key: typeof creator, action: string, payload: string, sig?: string) {
  return app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/actions`,
    payload: { action, payload, signature: sig ?? key.sign(id, action, payload) },
  });
}

// ------------------------------------------------------------ offer (creator)

test('POST /api/deals stores a creator-signed offer under the handle', async () => {
  const b = makeOffer(creator);
  const res = await postOffer(b);
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().handle, b.handle);
  assert.equal(chain.calls.length, 0, 'nothing on-chain until the client joins');
  assert.equal((await postOffer(b)).statusCode, 409);
});

test('POST /api/deals validation', async () => {
  const good = makeOffer(creator);
  const cases: [Record<string, unknown>, number, RegExp][] = [
    [{ offer_signature: stranger.signRaw(`escrow-v1|${CONTRACT_ID}|offer|${good.offer}`) }, 401, /creator_pk/],
    [{ offer_signature: good.offer_signature.replace(/=+$/, '') }, 400, /canonical/],
    [{ terms: { ...good.terms, title: 'other' } }, 400, /terms_hash/],
    [{ terms: { ...good.terms, salt: 'abc' } }, 400, /salt/],
    [{ handle: 'nothex' }, 400, /handle/],
    [{ offer: good.offer.replace('}', ',"x":"1"}') }, 400, /exactly/],
  ];
  for (const [over, status, re] of cases) {
    const res = await postOffer(good, over);
    assert.equal(res.statusCode, status, JSON.stringify(over) + res.body);
    assert.match(res.json().message, re);
  }
  for (const [opts, re] of [
    [{ reviewNs: 59n * 1_000_000_000n }, /review period/],
    [{ durationNs: 10n * 1_000_000_000n }, /delivery duration/],
    [{ amount: (config.maxDealAmount + 1n).toString() }, /maximum/],
    [{ amount: '999999' }, /minimum/],
    [{ feeBps: '200' }, /fee_bps must be 300/],
    [{ revisions: '1000' }, /revisions/],
  ] as const) {
    const res = await postOffer(makeOffer(creator, opts));
    assert.equal(res.statusCode, 400);
    assert.match(res.json().message, re);
  }
});

// ------------------------------------------------------------ read access

test('GET needs the link token; no payment info; unknown and unauthorized look the same', async () => {
  const b = makeOffer(creator);
  await postOffer(b);
  assert.equal((await get(b, {})).statusCode, 404);
  assert.equal((await get(b, { 'x-deal-token': 'wrong' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/deals/${'0'.repeat(64)}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/deals/0' })).statusCode, 404, 'numeric ids are not addressable');

  const res = await get(b);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.deal, null);
  assert.equal(body.offer, b.offer);
  assert.equal(body.terms.title, b.terms.title);
  assert.equal(body.terms.salt, b.terms.salt);
  assert.equal(
    body.terms.terms_hash,
    termsHash({ ...b.terms, amount: body.terms.amount, delivery_duration_ns: body.terms.delivery_duration_ns, review_period_ns: body.terms.review_period_ns }),
  );
  assert.equal(body.terms.revisions, '2');
  assert.equal(body.terms.fee_bps, 300);
  assert.equal(body.terms.delivery_deadline, null, 'v2: no deadline before funding');
  assert.equal('payment' in body, false);
});

test('signed read by a deal key works without the token; stale or foreign ones do not', async () => {
  const { b, id } = await joinedDeal();
  const ok = signedRequest(client, id, 'read', { handle: b.handle }, clock);
  let res = await get(b, { 'x-deal-payload': ok.payload, 'x-deal-signature': ok.signature });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().deal.client_pk, client.pk);
  const stale = signedRequest(client, id, 'read', { handle: b.handle }, clock - 3600_000);
  res = await get(b, { 'x-deal-payload': stale.payload, 'x-deal-signature': stale.signature });
  assert.equal(res.statusCode, 404);
  const foreign = signedRequest(stranger, id, 'read', { handle: b.handle }, clock);
  res = await get(b, { 'x-deal-payload': foreign.payload, 'x-deal-signature': foreign.signature });
  assert.equal(res.statusCode, 404);
});

// ------------------------------------------------------------ join (client)

test('join: the client key comes from the client; offer used once', async () => {
  const b = makeOffer(creator);
  await postOffer(b);
  assert.equal((await join(b, client.pk, 'wrong')).statusCode, 404);
  assert.equal((await join(b, creator.pk)).statusCode, 400);
  const res = await join(b);
  assert.equal(res.statusCode, 201, res.body);
  const [call] = chain.calls;
  assert.deepEqual(call.args, [b.offer, b.offer_signature, client.pk]);
  const second = await join(b, stranger.pk);
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'already_joined');
  const g = (await get(b)).json();
  assert.equal(g.deal.client_pk, client.pk);
  assert.equal(g.terms_verified, true);
});

// ------------------------------------------------------------ pay (client-signed)

test('pay-quote: client-signed only; confidential EXACT_OUTPUT quote to the escrow; full quote returned', async () => {
  const { b, id } = await joinedDeal();
  const url = `/api/deals/${b.handle}/pay-quote`;
  const fields = { origin_asset: 'nep141:eth-0xa0b8.omft.near', refund_address: '0xPayer' };

  let res = await app.inject({ method: 'POST', url, payload: signedRequest(creator, id, 'pay-quote', fields, clock) });
  assert.equal(res.statusCode, 403);
  res = await app.inject({ method: 'POST', url, payload: signedRequest(stranger, id, 'pay-quote', fields, clock) });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'pay-quote', fields, clock - 3600_000) });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'POST', url, payload: { payload: JSON.stringify(fields) } });
  assert.equal(res.statusCode, 400);
  assert.equal(oneClick.quotes.length, 0);

  res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'pay-quote', fields, clock) });
  assert.equal(res.statusCode, 200, res.body);
  const q = oneClick.quotes[0];
  assert.equal(q.dry, false);
  assert.equal(q.swapType, 'EXACT_OUTPUT');
  assert.equal(q.amount, '5000000');
  assert.equal(q.destinationAsset, 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
  assert.equal(q.recipient, CONTRACT_ID);
  assert.equal(q.recipientType, 'DESTINATION_CHAIN');
  assert.equal(q.customRecipientMsg, `{"deal_id":${id}}`);
  assert.equal(q.confidentiality, 'basic');
  assert.equal(q.refundTo, '0xPayer');
  const body = res.json();
  assert.equal(body.quote_response.quoteRequest.recipient, CONTRACT_ID);
  assert.ok(verifyQuoteSignature(body.quote_response, quoteSigner().pk), 'browser can verify the 1Click signature');
  assert.ok(body.deposit_address);

  // nothing about the payment in the deal resource
  const g = await get(b);
  assert.doesNotMatch(g.body, /0xPayer|deposit_address/);

  // status: token + a deposit address that belongs to this deal
  const statusUrl = `/api/deals/${b.handle}/pay-status?deposit_address=${body.deposit_address}`;
  assert.equal((await app.inject({ method: 'GET', url: statusUrl })).statusCode, 404);
  assert.equal(
    (await app.inject({ method: 'GET', url: `/api/deals/${b.handle}/pay-status?deposit_address=other`, headers: { 'x-deal-token': b.token } })).statusCode,
    404,
  );
  const st = await app.inject({ method: 'GET', url: statusUrl, headers: { 'x-deal-token': b.token } });
  assert.equal(st.statusCode, 200);
  assert.equal(st.json().status, 'PROCESSING');
  assert.doesNotMatch(st.body, /SECRETPAYER|0xpayer/);
});

test('v2 pay-quote is always for the FULL amount (a partial payment goes back to the client); refused once funded', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '2000000'); // underpayment: credited to the client, deal stays Created
  assert.equal(chain.deals[id].state, 'Created');
  assert.equal(chain.deals[id].client_payout, '2000000');
  const url = `/api/deals/${b.handle}/pay-quote`;
  const fields = { origin_asset: 'a', refund_address: 'r' };
  let res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'pay-quote', fields, clock) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(oneClick.quotes[0].amount, '5000000');
  chain.fund(id, '5000000');
  assert.equal(chain.deals[id].state, 'Funded');
  res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'pay-quote', fields, clock) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'wrong_state');
});

test('ONECLICK_FORCE_DRY defaults to true when unset', async () => {
  const c = readConfig({ ESCROW_CONTRACT_ID: 'x', DB_PATH: ':memory:' });
  assert.equal(c.oneClickForceDry, true);
  assert.equal(readConfig({ ONECLICK_FORCE_DRY: 'false' }).oneClickForceDry, false);
  await setup({ oneClickForceDry: true });
  const { b, id } = await joinedDeal();
  const res = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/pay-quote`,
    payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock),
  });
  assert.equal(oneClick.quotes[0].dry, true);
  assert.equal(res.json().deposit_address, null);
});

test('1Click errors map to 422 / 502', async () => {
  const { b, id } = await joinedDeal();
  const url = `/api/deals/${b.handle}/pay-quote`;
  oneClick.quote = async () => {
    throw new OneClickError(400, '1Click: Amount is too low');
  };
  let res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock) });
  assert.equal(res.statusCode, 422);
  oneClick.quote = async () => {
    throw new OneClickError(503, '1Click: down');
  };
  res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock) });
  assert.equal(res.statusCode, 502);
});

// ------------------------------------------------------------ actions

test('actions: signature, role, canonical encoding and pre-check before any gas is spent', async () => {
  const { b, id } = await joinedDeal();
  const p = '{"deliverable_hash":"h"}';
  let res = await act(b, id, stranger, 'deliver', p);
  assert.equal(res.statusCode, 401);
  res = await act(b, id, client, 'deliver', p);
  assert.equal(res.statusCode, 403);
  // review PoC 8: unpadded base64 is rejected by the server, not relayed
  res = await act(b, id, creator, 'deliver', p, creator.sign(id, 'deliver', p).replace(/=+$/, ''));
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_signature_encoding');
  // not funded yet -> pre-check fails, no tx
  res = await act(b, id, creator, 'deliver', p);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'precheck_failed');
  assert.equal(chain.calls.filter((c) => c.method === 'act').length, 0);

  chain.fund(id, '5000000');
  res = await act(b, id, creator, 'deliver', p);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().signer, 'creator');
  // the exact same submission is answered from the dedupe cache
  res = await act(b, id, creator, 'deliver', p);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().duplicate, true);
  assert.equal(chain.calls.filter((c) => c.method === 'act').length, 1);

  res = await act(b, id, client, 'accept', '{}');
  assert.equal(res.json().signer, 'client');
  assert.equal(chain.deals[id].state, 'Released');
});

test('actions: deliver after the deadline is refused by the pre-check', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  clock = Number(BigInt(chain.deals[id].delivery_deadline_ns!) / 1_000_000n) + 1000;
  const res = await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /deadline/);
});

test('actions: permanent contract rejections are cached (no gas for replays); network errors may be retried', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  const orig = chain.act.bind(chain);
  let calls = 0;
  chain.act = async () => {
    calls++;
    throw new ChainCallError('invalid signature (creator key required)', 'txX');
  };
  let res = await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().tx_hash, 'txX');
  assert.equal(res.json().act_call.args.action, 'deliver');
  res = await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().cached, true);
  assert.equal(calls, 1, 'identical rejected submission not re-sent');

  chain.act = async () => {
    throw new Error('RPC timeout');
  };
  res = await act(b, id, creator, 'deliver', '{"deliverable_hash":"h2"}');
  assert.equal(res.statusCode, 500);
  chain.act = orig;
  res = await act(b, id, creator, 'deliver', '{"deliverable_hash":"h2"}');
  assert.equal(res.statusCode, 200);
});

test('withdraw: amount and expiry are pre-checked; a failed transfer reports ok=false', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  await act(b, id, client, 'accept', '{}');
  const exp = ((BigInt(clock) + 600_000n) * 1_000_000n).toString();
  const w = (amount: string, expires = exp) => JSON.stringify({ destination: 'd'.repeat(64), amount, expires_at_ns: expires });
  let res = await act(b, id, creator, 'withdraw', w('5000001'));
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /exceeds/);
  res = await act(b, id, creator, 'withdraw', w('5000000', '1'));
  assert.match(res.json().message, /expired/);
  res = await act(b, id, creator, 'withdraw', JSON.stringify({ destination: 'd'.repeat(64) }));
  assert.equal(res.statusCode, 409);
  chain.nextActValue = false;
  res = await act(b, id, creator, 'withdraw', w('4850000')); // 5 USDC minus the 3% fee
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, false);
  assert.match(res.json().message, /new withdraw/);
});

test('timeout endpoint: auto-release after review, default split after dispute period', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  const url = `/api/deals/${b.handle}/timeout`;
  const h = { 'x-deal-token': b.token };
  assert.equal((await app.inject({ method: 'POST', url })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url, headers: h })).statusCode, 409);
  clock = Number(BigInt(chain.deals[id].review_ends_at_ns!) / 1_000_000n) + 1000;
  let res = await app.inject({ method: 'POST', url, headers: h });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().outcome, 'released');

  chain.deals[id].state = 'Disputed';
  chain.deals[id].dispute_ends_at_ns = String((BigInt(clock) + 5000n) * 1_000_000n);
  assert.equal((await app.inject({ method: 'POST', url, headers: h })).statusCode, 409);
  clock += 10_000;
  res = await app.inject({ method: 'POST', url, headers: h });
  assert.equal(res.json().outcome, 'split_50_50');
  assert.equal(chain.calls.at(-1)!.method, 'resolve_dispute_timeout');
});

// ------------------------------------------------------------ payout (party-signed)

test('payout-quote: refund goes to the party own implicit account in INTENTS; withdraw payload binds amount + expiry', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  await act(b, id, client, 'accept', '{}');
  const url = `/api/deals/${b.handle}/payout-quote`;
  const fields = { destination_asset: 'nep141:sol-5ce3.omft.near', recipient: 'SoLaNaAddr', recipient_type: 'DESTINATION_CHAIN' };

  let res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'payout-quote', fields, clock) });
  assert.equal(res.statusCode, 409, 'client has nothing to withdraw');
  res = await app.inject({ method: 'POST', url, payload: signedRequest(stranger, id, 'payout-quote', fields, clock) });
  assert.equal(res.statusCode, 401);

  res = await app.inject({ method: 'POST', url, payload: signedRequest(creator, id, 'payout-quote', fields, clock) });
  assert.equal(res.statusCode, 200, res.body);
  const q = oneClick.quotes[0];
  assert.equal(q.originAsset, config.usdcAssetId);
  assert.equal(q.swapType, 'EXACT_INPUT');
  assert.equal(q.amount, '4850000', 'the creator gets 5 USDC minus the 3% fee');
  assert.equal(q.recipient, 'SoLaNaAddr');
  assert.equal(q.refundType, 'INTENTS');
  assert.equal(q.refundTo, implicitAccountId(creator.pk));
  assert.notEqual(q.refundTo, config.relayerAccountId);
  assert.equal(q.confidentiality, 'basic');
  const body = res.json();
  assert.equal(body.party, 'creator');
  assert.equal(body.quote_response.quoteRequest.refundTo, implicitAccountId(creator.pk));
  const wp = JSON.parse(body.withdraw_payload);
  assert.equal(wp.destination, body.deposit_address);
  assert.equal(wp.amount, '4850000');
  const expectedExpiry = (BigInt(Date.parse(q.deadline)) - 300_000n) * 1_000_000n;
  assert.equal(wp.expires_at_ns, expectedExpiry.toString());

  // the signed payload is accepted by the withdraw pre-check
  res = await act(b, id, creator, 'withdraw', body.withdraw_payload);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(chain.deals[id].state, 'PaidOut');
});

test('payout-quote: quotes with a deposit memo or without a NEAR deposit account are refused', async () => {
  const { b, id } = await joinedDeal();
  chain.deals[id].state = 'Released';
  chain.deals[id].creator_payout = '5000000';
  const url = `/api/deals/${b.handle}/payout-quote`;
  const fields = { destination_asset: 'x', recipient: 'GSTELLAR', recipient_type: 'DESTINATION_CHAIN' };
  oneClick.nextQuoteOverride = { depositMemo: '12345' };
  let res = await app.inject({ method: 'POST', url, payload: signedRequest(creator, id, 'payout-quote', fields, clock) });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().message, /memo/);
  oneClick.nextQuoteOverride = { depositAddress: '0xNotANearAccount' };
  res = await app.inject({ method: 'POST', url, payload: signedRequest(creator, id, 'payout-quote', fields, clock) });
  assert.equal(res.statusCode, 502);
  res = await app.inject({
    method: 'POST',
    url,
    payload: signedRequest(creator, id, 'payout-quote', { ...fields, recipient_type: 'INTENTS' }, clock),
  });
  assert.equal(res.statusCode, 400);
});

// ------------------------------------------------------------ abuse guards / meta

test('rate limits: offers per IP', async () => {
  await setup({ rateWritesPerMin: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await postOffer(makeOffer(creator))).statusCode, 201);
  const res = await postOffer(makeOffer(creator));
  assert.equal(res.statusCode, 429);
  clock += 61_000;
  assert.equal((await postOffer(makeOffer(creator))).statusCode, 201);
});

test('health reports NEAR balances and low-balance warnings', async () => {
  let res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.json().ok, true);
  assert.ok(res.json().balances.relayer_yocto);
  chain.balances = { escrow: 1n, relayer: 1n };
  // balances are cached for 15 s
  res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.json().ok, true, 'cached');
  clock += 16_000;
  res = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(res.json().ok, false);
  assert.equal(res.json().warnings.length, 2);
});

test('GET /api/config exposes what the browser needs to sign', async () => {
  const c = (await app.inject({ method: 'GET', url: '/api/config' })).json();
  assert.equal(c.contract_id, CONTRACT_ID);
  assert.equal(c.message_prefix, 'escrow-v1');
  assert.equal(c.payout_refund_type, 'INTENTS');
  assert.equal(c.min_review_period_seconds, 60);
});

test('GET /api/tokens filters and caches', async () => {
  let res = await app.inject({ method: 'GET', url: '/api/tokens' });
  assert.deepEqual(
    res.json().map((t: { symbol: string }) => t.symbol),
    ['USDC', 'USDC', 'ETH'],
  );
  res = await app.inject({ method: 'GET', url: '/api/tokens' });
  assert.equal(oneClick.tokenCalls, 1);
});

// ======================================================================
// Attacks found in internal review, inverted (the attack must fail now)
// ======================================================================

test('POC fixed: the creator cannot censor the client dispute by exhausting a per-deal budget', async () => {
  const { b, id } = await joinedDeal();
  const d = chain.deals[id];
  d.state = 'Delivered';
  d.funded_amount = d.amount;
  d.delivered_at_ns = String(BigInt(clock) * 1_000_000n);
  d.review_ends_at_ns = String(BigInt(clock) * 1_000_000n + 3600n * 1_000_000_000n);
  // creator (10.0.0.1) floods garbage and also valid-signed but failing requests
  for (let i = 0; i < 40; i++) {
    await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/actions`, payload: {}, remoteAddress: '10.0.0.1' });
  }
  for (let i = 0; i < 40; i++) {
    const p = JSON.stringify({ deliverable_hash: `h${i}` });
    await app.inject({
      method: 'POST',
      url: `/api/deals/${b.handle}/actions`,
      payload: { action: 'deliver', payload: p, signature: creator.sign(id, 'deliver', p) },
      remoteAddress: '10.0.0.3',
    });
  }
  // the creator's own IP is now blocked ...
  const blocked = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/actions`, payload: {}, remoteAddress: '10.0.0.1' });
  assert.equal(blocked.statusCode, 429);
  // ... but the honest client's dispute from another IP goes through
  const res = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/actions`,
    payload: { action: 'dispute', payload: '{}', signature: client.sign(id, 'dispute', '{}') },
    remoteAddress: '10.0.0.2',
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(chain.calls.filter((c) => c.method === 'act').length, 1);
  assert.equal(res.json().act_call.method_name, 'act');
});

test('POC fixed: a signer is limited only for its own failing requests; act_call is exposed', async () => {
  const { b, id } = await joinedDeal();
  let last;
  for (let i = 0; i < config.rateSignerPerMin + 1; i++) {
    const p = JSON.stringify({ deliverable_hash: `h${i}` });
    last = await act(b, id, creator, 'deliver', p); // not funded -> pre-check fails
  }
  assert.equal(last!.statusCode, 429);
  // the client key is unaffected
  const r = await act(b, id, client, 'accept', '{}');
  assert.equal(r.statusCode, 409, 'pre-check (not Delivered), not rate-limited');
  assert.equal(r.json().act_call.args.signature, client.sign(id, 'accept', '{}'));
  // the act-call endpoint returns the exact permissionless call without relaying
  const before = chain.calls.length;
  const ac = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/act-call`,
    payload: { action: 'accept', payload: '{}', signature: client.sign(id, 'accept', '{}') },
  });
  assert.equal(ac.statusCode, 200);
  assert.deepEqual(ac.json().act_call.args, { deal_id: id, action: 'accept', payload: '{}', signature: client.sign(id, 'accept', '{}') });
  assert.equal(chain.calls.length, before);
});

test('POC fixed: join squatting is bounded by offer expiry and visible via fingerprints', async () => {
  const b = makeOffer(creator, { expiresNs: (BigInt(clock) + 120_000n) * 1_000_000n });
  assert.equal((await postOffer(b)).statusCode, 201);
  const squatter = keyFromSeed(77);
  const sq = await join(b, squatter.pk);
  assert.equal(sq.statusCode, 201);
  assert.equal(sq.json().client_fingerprint, keyFingerprint(squatter.pk));
  const res = await join(b, client.pk);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().client_fingerprint, keyFingerprint(squatter.pk));
  assert.notEqual(res.json().client_fingerprint, keyFingerprint(client.pk), 'the real client sees a different fingerprint');
  const g = (await get(b)).json();
  assert.equal(g.deal.client_fingerprint, keyFingerprint(squatter.pk));
  assert.equal(g.creator_fingerprint, keyFingerprint(creator.pk));

  // an expired offer cannot be joined at all
  const late = makeOffer(creator, { expiresNs: (BigInt(clock) + 120_000n) * 1_000_000n });
  assert.equal((await postOffer(late)).statusCode, 201);
  clock += 121_000;
  const lj = await join(late, client.pk);
  assert.equal(lj.statusCode, 409);
  assert.equal(lj.json().error, 'offer_expired');
});

test('POC fixed: signed reads are short-lived and single use', async () => {
  const { b, id } = await joinedDeal();
  const future = signedRequest(client, id, 'read', { handle: b.handle }, clock + 9 * 60_000);
  assert.equal((await get(b, { 'x-deal-payload': future.payload, 'x-deal-signature': future.signature })).statusCode, 404);
  const old = signedRequest(client, id, 'read', { handle: b.handle }, clock - 3 * 60_000);
  assert.equal((await get(b, { 'x-deal-payload': old.payload, 'x-deal-signature': old.signature })).statusCode, 404);
  const r = signedRequest(client, id, 'read', { handle: b.handle }, clock);
  const h = { 'x-deal-payload': r.payload, 'x-deal-signature': r.signature };
  assert.equal((await get(b, h)).statusCode, 200);
  assert.equal((await get(b, h)).statusCode, 404, 'replay of the same signed read is refused');
});

/**
 * The relayer send "times out" (its answer is lost) and the join lands on the
 * chain only after `landAfterSleeps` waits (or never). Rebuilds `app` with a
 * sleep that does not wait.
 */
async function timedOutJoinApp(landAfterSleeps: number | null) {
  const realCreate = chain.createDeal.bind(chain);
  let land: (() => Promise<unknown>) | null = null;
  chain.createDeal = async (offer, sig, pk) => {
    land = () => realCreate(offer, sig, pk);
    throw new RelayerTimeoutError();
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    if (land && sleeps.length === landAfterSleeps) await land();
  };
  app = await buildApp({ config, chain, oneClick, store: new SqliteStore(':memory:'), now: () => clock, sleep });
  return sleeps;
}

test('a join whose send timed out but landed seconds later answers success, not 504', async () => {
  const sleeps = await timedOutJoinApp(3);
  const b = makeOffer(creator);
  assert.equal((await postOffer(b)).statusCode, 201);
  const res = await join(b);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().deal_id, 0);
  assert.equal(res.json().client_pk, client.pk);
  assert.equal(res.json().recovered, true);
  assert.equal(sleeps.length, 3, 'stopped reading the chain once the deal was there');
  assert.ok(sleeps.every((ms) => ms > 0));
  assert.equal((await get(b)).json().deal_id, 0, 'the deal id is stored');
});

test('a join whose send timed out and never landed still answers 504 after the wait', async () => {
  const sleeps = await timedOutJoinApp(null);
  const b = makeOffer(creator);
  assert.equal((await postOffer(b)).statusCode, 201);
  const res = await join(b);
  assert.equal(res.statusCode, 504, res.body);
  assert.equal(res.json().error, 'relayer_timeout');
  assert.equal(sleeps.length, 10, 'bounded wait');
  assert.equal((await get(b)).json().deal_id, null);
});

test('a contract rejection of a join is not waited on', async () => {
  const sleeps = await timedOutJoinApp(null);
  chain.createDeal = async () => {
    throw new ChainCallError('offer expired', 'tx');
  };
  const b = makeOffer(creator);
  assert.equal((await postOffer(b)).statusCode, 201);
  const res = await join(b);
  assert.equal(res.statusCode, 422);
  assert.equal(sleeps.length, 0);
});

test('limits in error texts are plain words, machine codes unchanged', async () => {
  await setup({ minReviewPeriodSeconds: 300, minDeliverySeconds: 3600, maxOfferTtlSeconds: 3600 });
  const cases = [
    [{ reviewNs: 59n * SEC }, 'bad_request', 'review period must be between 5 minutes and 90 days'],
    [{ durationNs: 60n * SEC }, 'bad_request', 'delivery duration must be between 1 hour and 90 days'],
    [{ amount: '999999' }, 'amount_too_small', 'the deal amount is below the minimum of 1 USDC'],
    [{ amount: (config.maxDealAmount + 1n).toString() }, 'bad_request', 'the deal amount is above the maximum of 2000 USDC'],
    [{ expiresNs: BigInt(clock + 2 * 3600_000) * 1_000_000n }, 'bad_request', 'the link must expire in the future and at most 1 hour from now'],
  ] as const;
  for (const [opts, code, message] of cases) {
    const res = await postOffer(makeOffer(creator, opts));
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().error, code);
    assert.equal(res.json().message, message);
    assert.doesNotMatch(res.json().message, /\d+s\b/, 'no raw seconds');
  }
});

test('plainDuration: largest exact unit, singular and plural', () => {
  assert.equal(plainDuration(300), '5 minutes');
  assert.equal(plainDuration(7_776_000), '90 days');
  assert.equal(plainDuration(60), '1 minute');
  assert.equal(plainDuration(3600), '1 hour');
  assert.equal(plainDuration(3 * 3600), '3 hours');
  assert.equal(plainDuration(86400), '1 day');
  assert.equal(plainDuration(604_800), '7 days');
  assert.equal(plainDuration(90), '90 seconds');
  assert.equal(plainDuration(1), '1 second');
});

test('join recovery: a join that timed out is mapped on retry', async () => {
  const b = makeOffer(creator);
  await postOffer(b);
  chain.failAfterCreate = true;
  const first = await join(b);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().recovered, true);
  const again = await join(b);
  assert.equal(again.json().recovered, true);
  assert.equal((await get(b)).json().deal_id, 0);
});

test('withdraw pre-check: used signatures and the token contract as destination are refused before gas', async () => {
  const { b, id } = await joinedDeal();
  chain.deals[id].state = 'Released';
  chain.deals[id].creator_payout = '5000000';
  const exp = ((BigInt(clock) + 600_000n) * 1_000_000n).toString();
  let p = JSON.stringify({ destination: config.tokenAccountId, amount: '1', expires_at_ns: exp });
  let res = await act(b, id, creator, 'withdraw', p);
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /bad destination/);
  p = JSON.stringify({ destination: 'd'.repeat(64), amount: '5000000', expires_at_ns: exp });
  chain.usedWithdraws.add(`${id}|${p}|${creator.pk}`);
  const before = chain.calls.length;
  res = await act(b, id, creator, 'withdraw', p);
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /already used/);
  assert.equal(chain.calls.length, before);
});

test('quotes whose 1Click signature does not verify are refused', async () => {
  const { b, id } = await joinedDeal();
  oneClick.badSignature = true;
  const res = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/pay-quote`,
    payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock),
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'bad_quote_signature');
});

test('quote requests are limited per signer key', async () => {
  const { b, id } = await joinedDeal();
  let last;
  for (let i = 0; i < config.rateQuotesPerMin + 1; i++) {
    last = await app.inject({
      method: 'POST',
      url: `/api/deals/${b.handle}/pay-quote`,
      payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock),
    });
  }
  assert.equal(last!.statusCode, 429);
});

test('daily caps: offers and joins per network prefix, global join cap with a health warning', async () => {
  await setup({ dailyOffersPerIp: 3, dailyJoinsPerIp: 1, dailyJoinCap: 2, rateWritesPerMin: 100 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await postOffer(makeOffer(creator))).statusCode, 201);
  }
  const over = await postOffer(makeOffer(creator));
  assert.equal(over.statusCode, 429);
  assert.equal(over.json().error, 'daily_cap');
  // another /24 is not affected
  const other = makeOffer(creator);
  const r = await app.inject({
    method: 'POST',
    url: '/api/deals',
    remoteAddress: '203.0.113.7',
    payload: { handle: other.handle, offer: other.offer, offer_signature: other.offer_signature, terms: other.terms },
  });
  assert.equal(r.statusCode, 201);
  // joins: 1 per network, 2 globally (offers posted from other networks)
  const postFrom = (bb: OfferBundle, ip: string) =>
    app.inject({
      method: 'POST',
      url: '/api/deals',
      remoteAddress: ip,
      payload: { handle: bb.handle, offer: bb.offer, offer_signature: bb.offer_signature, terms: bb.terms },
    });
  const b1 = makeOffer(creator);
  assert.equal((await postFrom(b1, '192.0.2.1')).statusCode, 201);
  assert.equal((await join(b1)).statusCode, 201);
  const b2 = makeOffer(creator);
  assert.equal((await postFrom(b2, '192.0.2.2')).statusCode, 201);
  assert.equal((await join(b2)).statusCode, 429, 'per-network join cap');
  const j3 = await app.inject({
    method: 'POST',
    url: `/api/deals/${b2.handle}/join`,
    remoteAddress: '198.51.100.9',
    headers: { 'x-deal-token': b2.token },
    payload: { client_pk: client.pk },
  });
  assert.equal(j3.statusCode, 201);
  const h = (await app.inject({ method: 'GET', url: '/api/health' })).json();
  // near the global join cap: the warning goes to the server log, never to the public health answer
  assert.ok(!h.warnings.some((w: string) => /joins/.test(w)) && h.daily === undefined, 'no counters in public health');
});

// ======================================================================
// Round-3 PoCs, inverted (the attack must fail now)
// ======================================================================

test('POC3 fixed: one IP cannot exhaust the offer budget of everybody else', async () => {
  await setup({ dailyOffersPerIp: 5, rateWritesPerMin: 1000 });
  const attacker = keyFromSeed(90);
  let created = 0;
  for (let i = 0; i < 20; i++) {
    const b = makeOffer(attacker, { nowMs: clock });
    const r = await app.inject({
      method: 'POST',
      url: '/api/deals',
      remoteAddress: '6.6.6.6',
      payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms },
    });
    if (r.statusCode === 201) created++;
  }
  assert.equal(created, 5, 'the attacker is capped per network');
  const honest = makeOffer(creator, { nowMs: clock });
  const r = await app.inject({
    method: 'POST',
    url: '/api/deals',
    remoteAddress: '1.2.3.4',
    payload: { handle: honest.handle, offer: honest.offer, offer_signature: honest.offer_signature, terms: honest.terms },
  });
  assert.equal(r.statusCode, 201);
});

test('POC3 fixed: a time-dependent contract rejection is not cached; the same signed action is relayed again', async () => {
  const { b, id } = await joinedDeal({ nowMs: clock });
  chain.fund(id, '5000000');
  clock = Number(BigInt(chain.deals[id].delivery_deadline_ns!) / 1_000_000n) + 1_000;
  const orig = chain.act.bind(chain);
  let n = 0;
  chain.act = async (...a: Parameters<typeof orig>) => {
    n++;
    if (n === 1) throw new ChainCallError('refund: client may refund only a Funded deal after the delivery deadline', 'txA');
    return orig(...a);
  };
  let res = await act(b, id, client, 'refund', '{}');
  assert.equal(res.statusCode, 422);
  clock += 60_000;
  res = await act(b, id, client, 'refund', '{}');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(n, 2);
});

test('POC3 fixed: invalid POSTs from a shared IP do not block a valid dispute from the same IP', async () => {
  const { b, id } = await joinedDeal({ nowMs: clock });
  const d = chain.deals[id];
  d.state = 'Delivered';
  d.funded_amount = d.amount;
  d.review_ends_at_ns = String(BigInt(clock) * 1_000_000n + 3600n * 1_000_000_000n);
  for (let i = 0; i < config.rateInvalidPerMin + 5; i++) {
    await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/actions`, payload: {}, remoteAddress: '9.9.9.9' });
  }
  const junk = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/actions`, payload: {}, remoteAddress: '9.9.9.9' });
  assert.equal(junk.statusCode, 429, 'invalid requests from that IP are limited');
  const res = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/actions`,
    remoteAddress: '9.9.9.9',
    payload: { action: 'dispute', payload: '{}', signature: client.sign(id, 'dispute', '{}') },
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('POC3: round-2 censorship (junk from many IPs) does not block the dispute', async () => {
  const { b, id } = await joinedDeal({ nowMs: clock });
  const d = chain.deals[id];
  d.state = 'Delivered';
  d.funded_amount = d.amount;
  d.review_ends_at_ns = String(BigInt(clock) * 1_000_000n + 3600n * 1_000_000_000n);
  for (let i = 0; i < 100; i++) {
    await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/actions`, payload: {}, remoteAddress: `10.0.${i}.1` });
  }
  const res = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/actions`,
    remoteAddress: '10.9.9.9',
    payload: { action: 'dispute', payload: '{}', signature: client.sign(id, 'dispute', '{}') },
  });
  assert.equal(res.statusCode, 200, res.body);
});

test('POC3 fixed: N concurrent distinct-payload actions on one deal cause exactly one relayer tx', async () => {
  const { b, id } = await joinedDeal({ nowMs: clock });
  chain.fund(id, '5000000');
  const orig = chain.act.bind(chain);
  chain.act = async (...a: Parameters<typeof orig>) => {
    await new Promise((r) => setTimeout(r, 30));
    return orig(...a);
  };
  const N = 50;
  const res = await Promise.all(
    Array.from({ length: N }, (_, i) => {
      const p = JSON.stringify({ deliverable_hash: `h${i}` });
      return app.inject({
        method: 'POST',
        url: `/api/deals/${b.handle}/actions`,
        payload: { action: 'deliver', payload: p, signature: creator.sign(id, 'deliver', p) },
      });
    }),
  );
  const relayed = chain.calls.filter((c) => c.method === 'act').length;
  const codes = res.map((r) => r.statusCode);
  assert.equal(relayed, 1, 'only one relayer transaction for the deal');
  assert.equal(codes.filter((c) => c === 200).length, 1);
  assert.equal(codes.filter((c) => c === 409 || c === 429).length, N - 1);
  // the client's own key is unaffected by the creator's failures
  const ok = await act(b, id, client, 'accept', '{}');
  assert.equal(ok.statusCode, 200, ok.body);
});

test('timeout shares the per-deal lock: concurrent calls cause one tx', async () => {
  const { b, id } = await joinedDeal({ nowMs: clock });
  chain.fund(id, '5000000');
  await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  clock = Number(BigInt(chain.deals[id].review_ends_at_ns!) / 1_000_000n) + 1000;
  const orig = chain.releaseAfterTimeout.bind(chain);
  chain.releaseAfterTimeout = async (dealId: number) => {
    await new Promise((r) => setTimeout(r, 30));
    return orig(dealId);
  };
  const h = { 'x-deal-token': b.token };
  const [r1, r2] = await Promise.all([
    app.inject({ method: 'POST', url: `/api/deals/${b.handle}/timeout`, headers: h }),
    app.inject({ method: 'POST', url: `/api/deals/${b.handle}/timeout`, headers: h }),
  ]);
  assert.deepEqual([r1.statusCode, r2.statusCode].sort(), [200, 409]);
  assert.equal(chain.calls.filter((c) => c.method === 'release_after_timeout').length, 1);
});

test('401 responses do not echo the signed message', async () => {
  const { b, id } = await joinedDeal();
  const res = await act(b, id, stranger, 'deliver', '{"deliverable_hash":"h"}');
  assert.equal(res.statusCode, 401);
  assert.equal('signed_message' in res.json(), false);
  assert.doesNotMatch(res.body, /escrow-v1\|/);
});

test('quotes whose signed request differs from what the server sent are refused (R5b)', async () => {
  const { b, id } = await joinedDeal();
  for (const over of [
    { recipient: 'evil.near' },
    { customRecipientMsg: '{"deal_id":999}' },
    { refundTo: '0xEvil' },
    { amount: '1' },
    { destinationAsset: 'nep141:other' },
    { dry: true },
    { swapType: 'EXACT_INPUT' },
    { confidentiality: 'public' },
  ]) {
    oneClick.nextEchoOverride = over;
    const res = await app.inject({
      method: 'POST',
      url: `/api/deals/${b.handle}/pay-quote`,
      payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock),
    });
    assert.equal(res.statusCode, 502, JSON.stringify(over));
    assert.equal(res.json().error, 'quote_mismatch');
  }
  // payout: refundTo / refundType must be the party's own implicit INTENTS account
  chain.deals[id].state = 'Released';
  chain.deals[id].creator_payout = '5000000';
  for (const over of [{ refundTo: 'operator.near' }, { refundType: 'ORIGIN_CHAIN' }]) {
    oneClick.nextEchoOverride = over;
    const res = await app.inject({
      method: 'POST',
      url: `/api/deals/${b.handle}/payout-quote`,
      payload: signedRequest(creator, id, 'payout-quote', { destination_asset: 'x', recipient: 'y', recipient_type: 'DESTINATION_CHAIN' }, clock),
    });
    assert.equal(res.statusCode, 502, JSON.stringify(over));
  }
});

// ------------------------------------------------------------ fixes from the internal review (2026-11-03)

/** A deal in Released with the whole 5 USDC payout withdrawable by the creator. */
async function releasedDeal() {
  const { b, id } = await joinedDeal();
  chain.deals[id].state = 'Released';
  chain.deals[id].creator_payout = '5000000';
  return { b, id };
}
const expiresIn = (ms: number) => ((BigInt(clock) + BigInt(ms)) * 1_000_000n).toString();

test('only the whole payout is relayed; dust withdraws are refused before gas', async () => {
  const { b, id } = await releasedDeal();
  const before = chain.calls.length;
  const res = await act(b, id, creator, 'withdraw', JSON.stringify({ destination: 'd'.repeat(64), amount: '1', expires_at_ns: expiresIn(600_000) }));
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /whole withdrawable payout/);
  assert.equal(chain.calls.length, before);
});

test('a named destination that does not exist is refused; an existing one is relayed', async () => {
  const { b, id } = await releasedDeal();
  chain.missingAccounts.add('nobody.near');
  let res = await act(b, id, creator, 'withdraw', JSON.stringify({ destination: 'nobody.near', amount: '5000000', expires_at_ns: expiresIn(600_000) }));
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /does not exist/);
  res = await act(b, id, creator, 'withdraw', JSON.stringify({ destination: 'alice.near', amount: '5000000', expires_at_ns: expiresIn(600_000) }));
  assert.equal(res.statusCode, 200, res.body);
});

test('relayed withdraw attempts per party per deal are capped per day', async () => {
  await setup({ dailyWithdrawsPerParty: 2 });
  const { b, id } = await releasedDeal();
  for (let i = 0; i < 2; i++) {
    chain.nextActValue = false; // the token transfer fails, the payout is restored
    const res = await act(b, id, creator, 'withdraw', JSON.stringify({ destination: 'd'.repeat(64), amount: '5000000', expires_at_ns: expiresIn(600_000 + i) }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().ok, false);
  }
  const res = await act(b, id, creator, 'withdraw', JSON.stringify({ destination: 'd'.repeat(64), amount: '5000000', expires_at_ns: expiresIn(600_100) }));
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, 'daily_cap');
  assert.ok(res.json().act_call, 'the submit-yourself call is still returned');
});

test('joins pause while escrow or relayer NEAR is below the join reserve', async () => {
  const b = makeOffer(creator);
  assert.equal((await postOffer(b)).statusCode, 201);
  chain.balances = { escrow: 10n ** 23n, relayer: 10n ** 24n * 5n }; // escrow 0.1 NEAR free
  let res = await join(b);
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'low_balance');
  assert.equal(chain.calls.filter((c) => c.method === 'create_deal').length, 0);
  chain.balances = { escrow: 10n ** 24n * 5n, relayer: 10n ** 23n }; // relayer low
  assert.equal((await join(b)).statusCode, 503);
  chain.balances = { escrow: 10n ** 24n * 5n, relayer: 10n ** 24n * 5n };
  res = await join(b);
  assert.equal(res.statusCode, 201, res.body);
});

test('the pay-quote deposit deadline ends 1 h before pay_by; too close to pay_by is refused', async () => {
  const nowNs = BigInt(clock) * 1_000_000n;
  const MIN = 60n * 1_000_000_000n;
  const quote = (h: string, id: number) =>
    app.inject({
      method: 'POST',
      url: `/api/deals/${h}/pay-quote`,
      payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock),
    });
  // pay_by in 64 min: only 4 min left before pay_by - 1 h -> too late
  const late = await joinedDeal();
  chain.deals[late.id].pay_by_ns = (nowNs + 64n * MIN).toString();
  let res = await quote(late.b.handle, late.id);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'too_late');
  assert.equal(oneClick.quotes.length, 0);
  // pay_by in 80 min: the deposit is due at pay_by - 1 h (20 min from now)
  const soon = await joinedDeal();
  chain.deals[soon.id].pay_by_ns = (nowNs + 80n * MIN).toString();
  res = await quote(soon.b.handle, soon.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(Date.parse(oneClick.quotes.at(-1)!.deadline), Number((nowNs + 20n * MIN) / 1_000_000n));
  // pay_by far away (fresh deal: 7 days): the normal quote window
  const far = await joinedDeal();
  res = await quote(far.b.handle, far.id);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(Date.parse(oneClick.quotes.at(-1)!.deadline), clock + config.quoteDeadlineSeconds * 1000);
});

test('an IP over its invalid budget reads the chain at most once per 2 s; its valid action still goes through', async () => {
  await setup({ rateInvalidPerMin: 3 });
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  let reads = 0;
  const orig = chain.getDeal.bind(chain);
  chain.getDeal = async (i: number) => {
    reads++;
    return orig(i);
  };
  const junk = () => act(b, id, stranger, 'accept', '{}');
  for (let i = 0; i < 3; i++) assert.equal((await junk()).statusCode, 401);
  const afterBudget = reads;
  for (let i = 0; i < 50; i++) assert.equal((await junk()).statusCode, 429);
  assert.ok(reads - afterBudget <= 1, `junk caused ${reads - afterBudget} chain reads`);
  // a valid deal-key action from the same IP is not blocked
  const res = await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  assert.equal(res.statusCode, 200, res.body);
});

test('timeouts are queued with no deadline, behind deliver/dispute (before: at their past due time)', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
  const ends = BigInt(chain.deals[id].review_ends_at_ns!);
  clock = Number(ends / 1_000_000n) + 1000;
  const res = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/timeout`, headers: { 'x-deal-token': b.token } });
  assert.equal(res.statusCode, 200, res.body);
  const call = chain.calls.at(-1)!;
  assert.equal(call.method, 'release_after_timeout');
  assert.equal(call.args[1], undefined, 'no priority: a past due time would outrank a dispute');
});

test('request logs carry no query string and no IP', async () => {
  const lines: string[] = [];
  const { Writable } = await import('node:stream');
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  const logged = await buildApp({ config, chain, oneClick, store: new SqliteStore(':memory:'), now: () => clock, logger: { level: 'info', stream } });
  const b = makeOffer(creator);
  await logged.inject({
    method: 'GET',
    url: `/api/deals/${b.handle}/pay-status?deposit_address=SECRETDEPOSITADDR`,
    remoteAddress: '198.51.100.23',
  });
  const all = lines.join('');
  assert.ok(all.includes('/pay-status'), 'the request is logged');
  assert.ok(!all.includes('SECRETDEPOSITADDR'), 'no deposit address in logs');
  assert.ok(!all.includes('198.51.100.23'), 'no IP in logs');
  await logged.close();
});

// ======================================================================
// Contract v2 (2026-11-06)
// ======================================================================

const SEC = 1_000_000_000n;
const nsNow = () => BigInt(clock) * 1_000_000n;
const settlePayload = (over: Record<string, string> = {}) =>
  JSON.stringify({ split_bps: '7000', state: 'Delivered', seq: '0', expires_at_ns: (nsNow() + 3600n * SEC).toString(), nonce: 'n-1', ...over });

async function deliveredDeal() {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  assert.equal((await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}')).statusCode, 200);
  return { b, id };
}

test('v2 settle: one side publishes a signed proposal, the other reads it, both signatures are relayed; fee only from the creator share', async () => {
  const { b, id } = await deliveredDeal();
  const h = { 'x-deal-token': b.token };
  const url = `/api/deals/${b.handle}/settle-proposal`;
  const p = settlePayload();
  const csig = creator.sign(id, 'settle', p);
  assert.equal((await app.inject({ method: 'POST', url, payload: { payload: p, signature: csig } })).statusCode, 404, 'needs the link token');
  let res = await app.inject({ method: 'POST', url, headers: h, payload: { payload: p, signature: stranger.sign(id, 'settle', p) } });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'POST', url, headers: h, payload: { payload: p, signature: creator.sign(id, 'deliver', p) } });
  assert.equal(res.statusCode, 401, 'a signature for another action does not count');
  const wrongState = settlePayload({ state: 'Funded' });
  res = await app.inject({ method: 'POST', url, headers: h, payload: { payload: wrongState, signature: creator.sign(id, 'settle', wrongState) } });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /signed for Funded/);
  res = await app.inject({ method: 'POST', url, headers: h, payload: { payload: p, signature: csig } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(res.json().signer, 'creator');
  assert.equal(res.json().timer_ends_at_ns, chain.deals[id].review_ends_at_ns);
  assert.equal(chain.calls.filter((c) => c.method === 'settle').length, 0, 'a proposal alone is off-chain');

  const list = await app.inject({ method: 'GET', url: `/api/deals/${b.handle}/settle-proposals`, headers: h });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().proposals.map((x: { signer: string; payload: string; signature: string }) => [x.signer, x.payload, x.signature]),
    [['creator', p, csig]],
  );
  assert.equal((await app.inject({ method: 'GET', url: `/api/deals/${b.handle}/settle-proposals` })).statusCode, 404);

  const ksig = client.sign(id, 'settle', p);
  const settle = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/deals/${b.handle}/settle`, headers: h, payload: body });
  res = await settle({ payload: p, creator_signature: ksig, client_signature: csig });
  assert.equal(res.statusCode, 403, 'signatures in the wrong slots');
  res = await settle({ payload: p, creator_signature: csig, client_signature: csig });
  assert.equal(res.statusCode, 403);
  res = await settle({ payload: p, creator_signature: csig, client_signature: ksig });
  assert.equal(res.statusCode, 200, res.body);
  const call = chain.calls.find((c) => c.method === 'settle')!;
  assert.deepEqual(call.args, [id, p, csig, ksig]);
  const d = chain.deals[id];
  assert.equal(d.state, 'Released');
  assert.equal(d.creator_payout, '3395000', '70% = 3.5 USDC minus 3% fee');
  assert.equal(d.client_payout, '1500000');
  assert.equal(d.fee_amount, '105000');
  assert.deepEqual(d.outcome, { Settled: { creator_share_bps: 7000 } });
  res = await settle({ payload: p, creator_signature: csig, client_signature: ksig });
  assert.equal(res.statusCode, 409, 'a second settle is refused before gas');
  assert.equal(chain.calls.filter((c) => c.method === 'settle').length, 1);
});

test('v2 settle: revoke_settle bumps the seq so an old proposal dies; settle after the running timer is refused', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '5000000');
  const h = { 'x-deal-token': b.token };
  const p = settlePayload({ state: 'Funded', split_bps: '2000' });
  const body = { payload: p, creator_signature: creator.sign(id, 'settle', p), client_signature: client.sign(id, 'settle', p) };
  let res = await act(b, id, stranger, 'revoke_settle', '{"seq":"0"}');
  assert.equal(res.statusCode, 401);
  res = await act(b, id, client, 'revoke_settle', '{"seq":"0"}');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(chain.deals[id].settle_seq, 1);
  // contract v2: the same revoke cannot be replayed; a stale or
  // missing seq is refused before any gas is spent
  const before = chain.calls.length;
  // the exact same signature again: answered from the replay cache, not relayed
  await act(b, id, client, 'revoke_settle', '{"seq":"0"}');
  // the other party's revoke of the old seq: refused by the pre-check
  res = await act(b, id, creator, 'revoke_settle', '{"seq":"0"}');
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /settle_seq/);
  res = await act(b, id, creator, 'revoke_settle', '{"n":"1"}');
  assert.equal(res.statusCode, 409);
  assert.equal(chain.calls.length, before, 'nothing relayed');
  assert.equal(chain.deals[id].settle_seq, 1);
  res = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/settle`, headers: h, payload: body });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /revoked/);

  const p2 = settlePayload({ state: 'Funded', split_bps: '2000', seq: '1', expires_at_ns: (nsNow() + 30n * 86400n * SEC).toString() });
  const body2 = { payload: p2, creator_signature: creator.sign(id, 'settle', p2), client_signature: client.sign(id, 'settle', p2) };
  clock = Number(BigInt(chain.deals[id].delivery_deadline_ns!) / 1_000_000n) + 1000;
  res = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/settle`, headers: h, payload: body2 });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /timer is over/);
  assert.equal(chain.calls.filter((c) => c.method === 'settle').length, 0);
  // revoke_settle is refused before funding
  const fresh = await joinedDeal({ nowMs: clock });
  res = await act(fresh.b, fresh.id, creator, 'revoke_settle', '{"seq":"0"}');
  assert.equal(res.statusCode, 409);
});

test('v2 cancel is refused while the client holds a live payment address (R7); allowed after it expires', async () => {
  const { b, id } = await joinedDeal();
  const q = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/pay-quote`,
    payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock),
  });
  assert.equal(q.statusCode, 200, q.body);
  let res = await act(b, id, creator, 'cancel', '{"n":"1"}');
  assert.equal(res.statusCode, 409);
  assert.match(res.json().message, /may still be paying/);
  assert.equal(chain.calls.filter((c) => c.method === 'act').length, 0);
  // Still refused right after the quote deadline (the swap may be settling)
  clock += config.quoteDeadlineSeconds * 1000 + 1000;
  res = await act(b, id, creator, 'cancel', '{"n":"3"}');
  assert.equal(res.statusCode, 409);
  clock += 3600 * 1000;
  res = await act(b, id, creator, 'cancel', '{"n":"2"}');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(chain.deals[id].state, 'Cancelled');
});

test('v2 /timeout closes a never-paid deal after the funding cutoff (close_unpaid); the underpayment stays withdrawable', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '2000000');
  const url = `/api/deals/${b.handle}/timeout`;
  const h = { 'x-deal-token': b.token };
  let res = await app.inject({ method: 'POST', url, headers: h });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'too_early');
  assert.equal(res.json().ends_at_ns, chain.deals[id].funding_cutoff_ns);
  const cutoff = BigInt(chain.deals[id].funding_cutoff_ns);
  clock = Number(cutoff / 1_000_000n) + 1000;
  res = await app.inject({ method: 'POST', url, headers: h });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().outcome, 'closed_unpaid');
  const call = chain.calls.at(-1)!;
  assert.equal(call.method, 'close_unpaid');
  assert.equal(call.args[1], undefined, 'no priority');
  assert.equal(chain.deals[id].state, 'Expired');
  const w = JSON.stringify({ destination: 'd'.repeat(64), amount: '2000000', expires_at_ns: ((BigInt(clock) + 600_000n) * 1_000_000n).toString() });
  res = await act(b, id, client, 'withdraw', w);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(chain.deals[id].state, 'PaidOut');
  assert.equal((await app.inject({ method: 'POST', url, headers: h })).statusCode, 409);
});

test('v2 the client withdraws extra money mid-deal without ending the deal; a relayed withdraw attaches 0.00225 NEAR', async () => {
  const { b, id } = await joinedDeal();
  chain.fund(id, '7000000'); // 2 USDC more than the price
  assert.equal(chain.deals[id].state, 'Funded');
  const url = `/api/deals/${b.handle}/payout-quote`;
  const fields = { destination_asset: 'nep141:sol-5ce3.omft.near', recipient: 'SoLaNaAddr', recipient_type: 'DESTINATION_CHAIN' };
  let res = await app.inject({ method: 'POST', url, payload: signedRequest(creator, id, 'payout-quote', fields, clock) });
  assert.equal(res.statusCode, 409, 'the creator has nothing yet');
  res = await app.inject({ method: 'POST', url, payload: signedRequest(client, id, 'payout-quote', fields, clock) });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().amount, '2000000');
  res = await act(b, id, client, 'withdraw', res.json().withdraw_payload);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().act_call.deposit, '2250000000000000000000');
  assert.equal(res.json().act_call.args.action, 'withdraw');
  assert.equal(chain.deals[id].state, 'Funded', 'still Funded: PaidOut only for resolved deals');
  assert.equal(chain.deals[id].client_payout, '0');
  const other = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/act-call`,
    payload: { action: 'accept', payload: '{}', signature: client.sign(id, 'accept', '{}') },
  });
  assert.equal(other.json().act_call.deposit, '0', 'other actions take no deposit');
  const c = (await app.inject({ method: 'GET', url: '/api/config' })).json();
  assert.equal(c.withdraw_deposit_yocto, '2250000000000000000000');
  assert.equal(c.fee_bps, 300);
});

test('v2 revoke: the creator revokes an unjoined link on-chain; join is refused afterwards; a joined link cannot be revoked', async () => {
  const b = makeOffer(creator);
  assert.equal((await postOffer(b)).statusCode, 201);
  const url = `/api/deals/${b.handle}/revoke`;
  const msg = revokeOfferMessage(CONTRACT_ID, b.offer);
  let res = await app.inject({ method: 'POST', url, payload: { signature: stranger.signRaw(msg) } });
  assert.equal(res.statusCode, 401);
  res = await app.inject({ method: 'POST', url, payload: { signature: creator.signRaw(offerMessage(CONTRACT_ID, b.offer)) } });
  assert.equal(res.statusCode, 401, 'the offer signature itself is not a revocation');
  res = await app.inject({ method: 'POST', url, payload: { signature: creator.signRaw(msg) } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(chain.calls.at(-1), { method: 'revoke_offer', args: [b.offer, creator.signRaw(msg)] });
  assert.equal((await get(b)).json().revoked, true);
  res = await join(b);
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, 'revoked');
  assert.equal(chain.calls.filter((c) => c.method === 'create_deal').length, 0, 'no gas for a doomed join');
  res = await app.inject({ method: 'POST', url, payload: { signature: creator.signRaw(msg) } });
  assert.equal(res.statusCode, 409);

  const { b: jb } = await joinedDeal();
  res = await app.inject({
    method: 'POST',
    url: `/api/deals/${jb.handle}/revoke`,
    payload: { signature: creator.signRaw(revokeOfferMessage(CONTRACT_ID, jb.offer)) },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'already_joined');
});

test('v2 revoked on-chain but not in our DB (restored backup): the join is refused and remembered', async () => {
  const b = makeOffer(creator);
  assert.equal((await postOffer(b)).statusCode, 201);
  chain.revokedOffers.add(b.offer);
  let res = await join(b);
  assert.equal(res.statusCode, 410);
  assert.equal((await get(b)).json().revoked, true);
  res = await join(b);
  assert.equal(res.statusCode, 410);
  assert.equal(chain.calls.filter((c) => c.method === 'create_deal').length, 1, 'only the first join reached the chain');
});

test('v2 GET shows the deadline only after funding (funded_at + duration)', async () => {
  const { b, id } = await joinedDeal({ durationNs: 3n * 86400n * SEC });
  let g = (await get(b)).json();
  assert.equal(g.terms.delivery_deadline, null);
  assert.equal(g.terms.delivery_duration_seconds, 3 * 86400);
  assert.equal(g.deal.delivery_deadline_ns, null);
  clock += 3600_000;
  chain.fund(id, '5000000');
  g = (await get(b)).json();
  assert.equal(BigInt(g.deal.delivery_deadline_ns), BigInt(g.deal.funded_at_ns) + 3n * 86400n * SEC);
  assert.equal(g.terms.delivery_deadline, new Date(clock + 3 * 86400_000).toISOString());
});

test('FSTDEP023 gone: no deprecation warning; request logs stay method + path + status only', async () => {
  const warnings: string[] = [];
  const onWarning = (w: Error & { code?: string }) => warnings.push(String(w.code ?? w.name));
  process.on('warning', onWarning);
  const lines: string[] = [];
  const stream = { write: (l: string) => void lines.push(l) };
  try {
    const logged = await buildApp({
      config,
      chain,
      oneClick,
      store: new SqliteStore(':memory:'),
      now: () => clock,
      logger: { level: 'info', stream },
    });
    const res = await logged.inject({ method: 'GET', url: '/api/health?deposit=secret-address', headers: { 'x-deal-token': 'secret-token' } });
    assert.equal(res.statusCode, 200);
    await logged.close();
    await new Promise((r) => setImmediate(r)); // warnings are emitted on the next tick
  } finally {
    process.off('warning', onWarning);
  }
  assert.ok(!warnings.includes('FSTDEP023'), warnings.join(','));
  const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const req = recs.filter((r) => r.msg === 'request');
  assert.equal(req.length, 1, lines.join(''));
  assert.equal(req[0].url, '/api/health');
  assert.equal(req[0].method, 'GET');
  assert.equal(req[0].status, 200);
  assert.ok(!recs.some((r) => r.msg === 'incoming request' || r.msg === 'request completed'), 'Fastify own request lines stay off');
  assert.ok(!lines.join('').includes('secret'), 'no query string, no headers');
});
