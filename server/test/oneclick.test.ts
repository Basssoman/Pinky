import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OneClickClient, OneClickError } from '../src/oneclick.ts';

type Captured = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown, captured: Captured[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

test('sends X-API-Key and JSON body to /v0/quote', async () => {
  const cap: Captured[] = [];
  const c = new OneClickClient({
    baseUrl: 'https://1click.example/',
    apiKey: 'secret-key',
    fetchImpl: fakeFetch(200, { quote: { amountIn: '1' } }, cap),
  });
  const res = await c.quote({
    dry: true,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: 100,
    originAsset: 'a',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'b',
    amount: '1',
    refundTo: 'r',
    refundType: 'ORIGIN_CHAIN',
    recipient: 'x.near',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2030-01-01T00:00:00Z',
  });
  assert.equal(res.quote.amountIn, '1');
  assert.equal(cap[0].url, 'https://1click.example/v0/quote');
  assert.equal(cap[0].init.method, 'POST');
  const h = cap[0].init.headers as Record<string, string>;
  assert.equal(h['X-API-Key'], 'secret-key');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(JSON.parse(String(cap[0].init.body)).swapType, 'EXACT_OUTPUT');
});

test('no key -> no header; status query string', async () => {
  const cap: Captured[] = [];
  const c = new OneClickClient({ baseUrl: 'https://1click.example', fetchImpl: fakeFetch(200, { status: 'SUCCESS' }, cap) });
  const s = await c.status('dep addr', 'memo1');
  assert.equal(s.status, 'SUCCESS');
  assert.equal(cap[0].url, 'https://1click.example/v0/status?depositAddress=dep+addr&depositMemo=memo1');
  assert.equal((cap[0].init.headers as Record<string, string>)['X-API-Key'], undefined);
});

test('errors carry upstream status + message, never the key', async () => {
  const cap: Captured[] = [];
  const c = new OneClickClient({
    baseUrl: 'https://1click.example',
    apiKey: 'secret-key',
    fetchImpl: fakeFetch(400, { message: 'Amount is too low for bridge' }, cap),
  });
  await assert.rejects(c.getTokens(), (e: unknown) => {
    assert.ok(e instanceof OneClickError);
    assert.equal(e.status, 400);
    assert.match(e.message, /too low/);
    assert.doesNotMatch(e.message, /secret-key/);
    return true;
  });
});

test('network failure -> status 0', async () => {
  const c = new OneClickClient({
    baseUrl: 'https://1click.example',
    apiKey: 'secret-key',
    fetchImpl: (async () => {
      throw new TypeError('fetch failed secret-key');
    }) as typeof fetch,
  });
  await assert.rejects(c.getTokens(), (e: unknown) => {
    assert.ok(e instanceof OneClickError);
    assert.equal(e.status, 0);
    assert.doesNotMatch(e.message, /secret-key/);
    return true;
  });
});
