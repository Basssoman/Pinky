// Verified accounts, the public key-change log, a reset proved through a
// confirmed account, and the review window of a deal that ended by itself
// (starts at the client's first open), web side,
// against the REAL server code (in-process, fake chain, fake page reader).
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { judgePage, type AccountChecker, type CheckJob, type CheckResult } from '../../server/src/accounts.ts';
import { buildApp } from '../../server/src/app.ts';
import {
  accountAddMessage as sAdd,
  accountCheckMessage as sCheck,
  accountRemoveMessage as sRemove,
  accountsReadMessage as sRead,
  reviewOpenMessage as sOpen,
  VERIFIED_PROOF_MIN_AGE_MS,
  type Market,
} from '../../server/src/market.ts';
import { run as resetCli } from '../../server/scripts/market-key-reset.ts';
import { SqliteStore } from '../../server/src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, testConfig } from '../../server/test/helpers.ts';
import { ApiError, httpApi } from '../src/lib/api';
import type { ChainReader } from '../src/lib/chain';
import type { Net } from '../src/lib/config';
import { createDeal, joinDeal, loadDeal, markKeySaved, prepareClientKey, type Ctx } from '../src/lib/flows';
import { keyFromSeed, sha256Hex } from '../src/lib/keys';
import { memoryStore, newToken } from '../src/lib/local';
import {
  accountAddMessage,
  accountCheckMessage,
  accountRemoveMessage,
  accountsReadMessage,
  dealTokenFrom,
  profileIdOfKey,
  requestBoxPub,
  reviewOpenMessage,
  signAccountAdd,
  signAccountCheck,
  signAccountRemove,
  signAccountsRead,
  signInbox,
  signKeyResetCancel,
  signProfileWrite,
  signReviewOpen,
  type ProfileFields,
} from '../src/lib/market';
import { httpMarketApi, type MarketApi } from '../src/lib/marketApi';

const DAY = 86_400_000;

class FakeChecker implements AccountChecker {
  pages = new Map<string, string>();
  async check(job: CheckJob): Promise<CheckResult> {
    if (job.platform === 'x') return 'manual';
    const page = this.pages.get(job.url);
    return page === undefined ? 'unreadable' : judgePage(page, job, job.codes);
  }
}

let chain: FakeChain;
let app: Awaited<ReturnType<typeof buildApp>>;
let checker: FakeChecker;
let base = '';
let clock = Date.now();
let net: Net;

function chainReader(): ChainReader {
  return {
    getDeal: (id) => chain.getDeal(id) as ReturnType<ChainReader['getDeal']>,
    getDealIdByOffer: (offer) => chain.getDealIdByOffer(offer),
    isOfferRevoked: async (offer) => chain.revokedOffers.has(offer),
    getPeriods: async () => ({ disputePeriodNs: 7n * 86400n * 10n ** 9n, payByPeriodNs: 7n * 86400n * 10n ** 9n, fundingGraceNs: 6n * 3600n * 10n ** 9n }),
    getTimeMs: async () => clock,
  };
}
const browser = (): Ctx => ({ net, api: httpApi(base), chain: chainReader(), store: memoryStore(), now: () => clock });
const marketApi = (): MarketApi => httpMarketApi(base);
const market = () => (app as unknown as { market: Market }).market;

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  checker = new FakeChecker();
  const config = testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000, rateQuotesPerMin: 1000 });
  app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock, accountChecker: checker });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  net = {
    name: 'dev',
    contractId: CONTRACT_ID,
    usdcAssetId: config.usdcAssetId,
    tokenAccountId: config.tokenAccountId,
    oneClickKey: '',
    arbiterNoteKey: '',
    rpcUrls: [],
    apiBase: base,
    cliNetwork: 'sandbox',
  };
});
afterEach(async () => {
  await app.close();
});

const profileKey = { ...keyFromSeed('51'.repeat(32)), saved: true, createdAt: 0 };
const newKey = { ...keyFromSeed('52'.repeat(32)), saved: true, createdAt: 0 };
const PROFILE: ProfileFields = {
  nickname: 'mila_motion',
  bio: 'Motion for launches.',
  categories: ['motion'],
  portfolio: [],
  contacts: [{ kind: 'telegram', value: '@mila' }],
  services: [{ title: 'Logo reveal', description: 'One logo.', price_from_usdc: 120, delivery_days: 5 }],
};
const INPUT = { title: 'Logo reveal', work: 'A 6 s logo animation', gets: 'MP4', revisions: 2, price: '5', deliverySeconds: 14 * 86400, reviewSeconds: 3 * 86400, linkSeconds: 86400 };
const page = (code: string) => `<html><head><link rel="canonical" href="https://www.youtube.com/@milamotion"><meta property="og:description" content="Motion. ${code}"></head></html>`;

async function profile() {
  const api = marketApi();
  const id = profileIdOfKey(profileKey);
  await api.putProfile(id, { profile_pk: profileKey.pk, profile: PROFILE, ...signProfileWrite(CONTRACT_ID, profileKey, PROFILE, clock) });
  return { api, id };
}

describe('verified accounts through the web client', () => {
  test('the web builds the same signed messages as the server', () => {
    const url = 'https://www.youtube.com/@milamotion';
    expect(accountAddMessage(CONTRACT_ID, 'ab'.repeat(12), url, '1')).toBe(sAdd(CONTRACT_ID, 'ab'.repeat(12), url, '1'));
    expect(accountsReadMessage(CONTRACT_ID, 'ab'.repeat(12), '1')).toBe(sRead(CONTRACT_ID, 'ab'.repeat(12), '1'));
    expect(accountCheckMessage(CONTRACT_ID, 'ab'.repeat(12), 'cd'.repeat(8), '1')).toBe(sCheck(CONTRACT_ID, 'ab'.repeat(12), 'cd'.repeat(8), '1'));
    expect(accountRemoveMessage(CONTRACT_ID, 'ab'.repeat(12), 'cd'.repeat(8), '1')).toBe(sRemove(CONTRACT_ID, 'ab'.repeat(12), 'cd'.repeat(8), '1'));
    expect(reviewOpenMessage(CONTRACT_ID, 7, '1')).toBe(sOpen(CONTRACT_ID, 7, '1'));
  });

  test('add -> code -> check -> "account confirmed" on the public profile -> remove', async () => {
    const { api, id } = await profile();
    const added = await api.addAccount(id, { profile_pk: profileKey.pk, ...signAccountAdd(CONTRACT_ID, profileKey, 'https://youtube.com/@MilaMotion', clock) });
    const a = added.account;
    expect(a).toMatchObject({ platform: 'youtube', handle: '@milamotion', status: 'waiting', by_hand: false });
    const listed = await api.accounts(id, { profile_pk: profileKey.pk, ...signAccountsRead(CONTRACT_ID, profileKey, clock) });
    expect(listed.items.map((x) => x.code)).toEqual([a.code]);
    checker.pages.set(a.url, page(a.code));
    const checked = await api.checkAccount(id, a.account_id, { profile_pk: profileKey.pk, ...signAccountCheck(CONTRACT_ID, profileKey, a.account_id, clock) });
    expect(checked.result).toBe('found');
    const pub = await api.profile(id);
    expect(pub.accounts).toEqual([{ platform: 'youtube', handle: '@milamotion', url: 'https://www.youtube.com/@milamotion' }]);
    expect(JSON.stringify(pub)).not.toContain(a.code);
    await api.removeAccount(id, a.account_id, { profile_pk: profileKey.pk, ...signAccountRemove(CONTRACT_ID, profileKey, a.account_id, clock) });
    expect((await api.profile(id)).accounts).toEqual([]);
    await expect(api.addAccount(id, { profile_pk: profileKey.pk, ...signAccountAdd(CONTRACT_ID, profileKey, 'https://vimeo.com/mila', clock) })).rejects.toMatchObject({
      code: 'bad_account',
    });
  });

  test('X waits for a person of the team (by hand)', async () => {
    const { api, id } = await profile();
    const a = (await api.addAccount(id, { profile_pk: profileKey.pk, ...signAccountAdd(CONTRACT_ID, profileKey, 'https://x.com/mila', clock) })).account;
    expect(a.by_hand).toBe(true);
    const r = await api.checkAccount(id, a.account_id, { profile_pk: profileKey.pk, ...signAccountCheck(CONTRACT_ID, profileKey, a.account_id, clock) });
    expect(r.result).toBe('manual');
    expect(r.account.status).toBe('review');
  });
});

describe('key changes by support', () => {
  test('public log; a reset proved through an old confirmed account cannot be cancelled by the current key', async () => {
    const { api, id } = await profile();
    const a = (await api.addAccount(id, { profile_pk: profileKey.pk, ...signAccountAdd(CONTRACT_ID, profileKey, 'https://www.youtube.com/@milamotion', clock) })).account;
    checker.pages.set(a.url, page(a.code));
    await api.checkAccount(id, a.account_id, { profile_pk: profileKey.pk, ...signAccountCheck(CONTRACT_ID, profileKey, a.account_id, clock) });
    clock += VERIFIED_PROOF_MIN_AGE_MS + DAY;
    const quiet = () => {};
    const ms = market().store;
    expect(resetCli(ms, ['issue', id, newKey.pk, a.url], quiet)).toBe(0);
    const reset = ms.openReset(id)!;
    expect(resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], quiet)).toBe(0);
    const log = await api.keyResets();
    expect(log.items).toEqual([expect.objectContaining({ profile_id: id, nickname: 'mila_motion', status: 'pending' })]);
    expect(JSON.stringify(log)).not.toContain(reset.code);
    const inbox = await api.inbox(id, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) });
    expect(inbox.key_change).toMatchObject({ reset_id: reset.reset_id, cancellable: false });
    await expect(
      api.cancelKeyReset(id, { profile_pk: profileKey.pk, reset_id: reset.reset_id, ...signKeyResetCancel(CONTRACT_ID, profileKey, reset.reset_id, clock) }),
    ).rejects.toMatchObject({ status: 403, code: 'verified_proof' });
  });
});

describe('the review window of a deal that ended by itself starts at the first open', () => {
  test('auto-release: the browser signs "opened" with the client key; the 3 days start then', async () => {
    const { api, id } = await profile();
    const requestToken = newToken();
    const handle = sha256Hex(requestToken);
    await api.createRequest({ handle, profile_id: id, brief: 'Logo.', client_contact: { kind: 'telegram', value: '@c' }, client_box_pk: requestBoxPub(requestToken) });
    const inbox = await api.inbox(id, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) });
    const item = inbox.items.find((r) => r.handle === handle)!;
    await createDeal(browser(), { ...INPUT, fromRequest: { handle, profileKey, clientBoxPk: item.client_box_pk ?? null } });
    const dealToken = (await dealTokenFrom(requestToken, handle, await api.request(handle, requestToken)))!;
    const clientCtx = browser();
    let client = await loadDeal(clientCtx, dealToken);
    client = await joinDeal(clientCtx, markKeySaved(clientCtx, prepareClientKey(clientCtx, client)));
    const dealId = client.dealId!;
    chain.fund(dealId, chain.deals[dealId].amount);
    Object.assign(chain.deals[dealId], {
      state: 'PaidOut',
      outcome: 'AutoReleased',
      creator_withdrawn: '4850000',
      ended_at_ns: (BigInt(clock) * 1_000_000n).toString(),
      settled: true,
    });
    expect((await api.reviewLink(client.handle, dealToken)).starts_on_open).toBe(true);
    clock += 12 * DAY;
    // A key that is not the client's is refused.
    await expect(api.openReview(client.handle, dealToken, signReviewOpen(CONTRACT_ID, keyFromSeed('77'.repeat(32)), dealId, clock))).rejects.toBeInstanceOf(ApiError);
    const opened = await api.openReview(client.handle, dealToken, signReviewOpen(CONTRACT_ID, client.key!, dealId, clock));
    expect(opened.started).toBe(true);
    expect(Date.parse(opened.review_until!)).toBe(clock + 3 * DAY);
    const link = await api.reviewLink(client.handle, dealToken);
    expect(link).toMatchObject({ starts_on_open: false, can_review: true });
  });
});

describe('marketplace leftovers', () => {
  test('#58 (2) on the deal page: a deal from a checked request carries the profile id for the note', async () => {
    const { rememberCheckedCreator } = await import('../src/lib/market');
    const { dealInfo } = await import('../src/real/model');
    const storage = memoryStorage();
    // The record lives in this browser's storage (window.localStorage).
    const g = globalThis as { window?: unknown };
    const prev = g.window;
    g.window = { localStorage: storage };
    try {
      const { id } = await profile();
      const made = await createDeal(browser(), INPUT);
      const d = await loadDeal(browser(), made.token);
      rememberCheckedCreator(made.handle, { profileId: id, nickname: 'mila_motion', creatorPk: d.offer.creator_pk });
      expect(dealInfo({ ...d, role: 'client' }).creator).toEqual({ nick: 'mila_motion', profileUrl: `/creators/${id}`, profileId: id });
    } finally {
      g.window = prev;
    }
  });

  test('request statuses viewed / discussing / closed have their own badge colours', () => {
    const css = readFileSync(new URL('../src/market.css', import.meta.url), 'utf8');
    for (const s of ['open', 'viewed', 'discussing', 'closed', 'deal_ready']) expect(css).toMatch(new RegExp(`\.mk-status-${s} \{[^}]*color:`));
  });
});

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
