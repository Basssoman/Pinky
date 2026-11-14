// Marketplace fixes before the freeze, web side, against the REAL server code
// (in-process, fake chain): one live deal per request (the client's browser
// opens the older deals' links to show how they start), brief lines written
// by the AI helper (marked by the client's browser, shown to the creator),
// and which portfolio links open (same host list as the server).
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.ts';
import { isKnownLink as serverIsKnownLink, KNOWN_LINK_HOSTS as SERVER_HOSTS } from '../../server/src/market.ts';
import { SqliteStore } from '../../server/src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, testConfig } from '../../server/test/helpers.ts';
import { ApiError, httpApi } from '../src/lib/api';
import type { ChainReader } from '../src/lib/chain';
import type { Net } from '../src/lib/config';
import { createDeal, type Ctx } from '../src/lib/flows';
import { keyFromSeed, sha256Hex } from '../src/lib/keys';
import { memoryStore, newToken } from '../src/lib/local';
import {
  aiLinesOf,
  dealTokenFrom,
  isKnownLink,
  KNOWN_LINK_HOSTS,
  linkDomain,
  profileIdOfKey,
  requestBoxPub,
  signInbox,
  signProfileWrite,
  type ProfileFields,
} from '../src/lib/market';
import { httpMarketApi } from '../src/lib/marketApi';

let chain: FakeChain;
let store: SqliteStore;
let app: Awaited<ReturnType<typeof buildApp>>;
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

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  store = new SqliteStore(':memory:');
  const config = testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000, rateQuotesPerMin: 1000 });
  app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store, now: () => clock });
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
const PROFILE: ProfileFields = {
  nickname: 'mila_motion',
  bio: 'Motion for launches.',
  categories: ['motion'],
  portfolio: ['https://www.behance.net/mila', 'https://mila-motion.example.com/reel'],
  contacts: [{ kind: 'telegram', value: '@mila' }],
  services: [{ title: 'Logo reveal', description: 'One logo.', price_from_usdc: 120, delivery_days: 5 }],
};
const INPUT = { title: 'Logo reveal', work: 'A 6 s logo animation', gets: 'MP4', revisions: 2, price: '5', deliverySeconds: 14 * 86400, reviewSeconds: 3 * 86400, linkSeconds: 86400 };

async function profileAndRequest(brief = 'Logo for a launch post.', ai_lines?: number[]) {
  const api = httpMarketApi(base);
  const id = profileIdOfKey(profileKey);
  await api.putProfile(id, { profile_pk: profileKey.pk, profile: PROFILE, ...signProfileWrite(CONTRACT_ID, profileKey, PROFILE, clock) });
  const token = newToken();
  const handle = sha256Hex(token);
  await api.createRequest({
    handle,
    profile_id: id,
    brief,
    client_contact: { kind: 'telegram', value: '@client' },
    client_box_pk: requestBoxPub(token),
    ...(ai_lines ? { ai_lines } : {}),
  });
  const inbox = () => api.inbox(id, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) });
  return { api, id, token, handle, inbox };
}

describe('one live deal per request', () => {
  test('the second deal waits until the first link is cancelled; the client sees the older one and how its link starts', async () => {
    const { api, token, handle, inbox } = await profileAndRequest();
    const box = (await inbox()).items[0].client_box_pk ?? null;
    const first = await createDeal(browser(), { ...INPUT, fromRequest: { handle, profileKey, clientBoxPk: box } });

    // A second deal while the first link can still be paid: refused by the server.
    const refused = await createDeal(browser(), { ...INPUT, fromRequest: { handle, profileKey, clientBoxPk: box } }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).code).toBe('deal_live');

    // The creator cancels the first link (stands in for the on-chain revoke): the next deal goes through.
    store.markRevoked(first.handle);
    expect((await inbox()).items[0].status).toBe('discussing');
    const second = await createDeal(browser(), { ...INPUT, title: 'Logo reveal v2', fromRequest: { handle, profileKey, clientBoxPk: box } });

    const v = await api.request(handle, token);
    expect(v.status).toBe('deal_ready');
    expect(await dealTokenFrom(token, handle, v)).toBe(second.token);
    // The older deal: listed with its title and amount; the client's browser opens its link to show how it starts.
    expect(v.old_deals).toHaveLength(1);
    const old = v.old_deals![0];
    expect(old.title).toBe('Logo reveal');
    expect(old.amount_usdc).toBe('5');
    expect(old.made_on).toBe(new Date(clock).toISOString().slice(0, 10));
    expect(await dealTokenFrom(token, handle, { deal_link_box: old.deal_link_box })).toBe(first.token);
    // Another request's key cannot open it.
    expect(await dealTokenFrom(newToken(), handle, { deal_link_box: old.deal_link_box })).toBeNull();
  });
});

describe('brief lines written by the AI helper', () => {
  test('the lines the client kept word for word are marked; changed lines are the client’s', () => {
    const answer = '- 10 s logo animation\n- 4k MP4\n- Music: none';
    const brief = 'For our launch post\n- 10 s logo animation\n- 4k MP4, and a square copy\n- Music: none';
    expect(aiLinesOf(brief, answer)).toEqual([1, 3]);
    // No answer used (or "bring my text back"): nothing marked.
    expect(aiLinesOf(brief, null)).toEqual([]);
    // Line numbers count in the trimmed brief, like the server's; blank lines are never marked.
    expect(aiLinesOf('\n\n- 4k MP4\n\n', answer)).toEqual([0]);
    // A line the AI wrote once marks one line only, even if the client pastes it twice.
    expect(aiLinesOf('- 4k MP4\n- 4k MP4', answer)).toEqual([0]);
    // Spaces around a line do not make it the client's.
    expect(aiLinesOf('   - 4k MP4   ', answer)).toEqual([0]);
  });

  test('sent with the request, the creator’s inbox gets them; the client’s page does not', async () => {
    const answer = '- 10 s logo animation\n- 4k MP4';
    const brief = 'Hi!\n- 10 s logo animation\n- 4k MP4';
    const { api, token, handle, inbox } = await profileAndRequest(brief, aiLinesOf(brief, answer));
    const item = (await inbox()).items.find((i) => i.handle === handle)!;
    expect(item.ai_lines).toEqual([1, 2]);
    expect(item.brief.split('\n').filter((_, i) => item.ai_lines!.includes(i))).toEqual(['- 10 s logo animation', '- 4k MP4']);
    expect((await api.request(handle, token)) as unknown as Record<string, unknown>).not.toHaveProperty('ai_lines');
  });
});

describe('portfolio links that open', () => {
  test('same host list and same answers as the server', () => {
    expect([...KNOWN_LINK_HOSTS]).toEqual([...SERVER_HOSTS]);
    for (const l of [
      'https://www.youtube.com/@mila',
      'https://youtu.be/x',
      'https://www.behance.net/mila',
      'https://x.com/mila',
      'https://drive.google.com/file/d/1',
      'https://mila.example.com',
      'https://www.youtube.com.example.org/',
      'https://www.youtube.com:444/',
      'http://youtube.com/',
      'https://docs.google.com/forms/d/1',
    ]) {
      expect(isKnownLink(l), l).toBe(serverIsKnownLink(l));
    }
  });

  test('the public profile marks which links open', async () => {
    const { api, id } = await profileAndRequest();
    const p = await api.profile(id);
    expect(p.portfolio_known).toEqual([true, false]);
  });

  test('the domain shown for links that do not open', () => {
    expect(linkDomain('https://www.mila-motion.example.com/reel?x=1')).toBe('mila-motion.example.com');
    expect(linkDomain('http://t.me/mila')).toBe('t.me');
    expect(linkDomain('@mila')).toBeNull();
    expect(linkDomain('mila@example.com')).toBeNull();
  });
});
