// Telegram notifications with a mocked Telegram API.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import type { DealView } from '../src/chain.ts';
import { botUsername } from '../src/config.ts';
import { deriveEvents, notifyMessage, snapshot, type Notify } from '../src/notify.ts';
import { SqliteStore } from '../src/store.ts';
import { BOT_TEXTS, httpTelegram, TelegramError, type TelegramApi, type TgUpdate } from '../src/telegram.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey, type OfferBundle } from './helpers.ts';

const creator = keyFromSeed(21);
const client = keyFromSeed(22);
const stranger = keyFromSeed(23);
const BOT = 'PinkyTestBot';

class FakeTelegram implements TelegramApi {
  sent: { chat: string; text: string }[] = [];
  deleted: { chat: string; id: number }[] = [];
  blocked = new Set<string>();
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  async sendMessage(chat: string, text: string) {
    if (this.blocked.has(chat)) throw new TelegramError(403, 'Forbidden: bot was blocked by the user');
    this.sent.push({ chat, text });
  }
  async deleteMessage(chat: string, id: number) {
    this.deleted.push({ chat, id });
  }
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

async function setup(on = true) {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  tg = new FakeTelegram();
  const config = testConfig(on ? { telegramBotToken: '123:secret', telegramBotUsername: BOT } : {});
  app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock, telegram: tg });
  notify = (app as unknown as { notify: Notify }).notify;
}

beforeEach(async () => setup());

async function offer(): Promise<OfferBundle> {
  const b = makeOffer(creator, { nowMs: clock });
  const r = await app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms },
  });
  assert.equal(r.statusCode, 201, r.body);
  return b;
}

async function join(b: OfferBundle, key: DealKey = client) {
  const r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: key.pk } });
  assert.equal(r.statusCode, 201, r.body);
  return r.json().deal_id as number;
}

function notifyReq(b: OfferBundle, key: DealKey, role: 'creator' | 'client', op: 'start' | 'stop' | 'status', extra: Record<string, string> = {}) {
  const payload = JSON.stringify({
    op,
    role,
    pk: key.pk,
    handle: b.handle,
    lang: 'en',
    issued_at_ns: (BigInt(clock) * 1_000_000n).toString(),
    nonce: randomBytes(8).toString('hex'),
    ...extra,
  });
  return app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/notify`,
    headers: { 'x-deal-token': b.token },
    payload: { payload, signature: key.signRaw(notifyMessage(CONTRACT_ID, payload)) },
  });
}

function say(chat: string, text: string, lang = 'en') {
  return notify.handleUpdate({ update_id: updateId++, message: { message_id: updateId, chat: { id: Number(chat), type: 'private' }, text, from: { language_code: lang } } as never });
}

async function subscribe(b: OfferBundle, key: DealKey, role: 'creator' | 'client', chat: string) {
  const r = await notifyReq(b, key, role, 'start');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().bot, BOT);
  await say(chat, `/start ${r.json().code}`);
  assert.equal(tg.to(chat).at(-1), BOT_TEXTS.en.subscribed);
}

/** No message the bot sends may carry a link, an amount, a key or the deal title. */
function assertClean(text: string) {
  assert.doesNotMatch(text, /https?:|t\.me|\/k#|\/d#|ed25519|USDC|\$|\d+\.\d+|Logo animation/);
}

const DAY_MS = 86_400_000;

test('config: the bot name is public only when the bot is on; bad usernames turn it off', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().telegram_bot, BOT);
  await setup(false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/config' })).json().telegram_bot, null);
  const b = await offer();
  const r = await notifyReq(b, creator, 'creator', 'start');
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().error, 'notify_off');
  assert.equal(botUsername('@Pinky_bot'), 'Pinky_bot');
  assert.equal(botUsername('https://t.me/x'), '');
  assert.equal(botUsername(''), '');
});

test('subscribe needs the deal token, the right key and a fresh single-use signature', async () => {
  const b = await offer();
  // wrong key for the creator
  assert.equal((await notifyReq(b, stranger, 'creator', 'start')).statusCode, 403);
  // no token
  const ok = await notifyReq(b, creator, 'creator', 'start');
  assert.equal(ok.statusCode, 200);
  const noToken = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/notify`, payload: {} });
  assert.equal(noToken.statusCode, 404);
  // stale
  const old = await notifyReq(b, creator, 'creator', 'start', { issued_at_ns: (BigInt(clock - 10 * 60_000) * 1_000_000n).toString() });
  assert.equal(old.statusCode, 401);
  // a signature over another message (e.g. a deal action) does not count
  const payload = JSON.stringify({ op: 'start', role: 'creator', pk: creator.pk, handle: b.handle, issued_at_ns: (BigInt(clock) * 1_000_000n).toString() });
  const other = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/notify`,
    headers: { 'x-deal-token': b.token },
    payload: { payload, signature: creator.sign(0, 'notify', payload) },
  });
  assert.equal(other.statusCode, 401);
  // the code is long, random and has no key or handle in it
  const code = ok.json().code as string;
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!code.includes(b.handle.slice(0, 8)));
});

test('a code works once, in a private chat only; old codes fail', async () => {
  const b = await offer();
  const code = (await notifyReq(b, creator, 'creator', 'start')).json().code;
  await notify.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: -100, type: 'group' }, text: `/start ${code}` } });
  assert.equal(tg.sent.length, 0); // groups are ignored, the code is still unused
  await say('7', `/start ${code}`);
  assert.equal(tg.to('7')[0], BOT_TEXTS.en.subscribed);
  await say('8', `/start ${code}`);
  assert.equal(tg.to('8')[0], BOT_TEXTS.en.badCode);
  const late = (await notifyReq(b, creator, 'creator', 'start')).json().code;
  clock += 31 * 60_000;
  await say('9', `/start ${late}`);
  assert.equal(tg.to('9')[0], BOT_TEXTS.en.badCode);
  await say('9', '/start');
  assert.equal(tg.to('9')[1], BOT_TEXTS.en.hello);
});

test('the whole deal: each party hears only its own events, once, with no details', async () => {
  const b = await offer();
  await subscribe(b, creator, 'creator', '1');
  // the client subscribes on the key step, BEFORE joining
  await subscribe(b, client, 'client', '2');
  assert.equal(notify.store!.subsOf(b.handle).find((s) => s.party === 'client')!.pending_pk, client.pk);
  const id = await join(b);
  await notify.tick();
  assert.equal(tg.to('1').length, 1); // nothing new yet (only the "subscribed" line)
  assert.equal(notify.store!.subsOf(b.handle).find((s) => s.party === 'client')!.pending_pk, null);

  chain.fund(id, '5000000');
  await notify.tick();
  assert.match(tg.to('1').at(-1)!, /payment arrived/);
  assert.match(tg.to('2').at(-1)!, /payment arrived/);
  await notify.tick();
  assert.equal(tg.to('1').length, 2, 'no repeat');

  await chain.act(id, 'deliver', JSON.stringify({ deliverable_hash: 'h' }), '');
  await notify.tick();
  const delivered = tg.to('2').at(-1)!;
  assert.match(delivered, /delivered/);
  // review is 1 hour here: the "less than 1 day" warning rides in the same message
  assert.match(delivered, /Less than 1 day left to review/);
  assert.equal(tg.to('1').length, 2, 'the creator delivered: no message for them');

  await chain.act(id, 'dispute', '{}', '');
  await notify.tick();
  assert.match(tg.to('1').at(-1)!, /opened a dispute/);
  assert.equal(tg.to('2').length, 3, 'the client opened it');

  const d = chain.deals[id];
  Object.assign(d, { state: 'Released', outcome: { ArbiterSplit: { creator_share_bps: 5000 } }, ended_at_ns: String(BigInt(clock) * 1_000_000n), settled: false, creator_payout: '1', client_payout: '1' });
  await notify.tick();
  assert.match(tg.to('1').at(-1)!, /dispute is decided/);
  assert.match(tg.to('2').at(-1)!, /dispute is decided/);
  assert.equal(notify.store!.subsOf(b.handle).length, 2, 'kept while money waits');

  Object.assign(d, { state: 'PaidOut', settled: true, creator_payout: '0', client_payout: '0' });
  await notify.tick();
  assert.equal(notify.store!.subsOf(b.handle).length, 0, 'the Telegram ↔ deal link is deleted when the deal is over');
  for (const m of tg.sent) assertClean(m.text);
});

test('a client key that did not join loses its subscription', async () => {
  const b = await offer();
  await subscribe(b, stranger, 'client', '5');
  await join(b, client);
  await notify.tick();
  assert.equal(notify.store!.subsOf(b.handle).length, 0);
  // after the join, only the real client key can subscribe
  assert.equal((await notifyReq(b, stranger, 'client', 'start')).statusCode, 403);
  assert.equal((await notifyReq(b, client, 'client', 'start')).statusCode, 200);
});

test('timers: 1 day left to deliver (creator), delivery time over (client); accept (creator)', async () => {
  const b = makeOffer(creator, { nowMs: clock, durationNs: 3n * 86_400n * 1_000_000_000n });
  await app.inject({ method: 'POST', url: '/api/deals', payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms } });
  const id = await join(b);
  chain.fund(id, '5000000');
  await subscribe(b, creator, 'creator', '1');
  await subscribe(b, client, 'client', '2');
  await notify.tick();
  assert.equal(tg.sent.length, 2, 'funded before subscribing: not sent again');
  clock += 2 * DAY_MS + 3600_000;
  await notify.tick();
  assert.match(tg.to('1').at(-1)!, /Less than 1 day left to deliver/);
  clock += DAY_MS;
  await notify.tick();
  assert.match(tg.to('2').at(-1)!, /delivery time is over/);
  await notify.tick();
  assert.equal(tg.sent.length, 4);
});

test('deriveEvents: who hears what', () => {
  const base = chain.deals[0];
  assert.equal(base, undefined);
  const deal = {
    state: 'Released',
    outcome: 'Accepted',
    funded_at_ns: '1',
    delivered_at_ns: '2',
    disputed_at_ns: null,
    review_ends_at_ns: '9',
    delivery_deadline_ns: '9',
    settled: false,
  } as unknown as DealView;
  const prev = { s: 'Delivered', o: null, p: true, d: true };
  assert.deepEqual(deriveEvents('creator', prev, deal, 5n).events, ['accepted']);
  assert.deepEqual(deriveEvents('client', prev, deal, 5n).events, []);
  const refunded = { ...deal, outcome: 'RefundedByCreator', state: 'Refunded', delivered_at_ns: null } as unknown as DealView;
  assert.deepEqual(deriveEvents('client', { s: 'Funded', o: null, p: true }, refunded, 5n).events, ['refunded']);
  assert.deepEqual(deriveEvents('creator', snapshot(deal), deal, 5n).events, [], 'a baseline sends nothing');
});

test('unsubscribe: /stop in the chat, or signed with the deal key; status says which', async () => {
  const b = await offer();
  await subscribe(b, creator, 'creator', '1');
  await subscribe(b, creator, 'creator', '3');
  assert.equal((await notifyReq(b, creator, 'creator', 'status')).json().subscribed, true);
  await say('1', '/stop');
  assert.equal(tg.to('1').at(-1), BOT_TEXTS.en.stopped);
  assert.equal(notify.store!.subsOf(b.handle).length, 1);
  const r = await notifyReq(b, creator, 'creator', 'stop');
  assert.equal(r.json().removed, 1);
  assert.equal((await notifyReq(b, creator, 'creator', 'status')).json().subscribed, false);
  await say('1', '/stop');
  assert.equal(tg.to('1').at(-1), BOT_TEXTS.en.stoppedNone);
});

test('the bot never takes links or keys: it deletes them and warns', async () => {
  for (const text of ['https://pinkydeals.pages.dev/k#k1.client.aa', 'k1.creator.' + 'a'.repeat(32), 'ed25519:abc', 'a'.repeat(64)]) {
    await say('4', text);
    assert.equal(tg.to('4').at(-1), BOT_TEXTS.en.noLinks);
  }
  assert.equal(tg.deleted.length, 4);
  await say('4', 'hello?', 'uk');
  assert.equal(tg.to('4').at(-1), BOT_TEXTS.uk.help);
});

test('a chat that blocked the bot is forgotten; languages come from the site', async () => {
  const b = await offer();
  const id = await join(b);
  const r = await notifyReq(b, client, 'client', 'start', { lang: 'uk' });
  await say('6', `/start ${r.json().code}`);
  assert.equal(tg.to('6')[0], BOT_TEXTS.uk.subscribed);
  tg.blocked.add('6');
  chain.fund(id, '5000000');
  await notify.tick();
  assert.equal(notify.store!.subsOf(b.handle).length, 0);
});

test('an offer that expired before anyone joined: its subscriptions go', async () => {
  const b = await offer();
  await subscribe(b, creator, 'creator', '1');
  clock += 2 * DAY_MS;
  await notify.tick();
  assert.equal(notify.store!.subsOf(b.handle).length, 0);
  assert.equal(tg.sent.length, 1);
});

test('httpTelegram: token only in the path, JSON bodies, errors carry the status', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith('/sendMessage')) return new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden' }), { status: 403 });
    return new Response(JSON.stringify({ ok: true, result: [{ update_id: 5 }] }), { status: 200 });
  }) as typeof fetch;
  const api = httpTelegram('123:abc', fake, 'https://tg.test');
  assert.deepEqual(await api.getUpdates(3, 25), [{ update_id: 5 }]);
  assert.equal(calls[0].url, 'https://tg.test/bot123:abc/getUpdates');
  assert.deepEqual(calls[0].body, { offset: 3, timeout: 25, allowed_updates: ['message'] });
  await assert.rejects(api.sendMessage('1', 'hi'), (e: unknown) => e instanceof TelegramError && e.gone);
  assert.deepEqual(calls[1].body, { chat_id: '1', text: 'hi', link_preview_options: { is_disabled: true } });
});
