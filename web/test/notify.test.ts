// Telegram notifications from the browser side (web/src/lib/notify.ts) against
// the REAL server app with a mocked Telegram API.

import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { buildApp } from '../../server/src/app.ts';
import type { Notify } from '../../server/src/notify.ts';
import { SqliteStore } from '../../server/src/store.ts';
import type { TelegramApi } from '../../server/src/telegram.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, testConfig } from '../../server/test/helpers.ts';
import { httpApi } from '../src/lib/api';
import type { ChainReader } from '../src/lib/chain';
import type { Net } from '../src/lib/config';
import { createDeal, joinDeal, loadDeal, markKeySaved, prepareClientKey, type Ctx } from '../src/lib/flows';
import { memoryStore, type LocalDeal } from '../src/lib/local';
import { botLink, httpNotify, NotifyError, signNotify } from '../src/lib/notify';

let clock = Date.now();
let chain: FakeChain;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = '';
let sent: { chat: string; text: string }[] = [];

const tg: TelegramApi = {
  getUpdates: async () => [],
  sendMessage: async (chat, text) => void sent.push({ chat, text }),
  deleteMessage: async () => {},
};

async function start(bot: boolean) {
  clock = Date.now();
  sent = [];
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  const config = testConfig({ rateWritesPerMin: 1000, ...(bot ? { telegramBotToken: '1:x', telegramBotUsername: 'PinkyTestBot' } : {}) });
  app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock, telegram: tg });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
}

beforeEach(() => start(true));
afterEach(async () => {
  await app.close();
});

function browser(): Ctx {
  const chainReader: ChainReader = {
    getDeal: (id) => chain.getDeal(id) as ReturnType<ChainReader['getDeal']>,
    getDealIdByOffer: (offer) => chain.getDealIdByOffer(offer),
    isOfferRevoked: async (offer) => chain.revokedOffers.has(offer),
    getPeriods: async () => ({ disputePeriodNs: 7n * 86400n * 10n ** 9n, payByPeriodNs: 7n * 86400n * 10n ** 9n, fundingGraceNs: 6n * 3600n * 10n ** 9n }),
    getTimeMs: async () => clock,
  };
  const net = { name: 'dev', contractId: CONTRACT_ID, usdcAssetId: '', tokenAccountId: '', oneClickKey: '', arbiterNoteKey: '', rpcUrls: [], apiBase: base, cliNetwork: 'sandbox' } as unknown as Net;
  return { net, api: httpApi(base), chain: chainReader, store: memoryStore(), now: () => clock };
}

const notify = () => (app as unknown as { notify: Notify }).notify;
const sign = (l: LocalDeal, op: 'start' | 'stop' | 'status', lang = 'en') => signNotify(CONTRACT_ID, l, op, lang, clock);
const say = (chat: string, text: string) =>
  notify().handleUpdate({ update_id: 1, message: { message_id: 1, chat: { id: Number(chat), type: 'private' }, text } });

test('both parties subscribe from the key step (the client before joining) and hear only "news"', async () => {
  const api = httpNotify(base);
  expect(await api.bot()).toBe('PinkyTestBot');
  const creatorB = browser();
  const clientB = browser();
  const made = await createDeal(creatorB, {
    title: 'Secret title',
    work: 'w',
    gets: '',
    revisions: 1,
    price: '5',
    deliverySeconds: 14 * 86400,
    reviewSeconds: 3 * 86400,
    linkSeconds: 86400,
  });
  const creatorLocal = creatorB.store.get(made.handle)!;
  const c = await api.start(made.handle, made.token, sign(creatorLocal, 'start'));
  // The deep link carries only the code: no key, no token, no handle.
  const link = botLink(c.bot, c.code);
  expect(link).toBe(`https://t.me/PinkyTestBot?start=${c.code}`);
  expect(link).not.toContain(creatorLocal.seed);
  expect(link).not.toContain(made.token);
  expect(link).not.toContain(made.handle);
  await say('1', `/start ${c.code}`);
  expect((await api.status(made.handle, made.token, sign(creatorLocal, 'status'))).subscribed).toBe(true);

  // The client: key made on the key step, subscribed, then joins.
  const visitor = await loadDeal(clientB, made.token);
  const prepared = prepareClientKey(clientB, visitor);
  const clientLocal = clientB.store.get(made.handle)!;
  const k = await api.start(made.handle, made.token, sign(clientLocal, 'start', 'uk'));
  await say('2', `/start ${k.code}`);
  const joined = await joinDeal(clientB, markKeySaved(clientB, prepared));
  chain.fund(joined.deal!.id, '5000000');
  await notify().tick();
  const toCreator = sent.filter((m) => m.chat === '1').at(-1)!.text;
  const toClient = sent.filter((m) => m.chat === '2').at(-1)!.text;
  expect(toCreator).toMatch(/payment arrived/);
  expect(toClient).toMatch(/Оплата прийшла/);
  for (const m of sent) {
    expect(m.text).not.toMatch(/Secret title|https?:|\/k#|USDC|\d+\.\d+/);
  }

  // Stop with the key.
  expect((await api.stop(made.handle, made.token, sign(creatorLocal, 'stop'))).removed).toBe(1);
  expect((await api.status(made.handle, made.token, sign(creatorLocal, 'status'))).subscribed).toBe(false);
});

test('another key cannot subscribe as the creator; no bot = no button', async () => {
  const api = httpNotify(base);
  const creatorB = browser();
  const made = await createDeal(creatorB, { title: 't', work: 'w', gets: '', revisions: 0, price: '5', deliverySeconds: 86400 * 3, reviewSeconds: 86400 * 3, linkSeconds: 86400 });
  const fake: LocalDeal = { ...creatorB.store.get(made.handle)!, seed: 'ab'.repeat(32) };
  await expect(api.start(made.handle, made.token, sign(fake, 'start'))).rejects.toMatchObject({ status: 403, code: 'wrong_key' });
  await expect(api.start(made.handle, 'f'.repeat(32), sign(creatorB.store.get(made.handle)!, 'start'))).rejects.toBeInstanceOf(NotifyError);

  await app.close();
  await start(false);
  expect(await httpNotify(base).bot()).toBeNull();
});
