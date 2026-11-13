// Marketplace logic (marketplace/API.md): profile id, signed
// messages, the deal link encrypted to the client's request key,
// recovery links, field checks, the identicon.
import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2';
import { base58Decode, hex, utf8 } from '../src/lib/bytes';
import type { Api } from '../src/lib/api';
import type { ChainReader } from '../src/lib/chain';
import { createDeal, type Ctx } from '../src/lib/flows';
import { keyFromSeed, sha256Hex, verify } from '../src/lib/keys';
import { memoryStore } from '../src/lib/local';
import {
  cleanProfile,
  dealTokenFrom,
  expiresNs,
  identicon,
  inboxMessage,
  isHttpsLink,
  newProfileKey,
  openDealLink,
  parseProfileRecovery,
  parseRequestLink,
  profileIdOf,
  profileProblems,
  profileRecoveryLink,
  profileWriteMessage,
  requestBoxPub,
  requestDealMessage,
  reviewMessage,
  sealDealLink,
  signDecline,
  signInbox,
  signProfileWrite,
  signRequestDeal,
  type ProfileFields,
} from '../src/lib/market';

const C = 'escrow.test';
const SEED = '11'.repeat(32);
const key = { ...keyFromSeed(SEED), saved: true, createdAt: 0 };
const NOW = 1_800_000_000_000;

describe('profile key', () => {
  it('profile_id = first 12 bytes of sha256(raw public key), hex', () => {
    const raw = base58Decode(key.pk.slice(8));
    expect(profileIdOf(key.pk)).toBe(hex(sha256(raw)).slice(0, 24));
    expect(profileIdOf(key.pk)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('a new key is not saved yet and gives a valid id', () => {
    const k = newProfileKey(5);
    expect(k.saved).toBe(false);
    expect(k.createdAt).toBe(5);
    expect(profileIdOf(k.pk)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('the recovery link reads back from the link, its fragment or the whole file', () => {
    const link = profileRecoveryLink('https://pinky.example', SEED);
    expect(link).toBe(`https://pinky.example/p#p1.${SEED}`);
    expect(parseProfileRecovery(link)).toBe(SEED);
    expect(parseProfileRecovery(`#p1.${SEED}`)).toBe(SEED);
    expect(parseProfileRecovery(`Pinky: file\nKeep it private.\n\n${link}\n`)).toBe(SEED);
    expect(parseProfileRecovery(`https://x/k#k1.creator.${'a'.repeat(32)}.${SEED}`)).toBeNull();
    expect(parseProfileRecovery(`p1.${SEED}0`)).toBeNull();
    expect(parseProfileRecovery('hello')).toBeNull();
  });
});

describe('signed messages (API.md)', () => {
  const id = profileIdOf(key.pk);

  it('profile write: hash of the canonical body, with expiry', () => {
    const body = { nickname: 'mila', categories: ['video'], bio: '' };
    expect(profileWriteMessage(C, id, body, '123')).toBe(
      `escrow-v1|${C}|profile|${id}|${sha256Hex('{"bio":"","categories":["video"],"nickname":"mila"}')}|123`,
    );
    const s = signProfileWrite(C, key, body, NOW);
    expect(verify(key.pk, profileWriteMessage(C, id, body, s.expires_at_ns), s.sig)).toBe(true);
    expect(verify(key.pk, profileWriteMessage(C, id, { ...body, bio: 'x' }, s.expires_at_ns), s.sig)).toBe(false);
  });

  it('expiry is about 5 minutes ahead (the server allows ≤ 10) and unique per signature', () => {
    const e = BigInt(expiresNs(NOW));
    const now = BigInt(NOW) * 1_000_000n;
    expect(e > now + 299n * 1_000_000_000n).toBe(true);
    expect(e < now + 301n * 1_000_000_000n).toBe(true);
    expect(signInbox(C, key, NOW).sig).not.toBe(signInbox(C, key, NOW).sig);
  });

  it('inbox, decline, request-deal and review messages', () => {
    const h = 'ab'.repeat(32);
    expect(inboxMessage(C, id, '9')).toBe(`escrow-v1|${C}|profile-inbox|${id}|9`);
    const i = signInbox(C, key, NOW);
    expect(verify(key.pk, inboxMessage(C, id, i.expires_at_ns), i.sig)).toBe(true);
    const d = signDecline(C, key, h, NOW);
    expect(verify(key.pk, `escrow-v1|${C}|request-decline|${h}|${d.expires_at_ns}`, d.sig)).toBe(true);
    const dealPk = keyFromSeed('22'.repeat(32)).pk;
    const r = signRequestDeal(C, key, h, dealPk, NOW);
    expect(verify(key.pk, requestDealMessage(C, h, dealPk, r.expires_at_ns), r.sig)).toBe(true);
    expect(requestDealMessage(C, h, dealPk, '7')).toBe(`escrow-v1|${C}|request-deal|${h}|${dealPk}|7`);
    expect(reviewMessage(C, 12, id, 5, "great", "8")).toBe(`escrow-v1|${C}|review|12|${id}|5|${sha256Hex("great")}|8`);
  });

  it('signatures are canonical padded base64 of 64 bytes', () => {
    expect(signInbox(C, key, NOW).sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
  });
});

describe('the deal link on the request page', () => {
  const requestToken = 'c'.repeat(32);
  const handle = sha256Hex(requestToken);
  const dealToken = 'd'.repeat(32);

  it('only the request link can open it', async () => {
    const box = await sealDealLink(requestBoxPub(requestToken), handle, dealToken);
    expect(box.epk).toMatch(/^[0-9a-f]{64}$/);
    expect(box.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(box.ct).not.toContain(hex(utf8(dealToken)));
    expect(await openDealLink(requestToken, handle, box)).toBe(dealToken);
    expect(await openDealLink('e'.repeat(32), handle, box)).toBeNull();
  });

  it('a box made for another request does not open here (the handle is bound)', async () => {
    const box = await sealDealLink(requestBoxPub(requestToken), 'ff'.repeat(32), dealToken);
    expect(await openDealLink(requestToken, handle, box)).toBeNull();
  });

  it('a changed box does not open', async () => {
    const box = await sealDealLink(requestBoxPub(requestToken), handle, dealToken);
    const ct = (box.ct[0] === '0' ? '1' : '0') + box.ct.slice(1);
    expect(await openDealLink(requestToken, handle, { ...box, ct })).toBeNull();
  });

  it('the request key is the same every time for one token, and differs between tokens', () => {
    expect(requestBoxPub(requestToken)).toBe(requestBoxPub(requestToken));
    expect(requestBoxPub(requestToken)).not.toBe(requestBoxPub('f'.repeat(32)));
  });

  it('dealTokenFrom: the box first; a plain link only as a /d#token', async () => {
    const box = await sealDealLink(requestBoxPub(requestToken), handle, dealToken);
    expect(await dealTokenFrom(requestToken, handle, { deal_link_box: box })).toBe(dealToken);
    expect(await dealTokenFrom(requestToken, handle, { deal_link: `https://x/d#${dealToken}` })).toBe(dealToken);
    expect(await dealTokenFrom(requestToken, handle, { deal_link: 'https://evil/pay' })).toBeNull();
    expect(await dealTokenFrom(requestToken, handle, {})).toBeNull();
  });

  it('request links: 32 hex after #', () => {
    expect(parseRequestLink(`#${requestToken}`)).toBe(requestToken);
    expect(parseRequestLink('#abc')).toBeNull();
  });
});

describe('profile fields (same limits as the server)', () => {
  const ok: ProfileFields = {
    nickname: 'mila',
    bio: 'Motion for launches.',
    categories: ['motion'],
    portfolio: ['https://behance.net/mila'],
    contacts: [{ kind: 'telegram', value: '@mila' }],
    services: [{ title: 'Logo', description: '', price_from_usdc: 120, delivery_days: 5 }],
  };

  it('a good profile passes', () => {
    expect([...profileProblems(ok)]).toEqual([]);
  });

  it('catches each wrong field', () => {
    expect(profileProblems({ ...ok, nickname: 'm' }).has('nickname')).toBe(true);
    expect(profileProblems({ ...ok, nickname: 'x'.repeat(33) }).has('nickname')).toBe(true);
    expect(profileProblems({ ...ok, categories: [] }).has('categories')).toBe(true);
    expect(profileProblems({ ...ok, categories: ['video', 'motion', 'design', 'code'] }).has('categories')).toBe(true);
    expect(profileProblems({ ...ok, bio: 'x'.repeat(401) }).has('bio')).toBe(true);
    expect(profileProblems({ ...ok, portfolio: ['http://insecure.com'] }).has('portfolio')).toBe(true);
    expect(profileProblems({ ...ok, portfolio: Array(9).fill('https://a.com') }).has('portfolio')).toBe(true);
    expect(profileProblems({ ...ok, contacts: [{ kind: 'x', value: ' ' }] }).has('contacts')).toBe(true);
    for (const bad of [{ price_from_usdc: 0 }, { price_from_usdc: 2001 }, { price_from_usdc: 1.5 }, { delivery_days: 91 }, { title: '' }]) {
      expect(profileProblems({ ...ok, services: [{ ...ok.services[0], ...bad }] }).has('services')).toBe(true);
    }
  });

  it('https links only, with a real host', () => {
    expect(isHttpsLink('https://youtu.be/x')).toBe(true);
    expect(isHttpsLink('javascript:alert(1)')).toBe(false);
    expect(isHttpsLink('https://localhost')).toBe(false);
    expect(isHttpsLink(`https://a.com/${'x'.repeat(300)}`)).toBe(false);
  });

  it('cleanProfile trims and drops empty rows', () => {
    const c = cleanProfile({ ...ok, nickname: ' mila ', portfolio: [' https://a.com ', ''], contacts: [{ kind: 'x', value: '' }] });
    expect(c.nickname).toBe('mila');
    expect(c.portfolio).toEqual(['https://a.com']);
    expect(c.contacts).toEqual([]);
    expect('id' in c.services[0]).toBe(false);
  });
});

describe('identicon', () => {
  it('7 × 7, mirrored, never empty, same id → same picture', () => {
    for (const id of ['a1b2c3d4e5f60718293a4b5c', '000000000000000000000000', profileIdOf(key.pk)]) {
      const rows = identicon(id);
      expect(rows).toHaveLength(7);
      for (const r of rows) {
        expect(r).toHaveLength(7);
        expect(r).toBe([...r].reverse().join(''));
      }
      expect(rows.join('')).toMatch(/[#*]/);
      expect(identicon(id)).toEqual(rows);
    }
    expect(identicon('a1b2c3d4e5f60718293a4b5c')).not.toEqual(identicon('b2c3d4e5f60718293a4b5c6d'));
  });
});

describe('a deal made from a request (the one change to the deal flow)', () => {
  const ctxWith = (sent: unknown[]): Ctx => ({
    net: { name: 'dev', contractId: C, usdcAssetId: 'nep141:usdc', tokenAccountId: 'usdc', oneClickKey: '', arbiterNoteKey: '', rpcUrls: [], apiBase: '', cliNetwork: 'sandbox' },
    api: { createDeal: async (body: unknown) => (sent.push(body), { handle: 'x' }) } as unknown as Api,
    chain: { getPeriods: async () => ({}) } as unknown as ChainReader,
    store: memoryStore(),
    now: () => NOW,
  });
  const INPUT = { title: 'Logo', work: 'A logo', gets: '', revisions: 2, price: '150', deliverySeconds: 86400, reviewSeconds: 3 * 86400, linkSeconds: 86400 };

  it('sends request_handle, the profile-key signature over this deal key, and the deal link only as a box', async () => {
    const sent: Record<string, unknown>[] = [];
    const requestToken = 'c'.repeat(32);
    const handle = sha256Hex(requestToken);
    const made = await createDeal(ctxWith(sent), { ...INPUT, fromRequest: { handle, profileKey: key, clientBoxPk: requestBoxPub(requestToken) } });
    const body = sent[0];
    expect(body.request_handle).toBe(handle);
    expect(body.profile_pk).toBe(key.pk);
    const creatorPk = JSON.parse(String(body.offer)).creator_pk as string;
    expect(verify(key.pk, requestDealMessage(C, handle, creatorPk, String(body.request_expires_at_ns)), body.request_sig)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(made.token);
    expect(await openDealLink(requestToken, handle, body.deal_link_box as never)).toBe(made.token);
  });

  it('a deal without a request sends nothing extra', async () => {
    const sent: Record<string, unknown>[] = [];
    await createDeal(ctxWith(sent), INPUT);
    expect(Object.keys(sent[0]).sort()).toEqual(['handle', 'offer', 'offer_signature', 'terms']);
  });
});
