// The browser library against the server's own code and test vectors: keys,
// signatures, terms hash, 1Click quote checks, encrypted notes, file fingerprints.

import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { openAsArbiter as openAsArbiterNode, newNoteKey } from '../../server/scripts/arbiter/crypto.ts';
import * as server from '../../server/src/encoding.ts';
import { quoteSigningMessage as serverQuoteMessage } from '../../server/src/quoteSignature.ts';
import { base58Decode, base58Encode, hex } from '../src/lib/bytes';
import { filesFingerprint, filesManifest } from '../src/lib/files';
import {
  canonicalJson,
  fingerprint,
  implicitAccount,
  isCanonicalSignature,
  keyFromSeed,
  newKey,
  offerMessage,
  parsePublicKey,
  sign,
  signedMessage,
  termsHash,
  verify,
} from '../src/lib/keys';
import { clientLink, parseClientLink, parsePersonalLink, personalLink } from '../src/lib/local';
import { openAsArbiter, openFromParty, sealForArbiter, sealForParty } from '../src/lib/notes';
import { quoteSigningMessage, verifyQuoteSignature } from '../src/lib/quote';
import { coinsFromTokens } from '../src/lib/tokens';

const ONE_CLICK_KEY = 'ed25519:reYaWhvwu8Jzo3WUM3zhn6VrhuMEF4eADL17qtRVifc';
const fixture = JSON.parse(readFileSync(new URL('../../server/test/fixtures/dry-quote.json', import.meta.url), 'utf8'));

describe('keys and signatures', () => {
  test('a browser key signs what the server (and the contract) verify', () => {
    const key = newKey();
    expect(server.parsePublicKey(key.pk)?.length).toBe(32);
    const msg = signedMessage('escrow.near', 7, 'deliver', '{"deliverable_hash":"v1:ab","nonce":"1"}');
    expect(msg).toBe(server.signedMessage('escrow.near', 7, 'deliver', '{"deliverable_hash":"v1:ab","nonce":"1"}'));
    const sig = sign(key, msg);
    expect(isCanonicalSignature(sig)).toBe(true);
    expect(server.isCanonicalSignature(sig)).toBe(true);
    expect(server.verifySignature(key.pk, msg, sig)).toBe(true);
    expect(verify(key.pk, msg, sig)).toBe(true);
    expect(verify(key.pk, msg + ' ', sig)).toBe(false);
    expect(verify(newKey().pk, msg, sig)).toBe(false);
    expect(verify(key.pk, msg, sig.replace(/=+$/, ''))).toBe(false);
    expect(offerMessage('c', '{}')).toBe(server.offerMessage('c', '{}'));
  });

  test('the same seed gives the same key as the server test helper (ed25519 from a 32-byte seed)', () => {
    const key = keyFromSeed('07'.repeat(32));
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7)]);
    const jwk = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }) as { x: string };
    expect(key.pk).toBe(`ed25519:${base58Encode(Buffer.from(jwk.x, 'base64url'))}`);
    expect(fingerprint(key.pk)).toBe(server.keyFingerprint(key.pk));
    expect(implicitAccount(key.pk)).toBe(server.implicitAccountId(key.pk));
  });

  test('weak (small-order) and non-canonical keys are refused, like on the server', () => {
    const pk = (h: string) => `ed25519:${base58Encode(Buffer.from(h, 'hex'))}`;
    for (const h of [
      '0100000000000000000000000000000000000000000000000000000000000000',
      'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
      '0000000000000000000000000000000000000000000000000000000000000000',
      '0000000000000000000000000000000000000000000000000000000000000080',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    ]) {
      expect(parsePublicKey(pk(h)), h).toBeNull();
      expect(server.parsePublicKey(pk(h)), h).toBeNull();
    }
    // The trivial forgery (R = identity, s = 0) must not verify for the identity key.
    const forged = Buffer.concat([Buffer.from('01' + '00'.repeat(31), 'hex'), Buffer.alloc(32)]).toString('base64');
    expect(verify(pk('01' + '00'.repeat(31)), 'anything', forged)).toBe(false);
  });

  test('terms hash: the server test vector', () => {
    const t = {
      title: 'Logo animation',
      description: '10s, 4k',
      revisions: '2',
      amount: '5000000',
      delivery_duration_ns: '604800000000000',
      review_period_ns: '259200000000000',
      salt: '00112233445566778899aabbccddeeff',
    };
    const expected = createHash('sha256')
      .update(
        '{"amount":"5000000","delivery_duration_ns":"604800000000000","description":"10s, 4k","review_period_ns":"259200000000000","revisions":"2","salt":"00112233445566778899aabbccddeeff","title":"Logo animation"}',
      )
      .digest('hex');
    expect(termsHash(t)).toBe(expected);
    expect(termsHash(t)).toBe(server.termsHash(t));
    const tricky = { ...t, title: 'Ролик «на завтра» 🎬 "quoted" \\ /', description: 'line1\nline2\ttab' };
    expect(termsHash(tricky)).toBe(server.termsHash(tricky));
    expect(canonicalJson({ b: 1, a: [{ d: undefined, c: null }] })).toBe(server.canonicalJson({ b: 1, a: [{ d: undefined, c: null }] }));
  });

  test('base58 matches the server', () => {
    for (const bytes of [new Uint8Array([0, 0, 1, 2, 255]), new Uint8Array(32).fill(7), new Uint8Array([0])]) {
      expect(base58Encode(bytes)).toBe(server.base58Encode(bytes));
      expect(hex(base58Decode(base58Encode(bytes)))).toBe(hex(bytes));
    }
    expect(() => base58Decode('0OIl')).toThrow();
  });
});

describe('1Click quote signature', () => {
  test('a real 1Click dry quote verifies with the hard-coded key', () => {
    expect(quoteSigningMessage(fixture)).toBe(serverQuoteMessage(fixture));
    expect(verifyQuoteSignature(fixture, ONE_CLICK_KEY)).toBe(true);
  });

  test('any change of a signed field breaks it', () => {
    const tamper = (f: (q: typeof fixture) => void) => {
      const q = structuredClone(fixture);
      f(q);
      return verifyQuoteSignature(q, ONE_CLICK_KEY);
    };
    expect(tamper((q) => (q.quoteRequest.recipient = 'thief.near'))).toBe(false);
    expect(tamper((q) => (q.quoteRequest.amount = '1'))).toBe(false);
    expect(tamper((q) => (q.quoteRequest.customRecipientMsg = '{"deal_id":1}'))).toBe(false);
    expect(tamper((q) => (q.quoteRequest.refundTo = '0x0000000000000000000000000000000000000001'))).toBe(false);
    expect(tamper((q) => (q.quote.amountIn = '1'))).toBe(false);
    expect(tamper((q) => (q.timestamp = '2026-11-02T00:05:10.409Z'))).toBe(false);
    expect(tamper((q) => (q.signature = 'ed25519:1111'))).toBe(false);
    expect(verifyQuoteSignature(fixture, newKey().pk)).toBe(false);
    expect(verifyQuoteSignature({ quoteRequest: null, quote: null, signature: null, timestamp: null }, ONE_CLICK_KEY)).toBe(false);
  });
});

describe('encrypted notes', () => {
  const ctx = { contractId: 'escrow.near', dealId: 4, kind: 'delivery' };

  test('only the two deal keys read a party note, and only for this deal and kind', async () => {
    const creator = newKey();
    const client = newKey();
    const note = { link: 'https://drive.example/folder/abc', salt: 'aa'.repeat(16) };
    const data = await sealForParty(creator, client.pk, ctx, note);
    expect(await openFromParty(client, creator.pk, ctx, data)).toEqual(note);
    expect(await openFromParty(creator, client.pk, ctx, data)).toEqual(note);
    await expect(openFromParty(newKey(), creator.pk, ctx, data)).rejects.toThrow();
    await expect(openFromParty(client, creator.pk, { ...ctx, dealId: 5 }, data)).rejects.toThrow();
    await expect(openFromParty(client, creator.pk, { ...ctx, kind: 'dispute' }, data)).rejects.toThrow();
    expect(await sealForParty(creator, client.pk, ctx, note)).not.toBe(data);
    expect(Buffer.from(data, 'base64').toString('latin1')).not.toContain('drive.example');
  });

  test('an arbiter copy is read by the arbiter tool (Node crypto) and by nobody else', async () => {
    const arbiter = newNoteKey();
    const c = { ...ctx, kind: 'dispute_arbiter' };
    const note = { point: 'gets', pointText: 'MP4 + project file', text: 'The project file is missing.', delivery: { link: 'https://x.example/y', salt: 'bb'.repeat(16) } };
    const data = await sealForArbiter(arbiter.pub, c, note);
    expect(openAsArbiterNode(arbiter.priv, c, data)).toEqual(note);
    expect(await openAsArbiter(arbiter.priv, c, data)).toEqual(note);
    expect(() => openAsArbiterNode(newNoteKey().priv, c, data)).toThrow();
    expect(() => openAsArbiterNode(arbiter.priv, { ...c, dealId: 9 }, data)).toThrow();
  });
});

describe('file fingerprint', () => {
  const file = (text: string) => new Blob([text]);

  test('the same files give the same fingerprint in any order and under any name; other files do not', async () => {
    const salt = '0f'.repeat(16);
    const a = filesFingerprint(salt, await filesManifest([file('video bytes'), file('project bytes')]));
    const b = filesFingerprint(salt, await filesManifest([file('project bytes'), file('video bytes')]));
    expect(a).toBe(b);
    expect(a).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(filesFingerprint(salt, await filesManifest([file('video bytes')]))).not.toBe(a);
    expect(filesFingerprint(salt, await filesManifest([file('video bytes'), file('project bytes!')]))).not.toBe(a);
    expect(filesFingerprint('00'.repeat(16), await filesManifest([file('video bytes'), file('project bytes')]))).not.toBe(a);
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(await filesManifest([file('b'), file('a')])).toBe(`kept-files-v1\n${[`${sha('a')} 1`, `${sha('b')} 1`].sort().join('\n')}`);
  });
});

describe('links', () => {
  test('the personal link carries the key, the client link never does', () => {
    const d = { role: 'client' as const, token: 'ab'.repeat(16), seed: 'cd'.repeat(32) };
    const link = personalLink('https://kept.example', d);
    expect(link.startsWith('https://kept.example/k#k1.client.')).toBe(true);
    expect(parsePersonalLink(link)).toEqual(d);
    expect(parsePersonalLink(`  ${link}\n`)).toEqual(d);
    expect(parsePersonalLink(clientLink('https://kept.example', d.token))).toBeNull();
    expect(clientLink('https://kept.example', d.token)).not.toContain(d.seed);
    expect(parseClientLink(`#${d.token}`)).toBe(d.token);
    expect(parseClientLink('#k1.client.x.y')).toBeNull();
  });
});

describe('coins from the 1Click list', () => {
  test('TON is shown as TON (1Click calls it GRAM); the asset id stays the one 1Click knows', () => {
    const coins = coinsFromTokens([
      { assetId: 'nep245:v2_1.omni.hot.tg:1117_', symbol: 'GRAM', blockchain: 'ton', decimals: 9, price: 1.6, priceUpdatedAt: null, contractAddress: null },
      { assetId: 'nep245:v2_1.omni.hot.tg:1117_usdt', symbol: 'USDT', blockchain: 'ton', decimals: 6, price: 1, priceUpdatedAt: null, contractAddress: null },
    ]);
    expect(coins.map((c) => c.symbol)).toEqual(['TON', 'USDT']);
    expect(coins[0].networks).toEqual([{ code: 'ton', name: 'TON', assetId: 'nep245:v2_1.omni.hot.tg:1117_' }]);
  });
});

describe('pay and withdraw: network first, then coin', async () => {
  const { coinsFromTokens, coinsOn, networksOf } = await import('../src/lib/tokens');
  const coins = coinsFromTokens([
    { assetId: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24 },
    { assetId: 'a-usdc-near', symbol: 'USDC', blockchain: 'near', decimals: 6 },
    { assetId: 'a-usdc-sol', symbol: 'USDC', blockchain: 'sol', decimals: 6 },
    { assetId: 'a-sol', symbol: 'SOL', blockchain: 'sol', decimals: 9 },
  ] as never);
  test('every network once, in list order; coins per network', () => {
    expect(networksOf(coins).map((n) => n.name)).toEqual(['NEAR', 'Solana']);
    expect(coinsOn(coins, 'Solana').map((c) => c.symbol)).toEqual(['USDC', 'SOL']);
    expect(coinsOn(coins, 'NEAR').map((c) => c.symbol)).toEqual(['wNEAR', 'USDC']);
  });
});

test('paying shows "NEAR" for wNEAR (plain NEAR works, live deal 7); payouts keep "wNEAR"', async () => {
  const { coinsFromTokens } = await import('../src/lib/tokens');
  const list = [{ assetId: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24 }] as never;
  expect(coinsFromTokens(list, true)[0].symbol).toBe('NEAR');
  expect(coinsFromTokens(list)[0].symbol).toBe('wNEAR');
});
