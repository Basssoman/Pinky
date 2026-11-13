// Marketplace checks, web side, against the REAL server code (in-process,
// fake chain): the client's browser pins the creator's profile key and checks
// "deal ready" and the nickname against it; request life
// (viewed, in talks, decline reason); key reset by support (
// the new key finds its older profile, the current key cancels).
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { buildApp } from '../../server/src/app.ts';
import {
  declineReasonMessage as serverDeclineReasonMessage,
  discussMessage as serverDiscussMessage,
  keyResetCancelMessage as serverKeyResetCancelMessage,
  type Market,
} from '../../server/src/market.ts';
import { run as resetCli } from '../../server/scripts/market-key-reset.ts';
import { SqliteStore } from '../../server/src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, testConfig } from '../../server/test/helpers.ts';
import { httpApi } from '../src/lib/api';
import type { ChainReader } from '../src/lib/chain';
import type { Net } from '../src/lib/config';
import { createDeal, loadDeal, type Ctx } from '../src/lib/flows';
import { keyFromSeed, sha256Hex } from '../src/lib/keys';
import { memoryStore, newToken } from '../src/lib/local';
import {
  checkedCreator,
  checkRequest,
  declineReasonMessage,
  discussMessage,
  keyFingerprint,
  keyResetCancelMessage,
  loadProfileKey,
  parseRequestLink,
  parseRequestPin,
  profileIdOf,
  profileIdOfKey,
  rememberCheckedCreator,
  requestBoxPub,
  requestLink,
  signDecline,
  signDiscuss,
  signInbox,
  signKeyResetCancel,
  signProfileWrite,
  storeProfileKey,
  type ProfileFields,
  type RequestView,
} from '../src/lib/market';
import { httpMarketApi, type MarketApi } from '../src/lib/marketApi';
import { dealInfo } from '../src/real/model';

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
const market = () => (app as unknown as { market: Market }).market;

/** A tiny in-memory Storage (for the pinned-creator record and the profile key). */
function memStorage(): Storage {
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

const profileKey = { ...keyFromSeed('41'.repeat(32)), saved: true, createdAt: 0 };
const otherKey = { ...keyFromSeed('42'.repeat(32)), saved: true, createdAt: 0 };
const PROFILE: ProfileFields = {
  nickname: 'mila_motion',
  bio: 'Motion for launches.',
  categories: ['motion'],
  portfolio: ['https://behance.net/mila'],
  contacts: [{ kind: 'telegram', value: '@mila' }],
  services: [{ title: 'Logo reveal', description: 'One logo.', price_from_usdc: 120, delivery_days: 5 }],
};
const INPUT = { title: 'Logo reveal', work: 'A 6 s logo animation', gets: 'MP4', revisions: 2, price: '5', deliverySeconds: 14 * 86400, reviewSeconds: 3 * 86400, linkSeconds: 86400 };

async function profileAndRequest(k = profileKey) {
  const api = marketApi();
  const id = profileIdOfKey(k);
  await api.putProfile(id, { profile_pk: k.pk, profile: PROFILE, ...signProfileWrite(CONTRACT_ID, k, PROFILE, clock) });
  const token = newToken();
  const handle = sha256Hex(token);
  const sent = await api.createRequest({
    handle,
    profile_id: id,
    brief: 'Logo for a launch post.',
    client_contact: { kind: 'telegram', value: '@client' },
    client_box_pk: requestBoxPub(token),
  });
  return { api, id, token, handle, pinned: sent.profile_pk! };
}

describe('the client checks "deal ready" against the pinned profile key', () => {
  test('the same messages as the server', () => {
    expect(declineReasonMessage(CONTRACT_ID, 'ab'.repeat(32), 'busy', '1')).toBe(serverDeclineReasonMessage(CONTRACT_ID, 'ab'.repeat(32), 'busy', '1'));
    expect(discussMessage(CONTRACT_ID, 'ab'.repeat(32), '1')).toBe(serverDiscussMessage(CONTRACT_ID, 'ab'.repeat(32), '1'));
    expect(keyResetCancelMessage(CONTRACT_ID, 'cd'.repeat(12), 'ef'.repeat(8), '1')).toBe(serverKeyResetCancelMessage(CONTRACT_ID, 'cd'.repeat(12), 'ef'.repeat(8), '1'));
  });

  test('request link carries the key fingerprint; old links still open', () => {
    const t = 'a'.repeat(32);
    const fp = keyFingerprint(profileKey.pk);
    const link = requestLink('https://x.test', t, fp);
    expect(link).toBe(`https://x.test/r#${t}.${fp}`);
    expect(parseRequestLink(`#${t}.${fp}`)).toBe(t);
    expect(parseRequestPin(`#${t}.${fp}`)).toBe(fp);
    expect(parseRequestLink(`#${t}`)).toBe(t);
    expect(parseRequestPin(`#${t}`)).toBeNull();
    expect(parseRequestLink(`#${t}.zz`)).toBeNull();
  });

  test('a real deal from a request checks out; the nickname comes from what the key signed; the deal page shows the creator', async () => {
    const { api, id, token, handle, pinned } = await profileAndRequest();
    expect(pinned).toBe(profileKey.pk);
    let v = await api.request(handle, token);
    let c = checkRequest(CONTRACT_ID, handle, v, { pk: pinned });
    expect(c).toEqual({ key: 'same', nickname: 'mila_motion', deal: 'none', creatorPk: null });

    const inbox = await api.inbox(id, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) });
    const made = await createDeal(browser(), { ...INPUT, fromRequest: { handle, profileKey, clientBoxPk: inbox.items[0].client_box_pk ?? null } });
    v = await api.request(handle, token);
    c = checkRequest(CONTRACT_ID, handle, v, { pk: pinned });
    expect(c.deal).toBe('ok');
    const deal = await loadDeal(browser(), made.token);
    expect(c.creatorPk).toBe(deal.offer.creator_pk);
    // Another device: only the fingerprint from the link.
    expect(checkRequest(CONTRACT_ID, handle, v, { fp: keyFingerprint(pinned) }).deal).toBe('ok');

    // The deal page shows the creator only for the checked deal key.
    const storage = memStorage();
    rememberCheckedCreator(made.handle, { profileId: id, nickname: c.nickname!, creatorPk: c.creatorPk! }, storage);
    expect(checkedCreator(made.handle, deal.offer.creator_pk, storage)?.nickname).toBe('mila_motion');
    expect(checkedCreator(made.handle, otherKey.pk, storage)).toBeNull();
    expect(checkedCreator('f'.repeat(64), deal.offer.creator_pk, storage)).toBeNull();
    // Without the record (another browser, or not checked): no creator line.
    expect(dealInfo({ ...deal, role: 'visitor' }).creator).toBeNull();
  });

  test('a hacked server: another key, a swapped deal, a forged nickname — all caught', async () => {
    const { api, handle, token, pinned } = await profileAndRequest();
    const inboxId = profileIdOf(profileKey.pk);
    const inbox = await api.inbox(inboxId, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) });
    await createDeal(browser(), { ...INPUT, fromRequest: { handle, profileKey, clientBoxPk: inbox.items[0].client_box_pk ?? null } });
    const real = await api.request(handle, token);

    // 1. The server now serves another profile key (and signs with it): "changed", deal never "ok" with the pinned key.
    const swappedKey: RequestView = { ...real, profile: { ...real.profile, profile_pk: otherKey.pk } };
    expect(checkRequest(CONTRACT_ID, handle, swappedKey, { pk: pinned }).key).toBe('changed');
    expect(checkRequest(CONTRACT_ID, handle, swappedKey, { fp: keyFingerprint(pinned) }).key).toBe('changed');

    // 2. Another deal key under the real signature: the signature does not cover it.
    const swappedDeal: RequestView = { ...real, deal_proof: { ...real.deal_proof!, creator_pk: otherKey.pk } };
    expect(checkRequest(CONTRACT_ID, handle, swappedDeal, { pk: pinned }).deal).toBe('bad');
    // A proof made for another request does not fit this one.
    expect(checkRequest(CONTRACT_ID, 'e'.repeat(64), real, { pk: pinned }).deal).toBe('bad');
    // No proof at all: bad (never "ready to pay" without it).
    expect(checkRequest(CONTRACT_ID, handle, { ...real, deal_proof: null }, { pk: pinned }).deal).toBe('bad');

    // 3. A forged nickname: not shown as checked.
    const forged: RequestView = { ...real, profile_proof: { ...real.profile_proof!, profile: { ...real.profile_proof!.profile, nickname: 'trusted_studio' } } };
    expect(checkRequest(CONTRACT_ID, handle, forged, { pk: pinned }).nickname).toBeNull();

    // 4. An old request with no pin: only the key the profile id was made from is accepted.
    expect(checkRequest(CONTRACT_ID, handle, real, {}).key).toBe('unpinned');
    expect(checkRequest(CONTRACT_ID, handle, real, {}).deal).toBe('ok');
    expect(checkRequest(CONTRACT_ID, handle, swappedKey, {}).deal).toBe('bad');
  });
});

describe('request life through the real server', () => {
  test('viewed, in talks, then declined with a reason the client sees', async () => {
    const { api, id, token, handle } = await profileAndRequest();
    expect((await api.request(handle, token)).status).toBe('open');
    const inbox = await api.inbox(id, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) });
    expect(inbox.items[0].status).toBe('open');
    expect(inbox.items[0].closes_at).toBeTruthy();
    expect((await api.request(handle, token)).status).toBe('viewed');
    await api.discuss(handle, { profile_pk: profileKey.pk, ...signDiscuss(CONTRACT_ID, profileKey, handle, clock) });
    expect((await api.request(handle, token)).status).toBe('discussing');
    const body = signDecline(CONTRACT_ID, profileKey, handle, clock, '  Fully booked this month  ');
    expect(body.reason).toBe('Fully booked this month');
    await api.decline(handle, { profile_pk: profileKey.pk, ...body });
    const v = await api.request(handle, token);
    expect(v.status).toBe('declined');
    expect(v.decline_reason).toBe('Fully booked this month');
    // No reason: the old message, still accepted.
    const r2 = await profileAndRequest();
    const plain = signDecline(CONTRACT_ID, profileKey, r2.handle, clock);
    expect(plain.reason).toBeUndefined();
    await api.decline(r2.handle, { profile_pk: profileKey.pk, ...plain });
    expect((await api.request(r2.handle, r2.token)).status).toBe('declined');
  });
});

describe('key reset by support', () => {
  test('the new key finds its older profile and writes it; the current key could have cancelled', async () => {
    const { api, id, token, handle } = await profileAndRequest();
    const fresh = { ...keyFromSeed('43'.repeat(32)), saved: true, createdAt: 0 };
    const ms = market().store;
    const quiet = () => undefined;
    expect(resetCli(ms, ['issue', id, fresh.pk, 'https://behance.net/mila'], quiet)).toBe(0);
    let reset = ms.openReset(id)!;
    expect(resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], quiet)).toBe(0);
    // The owner's inbox shows the change; the current key cancels it with one signature.
    const kc = (await api.inbox(id, { profile_pk: profileKey.pk, ...signInbox(CONTRACT_ID, profileKey, clock) })).key_change!;
    expect(kc.reset_id).toBe(reset.reset_id);
    expect((await api.profile(id)).key_changing).toBe(true);
    await api.cancelKeyReset(id, { profile_pk: profileKey.pk, reset_id: kc.reset_id, ...signKeyResetCancel(CONTRACT_ID, profileKey, kc.reset_id, clock) });
    expect((await api.profile(id)).key_changing).toBe(false);

    // Again, not cancelled: 72 h later the new key owns the profile.
    resetCli(ms, ['issue', id, fresh.pk, 'https://behance.net/mila'], quiet);
    reset = ms.openReset(id)!;
    resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], quiet);
    expect((await api.profileByKey(fresh.pk)).pending?.profile_id).toBe(id);
    clock += 72 * 3600_000 + 1000;
    const found = await api.profileByKey(fresh.pk);
    expect(found.profile_id).toBe(id);
    // The browser keeps the profile id with the key (it is not the hash of the new key).
    const storage = memStorage();
    storeProfileKey({ ...fresh, profileId: found.profile_id! }, storage);
    const k = loadProfileKey(storage)!;
    expect(profileIdOfKey(k)).toBe(id);
    expect(profileIdOf(k.pk)).not.toBe(id);
    const edited = { ...PROFILE, nickname: 'mila_again' };
    await api.putProfile(id, { profile_pk: k.pk, profile: edited, ...signProfileWrite(CONTRACT_ID, k, edited, clock) });
    expect((await api.profile(id)).nickname).toBe('mila_again');
    expect((await api.profile(id)).recent_change).toEqual({ what: 'key', days_ago: 0 });

    // The client who pinned the OLD key now sees "key changed".
    const v = await api.request(handle, token);
    expect(checkRequest(CONTRACT_ID, handle, v, { pk: profileKey.pk }).key).toBe('changed');
    expect(v.profile.recent_change?.what).toBe('key');
  });
});
