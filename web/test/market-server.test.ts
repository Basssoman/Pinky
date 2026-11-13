// The marketplace web code against the REAL server code (in-process, fake
// chain): every signed message the web builds is checked by the server's own
// routes (server/src/market.ts). This is the end-to-end path the dev instance
// cannot run (it sends no transactions): profile → request → inbox → deal from
// request → the client opens the deal link from the box → join → finished →
// review, edit, stale edit, refunded label.
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.ts';
import { avatarMessage as serverAvatarMessage, reviewMessage as serverReviewMessage, reviewReplyMessage as serverReplyMessage } from '../../server/src/market.ts';
import { SqliteStore } from '../../server/src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, testConfig } from '../../server/test/helpers.ts';
import { ApiError, httpApi } from '../src/lib/api';
import type { ChainReader } from '../src/lib/chain';
import type { Net } from '../src/lib/config';
import { createDeal, joinDeal, loadDeal, markKeySaved, prepareClientKey, refreshDeal, type Ctx } from '../src/lib/flows';
import { keyFromSeed, sha256Hex } from '../src/lib/keys';
import { memoryStore, newToken } from '../src/lib/local';
import {
  dealTokenFrom,
  profileIdOf,
  requestBoxPub,
  reviewable,
  reviewMessage,
  reviewReplyMessage,
  signInbox,
  signProfileWrite,
  signReply,
  signReview,
  type ProfileFields,
} from '../src/lib/market';
import { httpMarketApi, type MarketApi } from '../src/lib/marketApi';
import { avatarMessage, bytesToBase64, centerSquare, signAvatar } from '../src/lib/marketAvatar';

let chain: FakeChain;
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
const marketApi = (): MarketApi => httpMarketApi(base);

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  const config = testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000, rateQuotesPerMin: 1000 });
  app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock });
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

const profileKey = { ...keyFromSeed('31'.repeat(32)), saved: true, createdAt: 0 };
const PROFILE: ProfileFields = {
  nickname: 'mila_motion',
  bio: 'Motion for launches.',
  categories: ['motion', 'video'],
  portfolio: ['https://behance.net/mila'],
  contacts: [{ kind: 'telegram', value: '@mila' }],
  services: [{ title: 'Logo reveal', description: 'One logo, two rounds.', price_from_usdc: 120, delivery_days: 5 }],
};
const INPUT = { title: 'Logo reveal', work: 'A 6 s logo animation', gets: 'MP4', revisions: 2, price: '5', deliverySeconds: 14 * 86400, reviewSeconds: 3 * 86400, linkSeconds: 86400 };

/** Creator profile → client request → creator makes the deal from it → client opens it from the box and joins. */
async function dealFromRequest() {
  const api = marketApi();
  const id = profileIdOf(profileKey.pk);
  await api.putProfile(id, { profile_pk: profileKey.pk, profile: PROFILE, ...signProfileWrite(CONTRACT_ID, profileKey, PROFILE, clock) });
  const profile = await api.profile(id);
  const service = profile.services[0];

  const requestToken = newToken();
  const handle = sha256Hex(requestToken);
  await api.createRequest({
    handle,
    profile_id: id,
    service_id: service.id,
    brief: 'Logo for a launch post.',
    client_contact: { kind: 'telegram', value: '@client' },
    client_box_pk: requestBoxPub(requestToken),
  });

  const inbox = await api.inbox(id, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) });
  const item = inbox.items.find((r) => r.handle === handle)!;
  expect(item.client_contact.value).toBe('@client');
  expect(item.client_box_pk).toBe(requestBoxPub(requestToken));

  const made = await createDeal(browser(), { ...INPUT, fromRequest: { handle, profileKey, clientBoxPk: item.client_box_pk ?? null } });
  const view = await api.request(handle, requestToken);
  expect(view.status).toBe('deal_ready');
  const dealToken = await dealTokenFrom(requestToken, handle, view);
  expect(dealToken).toBe(made.token);

  const clientCtx = browser();
  let client = await loadDeal(clientCtx, dealToken!);
  client = await joinDeal(clientCtx, markKeySaved(clientCtx, prepareClientKey(clientCtx, client)));
  return { api, id, clientCtx, client, dealToken: dealToken! };
}

describe('review against the server (its own signature check)', () => {
  test('the web and the server build the same review message', () => {
    expect(reviewMessage(CONTRACT_ID, 7, 'ab'.repeat(12), 4, 'Fast, clear.', '123')).toBe(
      serverReviewMessage(CONTRACT_ID, 7, 'ab'.repeat(12), 4, 'Fast, clear.', '123'),
    );
  });

  test('a finished deal from a request: post, edit, stale edit refused, shown on the profile without amounts', async () => {
    const { api, id, clientCtx, dealToken } = await dealFromRequest();
    let client = await loadDeal(clientCtx, dealToken);
    const dealId = client.dealId!;

    // not finished yet: no block, and the server says so too
    expect(reviewable(client)).toBe(false);
    expect((await api.reviewLink(client.handle, dealToken)).can_review).toBe(false);

    chain.fund(dealId, client.deal!.amount);
    Object.assign(chain.deals[dealId], { state: 'Released', outcome: 'Accepted', creator_payout: '4850000', fee_amount: '150000' });
    client = await refreshDeal(clientCtx, client);
    expect(reviewable(client)).toBe(true);
    // the server's GET may still say "not yet" (it re-reads the chain now and then): the web relies on its own read
    const link = await api.reviewLink(client.handle, dealToken);
    expect(link).toMatchObject({ linked: true, profile_id: id, nickname: 'mila_motion', review: null });

    // first review; the web trims the text and signs it as sent
    const first = signReview(CONTRACT_ID, client.key!, dealId, id, 5, '  Fast and clear.  ', clock);
    expect(first.text).toBe('Fast and clear.');
    await api.postReview(client.handle, dealToken, first);

    // an edit: a later expiry
    clock += 1000;
    await api.postReview(client.handle, dealToken, signReview(CONTRACT_ID, client.key!, dealId, id, 4, 'Good, one extra round.', clock));

    // an older signature cannot undo the edit
    const stale = signReview(CONTRACT_ID, client.key!, dealId, id, 1, 'old', clock - 10_000);
    await expect(api.postReview(client.handle, dealToken, stale)).rejects.toMatchObject({ status: 409, code: 'stale_review' });

    // a signature by another key is refused
    const other = signReview(CONTRACT_ID, keyFromSeed('99'.repeat(32)), dealId, id, 5, 'fake', clock + 5000);
    await expect(api.postReview(client.handle, dealToken, other)).rejects.toBeInstanceOf(ApiError);

    clock += 10 * 60_000;
    expect((await api.reviewLink(client.handle, dealToken)).can_review).toBe(true);
    const p = await api.profile(id);
    expect(p.reviews).toHaveLength(1);
    expect(p.reviews[0]).toMatchObject({ rating: 4, text: 'Good, one extra round.', refunded: false });
    expect(Object.keys(p.reviews[0]).sort()).toEqual(['month', 'outcome', 'rating', 'refunded', 'reply', 'review_id', 'text']);
    expect(p.reviews[0].outcome).toBe('paid');
    expect((await api.reviewLink(client.handle, dealToken)).review).toMatchObject({ rating: 4 });
  });

  test('a refunded deal: the review is labelled refunded', async () => {
    const { api, id, clientCtx, dealToken } = await dealFromRequest();
    let client = await loadDeal(clientCtx, dealToken);
    const dealId = client.dealId!;
    chain.fund(dealId, client.deal!.amount);
    Object.assign(chain.deals[dealId], { state: 'Refunded', outcome: 'RefundedByCreator', client_payout: client.deal!.amount, creator_payout: '0' });
    client = await refreshDeal(clientCtx, client);
    expect(reviewable(client)).toBe(true);
    await api.postReview(client.handle, dealToken, signReview(CONTRACT_ID, client.key!, dealId, id, 2, 'Did not deliver.', clock));
    const p = await api.profile(id);
    expect(p.reviews[0]).toMatchObject({ rating: 2, refunded: true, outcome: 'refunded' });
  });

  test('dispute label, the creator answers once (signed by the profile key), the review locks after 3 days', async () => {
    const { api, id, clientCtx, dealToken } = await dealFromRequest();
    let client = await loadDeal(clientCtx, dealToken);
    const dealId = client.dealId!;
    chain.fund(dealId, client.deal!.amount);
    Object.assign(chain.deals[dealId], {
      state: 'Released',
      outcome: { ArbiterSplit: { creator_share_bps: 5000 } },
      disputed_at_ns: chain.nowNs().toString(),
      ended_at_ns: chain.nowNs().toString(),
      creator_payout: '2425000',
      client_payout: '2500000',
    });
    client = await refreshDeal(clientCtx, client);
    const link = await api.reviewLink(client.handle, dealToken);
    expect(link).toMatchObject({ can_review: true, locked: false, outcome: 'dispute' });
    expect(Date.parse(link.review_until!)).toBe(clock + 3 * 86400_000);
    await api.postReview(client.handle, dealToken, signReview(CONTRACT_ID, client.key!, dealId, id, 3, 'Half done.', clock));

    // the creator's answer, built by the web, checked by the server
    const rid = (await api.profile(id)).reviews[0].review_id!;
    expect(serverReplyMessage(CONTRACT_ID, id, rid, 'Fair.', '9')).toBe(reviewReplyMessage(CONTRACT_ID, id, rid, 'Fair.', '9'));
    // another key cannot answer for this profile
    const stranger = { ...keyFromSeed('77'.repeat(32)), saved: true, createdAt: 0 };
    await expect(api.replyReview(id, rid, { ...signReply(CONTRACT_ID, stranger, rid, 'x', clock), profile_pk: profileKey.pk })).rejects.toMatchObject({
      status: 401,
    });
    const res = await api.replyReview(id, rid, signReply(CONTRACT_ID, profileKey, rid, '  We agreed on half.  ', clock));
    expect(res.review?.reply?.text).toBe('We agreed on half.');
    await expect(api.replyReview(id, rid, signReply(CONTRACT_ID, profileKey, rid, 'Second try', clock + 1))).rejects.toMatchObject({
      status: 409,
      code: 'already_replied',
    });
    const p = await api.profile(id);
    expect(p.reviews[0]).toMatchObject({ outcome: 'dispute', refunded: false, reply: { text: 'We agreed on half.' } });
    expect(p.since_month).toBe(new Date(clock).toISOString().slice(0, 7));

    // 3 days after the end: locked
    clock += 3 * 86400_000;
    expect(await api.reviewLink(client.handle, dealToken)).toMatchObject({ can_review: false, locked: true });
    await expect(api.postReview(client.handle, dealToken, signReview(CONTRACT_ID, client.key!, dealId, id, 5, 'Changed', clock))).rejects.toMatchObject({
      status: 409,
      code: 'review_locked',
    });
  });
});

describe('AI brief helper against the server', () => {
  test('hidden without a NEAR AI key on the server', async () => {
    expect(await marketApi().briefStatus()).toMatchObject({ enabled: false });
    await expect(marketApi().brief({ request: 'Logo animation' })).rejects.toMatchObject({ status: 404, code: 'brief_off' });
  });

  test('with a key: the checklist comes back; no signature from NEAR AI = no "checked" mark', async () => {
    await app.close();
    const sent: string[] = [];
    const fakeAi: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/chat/completions')) {
        sent.push(String(init?.body));
        return new Response(JSON.stringify({ id: 'c1', choices: [{ message: { content: '1. Logo animation, 8 s\n2. MP4 and MOV\n3. Two rounds of changes' } }] }));
      }
      return new Response('{}', { status: 404 });
    };
    const config = testConfig({ nearAiApiKey: 'k', nearAiBaseUrl: 'https://ai.test/v1', rateReadsPerMin: 1000, rateWritesPerMin: 1000 });
    app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock, briefFetch: fakeAi });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const api = marketApi();
    expect(await api.briefStatus()).toMatchObject({ enabled: true });
    const r = await api.brief({ request: 'Логотип для запуску, 8 секунд', service_title: 'Logo reveal', lang: 'uk' });
    expect(r.checklist).toBe('- Logo animation, 8 s\n- MP4 and MOV\n- Two rounds of changes');
    expect(r.verified).toBe(false);
    expect(JSON.parse(sent[0]).messages[1].content).toContain('Логотип для запуску, 8 секунд');
    await expect(api.brief({ request: 'x'.repeat(601) })).rejects.toMatchObject({ status: 400 });
  });
});

describe('profile picture against the server', () => {
  // A 40 x 30 PNG (with a pHYs chunk) made once with sharp.
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAPUlEQVRIie3VQQ0AMAwCwJlDFWaRMhnb45L+mzSUO0ufzLE4Tj3hqneKApnKLCSCxWIxWBwWi8VgcV+xeAFD+J5qxva30gAAAABJRU5ErkJggg==';
  const png = () => Uint8Array.from(atob(PNG_B64), (c) => c.charCodeAt(0));

  test('the web and the server build the same picture message', () => {
    expect(avatarMessage(CONTRACT_ID, 'ab'.repeat(12), 'remove', '9')).toBe(serverAvatarMessage(CONTRACT_ID, 'ab'.repeat(12), 'remove', '9'));
  });

  test('upload signed in the web → re-encoded WebP served from our API; shown on the card; removed again', async () => {
    const api = marketApi();
    const id = profileIdOf(profileKey.pk);
    await api.putProfile(id, { profile_pk: profileKey.pk, profile: PROFILE, ...signProfileWrite(CONTRACT_ID, profileKey, PROFILE, clock) });
    const bytes = png();
    expect(bytesToBase64(bytes)).toBe(PNG_B64);
    const r = await api.putAvatar(id, { profile_pk: profileKey.pk, image: bytesToBase64(bytes), ...signAvatar(CONTRACT_ID, profileKey, bytes, clock) });
    expect(r.avatar).toMatch(/^[0-9a-f]{16}$/);
    expect((await api.profile(id)).avatar).toBe(r.avatar);
    expect((await api.profiles({})).items.find((c) => c.profile_id === id)?.avatar).toBe(r.avatar);

    const url = api.avatarUrl(id, r.avatar);
    expect(url.startsWith(base)).toBe(true);
    const img = await fetch(url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/webp');
    expect(img.headers.get('x-content-type-options')).toBe('nosniff');
    const out = new Uint8Array(await img.arrayBuffer());
    expect(String.fromCharCode(...out.subarray(8, 12))).toBe('WEBP');
    expect(new TextDecoder('latin1').decode(out)).not.toContain('pHYs');

    // Signed by another key: refused.
    const other = { ...keyFromSeed('32'.repeat(32)), saved: true, createdAt: 0 };
    await expect(
      api.putAvatar(id, { profile_pk: profileKey.pk, image: PNG_B64, ...signAvatar(CONTRACT_ID, other, bytes, clock) }),
    ).rejects.toMatchObject({ status: 401 });

    await api.removeAvatar(id, { profile_pk: profileKey.pk, ...signAvatar(CONTRACT_ID, profileKey, 'remove', clock) });
    expect((await api.profile(id)).avatar).toBeNull();
    expect((await fetch(url)).status).toBe(404);
  });

  test('the middle square of a wide or tall picture', () => {
    expect(centerSquare(900, 300)).toEqual([300, 0, 300]);
    expect(centerSquare(300, 901)).toEqual([0, 300, 300]);
    expect(centerSquare(256, 256)).toEqual([0, 0, 256]);
  });
});
