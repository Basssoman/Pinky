// Bot reminder "leave a review, less than 2 days left" with the
// bot rules: client only, once, no details, only a confirmed subscription;
// the Telegram ↔ deal link goes once the reminder is sent, the review is
// written or the 3-day window is over. Mocked chain and Telegram.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { parsePublicKey, sha256Hex } from '../src/encoding.ts';
import { profileIdOf, profileWriteMessage, requestDealMessage, reviewMessage, type Market } from '../src/market.ts';
import { notifyMessage, REVIEW_REMIND_MS, reviewReminderDue, type Notify } from '../src/notify.ts';
import { SqliteStore } from '../src/store.ts';
import { BOT_TEXTS, newsText, TelegramError, type TelegramApi, type TgUpdate } from '../src/telegram.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey, type OfferBundle } from './helpers.ts';

const DAY_MS = 86_400_000;
const BOT = 'PinkyTestBot';

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
function profKey(seed: number): PKey {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
}
const alice = profKey(41);
const creatorDeal = keyFromSeed(42);
const clientDeal = keyFromSeed(43);

let chain: FakeChain;
let tg: FakeTelegram;
let app: FastifyInstance;
let clock = Date.now();
let seq = 0n;
let updateId = 1;
const exp = () => ((BigInt(clock) + 300_000n) * 1_000_000n + seq++).toString();
const notify = () => (app as unknown as { notify: Notify }).notify;
const market = () => (app as unknown as { market: Market }).market;

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  tg = new FakeTelegram();
  const config = testConfig({
    telegramBotToken: '123:secret',
    telegramBotUsername: BOT,
    rateWritesPerMin: 1000,
    rateInvalidPerMin: 1000,
    rateReadsPerMin: 1000,
  });
  app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock, telegram: tg });
});

async function profile() {
  const profile = {
    nickname: 'Alice Motion',
    bio: 'Logo animations',
    categories: ['motion'],
    portfolio: [],
    contacts: [{ kind: 'telegram', value: '@alice_motion' }],
    services: [{ title: 'Logo animation', description: '10 s', price_from_usdc: 150, delivery_days: 5 }],
  };
  const e = exp();
  const r = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${alice.id}`,
    payload: { profile_pk: alice.pk, profile, expires_at_ns: e, sig: alice.signRaw(profileWriteMessage(CONTRACT_ID, alice.id, profile, e)) },
  });
  assert.equal(r.statusCode, 201, r.body);
}

/** A request in the catalog -> a deal from it, joined by the client. `linked: false` = a plain deal (no request). */
async function deal(linked = true): Promise<{ b: OfferBundle; id: number }> {
  const b = makeOffer(creatorDeal, { nowMs: clock });
  const payload: Record<string, unknown> = { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms };
  if (linked) {
    await profile();
    const token = randomBytes(16).toString('hex');
    const rh = sha256Hex(token);
    const req = await app.inject({
      method: 'POST',
      url: '/api/requests',
      payload: {
        handle: rh,
        profile_id: alice.id,
        brief: 'Need a 10 s logo animation for our launch',
        client_contact: { kind: 'telegram', value: '@client_contact' },
        client_box_pk: randomBytes(32).toString('hex'),
      },
    });
    assert.equal(req.statusCode, 201, req.body);
    const e = exp();
    Object.assign(payload, {
      request_handle: rh,
      request_expires_at_ns: e,
      request_sig: alice.signRaw(requestDealMessage(CONTRACT_ID, rh, creatorDeal.pk, e)),
      deal_link_box: { epk: 'a'.repeat(64), iv: 'b'.repeat(24), ct: 'c'.repeat(96) },
    });
  }
  const r = await app.inject({ method: 'POST', url: '/api/deals', payload });
  assert.equal(r.statusCode, 201, r.body);
  const j = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: clientDeal.pk } });
  assert.equal(j.statusCode, 201, j.body);
  const id = j.json().deal_id as number;
  chain.fund(id, chain.deals[id].amount);
  return { b, id };
}

async function subscribe(b: OfferBundle, key: DealKey, role: 'creator' | 'client', chat: string) {
  const payload = JSON.stringify({ op: 'start', role, pk: key.pk, handle: b.handle, lang: 'en', issued_at_ns: (BigInt(clock) * 1_000_000n).toString(), nonce: randomBytes(8).toString('hex') });
  const r = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/notify`,
    headers: { 'x-deal-token': b.token },
    payload: { payload, signature: key.signRaw(notifyMessage(CONTRACT_ID, payload)) },
  });
  assert.equal(r.statusCode, 200, r.body);
  await notify().handleUpdate({ update_id: updateId++, message: { message_id: updateId, chat: { id: Number(chat), type: 'private' }, text: `/start ${r.json().code}` } });
  assert.equal(tg.to(chat).at(-1), BOT_TEXTS.en.subscribed);
}

/** The client accepts: fully paid, finished, the creator got the money; `settled` = nothing left to withdraw. */
function accept(id: number, settled = true) {
  Object.assign(chain.deals[id], {
    state: settled ? 'PaidOut' : 'Released',
    outcome: 'Accepted',
    creator_payout: settled ? '0' : '4850000',
    creator_withdrawn: settled ? '4850000' : '0',
    ended_at_ns: (BigInt(clock) * 1_000_000n).toString(),
    settled,
  });
}

/** The marketplace re-reads linked deals on its own timer (off in tests). */
async function marketCatchesUp() {
  clock += 31_000;
  await market().refreshLinks();
}

const reminder = (t: string) => t.includes(BOT_TEXTS.en.events.leave_review);

test('the client hears "leave a review, less than 2 days left" once, at day 1 of 3; the creator never', async () => {
  const { b, id } = await deal();
  await subscribe(b, creatorDeal, 'creator', '1');
  await subscribe(b, clientDeal, 'client', '2');
  await notify().tick();
  accept(id);
  await notify().tick();
  // Over on-chain, but the marketplace has not stored the end yet: only the client's row waits.
  assert.deepEqual(
    notify().store!.subsOf(b.handle).map((s) => s.party),
    ['client'],
  );
  await marketCatchesUp();
  await notify().tick();
  assert.equal(tg.to('2').filter(reminder).length, 0, 'not yet: 3 days left');
  clock += DAY_MS - 60_000;
  await notify().tick();
  assert.equal(tg.to('2').filter(reminder).length, 0, 'still a bit more than 2 days left');
  clock += 120_000;
  await notify().tick();
  const msgs = tg.to('2').filter(reminder);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0], newsText('en', ['leave_review']));
  // No link, amount, key, nickname or title in it.
  assert.doesNotMatch(msgs[0], /https?:|t\.me|\/k#|ed25519|USDC|\$|\d+\.\d+|Alice|Logo/);
  assert.equal(tg.to('1').filter(reminder).length, 0, 'the creator is never reminded');
  // Sent: the Telegram ↔ deal link is gone.
  assert.equal(notify().store!.subsOf(b.handle).length, 0);
  clock += DAY_MS / 2;
  await notify().tick();
  assert.equal(tg.to('2').filter(reminder).length, 1, 'once');
});

test('no reminder when the review is already written; the subscription goes', async () => {
  const { b, id } = await deal();
  await subscribe(b, clientDeal, 'client', '2');
  accept(id);
  await marketCatchesUp();
  await notify().tick();
  assert.equal(notify().store!.subsOf(b.handle).length, 1);
  const e = exp();
  const r = await app.inject({
    method: 'POST',
    url: `/api/deals/${b.handle}/review`,
    headers: { 'x-deal-token': b.token },
    payload: { rating: 5, text: 'Great', expires_at_ns: e, sig: clientDeal.signRaw(reviewMessage(CONTRACT_ID, id, alice.id, 5, 'Great', e)) },
  });
  assert.equal(r.statusCode, 201, r.body);
  clock += DAY_MS + 60_000;
  await notify().tick();
  assert.equal(tg.to('2').filter(reminder).length, 0);
  assert.equal(notify().store!.subsOf(b.handle).length, 0);
});

test('the reminder also comes while the creator has not withdrawn yet (deal not settled)', async () => {
  const { b, id } = await deal();
  await subscribe(b, clientDeal, 'client', '2');
  accept(id, false);
  await marketCatchesUp();
  clock += DAY_MS + 60_000;
  await notify().tick();
  assert.equal(tg.to('2').filter(reminder).length, 1);
  assert.equal(notify().store!.subsOf(b.handle).length, 1, 'kept while money waits (not over yet)');
});

test('a deal not from a request: no reminder, deleted when over as before', async () => {
  const { b, id } = await deal(false);
  await subscribe(b, clientDeal, 'client', '2');
  accept(id);
  await notify().tick();
  assert.equal(notify().store!.subsOf(b.handle).length, 0);
  assert.equal(tg.to('2').filter(reminder).length, 0);
});

test('a refund before the deal was paid is not reviewable: no reminder, nothing kept', async () => {
  const { b, id } = await deal();
  await subscribe(b, clientDeal, 'client', '2');
  Object.assign(chain.deals[id], { state: 'Refunded', outcome: 'Cancelled', funded_amount: '0', ended_at_ns: (BigInt(clock) * 1_000_000n).toString(), settled: true });
  await notify().tick();
  assert.equal(notify().store!.subsOf(b.handle).length, 0);
});

test('the window is over (server was down): no late reminder, the row goes', async () => {
  const { b, id } = await deal();
  await subscribe(b, clientDeal, 'client', '2');
  accept(id);
  await marketCatchesUp();
  clock += 3 * DAY_MS + 60_000;
  await notify().tick();
  assert.equal(tg.to('2').filter(reminder).length, 0);
  assert.equal(notify().store!.subsOf(b.handle).length, 0);
});

test('reviewReminderDue: client only, once, inside the last 2 days, before a review', () => {
  const now = 1_000_000_000;
  const open = { until_ms: now + REVIEW_REMIND_MS - 1, reviewed: false };
  const seen = { s: 'PaidOut', o: 'Accepted' };
  assert.equal(reviewReminderDue('client', seen, open, now), true);
  assert.equal(reviewReminderDue('creator', seen, open, now), false);
  assert.equal(reviewReminderDue('client', { ...seen, rv: true }, open, now), false);
  assert.equal(reviewReminderDue('client', seen, { ...open, reviewed: true }, now), false);
  assert.equal(reviewReminderDue('client', seen, { until_ms: now + REVIEW_REMIND_MS + 1, reviewed: false }, now), false);
  assert.equal(reviewReminderDue('client', seen, { until_ms: now, reviewed: false }, now), false);
  assert.equal(reviewReminderDue('client', seen, 'wait', now), false);
  assert.equal(reviewReminderDue('client', seen, null, now), false);
});

test('bot texts: the reminder exists in every bot language, with no link', () => {
  for (const t of Object.values(BOT_TEXTS)) {
    assert.ok(t.events.leave_review.length > 10);
    assert.doesNotMatch(t.events.leave_review, /https?:|t\.me|\//);
  }
});
