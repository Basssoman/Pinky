import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  base58Decode,
  base58Encode,
  baseUnitsToUsdc,
  canonicalJson,
  implicitAccountId,
  isAccountId,
  isCanonicalSignature,
  offerMessage,
  parseOffer,
  parsePublicKey,
  signedMessage,
  termsHash,
  toNanos,
  usdcToBaseUnits,
  verifySignature,
} from '../src/encoding.ts';
import { keyFromSeed, makeOffer } from './helpers.ts';

test('base58 round trip incl. leading zeros', () => {
  for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([0])]) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
  }
  assert.equal(base58Encode(new Uint8Array([0, 0, 0])), '111');
  assert.throws(() => base58Decode('0OIl'));
});

test('public key parsing and implicit account id', () => {
  const k = keyFromSeed(1);
  assert.equal(parsePublicKey(k.pk)?.length, 32);
  assert.equal(parsePublicKey(k.pk.replace('ed25519:', '')), null);
  assert.equal(parsePublicKey('ed25519:abc'), null);
  assert.equal(parsePublicKey(42), null);
  const implicit = implicitAccountId(k.pk);
  assert.match(implicit, /^[0-9a-f]{64}$/);
  assert.equal(implicit, Buffer.from(parsePublicKey(k.pk)!).toString('hex'));
  assert.ok(isAccountId(implicit));
});

test('signed message format and verification', () => {
  const creator = keyFromSeed(1);
  const client = keyFromSeed(2);
  const payload = '{"destination":"abc.near","amount":"1","expires_at_ns":"9"}';
  const msg = signedMessage('escrow.near', 7, 'withdraw', payload);
  assert.equal(msg, `escrow-v1|escrow.near|7|withdraw|${payload}`);
  const sig = creator.sign(7, 'withdraw', payload, 'escrow.near');
  assert.ok(verifySignature(creator.pk, msg, sig));
  assert.ok(!verifySignature(client.pk, msg, sig));
  assert.ok(!verifySignature(creator.pk, signedMessage('escrow.near', 8, 'withdraw', payload), sig));
  assert.ok(!verifySignature(creator.pk, signedMessage('escrow.near', 7, 'accept', payload), sig));
  assert.ok(!verifySignature(creator.pk, signedMessage('other.near', 7, 'withdraw', payload), sig));
  assert.ok(!verifySignature(creator.pk, msg, 'AAAA'));
  assert.ok(!verifySignature('ed25519:bad', msg, sig));
});

test('only canonical padded base64 signatures are accepted (review PoC 8)', () => {
  const sig = keyFromSeed(1).sign(0, 'deliver', '{}');
  assert.equal(sig.length, 88);
  assert.ok(isCanonicalSignature(sig));
  assert.ok(!isCanonicalSignature(sig.replace(/=+$/, '')), 'unpadded');
  assert.ok(!isCanonicalSignature(sig.replace(/\+/g, '-').replace(/\//g, '_')), 'url-safe alphabet');
  // non-canonical: last data char with non-zero low bits decodes to the same bytes
  const last = sig[85];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const alt = alphabet[(alphabet.indexOf(last) & ~0xf) | ((alphabet.indexOf(last) + 1) & 0xf)];
  const tweaked = sig.slice(0, 85) + alt + '==';
  assert.deepEqual(Buffer.from(tweaked, 'base64'), Buffer.from(sig, 'base64'));
  assert.ok(!isCanonicalSignature(tweaked), 'non-canonical trailing bits');
  assert.ok(!verifySignature(keyFromSeed(1).pk, signedMessage('escrow.test.near', 0, 'deliver', '{}'), tweaked));
});

test('offers: parsing mirrors the contract; signature binds the contract', () => {
  const creator = keyFromSeed(3);
  const b = makeOffer(creator, { contractId: 'escrow.near' });
  const o = parseOffer(b.offer);
  assert.equal(o.creator_pk, creator.pk);
  assert.ok(verifySignature(creator.pk, offerMessage('escrow.near', b.offer), b.offer_signature));
  assert.ok(!verifySignature(creator.pk, offerMessage('other.near', b.offer), b.offer_signature));
  assert.equal(offerMessage('escrow.near', '{}'), 'escrow-v1|escrow.near|offer|{}');
  assert.throws(() => parseOffer(b.offer.replace('}', ',"client_pk":"x"}')), /exactly/);
  assert.throws(() => parseOffer(JSON.stringify({ ...o, amount: 5 })), /string/);
  assert.throws(() => parseOffer(JSON.stringify({ ...o, offer_nonce: 'short' })), /nonce/);
  assert.throws(() => parseOffer(JSON.stringify({ ...o, terms_hash: 'ABC' })), /terms_hash/);
});

test('offer v2: exact fields, canonical decimals, fee and duration caps', () => {
  const o = parseOffer(makeOffer(keyFromSeed(3)).offer);
  assert.deepEqual(Object.keys(o).sort(), [
    'amount',
    'creator_pk',
    'delivery_duration_ns',
    'fee_bps',
    'offer_expires_at_ns',
    'offer_nonce',
    'review_period_ns',
    'terms_hash',
  ]);
  const without = (k: string) => {
    const c: Record<string, unknown> = { ...o };
    delete c[k];
    return JSON.stringify(c);
  };
  assert.throws(() => parseOffer(without('fee_bps')), /exactly/);
  assert.throws(() => parseOffer(JSON.stringify({ ...JSON.parse(without('delivery_duration_ns')), delivery_deadline_ns: '1' })), /exactly/, 'v1 field refused');
  for (const amount of ['+5', '05', '5.0', '-1', '0', ' 5', '']) {
    assert.throws(() => parseOffer(JSON.stringify({ ...o, amount })), /amount/, amount);
  }
  assert.throws(() => parseOffer(JSON.stringify({ ...o, fee_bps: '301' })), /fee_bps/);
  assert.throws(() => parseOffer(JSON.stringify({ ...o, fee_bps: '0300' })), /fee_bps/);
  assert.equal(parseOffer(JSON.stringify({ ...o, fee_bps: '0' })).fee_bps, '0');
  assert.throws(() => parseOffer(JSON.stringify({ ...o, delivery_duration_ns: '0' })), /delivery_duration_ns/);
  assert.throws(() => parseOffer(JSON.stringify({ ...o, delivery_duration_ns: String(91n * 86_400n * 1_000_000_000n) })), /90 days/);
  assert.throws(() => parseOffer(JSON.stringify({ ...o, review_period_ns: String(91n * 86_400n * 1_000_000_000n) })), /90 days/);
  assert.throws(() => parseOffer(JSON.stringify({ ...o, offer_expires_at_ns: '01' })), /offer_expires_at_ns/);
});

test('usdc amounts', () => {
  assert.equal(usdcToBaseUnits('12.5'), '12500000');
  assert.equal(usdcToBaseUnits(12.5), '12500000');
  assert.equal(usdcToBaseUnits('0.000001'), '1');
  for (const bad of ['0', '-1', '1.0000001', 'abc', '1e3', '', null, undefined, Infinity]) {
    assert.throws(() => usdcToBaseUnits(bad), String(bad));
  }
  assert.equal(baseUnitsToUsdc('12500000'), '12.5');
  assert.equal(baseUnitsToUsdc('1'), '0.000001');
});

test('times', () => {
  assert.equal(toNanos(1_700_000_000), 1_700_000_000_000_000_000n);
  assert.equal(toNanos('2023-11-14T22:13:20.000Z'), 1_700_000_000_000_000_000n);
  assert.throws(() => toNanos('tomorrow'));
});

test('salted terms hash: canonical, order independent, test vector', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  const t = {
    title: 'Logo animation',
    description: '10s, 4k',
    revisions: '2',
    amount: '5000000',
    delivery_duration_ns: '604800000000000',
    review_period_ns: '259200000000000',
    salt: '00112233445566778899aabbccddeeff',
  };
  const h = termsHash(t);
  assert.notEqual(termsHash({ ...t, salt: 'ffeeddccbbaa99887766554433221100' }), h, 'salt changes the hash');
  assert.notEqual(termsHash({ ...t, revisions: '3' }), h, 'revisions are part of the sealed terms');
  assert.notEqual(termsHash({ ...t, revisions: '' }), h, '"no revisions set" differs from a number');
  // Test vector (web must reproduce this; contract v2 terms):
  const expected = createHash('sha256')
    .update(
      '{"amount":"5000000","delivery_duration_ns":"604800000000000","description":"10s, 4k","review_period_ns":"259200000000000","revisions":"2","salt":"00112233445566778899aabbccddeeff","title":"Logo animation"}',
    )
    .digest('hex');
  assert.equal(h, expected);
});

test('small-order ("weak") and non-canonical ed25519 keys are refused; normal keys parse', () => {
  const pk = (hex: string) => `ed25519:${base58Encode(Buffer.from(hex, 'hex'))}`;
  const weak = [
    '0100000000000000000000000000000000000000000000000000000000000000', // identity
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // order 2
    '0000000000000000000000000000000000000000000000000000000000000000', // order 4
    '0000000000000000000000000000000000000000000000000000000000000080', // order 4
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', // order 8
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a', // order 8
  ];
  for (const h of weak) assert.equal(parsePublicKey(pk(h)), null, h);
  assert.equal(parsePublicKey(pk('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f')), null, 'y = p is non-canonical');
  // the trivial forgery (R = identity, s = 0) is no longer accepted for the identity key
  const trivialSig = Buffer.concat([Buffer.from('01'.padEnd(64, '0'), 'hex'), Buffer.alloc(32)]).toString('base64');
  assert.equal(verifySignature(pk(weak[0]), 'any message', trivialSig), false);
  // a normal random key still parses
  assert.ok(parsePublicKey('ed25519:82r55u2SXwo7tgL8pq6wDeZJ3mg8zoPM7TRyuKMgjGFD'));
});
