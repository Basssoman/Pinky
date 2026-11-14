// A deal that ended by itself (auto-release after the review
// timer, refund after a missed delivery deadline): the 3-day review window
// starts when the client first opens the deal after the end (a signed read),
// at most 30 days after the end. The bot's review reminder follows that window.
// Also: the bot tells the profile owner (their
// creator-deal chats) once when support confirms a key reset.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { parsePublicKey, sha256Hex } from '../src/encoding.ts';
import { IDLE_OPEN_MAX_MS, profileIdOf, profileWriteMessage, requestDealMessage, reviewMessage, reviewOpenMessage, reviewUntilMs, type Market } from '../src/market.ts';
import { notifyMessage, type Notify } from '../src/notify.ts';
import { SqliteStore } from '../src/store.ts';
import { BOT_TEXTS, TelegramError, type TelegramApi, type TgUpdate } from '../src/telegram.ts';
import { run as resetCli } from '../scripts/market-key-reset.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey, type OfferBundle } from './helpers.ts';

const DAY = 86_400_000;
const WINDOW = 3 * DAY;

class FakeTelegram implements TelegramApi {
  sent: { chat: string; text: string }[] = [];
  async getUpdates(): Promise<TgUpdate[]> {
    return [];
  }
  async sendMessage(chat: string, text: string) {
    if (chat === 'blocked') throw new TelegramError(403, 'Forbidden');
    this.sent.push({ chat, text });
  }
  async deleteMessage() {}
  to(chat: string) {
    return this.sent.filter((m) => m.chat === chat).map((m) => m.text);
  }
}

type PKey = DealKey & { id: string };
const profKey = (seed: number): PKey => {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
};
const alice = profKey(91);
const fresh = profKey(92);
const creatorDeal = keyFromSeed(93);
const clientDeal = keyFromSeed(94);

let chain: FakeChain;
let tg: FakeTelegram;
let app: FastifyInstance;
let clock = Date.now();
let seq = 0n;
let updateId = 1;
const exp = () => ((BigInt(clock) + 300_000n) * 1_000_000n + seq++).toString();
const market = () => (app as unknown as { market: Market }).market;
const notify = () => (app as unknown as { notify: Notify }).notify;

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  tg = new FakeTelegram();
  app = await buildApp({
    config: testConfig({ telegramBotToken: '123:secret', telegramBotUsername: 'PinkyTestBot', rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000 }),
    chain,
    oneClick: new FakeOneClick(),
    store: new SqliteStore(':memory:'),
    now: () => clock,
    telegram: tg,
  });
});

async function deal(): Promise<{ b: OfferBundle; id: number }> {
  const profile = { nickname: 'Alice Motion', bio: '', categories: ['motion'], portfolio: [], contacts: [], services: [] };
  let e = exp();
  await app.inject({ method: 'PUT', url: `/api/profiles/${alice.id}`, payload: { profile_pk: alice.pk, profile, expires_at_ns: e, sig: alice.signRaw(profileWriteMessage(CONTRACT_ID, alice.id, profile, e)) } });
  const token = randomBytes(16).toString('hex');
  const rh = sha256Hex(token);
  const req = await app.inject({
    method: 'POST',
    url: '/api/requests',
    payload: { handle: rh, profile_id: alice.id, brief: 'A logo animation', client_contact: { kind: 'telegram', value: '@c' }, client_box_pk: randomBytes(32).toString('hex') },
  });
  assert.equal(req.statusCode, 201, req.body);
  const b = makeOffer(creatorDeal, { nowMs: clock });
  e = exp();
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
      request_sig: alice.signRaw(requestDealMessage(CONTRACT_ID, rh, creatorDeal.pk, e)),
      deal_link_box: { epk: 'a'.repeat(64), iv: 'b'.repeat(24), ct: 'c'.repeat(96) },
    },
  });
  assert.equal(r.statusCode, 201, r.body);
  const j = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: clientDeal.pk } });
  assert.equal(j.statusCode, 201, j.body);
  const id = j.json().deal_id as number;
  chain.fund(id, chain.deals[id].amount);
  return { b, id };
}

/** The deal ends: `outcome` "AutoReleased" / "RefundedAfterDeadline" = nobody acted; "Accepted" = the client acted. */
function end(id: number, outcome: 'AutoReleased' | 'RefundedAfterDeadline' | 'Accepted') {
  const refund = outcome === 'RefundedAfterDeadline';
  Object.assign(chain.deals[id], {
    state: refund ? 'Refunded' : 'PaidOut',
    outcome,
    creator_payout: '0',
    creator_withdrawn: refund ? '0' : '4850000',
    client_withdrawn: refund ? chain.deals[id].amount : '0',
    ended_at_ns: (BigInt(clock) * 1_000_000n).toString(),
    settled: true,
  });
}

const reviewView = async (b: OfferBundle) => (await app.inject({ method: 'GET', url: `/api/deals/${b.handle}/review`, headers: { 'x-deal-token': b.token } })).json();
async function open(b: OfferBundle, id: number, key: DealKey = clientDeal) {
  const e = exp();
  return app.inject({ method: 'POST', url: `/api/deals/${b.handle}/review/open`, headers: { 'x-deal-token': b.token }, payload: { expires_at_ns: e, sig: key.signRaw(reviewOpenMessage(CONTRACT_ID, id, e)) } });
}
async function review(b: OfferBundle, id: number) {
  const e = exp();
  return app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/review`,
    headers: { 'x-deal-token': b.token },
    payload: { rating: 4, text: 'ok', expires_at_ns: e, sig: clientDeal.signRaw(reviewMessage(CONTRACT_ID, id, alice.id, 4, 'ok', e)) },
  });
}

test('reviewUntilMs: plain 3 days; "nobody acted": from the first open, at most 30 days after the end', () => {
  const ended = 1_000_000;
  assert.equal(reviewUntilMs({ ended_ms: ended }, WINDOW), ended + WINDOW);
  assert.equal(reviewUntilMs({ ended_ms: ended, idle_end: true, opened_ms: null }, WINDOW), ended + IDLE_OPEN_MAX_MS + WINDOW);
  assert.equal(reviewUntilMs({ ended_ms: ended, idle_end: true, opened_ms: ended + 5 * DAY }, WINDOW), ended + 5 * DAY + WINDOW);
  assert.equal(reviewUntilMs({ ended_ms: ended, idle_end: true, opened_ms: ended + 40 * DAY }, WINDOW), ended + IDLE_OPEN_MAX_MS + WINDOW);
  assert.equal(reviewUntilMs({ ended_ms: null, idle_end: true, opened_ms: null }, WINDOW), null);
});

test('auto-release: the 3 days start when the client opens the deal (signed), 10 days after the end', async () => {
  const { b, id } = await deal();
  end(id, 'AutoReleased');
  const v0 = await reviewView(b);
  assert.equal(v0.starts_on_open, true);
  assert.equal(v0.can_review, true);
  clock += 10 * DAY;
  // The creator holds the deal token too, but cannot start the client's window.
  assert.equal((await open(b, id, creatorDeal)).statusCode, 401);
  const o = await open(b, id);
  assert.equal(o.statusCode, 200, o.body);
  assert.equal(o.json().started, true);
  assert.equal(Date.parse(o.json().review_until), clock + WINDOW);
  // Only the first open counts.
  clock += DAY;
  assert.equal((await open(b, id)).json().started, false);
  assert.equal((await reviewView(b)).starts_on_open, false);
  clock += 2 * DAY + 1000;
  const v = await reviewView(b);
  assert.equal(v.can_review, false);
  assert.equal(v.locked, true);
  assert.equal((await review(b, id)).json().error, 'review_locked');
});

test('refund after a missed deadline, never opened: open until 30 + 3 days after the end, then locked', async () => {
  const { b, id } = await deal();
  end(id, 'RefundedAfterDeadline');
  const v = await reviewView(b);
  assert.equal(v.outcome, 'refunded');
  assert.equal(v.starts_on_open, true);
  clock += IDLE_OPEN_MAX_MS + 1000;
  // Past the 30 days: no more waiting for the open, the 3 days run.
  assert.equal((await reviewView(b)).starts_on_open, false);
  assert.equal((await reviewView(b)).can_review, true);
  // An open on day 31 does not give 3 more days.
  const o = await open(b, id);
  assert.equal(Date.parse(o.json().review_until), Date.parse(v.review_until));
  clock += WINDOW;
  assert.equal((await reviewView(b)).locked, true);
});

test('a review on a "nobody acted" deal also counts as the first open', async () => {
  const { b, id } = await deal();
  end(id, 'AutoReleased');
  clock += 2 * DAY;
  assert.equal((await review(b, id)).statusCode, 201);
  assert.equal(Date.parse((await reviewView(b)).review_until), clock + WINDOW);
});

test('accepted by the client: plain 3 days from the end, the open changes nothing', async () => {
  const { b, id } = await deal();
  end(id, 'Accepted');
  const ended = clock;
  const v = await reviewView(b);
  assert.equal(v.starts_on_open, false);
  assert.equal(Date.parse(v.review_until), ended + WINDOW);
  clock += DAY;
  assert.equal((await open(b, id)).json().started, false);
  assert.equal(Date.parse((await reviewView(b)).review_until), ended + WINDOW);
});

async function subscribe(b: OfferBundle, key: DealKey, role: 'creator' | 'client', chat: string) {
  const payload = JSON.stringify({ op: 'start', role, pk: key.pk, handle: b.handle, lang: 'en', issued_at_ns: (BigInt(clock) * 1_000_000n).toString(), nonce: randomBytes(8).toString('hex') });
  const r = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/notify`, headers: { 'x-deal-token': b.token }, payload: { payload, signature: key.signRaw(notifyMessage(CONTRACT_ID, payload)) } });
  assert.equal(r.statusCode, 200, r.body);
  await notify().handleUpdate({ update_id: updateId++, message: { message_id: updateId, chat: { id: Number(chat), type: 'private' }, text: `/start ${r.json().code}` } });
}
const reminder = (t: string) => t.includes(BOT_TEXTS.en.events.leave_review);

test('bot: the reminder follows the window that starts at the first open', async () => {
  const { b, id } = await deal();
  await subscribe(b, clientDeal, 'client', '7');
  end(id, 'AutoReleased');
  clock += 31_000;
  await market().refreshLinks();
  await notify().tick();
  // Not opened: the row waits (up to 30 + 3 days), no reminder yet.
  clock += 5 * DAY;
  await notify().tick();
  assert.equal(tg.to('7').filter(reminder).length, 0);
  assert.equal(notify().store!.subsOf(b.handle).length, 1, 'kept while the window can still start');
  await open(b, id);
  clock += DAY + 60_000; // less than 2 of the 3 days left
  await notify().tick();
  assert.equal(tg.to('7').filter(reminder).length, 1);
  assert.equal(notify().store!.subsOf(b.handle).length, 0, 'sent: the link goes');
});

test('bot: never opened -> the reminder comes near the end of the 30 + 3 days', async () => {
  const { b, id } = await deal();
  await subscribe(b, clientDeal, 'client', '8');
  end(id, 'RefundedAfterDeadline');
  clock += 31_000;
  await market().refreshLinks();
  clock += IDLE_OPEN_MAX_MS + DAY - 120_000;
  await notify().tick();
  assert.equal(tg.to('8').filter(reminder).length, 0);
  clock += 240_000;
  await notify().tick();
  assert.equal(tg.to('8').filter(reminder).length, 1);
});

test('bot: a confirmed key reset -> one fixed message to the creator chats of the profile; never the client', async () => {
  const { b } = await deal();
  await subscribe(b, creatorDeal, 'creator', '11');
  await subscribe(b, clientDeal, 'client', '12');
  const ms = market().store;
  const quiet = () => {};
  resetCli(ms, ['issue', alice.id, fresh.pk, 'https://www.behance.net/alice'], quiet);
  const reset = ms.openReset(alice.id)!;
  await notify().tick();
  assert.equal(tg.to('11').filter((t) => t === BOT_TEXTS.en.keyReset).length, 0, 'not before the operator confirms');
  resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], quiet);
  await notify().tick();
  await notify().tick();
  const msgs = tg.to('11').filter((t) => t === BOT_TEXTS.en.keyReset);
  assert.equal(msgs.length, 1, 'once');
  assert.doesNotMatch(msgs[0], /https?:|t\.me|ed25519|Alice|СБРОС|PINKY-KEY/);
  assert.equal(tg.to('12').filter((t) => t === BOT_TEXTS.en.keyReset).length, 0, 'the client never');
  assert.ok(BOT_TEXTS.uk.keyReset.length > 20);
});
