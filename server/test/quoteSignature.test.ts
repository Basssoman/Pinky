import assert from 'node:assert/strict';
import { sign as edSign } from 'node:crypto';
import { test } from 'node:test';

import { base58Encode } from '../src/encoding.ts';
import { ONE_CLICK_MANAGER_PUBLIC_KEY, quoteSigningMessage, verifyQuoteSignature } from '../src/quoteSignature.ts';
import { quoteSigner } from './helpers.ts';

function signed(dry: boolean) {
  const res = {
    timestamp: '2026-11-02T00:00:00.000Z',
    quoteRequest: {
      dry,
      swapType: 'EXACT_INPUT',
      slippageTolerance: 100,
      originAsset: 'nep141:usdc',
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:sol-usdc',
      amount: '5000000',
      refundTo: 'a'.repeat(64),
      refundType: 'INTENTS',
      recipient: 'SoLaNa',
      recipientType: 'DESTINATION_CHAIN',
      deadline: '2026-11-02T00:30:00.000Z',
      quoteWaitingTimeMs: 3000,
      confidentiality: 'basic',
    },
    quote: {
      amountIn: '5000000',
      amountInFormatted: '5.0',
      amountInUsd: '5',
      minAmountIn: '5000000',
      amountOut: '4990000',
      amountOutFormatted: '4.99',
      amountOutUsd: '4.99',
      minAmountOut: '4940000',
      ...(dry ? {} : { depositAddress: 'f'.repeat(64), deadline: '2026-11-02T00:30:00.000Z', timeEstimate: 20 }),
    },
    signature: '',
  };
  const sig = edSign(null, Buffer.from(quoteSigningMessage(res), 'utf8'), quoteSigner().priv);
  res.signature = `ed25519:${base58Encode(sig)}`;
  return res;
}

test('quote signature: valid for dry and non-dry quotes, any tampering of covered fields fails', () => {
  for (const dry of [true, false]) {
    const res = signed(dry);
    assert.ok(verifyQuoteSignature(res, quoteSigner().pk));
    assert.ok(!verifyQuoteSignature(res), 'wrong key (the real 1Click manager key) fails');
    for (const [where, field, value] of [
      ['quoteRequest', 'recipient', 'evil'],
      ['quoteRequest', 'refundTo', 'evil.near'],
      ['quoteRequest', 'amount', '1'],
      ['quoteRequest', 'destinationAsset', 'nep141:x'],
      ['quote', 'amountOut', '1'],
    ] as const) {
      const t = structuredClone(res) as unknown as Record<string, Record<string, unknown>>;
      t[where][field] = value;
      assert.ok(!verifyQuoteSignature(t, quoteSigner().pk), `${where}.${field}`);
    }
    const t2 = structuredClone(res);
    t2.timestamp = '2026-11-02T00:00:01.000Z';
    assert.ok(!verifyQuoteSignature(t2, quoteSigner().pk), 'timestamp');
  }
  const nd = structuredClone(signed(false)) as unknown as Record<string, Record<string, unknown>>;
  nd.quote.depositAddress = 'e'.repeat(64);
  assert.ok(!verifyQuoteSignature(nd, quoteSigner().pk), 'depositAddress is covered for non-dry quotes');
});

test('quote signature: NOT covered fields (documented): confidentiality', () => {
  const res = signed(false);
  const t = structuredClone(res);
  t.quoteRequest.confidentiality = 'public';
  assert.ok(verifyQuoteSignature(t, quoteSigner().pk));
});

test('quote signature: malformed input never throws', () => {
  assert.equal(verifyQuoteSignature({}), false);
  assert.equal(verifyQuoteSignature({ signature: 'ed25519:xyz', quote: {}, quoteRequest: {} }), false);
  assert.match(ONE_CLICK_MANAGER_PUBLIC_KEY, /^ed25519:/);
});

// ---------------------------------------------------------------- R5a: official SDK + real fixture

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { quoteHash as sdkQuoteHash, verifyQuoteSignature as sdkVerify } from '@defuse-protocol/one-click-sdk-typescript';

function loadFixture(): Record<string, any> {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [resolve(here, 'fixtures/dry-quote.json'), resolve(here, '../../test/fixtures/dry-quote.json')]) {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      /* try next */
    }
  }
  throw new Error('fixture not found');
}

test('real 1Click dry quote (fixture) verifies with our helper and with the official SDK', () => {
  const fx = loadFixture();
  assert.equal(JSON.stringify(fx).toLowerCase().includes('api-key'), false, 'fixture has no key-like headers');
  assert.equal(verifyQuoteSignature(fx), true);
  assert.equal(sdkVerify(fx as never), true);
  assert.equal(quoteSigningMessage(fx), sdkQuoteHash(fx as never), 'same signed message as the SDK');
});

test('our verifier agrees with the SDK on every tampered variant (fixture + synthetic)', () => {
  const fx = loadFixture();
  const variants: [string, (r: any) => void][] = [
    ['amountIn', (r) => (r.quote.amountIn = '1')],
    ['recipient', (r) => (r.quoteRequest.recipient = 'evil.near')],
    ['customRecipientMsg', (r) => (r.quoteRequest.customRecipientMsg = '{"deal_id":9}')],
    ['refundTo', (r) => (r.quoteRequest.refundTo = '0x0')],
    ['timestamp', (r) => (r.timestamp = '2020-01-01T00:00:00.000Z')],
    ['confidentiality (not covered)', (r) => (r.quoteRequest.confidentiality = 'public')],
    ['appFees (not covered)', (r) => (r.quoteRequest.appFees = [])],
    ['depositMode (not covered)', (r) => (r.quoteRequest.depositMode = 'MEMO')],
    ['quoteWaitingTimeMs 0', (r) => (r.quoteRequest.quoteWaitingTimeMs = 0)],
  ];
  for (const [name, mutate] of variants) {
    const r = structuredClone(fx);
    mutate(r);
    assert.equal(verifyQuoteSignature(r), sdkVerify(r as never), name);
    assert.equal(quoteSigningMessage(r), sdkQuoteHash(r as never), name);
  }
  // synthetic non-dry quotes signed with a test key, incl. falsy optionals
  for (const dry of [true, false]) {
    const r = signed(dry) as any;
    if (!dry) {
      r.quote.depositMemo = null;
      r.quote.refundFee = '';
    }
    const sig = edSign(null, Buffer.from(quoteSigningMessage(r), 'utf8'), quoteSigner().priv);
    r.signature = `ed25519:${base58Encode(sig)}`;
    assert.equal(sdkVerify(r, quoteSigner().pk), true, `sdk dry=${dry}`);
    assert.equal(quoteSigningMessage(r), sdkQuoteHash(r), `message dry=${dry}`);
  }
});
