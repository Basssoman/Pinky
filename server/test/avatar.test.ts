// Profile pictures: uploaded to us, checked, re-encoded to a
// 256 x 256 WebP without metadata, served from our API; removable; hidden
// profiles stop serving it. Mocked chain, in-memory SQLite, real sharp.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';

import { buildApp } from '../src/app.ts';
import { parsePublicKey } from '../src/encoding.ts';
import { avatarMessage, profileIdOf, profileWriteMessage, type Market } from '../src/market.ts';
import { AVATAR, bytesSha256Hex, sniffImage } from '../src/market-avatar.ts';
import { SqliteStore } from '../src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, testConfig, type DealKey } from './helpers.ts';

let app: FastifyInstance;
let clock = Date.now();

beforeEach(async () => {
  clock = Date.now();
  const chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  app = await buildApp({
    config: testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000 }),
    chain,
    oneClick: new FakeOneClick(),
    store: new SqliteStore(':memory:'),
    now: () => clock,
  });
});

type PKey = DealKey & { id: string };
const profKey = (seed: number): PKey => {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
};
const alice = profKey(61);
const bob = profKey(62);

let seq = 0n;
const exp = () => ((BigInt(clock) + 300_000n) * 1_000_000n + seq++).toString();

async function createProfile(k: PKey) {
  const profile = { nickname: 'Alice Motion', categories: ['motion'] };
  const e = exp();
  const r = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${k.id}`,
    payload: { profile_pk: k.pk, profile, expires_at_ns: e, sig: k.signRaw(profileWriteMessage(CONTRACT_ID, k.id, profile, e)) },
  });
  assert.equal(r.statusCode, 201, r.body);
}

function upload(k: PKey, bytes: Uint8Array, o: { signer?: DealKey; signedBytes?: Uint8Array; id?: string; image?: string } = {}) {
  const e = exp();
  const id = o.id ?? k.id;
  const sig = (o.signer ?? k).signRaw(avatarMessage(CONTRACT_ID, id, bytesSha256Hex(o.signedBytes ?? bytes), e));
  return app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}/avatar`,
    payload: { profile_pk: k.pk, image: o.image ?? Buffer.from(bytes).toString('base64'), expires_at_ns: e, sig },
  });
}

function remove(k: PKey, signer: DealKey = k) {
  const e = exp();
  return app.inject({
    method: 'DELETE',
    url: `/api/profiles/${k.id}/avatar`,
    payload: { profile_pk: k.pk, expires_at_ns: e, sig: signer.signRaw(avatarMessage(CONTRACT_ID, k.id, 'remove', e)) },
  });
}

const MARKER = 'PINKY-SECRET-GPS-48.8566N';

/** A 640 x 480 JPEG with EXIF (copyright + camera fields carrying a marker) and an XMP-like comment. */
async function photoWithMetadata(): Promise<Uint8Array> {
  const buf = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#e0457b' } })
    .jpeg()
    .withExif({ IFD0: { Copyright: MARKER, Artist: MARKER, Make: 'TestCam', Model: MARKER } })
    .toBuffer();
  return new Uint8Array(buf);
}

const avatarOf = async (k: PKey) => (await app.inject({ method: 'GET', url: `/api/profiles/${k.id}` })).json().avatar as string | null;

test('upload: a JPEG with EXIF comes back as a 256x256 WebP without any metadata, served from our API', async () => {
  await createProfile(alice);
  assert.equal(await avatarOf(alice), null, 'no picture yet: the pixel pattern');
  const photo = await photoWithMetadata();
  assert.ok(Buffer.from(photo).includes(MARKER), 'the test photo really carries the marker');
  const meta = await sharp(photo).metadata();
  assert.ok(meta.exif, 'the test photo has EXIF');

  const r = await upload(alice, photo);
  assert.equal(r.statusCode, 200, r.body);
  const v = r.json().avatar as string;
  assert.match(v, /^[0-9a-f]{16}$/);
  assert.equal(await avatarOf(alice), v);

  const cards = (await app.inject({ method: 'GET', url: '/api/profiles' })).json().items as { profile_id: string; avatar: string | null }[];
  assert.equal(cards.find((c) => c.profile_id === alice.id)?.avatar, v, 'the catalog card has it too');

  const img = await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/avatar/${v}` });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/webp');
  assert.equal(img.headers['x-content-type-options'], 'nosniff');
  assert.match(String(img.headers['cache-control']), /max-age=31536000/);
  const out = img.rawPayload;
  assert.equal(sniffImage(out), 'webp');
  assert.ok(!out.includes(MARKER), 'no marker bytes in the stored picture');
  assert.ok(!out.includes('Exif'), 'no EXIF chunk');
  assert.ok(!out.includes('XMP '), 'no XMP chunk');
  assert.ok(!out.includes('ICCP'), 'no ICC chunk');
  const outMeta = await sharp(out).metadata();
  assert.equal(outMeta.format, 'webp');
  assert.equal(outMeta.width, AVATAR.size);
  assert.equal(outMeta.height, AVATAR.size);
  assert.equal(outMeta.exif, undefined);
  assert.equal(outMeta.xmp, undefined);
  assert.equal(outMeta.icc, undefined);
});

test('upload: PNG and WebP are accepted; a wide picture is cropped to the middle square', async () => {
  await createProfile(alice);
  const png = new Uint8Array(await sharp({ create: { width: 900, height: 300, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } } }).png().toBuffer());
  assert.equal((await upload(alice, png)).statusCode, 200);
  const webp = new Uint8Array(await sharp({ create: { width: 300, height: 300, channels: 3, background: '#00ff00' } }).webp().toBuffer());
  const r = await upload(alice, webp);
  assert.equal(r.statusCode, 200, r.body);
  const img = await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/avatar/${r.json().avatar}` });
  const m = await sharp(img.rawPayload).metadata();
  assert.equal(m.width, 256);
  assert.equal(m.height, 256);
});

test('upload: wrong types are refused by their first bytes (GIF, SVG, HTML), and a fake JPEG header does not pass the decoder', async () => {
  await createProfile(alice);
  const gif = new Uint8Array(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).gif().toBuffer());
  for (const bad of [gif, new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), new TextEncoder().encode('<html><script>alert(1)</script>')]) {
    const r = await upload(alice, bad);
    assert.equal(r.statusCode, 415, r.body);
    assert.equal(r.json().error, 'bad_image_type');
  }
  // JPEG magic + junk: passes the first check, fails decoding.
  const fake = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode('<html>not really a jpeg</html>')]);
  const r = await upload(alice, fake);
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(r.json().error, 'bad_image');
  // A real PNG sent with a JPEG-looking header is refused too (type must match the decoder).
  const png = new Uint8Array(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer());
  const mixed = new Uint8Array([0xff, 0xd8, 0xff, ...png]);
  assert.equal((await upload(alice, mixed)).statusCode, 400);
  assert.equal(await avatarOf(alice), null);
});

test('upload: too big is refused (more than 2 MB of picture, or a body over the limit)', async () => {
  await createProfile(alice);
  const big = new Uint8Array(AVATAR.maxBytes + 1);
  big.set([0xff, 0xd8, 0xff]);
  const r = await upload(alice, big);
  assert.equal(r.statusCode, 413, r.body);
  assert.equal(r.json().error, 'image_too_big');
  const huge = await upload(alice, new Uint8Array(3), { image: 'A'.repeat(4 * 1024 * 1024) });
  assert.equal(huge.statusCode, 413);
  const notB64 = await upload(alice, new Uint8Array(3), { image: '!!!!' });
  assert.equal(notB64.statusCode, 400);
});

test('upload: the signature must be the owner key over these exact bytes', async () => {
  await createProfile(alice);
  const photo = await photoWithMetadata();
  const wrongKey = await upload(alice, photo, { signer: bob });
  assert.equal(wrongKey.statusCode, 401, wrongKey.body);
  assert.equal(wrongKey.json().error, 'invalid_signature');
  const otherBytes = await upload(alice, photo, { signedBytes: new Uint8Array([1, 2, 3]) });
  assert.equal(otherBytes.statusCode, 401);
  // Bob signs with his own key for Alice's profile: the profile belongs to another key.
  const e = exp();
  const asBob = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${alice.id}/avatar`,
    payload: { profile_pk: bob.pk, image: Buffer.from(photo).toString('base64'), expires_at_ns: e, sig: bob.signRaw(avatarMessage(CONTRACT_ID, alice.id, bytesSha256Hex(photo), e)) },
  });
  assert.equal(asBob.statusCode, 403);
  // No profile yet: save the profile first.
  assert.equal((await upload(bob, photo)).statusCode, 404);
  // A used signature cannot be sent again.
  const e2 = exp();
  const payload = { profile_pk: alice.pk, image: Buffer.from(photo).toString('base64'), expires_at_ns: e2, sig: alice.signRaw(avatarMessage(CONTRACT_ID, alice.id, bytesSha256Hex(photo), e2)) };
  assert.equal((await app.inject({ method: 'PUT', url: `/api/profiles/${alice.id}/avatar`, payload })).statusCode, 200);
  const again = await app.inject({ method: 'PUT', url: `/api/profiles/${alice.id}/avatar`, payload });
  assert.equal(again.statusCode, 401);
  assert.equal(again.json().error, 'replayed_request');
});

test('replace and remove: the old picture stops being served; removal needs the owner signature', async () => {
  await createProfile(alice);
  const v1 = (await upload(alice, await photoWithMetadata())).json().avatar as string;
  const png = new Uint8Array(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } }).png().toBuffer());
  const v2 = (await upload(alice, png)).json().avatar as string;
  assert.notEqual(v1, v2);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/avatar/${v1}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/avatar/${v2}` })).statusCode, 200);

  assert.equal((await remove(alice, bob)).statusCode, 401);
  const r = await remove(alice);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().avatar, null);
  assert.equal(await avatarOf(alice), null);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/avatar/${v2}` })).statusCode, 404);
});

test('hidden profiles stop serving the picture (self-hidden and operator-hidden); the operator hide also blocks a new upload', async () => {
  await createProfile(alice);
  const v = (await upload(alice, await photoWithMetadata())).json().avatar as string;
  const url = `/api/profiles/${alice.id}/avatar/${v}`;
  const e = exp();
  const hide = await app.inject({
    method: 'DELETE',
    url: `/api/profiles/${alice.id}`,
    payload: { profile_pk: alice.pk, expires_at_ns: e, sig: alice.signRaw(profileWriteMessage(CONTRACT_ID, alice.id, { delete: true }, e)) },
  });
  assert.equal(hide.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);

  const ms = (app as unknown as { market: Market }).market.store;
  ms.setSelfHidden(alice.id, false);
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 200);
  ms.setOperatorHidden(alice.id, true);
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
  assert.equal((await upload(alice, await photoWithMetadata())).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/avatar/zzzz` })).statusCode, 404);
});

test('rate limit: at most 5 picture changes a minute per profile', async () => {
  await createProfile(alice);
  const png = new Uint8Array(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#000' } }).png().toBuffer());
  for (let i = 0; i < 5; i++) assert.equal((await upload(alice, png)).statusCode, 200);
  const r = await upload(alice, png);
  assert.equal(r.statusCode, 429);
  assert.equal(r.json().error, 'rate_limited');
});
