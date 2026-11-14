// Weekly volume alert: when the PAID deals made from requests to one creator
// profile pass the alert level in a rolling 7 days, the team chat gets one
// message (or the server log a warning line when no chat is set); not again
// for the same profile within 7 days. Mocked chain and Telegram.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { readConfig, type Config } from '../src/config.ts';
import { parsePublicKey, sha256Hex } from '../src/encoding.ts';
import { profileIdOf, profileWriteMessage, requestDealMessage } from '../src/market.ts';
import { usdWhole, VOLUME_WINDOW_MS, volumeMessage, type Reports } from '../src/reports.ts';
import { SqliteStore } from '../src/store.ts';
import { TelegramError, type TelegramApi, type TgUpdate } from '../src/telegram.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey } from './helpers.ts';

const CHAT = '-1009876543210';
const DAY_MS = 86_400_000;

class FakeTelegram implements TelegramApi {
  sent: { chat: string; text: string }[] = [];
  fail = false;
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  async sendMessage(chat: string, text: string) {
    if (this.fail) throw new TelegramError(400, 'Bad Request: chat not found');
    this.sent.push({ chat, text });
  }
  async deleteMessage() {}
}

type PKey = DealKey & { id: string };
function profKey(seed: number): PKey {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
}
const alice = profKey(71);
const bob = profKey(72);
const creatorDeal = keyFromSeed(73);
const clientDeal = keyFromSeed(74);

let chain: FakeChain;
let tg: FakeTelegram;
let app: FastifyInstance;
let logs: string[];
let store: SqliteStore;
let clock = Date.now();
let seq = 0n;
let ipN = 1;
const exp = () => ((BigInt(clock) + 300_000n) * 1_000_000n + seq++).toString();
const reports = () => (app as unknown as { reports: Reports }).reports;

/** Alert level 12 USDC; every test deal is 5 USDC: 2 deals stay under, 3 go over. */
async function setup(overrides: Partial<Config> = {}, keep?: { store: SqliteStore; chain: FakeChain; clock: number }) {
  clock = keep?.clock ?? Date.now();
  chain = keep?.chain ?? new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  tg = new FakeTelegram();
  logs = [];
  store = keep?.store ?? new SqliteStore(':memory:');
  app = await buildApp({
    config: testConfig({
      telegramBotToken: '123:secret',
      telegramBotUsername: 'PinkyTestBot',
      telegramReportsChatId: CHAT,
      corsOrigin: 'https://pinky.example',
      volumeAlertUsdc: 12,
      rateWritesPerMin: 1000,
      rateInvalidPerMin: 1000,
      rateReadsPerMin: 1000,
      ...overrides,
    }),
    chain,
    oneClick: new FakeOneClick(),
    store,
    now: () => clock,
    telegram: tg,
    logger: { level: 'warn', stream: { write: (l: string) => void logs.push(l) } },
  });
}

beforeEach(async () => setup());

async function profile(who: PKey) {
  const p = {
    nickname: `Creator ${who.id.slice(0, 4)}`,
    bio: 'Logo animations',
    categories: ['motion'],
    portfolio: [],
    contacts: [{ kind: 'telegram', value: '@creator_contact' }],
    services: [{ title: 'Logo animation', description: '10 s', price_from_usdc: 150, delivery_days: 5 }],
  };
  const e = exp();
  const r = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${who.id}`,
    payload: { profile_pk: who.pk, profile: p, expires_at_ns: e, sig: who.signRaw(profileWriteMessage(CONTRACT_ID, who.id, p, e)) },
  });
  assert.ok(r.statusCode === 201 || r.statusCode === 200, r.body);
}

/** A new request to `who` -> a deal from it, joined by the client; `fund` = paid in full. */
async function dealFromRequest(who: PKey, fund = true): Promise<number> {
  const token = randomBytes(16).toString('hex');
  const rh = sha256Hex(token);
  const req = await app.inject({
    method: 'POST',
    url: '/api/requests',
    remoteAddress: `198.51.100.${ipN++}`,
    payload: {
      handle: rh,
      profile_id: who.id,
      brief: 'Need a 10 s logo animation for our launch',
      client_contact: { kind: 'telegram', value: '@client_contact' },
      client_box_pk: randomBytes(32).toString('hex'),
    },
  });
  assert.equal(req.statusCode, 201, req.body);
  const b = makeOffer(creatorDeal, { nowMs: clock });
  const e = exp();
  const r = await app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: {
      handle: b.handle,
      offer: b.offer,
      offer_signature: b.offer_signature,
      terms: b.terms,
      request_handle: rh,
      request_expires_at_ns: e,
      request_sig: who.signRaw(requestDealMessage(CONTRACT_ID, rh, creatorDeal.pk, e)),
      deal_link_box: { epk: 'a'.repeat(64), iv: 'b'.repeat(24), ct: 'c'.repeat(96) },
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  const j = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: clientDeal.pk } });
  assert.equal(j.statusCode, 201, j.body);
  const id = j.json().deal_id as number;
  if (fund) chain.fund(id, chain.deals[id].amount);
  return id;
}

/** A plain deal (no request): never counted. */
async function plainDeal(): Promise<number> {
  const b = makeOffer(creatorDeal, { nowMs: clock });
  const r = await app.inject({ method: 'POST', url: '/api/deals', payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms } });
  assert.equal(r.statusCode, 201, r.body);
  const j = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: clientDeal.pk } });
  const id = j.json().deal_id as number;
  chain.fund(id, chain.deals[id].amount);
  return id;
}

const volumeLogs = () => logs.filter((l) => l.includes('weekly paid volume'));

test('over the level in 7 days: ONE message to the team chat; not again within 7 days; again after', async () => {
  await profile(alice);
  await dealFromRequest(alice);
  await dealFromRequest(alice);
  await plainDeal();
  await plainDeal(); // plain deals never count, even from the same creator key
  assert.deepEqual(await reports().checkVolume(), [], '10 USDC paid: under the level');
  assert.equal(tg.sent.length, 0);

  await dealFromRequest(alice);
  const raised = await reports().checkVolume();
  assert.deepEqual(raised, [{ profile_id: alice.id, volume: 15_000_000n, deals: 3 }]);
  assert.equal(tg.sent.length, 1);
  assert.equal(tg.sent[0].chat, CHAT);
  const text = tg.sent[0].text;
  assert.match(text, /^Pinky volume alert: one creator profile got about \$15 in paid deals from requests in the last 7 days \(3 deals; alert level \$12\)/);
  assert.ok(text.includes(`Profile: https://pinky.example/creators/${alice.id}`));
  assert.ok(text.includes(`market-admin.js hide ${alice.id}`));
  // No nickname, title, brief or contact in the team message.
  assert.doesNotMatch(text, /Creator |Logo animation|client_contact|creator_contact/);
  assert.equal(volumeLogs().length, 0, 'sent to the chat: no log line needed');

  // More deals the same week: no repeat.
  await dealFromRequest(alice);
  assert.deepEqual(await reports().checkVolume(), []);
  assert.equal(tg.sent.length, 1);

  // After 7 days the old deals are out of the window; new paid volume over the level alerts again.
  clock += VOLUME_WINDOW_MS + 60_000;
  assert.deepEqual(await reports().checkVolume(), [], 'old deals do not count any more');
  await dealFromRequest(alice);
  await dealFromRequest(alice);
  await dealFromRequest(alice);
  assert.equal((await reports().checkVolume()).length, 1);
  assert.equal(tg.sent.length, 2);
});

test('only PAID deals count: joined but unpaid ones do not', async () => {
  await profile(alice);
  await dealFromRequest(alice);
  await dealFromRequest(alice);
  await dealFromRequest(alice, false);
  await dealFromRequest(alice, false);
  assert.deepEqual(await reports().checkVolume(), []);
  assert.equal(tg.sent.length, 0);
});

test('per profile: two creators with 10 USDC each raise nothing', async () => {
  await profile(alice);
  await profile(bob);
  await dealFromRequest(alice);
  await dealFromRequest(alice);
  await dealFromRequest(bob);
  await dealFromRequest(bob);
  assert.deepEqual(await reports().checkVolume(), []);
});

test('no chat set: one warning line in the server log instead, and still no repeat (also after a server restart)', async () => {
  await setup({ telegramReportsChatId: '' });
  await profile(alice);
  for (let i = 0; i < 3; i++) await dealFromRequest(alice);
  assert.equal((await reports().checkVolume()).length, 1);
  assert.equal(tg.sent.length, 0);
  assert.equal(volumeLogs().length, 1);
  const line = JSON.parse(volumeLogs()[0]) as Record<string, unknown>;
  assert.equal(line.profile_id, alice.id);
  assert.equal(line.volume_usdc, 15);
  assert.equal(line.deals, 3);
  assert.equal((await reports().checkVolume()).length, 0);
  assert.equal(volumeLogs().length, 1);
  // A restart (new server on the same database, a day later): still no repeat within the 7 days.
  await setup({ telegramReportsChatId: '' }, { store, chain, clock: clock + DAY_MS });
  assert.equal((await reports().checkVolume()).length, 0);
  assert.equal(volumeLogs().length, 0);
});

test('Telegram fails: the alert goes to the log and is not repeated', async () => {
  await profile(alice);
  for (let i = 0; i < 3; i++) await dealFromRequest(alice);
  tg.fail = true;
  assert.equal((await reports().checkVolume()).length, 1);
  assert.equal(volumeLogs().length, 1);
  tg.fail = false;
  assert.equal((await reports().checkVolume()).length, 0);
  assert.equal(tg.sent.length, 0);
});

test('level 0 = off', async () => {
  await setup({ volumeAlertUsdc: 0 });
  await profile(alice);
  for (let i = 0; i < 3; i++) await dealFromRequest(alice);
  assert.deepEqual(await reports().checkVolume(), []);
  assert.equal(tg.sent.length + volumeLogs().length, 0);
});

test('config: VOLUME_ALERT_USDC defaults to 10,000; negative means off; message and amount format', () => {
  const base = { NEAR_NETWORK: 'sandbox', ESCROW_CONTRACT_ID: CONTRACT_ID, RELAYER_ACCOUNT_ID: 'r.test.near', RELAYER_PRIVATE_KEY: 'ed25519:unused', DB_PATH: ':memory:' };
  assert.equal(readConfig(base).volumeAlertUsdc, 10_000);
  assert.equal(readConfig({ ...base, VOLUME_ALERT_USDC: '25000' }).volumeAlertUsdc, 25_000);
  assert.equal(readConfig({ ...base, VOLUME_ALERT_USDC: '-5' }).volumeAlertUsdc, 0);
  assert.throws(() => readConfig({ ...base, VOLUME_ALERT_USDC: 'lots' }));
  assert.equal(usdWhole(12_345_678_901n), '12,345');
  assert.equal(usdWhole(999_999n), '0');
  const m = volumeMessage({ profile_id: 'ab'.repeat(12), volume: 10_500_000_000n, deals: 6, link: null, threshold: 10_000_000_000n });
  assert.match(m, /about \$10,500 .*\(6 deals; alert level \$10,000\)/);
  assert.match(m, /Profile id: (ab){12}/);
});
