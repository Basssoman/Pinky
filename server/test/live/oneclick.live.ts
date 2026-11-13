// Live check of 1Click request shapes. DRY quotes only (no deposit
// addresses, no funds). Run with `npm run test:live`; uses ONECLICK_API_KEY
// from the env files (never printed).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildApp } from '../../src/app.ts';
import { loadEnvFiles, readConfig } from '../../src/config.ts';
import { implicitAccountId } from '../../src/encoding.ts';
import { OneClickClient, type OneClickToken } from '../../src/oneclick.ts';
import { SqliteStore } from '../../src/store.ts';
import { FakeChain, keyFromSeed, makeOffer, signedRequest } from '../helpers.ts';

loadEnvFiles();
const base = readConfig();
const config = { ...base, oneClickForceDry: true, dbPath: ':memory:', minReviewPeriodSeconds: 60, minDeliverySeconds: 60 };
const oneClick = new OneClickClient({ baseUrl: config.oneClickBaseUrl, apiKey: config.oneClickApiKey });

let tokens: OneClickToken[] = [];

test('GET /v0/tokens includes NEAR USDC (the escrow token)', async () => {
  tokens = await oneClick.getTokens();
  const usdc = tokens.find((t) => t.assetId === config.usdcAssetId);
  assert.ok(usdc, 'NEAR USDC asset id not listed');
  assert.equal(usdc.decimals, 6);
  console.log(`api key present: ${config.oneClickApiKey ? 'yes' : 'no'}; tokens: ${tokens.length}`);
});

test('server builds dry pay-quote and payout-quote requests 1Click accepts', async () => {
  if (!tokens.length) tokens = await oneClick.getTokens();
  // 1Click rejects quotes to non-existent NAMED NEAR accounts, so stand in an
  // existing account for the escrow contract id. Dry only.
  const chain = new FakeChain(process.env.LIVE_ESCROW_STANDIN || 'intents.near');
  const app = await buildApp({ config, chain, oneClick, store: new SqliteStore(':memory:') });
  const creator = keyFromSeed(41);
  const client = keyFromSeed(42);

  const b = makeOffer(creator, { contractId: chain.contractId });
  const created = await app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms },
  });
  assert.equal(created.statusCode, 201, created.body);
  const joined = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/join`,
    headers: { 'x-deal-token': b.token },
    payload: { client_pk: client.pk },
  });
  assert.equal(joined.statusCode, 201, joined.body);
  const id = joined.json().deal_id;

  const baseUsdc = tokens.find((t) => t.symbol === 'USDC' && t.blockchain === 'base');
  assert.ok(baseUsdc);

  const pay = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/pay-quote`,
    payload: signedRequest(client, id, 'pay-quote', {
      origin_asset: baseUsdc.assetId,
      refund_address: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D',
    }, Date.now(), chain.contractId),
  });
  console.log('pay-quote', pay.statusCode, JSON.stringify(pay.json().quote_response?.quote ?? pay.json()));
  assert.equal(pay.statusCode, 200, pay.body);
  assert.equal(pay.json().quote_response.quoteRequest.customRecipientMsg, `{"deal_id":${id}}`);

  chain.fund(id, '5000000');
  chain.deals[id].state = 'Released';
  chain.deals[id].creator_payout = '5000000';
  for (const [asset, recipient, type] of [
    [baseUsdc.assetId, '0x2527D02599Ba641c19FEa793cD0F167589a0f10D', 'DESTINATION_CHAIN'],
    [config.usdcAssetId, 'escrow-demo-recipient.near', 'CONFIDENTIAL_INTENTS'],
  ]) {
    const payout = await app.inject({
      method: 'POST',
      url: `/api/deals/${b.handle}/payout-quote`,
      payload: signedRequest(creator, id, 'payout-quote', { destination_asset: asset, recipient, recipient_type: type }, Date.now(), chain.contractId),
    });
    const body = payout.json();
    console.log('payout-quote', type, payout.statusCode, body.refund_type, body.refund_to, JSON.stringify(body.quote_response?.quote ?? body));
    assert.equal(payout.statusCode, 200, payout.body);
    assert.equal(body.refund_type, 'INTENTS');
    assert.equal(body.refund_to, implicitAccountId(creator.pk));
    assert.equal(body.quote_response.quoteRequest.refundTo, implicitAccountId(creator.pk));
  }
});
