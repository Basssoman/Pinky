// "Report" button: POST /api/reports, the operator
// message from our bot (never a clickable link from user text), the
// /chatid bot command, and the public health answer without counters.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import type { Config } from '../src/config.ts';
import type { Market } from '../src/market.ts';
import type { Notify } from '../src/notify.ts';
import { defang, REPORT_TEXT_MAX, reportMessage, siteOrigin, type ReportStore } from '../src/reports.ts';
import { SqliteStore } from '../src/store.ts';
import { TelegramError, type TelegramApi, type TgUpdate } from '../src/telegram.ts';
import { FakeChain, FakeOneClick, testConfig } from './helpers.ts';

const CHAT = '-1001234567890';

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

let app: FastifyInstance;
let tg: FakeTelegram;
let clock = Date.now();
let profileId: string;
let reviewId: string;
let requestHandle: string;

async function setup(overrides: Partial<Config> = {}) {
  clock = Date.now();
  tg = new FakeTelegram();
  app = await buildApp({
    config: testConfig({
      telegramBotToken: '123:secret',
      telegramBotUsername: 'PinkyTestBot',
      telegramReportsChatId: CHAT,
      corsOrigin: 'https://pinky.example',
      ...overrides,
    }),
    chain: new FakeChain(),
    oneClick: new FakeOneClick(),
    store: new SqliteStore(':memory:'),
    now: () => clock,
    telegram: tg,
  });
  const ms = (app as unknown as { market: Market }).market.store;
  profileId = randomBytes(12).toString('hex');
  ms.saveProfile(profileId, 'ed25519:x', { nickname: 'Alice', bio: 'motion', categories: ['motion'], portfolio: [], contacts: [], services: [] });
  const dealHandle = randomBytes(32).toString('hex');
  ms.saveReview({ deal_handle: dealHandle, profile_id: profileId, rating: 5, text: 'great', refunded: false, signed_expires_ns: '1', outcome: 'paid' });
  reviewId = ms.getReview(dealHandle)!.review_id;
  requestHandle = randomBytes(32).toString('hex');
  ms.insertRequest({
    handle: requestHandle,
    profile_id: profileId,
    service: null,
    brief: 'test task: run this file',
    wanted_deadline: null,
    contact_kind: 'telegram',
    contact_value: '@x',
    client_box_pk: 'a'.repeat(64),
  });
}
beforeEach(async () => setup());

const reports = () => (app as unknown as { reports: { store: ReportStore } }).reports.store;
let ipSeq = 1;
const freshIp = () => `198.51.${100 + (ipSeq >> 8)}.${ipSeq++ & 255}`;
const send = (payload: Record<string, unknown>, ip = freshIp()) => app.inject({ method: 'POST', url: '/api/reports', payload, remoteAddress: ip });
const flush = () => new Promise((r) => setImmediate(r));

test('report: each kind is stored; the operator chat gets one message with our page link', async () => {
  for (const [kind, id] of [
    ['profile', profileId],
    ['review', reviewId],
    ['request', requestHandle],
  ] as const) {
    const res = await send({ kind, target_id: id, reason: 'scam', text: 'fake job' });
    assert.equal(res.statusCode, 201, res.body);
    assert.deepEqual(res.json(), { ok: true });
  }
  const rows = reports().list();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === 'open' && r.reason === 'scam' && r.text === 'fake job'));
  assert.ok(!JSON.stringify(rows).includes('198.51.'), 'no IP stored');
  await flush();
  assert.equal(tg.sent.length, 3);
  assert.ok(tg.sent.every((m) => m.chat === CHAT));
  const profileMsg = tg.sent.find((m) => m.text.includes('creator profile'))!.text;
  assert.match(profileMsg, new RegExp(`Open: https://pinky\\.example/creators/${profileId}`));
  assert.match(profileMsg, /Reason: scam/);
  // a private request has no page link
  const reqMsg = tg.sent.find((m) => m.text.includes('request'))!.text;
  assert.doesNotMatch(reqMsg, /Open: /);
});

test('report: the creator answer of a review can be reported only when there is one', async () => {
  const ms = (app as unknown as { market: Market }).market.store;
  assert.equal((await send({ kind: 'reply', target_id: reviewId, reason: 'offensive' })).statusCode, 404);
  ms.saveReply(reviewId, 'thanks!');
  assert.equal((await send({ kind: 'reply', target_id: reviewId, reason: 'offensive' })).statusCode, 201);
});

test('report: bad or hidden target is refused and stores nothing', async () => {
  const ms = (app as unknown as { market: Market }).market.store;
  const cases: Record<string, unknown>[] = [
    { kind: 'profile', target_id: 'f'.repeat(24), reason: 'scam' }, // no such profile
    { kind: 'profile', target_id: 'not-hex', reason: 'scam' },
    { kind: 'review', target_id: 'e'.repeat(16), reason: 'scam' },
    { kind: 'request', target_id: 'd'.repeat(64), reason: 'scam' },
    { kind: 'request', target_id: profileId, reason: 'scam' }, // wrong id shape for the kind
  ];
  for (const c of cases) assert.equal((await send(c)).statusCode, 404, JSON.stringify(c));
  assert.equal((await send({ kind: 'deal', target_id: profileId, reason: 'scam' })).statusCode, 400);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'spam' })).statusCode, 400);
  assert.equal((await send({ kind: 'profile', target_id: profileId })).statusCode, 400);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam', text: 5 })).statusCode, 400);
  ms.setOperatorHidden(profileId, true);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' })).statusCode, 404, 'already hidden');
  assert.equal(reports().list({ all: true }).length, 0);
  await flush();
  assert.equal(tg.sent.length, 0);
});

test('report: text over 500 characters is refused (characters, not bytes); control chars refused', async () => {
  const ok = 'я'.repeat(REPORT_TEXT_MAX); // 1000 bytes, 500 characters
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'other', text: ok })).statusCode, 201);
  const long = await send({ kind: 'profile', target_id: profileId, reason: 'other', text: 'a'.repeat(REPORT_TEXT_MAX + 1) });
  assert.equal(long.statusCode, 400);
  assert.match(long.json().message, /too long/);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'other', text: 'a\u0000b' })).statusCode, 400);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'other', text: 'bidi ‮ flip' })).statusCode, 400);
  // new lines are fine
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'other', text: 'line 1\nline 2' })).statusCode, 201);
  assert.equal(reports().list().length, 2);
});

test('report: rate limits per IP, per target, and one report per person per thing per day', async () => {
  const ip = '203.0.113.7';
  // same person, same thing: thanked, stored once
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' }, ip)).statusCode, 201);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' }, ip)).statusCode, 202);
  assert.equal(reports().list().length, 1);
  // 3 per minute per IP (the two above + one more), then 429
  assert.equal((await send({ kind: 'review', target_id: reviewId, reason: 'scam' }, ip)).statusCode, 201);
  assert.equal((await send({ kind: 'request', target_id: requestHandle, reason: 'scam' }, ip)).statusCode, 429);
  clock += 61_000;
  assert.equal((await send({ kind: 'request', target_id: requestHandle, reason: 'scam' }, ip)).statusCode, 201);

  // per target: 10 an hour from different people, then 429
  await setup();
  for (let i = 0; i < 10; i++) assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' })).statusCode, 201);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' })).statusCode, 429);
  assert.equal(reports().list().length, 10);
  clock += 60 * 60_000 + 1;
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' })).statusCode, 201);
});

test('report: per network per day cap (IPv4 /24)', async () => {
  for (let i = 0; i < 20; i++) {
    if (i % 3 === 0) clock += 61_000; // stay under the per-minute limit
    const ms = (app as unknown as { market: Market }).market.store;
    const pid = randomBytes(12).toString('hex');
    ms.saveProfile(pid, `ed25519:p${i}`, { nickname: `P${i}`, bio: '', categories: ['motion'], portfolio: [], contacts: [], services: [] });
    assert.equal((await send({ kind: 'profile', target_id: pid, reason: 'other' }, `192.0.2.${i + 1}`)).statusCode, 201);
  }
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'other' }, '192.0.2.200')).statusCode, 429);
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'other' }, '192.0.3.1')).statusCode, 201, 'another network');
});

test('report: the operator message has no clickable link from the user text', async () => {
  const evil = 'Open https://evil.example/x.exe or www.bad.io, mail me a@b.co, t.me/scammer, @scammer_bot, evil。com hxxp://x.y';
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'link', text: evil })).statusCode, 201);
  await flush();
  const msg = tg.sent[0].text;
  const [before, textLine, after] = [msg.split('\nText: ')[0], msg.split('\nText: ')[1].split('\n')[0], msg.split('\nText: ')[1].split('\n').slice(1).join('\n')];
  assert.ok(before && after);
  // nothing Telegram would turn into a link, an e-mail or a mention
  assert.doesNotMatch(textLine, /https?:\/\//i);
  assert.doesNotMatch(textLine, /\w\.\w/);
  assert.doesNotMatch(textLine, /@/);
  assert.doesNotMatch(textLine, /。com/);
  assert.match(textLine, /evil\[\.\]example/);
  assert.match(textLine, /hxxps\[:\]\/\//);
  // the stored report keeps the original text for the operator
  assert.equal(reports().list()[0].text, evil);
  // only our own page link is a link in the whole message
  const links = msg.match(/https?:\/\/\S+/g) ?? [];
  assert.deepEqual(links, [`https://pinky.example/creators/${profileId}`]);
});

test('report: defang / reportMessage / siteOrigin units', () => {
  assert.equal(defang('see evil.com now'), 'see evil[.]com now');
  assert.equal(defang('end of sentence. Next'), 'end of sentence. Next');
  assert.equal(defang('HTTPS://X.Y'), 'hxxpS[:]//X[.]Y');
  assert.equal(defang('ftp://a'), 'ftp[:]//a');
  assert.equal(defang('a\nb‮c'), 'a b c');
  assert.equal(defang('＠name'), '(at)name');
  const m = reportMessage({ id: 7, kind: 'review', reason: 'offensive', text: '', link: null, count: 3 });
  assert.match(m, /^Pinky report #7: review/);
  assert.match(m, /Open reports about this: 3/);
  assert.doesNotMatch(m, /Text:/);
  assert.equal(siteOrigin('https://pinkydeals.pages.dev,http://localhost:5175'), 'https://pinkydeals.pages.dev');
  assert.equal(siteOrigin('*'), null);
});

test('report: without TELEGRAM_REPORTS_CHAT_ID reports are only stored; a Telegram failure does not fail the report', async () => {
  await setup({ telegramReportsChatId: '' });
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' })).statusCode, 201);
  await flush();
  assert.equal(tg.sent.length, 0);
  assert.equal(reports().list().length, 1);

  await setup();
  tg.fail = true;
  assert.equal((await send({ kind: 'profile', target_id: profileId, reason: 'scam' })).statusCode, 201);
  await flush();
  assert.equal(reports().list().length, 1);
});

test('report store: close one or all about the same thing', async () => {
  for (let i = 0; i < 3; i++) await send({ kind: 'profile', target_id: profileId, reason: 'scam' });
  await send({ kind: 'review', target_id: reviewId, reason: 'scam' });
  const [newest] = reports().list();
  assert.equal(reports().countOpenFor('profile', profileId), 3);
  const firstProfile = reports().list().find((r) => r.kind === 'profile')!;
  assert.equal(reports().close(firstProfile.id, true), 3);
  assert.equal(reports().list().length, 1);
  assert.equal(reports().close(newest.id), 1);
  assert.equal(reports().close(newest.id), 0, 'already closed');
  assert.equal(reports().list({ all: true }).length, 4);
});

test('bot: /chatid answers the chat id, also in a group; the config reads the env var', async () => {
  const notify = (app as unknown as { notify: Notify }).notify;
  await notify.handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: 4242, type: 'private' }, text: '/chatid' } });
  await notify.handleUpdate({ update_id: 2, message: { message_id: 2, chat: { id: -100777, type: 'supergroup' }, text: '/chatid@PinkyTestBot' } });
  // other group messages are still ignored
  await notify.handleUpdate({ update_id: 3, message: { message_id: 3, chat: { id: -100777, type: 'supergroup' }, text: '/stop' } });
  assert.equal(tg.sent.length, 2);
  assert.equal(tg.sent[0].chat, '4242');
  assert.match(tg.sent[0].text, /4242/);
  assert.equal(tg.sent[1].chat, '-100777');
  assert.match(tg.sent[1].text, /-100777/);
  assert.doesNotMatch(tg.sent.map((m) => m.text).join(' '), /https?:|t\.me/);

  const { readConfig } = await import('../src/config.ts');
  const base = { ESCROW_CONTRACT_ID: 'x.near', RELAYER_ACCOUNT_ID: 'r.near', RELAYER_PRIVATE_KEY: 'ed25519:x', ONECLICK_API_KEY: 'k' };
  assert.equal(readConfig({ ...base, TELEGRAM_REPORTS_CHAT_ID: ' -1001 ' }).telegramReportsChatId, '-1001');
  assert.equal(readConfig({ ...base, TELEGRAM_REPORTS_CHAT_ID: '@channel' }).telegramReportsChatId, '');
  assert.equal(readConfig(base).telegramReportsChatId, '');
});

test('health: public answer has no daily counters, thresholds or caps', async () => {
  const h = (await app.inject({ method: 'GET', url: '/api/health' })).json();
  assert.deepEqual(Object.keys(h).sort(), ['balances', 'contract_id', 'network', 'ok', 'warnings']);
  const s = JSON.stringify(h);
  assert.doesNotMatch(s, /daily|threshold|cap|joins|offers/i);
});
