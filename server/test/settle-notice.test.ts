// Bot message when one party proposes an agreed split ("work it out"): the
// OTHER party's confirmed Telegram chats get one fixed line "your deal has a
// new proposal, answer by <time>" with no amount, share, title or link.
// Mocked chain and Telegram.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { notifyMessage, PROPOSAL_NOTICE_GAP_MS, type Notify } from '../src/notify.ts';
import { SqliteStore } from '../src/store.ts';
import { BOT_TEXTS, botTime, proposalText, TelegramError, type TelegramApi, type TgUpdate } from '../src/telegram.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey, type OfferBundle } from './helpers.ts';

const creator = keyFromSeed(61);
const client = keyFromSeed(62);
const BOT = 'PinkyTestBot';
const SEC = 1_000_000_000n;

class FakeTelegram implements TelegramApi {
  sent: { chat: string; text: string }[] = [];
  blocked = new Set<string>();
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  async sendMessage(chat: string, text: string) {
    if (this.blocked.has(chat)) throw new TelegramError(403, 'Forbidden: bot was blocked by the user');
    this.sent.push({ chat, text });
  }
  async deleteMessage() {}
  to(chat: string) {
    return this.sent.filter((m) => m.chat === chat).map((m) => m.text);
  }
}

let chain: FakeChain;
let tg: FakeTelegram;
let app: FastifyInstance;
let notify: Notify;
let clock = Date.now();
let updateId = 1;
const nsNow = () => BigInt(clock) * 1_000_000n;

async function setup(on = true) {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = nsNow;
  tg = new FakeTelegram();
  const config = testConfig({
    ...(on ? { telegramBotToken: '123:secret', telegramBotUsername: BOT } : {}),
    rateWritesPerMin: 1000,
    rateInvalidPerMin: 1000,
    rateReadsPerMin: 1000,
  });
  app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock, telegram: tg });
  notify = (app as unknown as { notify: Notify }).notify;
}

beforeEach(async () => setup());

async function offer(): Promise<OfferBundle> {
  const b = makeOffer(creator, { nowMs: clock, title: 'Secret title' });
  const r = await app.inject({ method: 'POST', url: '/api/deals', payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms } });
  assert.equal(r.statusCode, 201, r.body);
  return b;
}

async function join(b: OfferBundle): Promise<number> {
  const r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: client.pk } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().deal_id as number;
}

async function subscribe(b: OfferBundle, key: DealKey, role: 'creator' | 'client', chat: string, lang = 'en') {
  const payload = JSON.stringify({ op: 'start', role, pk: key.pk, handle: b.handle, lang, issued_at_ns: nsNow().toString(), nonce: randomBytes(8).toString('hex') });
  const r = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/notify`,
    headers: { 'x-deal-token': b.token },
    payload: { payload, signature: key.signRaw(notifyMessage(CONTRACT_ID, payload)) },
  });
  assert.equal(r.statusCode, 200, r.body);
  await notify.handleUpdate({ update_id: updateId++, message: { message_id: updateId, chat: { id: Number(chat), type: 'private' }, text: `/start ${r.json().code}` } });
}

/** A funded deal, both parties subscribed (client chat in `clientLang`). */
async function fundedDeal(clientLang = 'en') {
  const b = await offer();
  const id = await join(b);
  chain.fund(id, '5000000');
  await subscribe(b, creator, 'creator', '1');
  await subscribe(b, client, 'client', '2', clientLang);
  await notify.tick(); // baseline: "paid" happened before subscribing, nothing is sent
  tg.sent = [];
  return { b, id };
}

function propose(b: OfferBundle, id: number, key: DealKey, over: Record<string, string> = {}) {
  const payload = JSON.stringify({
    split_bps: '7000',
    state: 'Funded',
    seq: '0',
    expires_at_ns: (nsNow() + 3600n * SEC).toString(),
    nonce: randomBytes(4).toString('hex'),
    ...over,
  });
  return app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/settle-proposal`,
    headers: { 'x-deal-token': b.token },
    payload: { payload, signature: key.sign(id, 'settle', payload) },
  });
}

/** The fire-and-forget send runs after the route answered: let it finish. */
const settle = () => new Promise((r) => setImmediate(r));

/** No message about a proposal may carry a share, an amount, a link, a key or the title. */
function assertClean(text: string) {
  assert.doesNotMatch(text, /https?:|t\.me|\/k#|\/d#|ed25519|USDC|\$|%|7000|Secret title/);
}

test('client proposes a split: only the creator hears "new proposal, answer by <time>", with no details', async () => {
  const { b, id } = await fundedDeal();
  const r = await propose(b, id, client);
  assert.equal(r.statusCode, 201, r.body);
  await settle();
  const expiresMs = clock + 3600_000;
  assert.deepEqual(tg.to('1'), [proposalText('en', expiresMs)]);
  assert.deepEqual(tg.to('2'), [], 'the proposer gets nothing');
  const text = tg.to('1')[0];
  assert.ok(text.startsWith('Pinky: your deal has a new proposal. Answer by '));
  assert.ok(text.includes(botTime('en', expiresMs)));
  assert.ok(text.includes(BOT_TEXTS.en.open), 'ends with "open your saved personal link"');
  assertClean(text);
});

test('creator proposes: the client hears it in the client chat language (Ukrainian)', async () => {
  const { b, id } = await fundedDeal('uk');
  assert.equal((await propose(b, id, creator)).statusCode, 201);
  await settle();
  assert.deepEqual(tg.to('1'), [], 'the proposer gets nothing');
  assert.equal(tg.to('2').length, 1);
  assert.equal(tg.to('2')[0], proposalText('uk', clock + 3600_000));
  assert.match(tg.to('2')[0], /нова пропозиція/);
  assertClean(tg.to('2')[0]);
});

test('re-posting within an hour does not flood the other side; after the quiet hour a new proposal is told again', async () => {
  const { b, id } = await fundedDeal();
  assert.equal((await propose(b, id, client)).statusCode, 201);
  await settle();
  assert.equal((await propose(b, id, client, { split_bps: '6000' })).statusCode, 201);
  await settle();
  assert.equal(tg.to('1').length, 1, 'one message for two proposals in the same hour');
  clock += PROPOSAL_NOTICE_GAP_MS + 1000;
  assert.equal((await propose(b, id, client, { split_bps: '5000' })).statusCode, 201);
  await settle();
  assert.equal(tg.to('1').length, 2);
  for (const m of tg.sent) assertClean(m.text);
});

test('"answer by" is the deal timer when it ends before the signed expiry', async () => {
  const { b, id } = await fundedDeal();
  const deadline = BigInt(chain.deals[id].delivery_deadline_ns!);
  const r = await propose(b, id, client, { expires_at_ns: (deadline + 86_400n * SEC).toString() });
  assert.equal(r.statusCode, 201, r.body);
  await settle();
  const timerMs = Number(BigInt(r.json().timer_ends_at_ns) / 1_000_000n);
  assert.ok(timerMs < Number((deadline + 86_400n * SEC) / 1_000_000n), "the timer is the earlier one");
  assert.deepEqual(tg.to('1'), [proposalText('en', timerMs)]);
});

test('a refused proposal sends nothing; a blocked chat never fails the proposal', async () => {
  const { b, id } = await fundedDeal();
  const bad = await propose(b, id, client, { state: 'Delivered' });
  assert.equal(bad.statusCode, 409);
  await settle();
  assert.equal(tg.sent.length, 0);
  tg.blocked.add('1');
  const ok = await propose(b, id, client);
  assert.equal(ok.statusCode, 201, ok.body);
  await settle();
  assert.equal(tg.sent.length, 0);
  assert.equal(notify.store!.subsOf(b.handle).filter((s) => s.party === 'creator').length, 0, 'the blocked chat is dropped');
});

test('only confirmed subscriptions: a pre-join client key is not told until the watcher has checked it', async () => {
  const b = await offer();
  await subscribe(b, client, 'client', '2'); // before joining: pending key
  const id = await join(b);
  chain.fund(id, '5000000');
  assert.equal((await propose(b, id, creator)).statusCode, 201);
  await settle();
  assert.equal(tg.to('2').filter((t) => /new proposal/.test(t)).length, 0, 'not confirmed yet');
  await notify.tick(); // confirms the key (and tells "paid")
  clock += PROPOSAL_NOTICE_GAP_MS + 1000;
  assert.equal((await propose(b, id, creator)).statusCode, 201);
  await settle();
  assert.equal(tg.to('2').filter((t) => /new proposal/.test(t)).length, 1);
});

test('with the bot off, proposals work as before', async () => {
  await setup(false);
  const b = await offer();
  const id = await join(b);
  chain.fund(id, '5000000');
  assert.equal((await propose(b, id, client)).statusCode, 201);
  await settle();
  assert.equal(tg.sent.length, 0);
});

test('bot time format: UTC, no year', () => {
  const ms = Date.UTC(2026, 10, 14, 8, 5);
  assert.equal(botTime('en', ms), '14 Nov, 08:05 UTC');
  assert.equal(botTime('uk', ms), '14.11, 08:05 UTC');
});
