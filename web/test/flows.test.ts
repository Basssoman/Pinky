// The two browsers' flows (web/src/lib/flows.ts) against the REAL server app,
// with the in-memory chain and a scripted 1Click from the server's own tests.
// Covers the happy path and what a hacked or lying server could try.

import { sign as edSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { openAsArbiter, newNoteKey } from '../../server/scripts/arbiter/crypto.ts';
import { buildApp } from '../../server/src/app.ts';
import { actCall as serverActCall } from '../../server/src/chain.ts';
import type { QuoteRequest, QuoteResponse } from '../../server/src/oneclick.ts';
import { quoteSigningMessage } from '../../server/src/quoteSignature.ts';
import { SqliteStore } from '../../server/src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, quoteSigner, testConfig } from '../../server/test/helpers.ts';
import { ApiError, httpApi, type Api } from '../src/lib/api';
import { base58Encode } from '../src/lib/bytes';
import type { ChainReader } from '../src/lib/chain';
import type { Net } from '../src/lib/config';
import {
  acceptSettle,
  act,
  ActionError,
  createDeal,
  DealError,
  deliver,
  filesMatch,
  finishTimer,
  joinDeal,
  loadDeal,
  markKeySaved,
  openDispute,
  ownPayout,
  prepareClientKey,
  proposeSettle,
  readNotes,
  readProposals,
  refreshDeal,
  requestPayQuote,
  resendNotes,
  revokeLink,
  revokeProposals,
  sendCreatorArbiterCopy,
  storedPayQuote,
  timerOver,
  withdraw,
  type Ctx,
  type NewDealInput,
} from '../src/lib/flows';
import { keyFromSeed, newKey, sign, signedMessage } from '../src/lib/keys';
import { memoryStore } from '../src/lib/local';
import { QuoteError } from '../src/lib/quote';

let clock = Date.now();
let chain: FakeChain;
let oneClick: FreshOneClick;
let app: Awaited<ReturnType<typeof buildApp>>;
let base = '';
let net: Net;
const arbiterNote = newNoteKey();
const arbiterApi = newKey();

/** Like real 1Click: the quote timestamp is "now" (the server's fake uses a fixed date). */
class FreshOneClick extends FakeOneClick {
  override async quote(req: QuoteRequest): Promise<QuoteResponse> {
    const res = await super.quote(req);
    res.timestamp = new Date(clock).toISOString();
    return resign(res);
  }
}

function resign<T extends { signature?: string | null }>(res: T): T {
  const sig = edSign(null, Buffer.from(quoteSigningMessage(res as never), 'utf8'), quoteSigner().priv);
  res.signature = `ed25519:${base58Encode(sig)}`;
  return res;
}

function chainReader(): ChainReader {
  return {
    getDeal: (id) => chain.getDeal(id) as ReturnType<ChainReader['getDeal']>,
    getDealIdByOffer: (offer) => chain.getDealIdByOffer(offer),
    isOfferRevoked: async (offer) => chain.revokedOffers.has(offer),
    getPeriods: async () => ({ disputePeriodNs: 7n * 86400n * 10n ** 9n, payByPeriodNs: 7n * 86400n * 10n ** 9n, fundingGraceNs: 6n * 3600n * 10n ** 9n }),
    getTimeMs: async () => clock,
  };
}

/** One browser: its own key store. `api` can be wrapped to play a hacked server. */
function browser(wrap: (api: Api) => Api = (a) => a): Ctx {
  return { net, api: wrap(httpApi(base)), chain: chainReader(), store: memoryStore(), now: () => clock };
}

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  oneClick = new FreshOneClick();
  const config = testConfig({ arbiterApiPublicKey: arbiterApi.pk, rateWritesPerMin: 1000, rateQuotesPerMin: 1000 });
  app = await buildApp({ config, chain, oneClick, store: new SqliteStore(':memory:'), now: () => clock });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  net = {
    name: 'dev',
    contractId: CONTRACT_ID,
    usdcAssetId: config.usdcAssetId,
    tokenAccountId: config.tokenAccountId,
    oneClickKey: quoteSigner().pk,
    arbiterNoteKey: arbiterNote.pub,
    rpcUrls: [],
    apiBase: base,
    cliNetwork: 'sandbox',
  };
});

afterEach(async () => {
  await app.close();
});

const INPUT: NewDealInput = {
  title: '30-second promo video',
  work: 'Vertical 9:16 video, three scenes.',
  gets: 'MP4 1080×1920 plus the project file.',
  revisions: 2,
  price: '5',
  deliverySeconds: 14 * 86400,
  reviewSeconds: 3 * 86400,
  linkSeconds: 3 * 86400,
};

const PAY = { originAsset: 'nep141:eth-0xa0b8.omft.near', refundTo: '0x2527D02599Ba641c19FEa793cD0F167589a0f10D', coin: 'USDC', network: 'Ethereum' };
const file = (text: string) => new Blob([text]);
const FILES = [file('final video'), file('project file')];

/** Creator makes a deal, the client opens the link, joins and the deal gets funded. */
async function fundedDeal(clientWrap?: (api: Api) => Api) {
  const creatorCtx = browser();
  const clientCtx = browser(clientWrap);
  const made = await createDeal(creatorCtx, INPUT);
  let client = await loadDeal(clientCtx, made.token);
  client = await joinDeal(clientCtx, markKeySaved(clientCtx, prepareClientKey(clientCtx, client)));
  chain.fund(client.dealId!, client.deal!.amount);
  client = await refreshDeal(clientCtx, client);
  const creator = await loadDeal(creatorCtx, made.token);
  return { creatorCtx, clientCtx, creator, client, token: made.token };
}

describe('the whole deal', () => {
  test('create → open the link → join → pay → deliver → accept → withdraw', async () => {
    const creatorCtx = browser();
    const clientCtx = browser();

    const made = await createDeal(creatorCtx, INPUT);
    expect(made.role).toBe('creator');
    expect(chain.calls.length).toBe(0); // nothing on-chain until the client joins

    // The client opens /d#token in another browser.
    let client = await loadDeal(clientCtx, made.token);
    expect(client.role).toBe('visitor');
    expect(client.terms).toMatchObject({ title: INPUT.title, work: INPUT.work, gets: INPUT.gets, revisions: 2, amount: '5000000', feeBps: 300 });
    expect(client.terms.deliveryMs).toBe(14 * 86400_000);
    expect(client.creatorCode).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(client.deal).toBeNull();

    client = prepareClientKey(clientCtx, client);
    expect(client.role).toBe('client');
    expect(chain.calls.length).toBe(0); // the key is saved before it becomes the deal's key
    client = await joinDeal(clientCtx, markKeySaved(clientCtx, client));
    expect(client.deal!.client_pk).toBe(client.key!.pk);
    expect(client.deal!.state).toBe('Created');

    // The creator sees the same two codes.
    let creator = await loadDeal(creatorCtx, made.token);
    expect(creator.role).toBe('creator');
    expect(creator.clientCode).toBe(client.clientCode);
    expect(creator.creatorCode).toBe(client.creatorCode);

    // Payment address: only after the signed quote passed every check.
    const quote = await requestPayQuote(clientCtx, client, PAY);
    expect(quote.depositAddress).toBe(oneClick.quotes.length ? `${'d'.repeat(63)}1` : '');
    expect(oneClick.quotes[0]).toMatchObject({ recipient: CONTRACT_ID, amount: '5000000', refundTo: PAY.refundTo, customRecipientMsg: '{"deal_id":0}' });
    expect(storedPayQuote(clientCtx, client)?.depositAddress).toBe(quote.depositAddress);

    chain.fund(client.dealId!, '5000000');
    client = await refreshDeal(clientCtx, client);
    expect(client.deal!.state).toBe('Funded');

    // Deliver: encrypted link for the client + fingerprint on-chain.
    creator = await refreshDeal(creatorCtx, creator);
    await deliver(creatorCtx, creator, 'https://drive.example/final', FILES);
    client = await refreshDeal(clientCtx, client);
    expect(client.deal!.state).toBe('Delivered');
    expect(client.deal!.deliverable_hash).toMatch(/^v1:[0-9a-f]{64}$/);
    const notes = await readNotes(clientCtx, client);
    expect(notes.delivery?.link).toBe('https://drive.example/final');
    expect(await filesMatch(client, notes.delivery!, [FILES[1], FILES[0]])).toBe(true);
    expect(await filesMatch(client, notes.delivery!, [file('something else')])).toBe(false);

    await act(clientCtx, client, 'accept');
    creator = await refreshDeal(creatorCtx, creator);
    expect(creator.deal!.outcome).toBe('Accepted');
    expect(ownPayout(creator).payout).toBe(4_850_000n); // 5 USDC minus the 3% fee

    await withdraw(creatorCtx, creator, { destinationAsset: 'nep141:eth-0xa0b8.omft.near', recipient: '0x1111111111111111111111111111111111111111', recipientType: 'DESTINATION_CHAIN' });
    creator = await refreshDeal(creatorCtx, creator);
    expect(ownPayout(creator)).toEqual({ payout: 0n, pending: 0n, withdrawn: 4_850_000n });
    expect(creator.deal!.state).toBe('PaidOut');
  });

  test('dispute: the reason reaches the creator, both copies reach only the arbiter; then both sides agree on a split', async () => {
    const { creatorCtx, clientCtx, creator, client } = await fundedDeal();
    await deliver(creatorCtx, creator, 'https://drive.example/final', FILES);
    let c = await refreshDeal(clientCtx, client);
    const notes = await readNotes(clientCtx, c);
    const reason = { point: 'gets', pointText: INPUT.gets, text: 'The project file is missing from the folder.' };
    await openDispute(clientCtx, c, reason, notes.delivery);
    c = await refreshDeal(clientCtx, c);
    expect(c.deal!.state).toBe('Disputed');

    let cr = await refreshDeal(creatorCtx, creator);
    let crNotes = await readNotes(creatorCtx, cr);
    expect(crNotes.dispute).toEqual(reason);
    expect(crNotes.arbiterCopy).toEqual({ creator: false, client: true });
    expect(await sendCreatorArbiterCopy(creatorCtx, cr, crNotes)).toBe(true);
    crNotes = await readNotes(creatorCtx, cr);
    expect(crNotes.arbiterCopy.creator).toBe(true);
    expect(await sendCreatorArbiterCopy(creatorCtx, cr, crNotes)).toBe(false);

    // The arbiter tool reads the case with its API key and decrypts with its own key.
    const payload = JSON.stringify({ deal_id: c.dealId, issued_at_ns: (BigInt(clock) * 1_000_000n).toString(), nonce: 'a1' });
    const res = await fetch(`${base}/api/arbiter/case`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload, signature: sign(arbiterApi, `escrow-v1|${CONTRACT_ID}|arbiter|case|${payload}`) }),
    });
    expect(res.status).toBe(200);
    const kase = (await res.json()) as { notes: { kind: string; payload: string }[] };
    const data = (kind: string) => JSON.parse(kase.notes.find((n) => n.kind === kind)!.payload).data as string;
    const nc = (kind: string) => ({ contractId: CONTRACT_ID, dealId: c.dealId!, kind });
    const fromClient = openAsArbiter<{ text: string; delivery: { link: string; salt: string } }>(arbiterNote.priv, nc('dispute_arbiter'), data('dispute_arbiter'));
    const fromCreator = openAsArbiter<{ link: string; salt: string }>(arbiterNote.priv, nc('delivery_arbiter'), data('delivery_arbiter'));
    expect(fromClient.text).toBe(reason.text);
    expect(fromClient.delivery).toEqual(fromCreator);
    // Our server stores only ciphertext.
    expect(JSON.stringify(kase.notes)).not.toContain('drive.example');
    expect(JSON.stringify(kase.notes)).not.toContain('project file is missing');

    // "Work it out": the client proposes 40% to the creator, the creator accepts.
    await proposeSettle(clientCtx, c, 40);
    cr = await refreshDeal(creatorCtx, cr);
    const proposals = await readProposals(creatorCtx, cr);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ signer: 'client', creatorPct: 40, mine: false });
    expect((await readProposals(clientCtx, c))[0].mine).toBe(true);
    await acceptSettle(creatorCtx, cr, proposals[0]);
    cr = await refreshDeal(creatorCtx, cr);
    expect(cr.deal!.outcome).toEqual({ Settled: { creator_share_bps: 4000 } });
    expect(ownPayout(cr).payout).toBe(1_940_000n); // 40% of 5 USDC minus 3%
    c = await refreshDeal(clientCtx, c);
    expect(ownPayout(c).payout).toBe(3_000_000n);
  });

  test('a proposal that was taken back, or signed for another state, is not offered', async () => {
    const { creatorCtx, clientCtx, creator, client } = await fundedDeal();
    await proposeSettle(creatorCtx, creator, 80);
    expect(await readProposals(clientCtx, client)).toHaveLength(1);
    await revokeProposals(creatorCtx, creator);
    const c = await refreshDeal(clientCtx, client);
    expect(c.deal!.settle_seq).toBe(1);
    expect(await readProposals(clientCtx, c)).toHaveLength(0);

    await proposeSettle(creatorCtx, creator, 80);
    await deliver(creatorCtx, await refreshDeal(creatorCtx, creator), 'https://drive.example/final', FILES);
    expect(await readProposals(clientCtx, await refreshDeal(clientCtx, c))).toHaveLength(0); // signed before delivery
  });

  test('late delivery: the client takes the money back; a timer that ran out can be finished by anyone', async () => {
    const { clientCtx, client } = await fundedDeal();
    clock += 15 * 86400_000;
    await act(clientCtx, client, 'refund');
    const c = await refreshDeal(clientCtx, client);
    expect(c.deal!.outcome).toBe('RefundedAfterDeadline');
    expect(ownPayout(c).payout).toBe(5_000_000n);

    const second = await fundedDeal();
    await deliver(second.creatorCtx, second.creator, 'https://drive.example/final', FILES);
    let cr = await refreshDeal(second.creatorCtx, second.creator);
    expect(timerOver(cr.deal!, clock)).toBeNull();
    clock += 3 * 86400_000 + 60_000;
    expect(timerOver(cr.deal!, clock)).toBe('review');
    await finishTimer(second.creatorCtx, cr);
    cr = await refreshDeal(second.creatorCtx, cr);
    expect(cr.deal!.outcome).toBe('AutoReleased');
  });

  test('the creator cancels a link nobody accepted; the client is told not to use it', async () => {
    const creatorCtx = browser();
    const made = await createDeal(creatorCtx, INPUT);
    await revokeLink(creatorCtx, await loadDeal(creatorCtx, made.token));
    const clientCtx = browser();
    const client = await loadDeal(clientCtx, made.token);
    expect(client.revoked).toBe(true);
    await expect(joinDeal(clientCtx, prepareClientKey(clientCtx, client))).rejects.toMatchObject({ code: 'revoked' });
  });

  test('a contract that allows a shorter link: the link is cut to its limit instead of being refused', async () => {
    const hourNs = 3600n * 10n ** 9n;
    const ctx = browser();
    const read = ctx.chain;
    ctx.chain = { ...read, getPeriods: async () => ({ ...(await read.getPeriods()), maxOfferTtlNs: hourNs }) };
    const made = await createDeal(ctx, INPUT); // asks for 3 days
    const expires = BigInt(JSON.parse(made.cache!.offer).offer_expires_at_ns);
    const now = BigInt(clock) * 1_000_000n;
    expect(expires - now).toBe(hourNs - 120n * 10n ** 9n);
    expect((await loadDeal(browser(), made.token)).offerExpiresMs).toBe(Number(expires / 1_000_000n));
  });
});

describe('what a hacked or lying server cannot do', () => {
  test('change the terms or the price: the page refuses the deal', async () => {
    const made = await createDeal(browser(), INPUT);
    const tamper = (change: (d: Awaited<ReturnType<Api['getDeal']>>) => void) =>
      browser((api) => ({
        ...api,
        getDeal: async (h, t) => {
          const d = await api.getDeal(h, t);
          change(d);
          return d;
        },
      }));
    await expect(loadDeal(tamper((d) => (d.terms.title = 'Another job')), made.token)).rejects.toMatchObject({ code: 'tampered' });
    await expect(loadDeal(tamper((d) => (d.terms.description += ' plus more')), made.token)).rejects.toMatchObject({ code: 'tampered' });
    await expect(loadDeal(tamper((d) => (d.offer = d.offer.replace('"amount":"5000000"', '"amount":"1000000"'))), made.token)).rejects.toMatchObject({ code: 'tampered' });
    // A whole deal re-made by the server for another contract: the signature is bound to the hard-coded id.
    const other = browser();
    other.net = { ...net, contractId: 'thief.near' };
    await expect(loadDeal(other, made.token)).rejects.toMatchObject({ code: 'tampered' });
    await expect(loadDeal(browser(), 'ff'.repeat(16))).rejects.toMatchObject({ code: 'not_found' });
  });

  test('join with another key: the client reads the chain and refuses to pay', async () => {
    const attacker = newKey();
    const clientCtx = browser((api) => ({ ...api, join: (h, t) => api.join(h, t, attacker.pk) }));
    const made = await createDeal(browser(), INPUT);
    const client = prepareClientKey(clientCtx, await loadDeal(clientCtx, made.token));
    await expect(joinDeal(clientCtx, client)).rejects.toMatchObject({ code: 'used' });
    // Reopening the link later in the same browser: the deal belongs to other keys.
    expect((await loadDeal(clientCtx, made.token)).role).toBe('stranger');
    // And a fresh browser sees a used link, not a deal to pay.
    expect((await loadDeal(browser(), made.token)).role).toBe('stranger');
  });

  test('hand out a payment address that is not for this deal', async () => {
    const check = async (change: (q: Awaited<ReturnType<Api['payQuote']>>) => void, code: QuoteError['code']) => {
      const { clientCtx, client } = await unpaidDeal((api) => ({
        ...api,
        payQuote: async (h, s) => {
          const q = await api.payQuote(h, s);
          change(q);
          return q;
        },
      }));
      const err = await requestPayQuote(clientCtx, client, PAY).catch((e) => e);
      expect(err).toBeInstanceOf(QuoteError);
      expect((err as QuoteError).code).toBe(code);
      expect(storedPayQuote(clientCtx, client)).toBeNull(); // nothing is kept or shown
    };
    // Another address without 1Click's signature.
    await check((q) => (q.quote_response.quote!.depositAddress = 'attacker-address'), 'signature');
    // Validly signed by 1Click, but paying someone else / another deal / another amount / refund elsewhere.
    const signed = (f: (req: Record<string, unknown>) => void) => (q: Awaited<ReturnType<Api['payQuote']>>) => {
      f(q.quote_response.quoteRequest!);
      resign(q.quote_response);
    };
    await check(signed((r) => (r.recipient = 'thief.near')), 'mismatch');
    await check(signed((r) => (r.customRecipientMsg = '{"deal_id":7}')), 'mismatch');
    await check(signed((r) => (r.amount = '9000000')), 'mismatch');
    await check(signed((r) => (r.refundTo = '0x0000000000000000000000000000000000000001')), 'mismatch');
    await check(signed((r) => (r.destinationAsset = 'nep141:other.near')), 'mismatch');
    await check(signed((r) => (r.swapType = 'EXACT_INPUT')), 'mismatch');
    await check(signed((r) => (r.originAsset = 'nep141:other-coin.near')), 'mismatch');
    // An old quote replayed.
    await check((q) => {
      q.quote_response.timestamp = new Date(clock - 10 * 60_000).toISOString();
      resign(q.quote_response);
    }, 'stale');
    // A dry (test-mode) quote never shows an address.
    await check((q) => {
      q.quote_response.quoteRequest!.dry = true;
      resign(q.quote_response);
    }, 'dry');
  });

  test('a stored payment address is checked again every time it is shown', async () => {
    const { clientCtx, client } = await unpaidDeal();
    const quote = await requestPayQuote(clientCtx, client, PAY);
    expect(storedPayQuote(clientCtx, client)?.depositAddress).toBe(quote.depositAddress);
    clock += 20 * 60_000; // still inside the 30 minute window
    expect(storedPayQuote(clientCtx, client)?.depositAddress).toBe(quote.depositAddress);
    const local = clientCtx.store.get(client.handle)!;
    const bad = structuredClone(local);
    bad.payQuote!.response.quote!.depositAddress = 'attacker-address';
    clientCtx.store.put(bad);
    expect(storedPayQuote(clientCtx, client)).toBeNull();
    clientCtx.store.put(local);
    clock += 20 * 60_000; // past the deadline we asked for
    expect(storedPayQuote(clientCtx, client)).toBeNull();
  });

  test('redirect a withdraw: destination, amount and refund account are checked before signing', async () => {
    const check = async (change: (q: Awaited<ReturnType<Api['payoutQuote']>>) => void) => {
      const { clientCtx, client } = await fundedDeal((api) => ({
        ...api,
        payoutQuote: async (h, s) => {
          const q = await api.payoutQuote(h, s);
          change(q);
          return q;
        },
      }));
      clock += 15 * 86400_000;
      await act(clientCtx, client, 'refund');
      const c = await refreshDeal(clientCtx, client);
      const before = chain.calls.length;
      await expect(
        withdraw(clientCtx, c, { destinationAsset: 'nep141:eth-0xa0b8.omft.near', recipient: '0x1111111111111111111111111111111111111111', recipientType: 'DESTINATION_CHAIN' }),
      ).rejects.toBeInstanceOf(QuoteError);
      expect(chain.calls.length).toBe(before); // nothing was signed or sent
    };
    const payload = (f: (w: Record<string, string>) => void) => (q: Awaited<ReturnType<Api['payoutQuote']>>) => {
      const w = JSON.parse(q.withdraw_payload!) as Record<string, string>;
      f(w);
      q.withdraw_payload = JSON.stringify(w);
    };
    await check(payload((w) => (w.destination = 'thief.near')));
    await check(payload((w) => (w.amount = '1')));
    await check(payload((w) => (w.expires_at_ns = (BigInt(clock + 40 * 86400_000) * 1_000_000n).toString())));
    await check((q) => {
      q.quote_response.quoteRequest!.recipient = '0x2222222222222222222222222222222222222222';
      resign(q.quote_response);
    });
    await check((q) => {
      q.quote_response.quoteRequest!.refundTo = 'thief.near';
      resign(q.quote_response);
    });
    await check((q) => (q.quote_response.quote!.depositAddress = 'e'.repeat(64)));
  });

  test('forge a note: a files link or dispute text not signed by the right deal key is ignored', async () => {
    const stranger = keyFromSeed('09'.repeat(32));
    const { creatorCtx, creator, client, token } = await fundedDeal();
    await deliver(creatorCtx, creator, 'https://drive.example/final', FILES);
    const lying = browser((api) => ({
      ...api,
      notes: async (h, t) => {
        const r = await api.notes(h, t);
        const p = JSON.stringify({ kind: 'delivery', data: 'AAAA', issued_at_ns: '1', nonce: 'x' });
        r.notes = [{ kind: 'delivery', signer: 'creator', payload: p, signature: sign(stranger, signedMessage(CONTRACT_ID, client.dealId!, 'note', p)), created_at: '' }];
        return r;
      },
    }));
    lying.store.put(client.local!);
    const c = await loadDeal(lying, token);
    expect((await readNotes(lying, c)).delivery).toBeNull();
  });
});

describe('when our server is down', () => {
  test('the deal still opens from this browser and the chain, and the action is ready to send by hand', async () => {
    const { clientCtx, client, creatorCtx, creator, token } = await fundedDeal();
    await deliver(creatorCtx, creator, 'https://drive.example/final', FILES);
    const down: Api = new Proxy({} as Api, {
      get: () => async () => {
        throw new ApiError(0, 'unreachable', 'The server is not responding.');
      },
    });
    const offline: Ctx = { ...clientCtx, api: down };
    const d = await loadDeal(offline, token);
    expect(d.offline).toBe(true);
    expect(d.terms.title).toBe(INPUT.title);
    expect(d.deal!.state).toBe('Delivered'); // from the chain
    expect(d.dealId).toBe(client.dealId);

    const err = (await act(offline, d, 'accept').catch((e) => e)) as ActionError;
    expect(err).toBeInstanceOf(ActionError);
    expect(err.serverDown).toBe(true);
    const { args } = err.call;
    expect(err.call).toEqual(serverActCall(CONTRACT_ID, d.dealId!, 'accept', args.payload, args.signature));
    // What the person would send from any NEAR wallet is accepted by the contract as it is.
    await chain.act(args.deal_id, args.action, args.payload, args.signature);
    expect((await refreshDeal(offline, d)).deal!.outcome).toBe('Accepted');

    // A browser that never opened the deal has nothing to fall back on.
    await expect(loadDeal({ ...browser(), api: down }, token)).rejects.toBeInstanceOf(ApiError);
  });

  test('a delivery and a dispute still go out by hand, and their notes are sent once the server is back', async () => {
    const { clientCtx, client, creatorCtx, creator } = await fundedDeal();
    const down: Api = new Proxy({} as Api, {
      get: () => async () => {
        throw new ApiError(0, 'unreachable', 'The server is not responding.');
      },
    });
    const sendByHand = async (err: unknown) => {
      expect(err).toBeInstanceOf(ActionError);
      const { args } = (err as ActionError).call;
      await chain.act(args.deal_id, args.action, args.payload, args.signature);
    };

    // The creator delivers while our server is down: the action is ready to send from any NEAR wallet.
    await sendByHand(await deliver({ ...creatorCtx, api: down }, creator, 'https://drive.example/final', FILES).catch((e) => e));
    let cr = await refreshDeal(creatorCtx, creator);
    expect(cr.deal!.state).toBe('Delivered');
    let c = await refreshDeal(clientCtx, client);
    expect((await readNotes(clientCtx, c)).delivery).toBeNull(); // the link never reached the server
    // Server back: the creator's browser sends the link from its own copy.
    expect(await resendNotes(creatorCtx, cr, await readNotes(creatorCtx, cr))).toBe(true);
    const got = (await readNotes(clientCtx, c)).delivery;
    expect(got?.link).toBe('https://drive.example/final');
    expect(await filesMatch(c, got!, FILES)).toBe(true);
    expect(await resendNotes(creatorCtx, cr, await readNotes(creatorCtx, cr))).toBe(false);

    // The same for the client's dispute.
    const reason = { point: 'work', pointText: 'The work: three scenes', text: 'Only two scenes instead of three.' };
    await sendByHand(await openDispute({ ...clientCtx, api: down }, c, reason, got).catch((e) => e));
    c = await refreshDeal(clientCtx, c);
    expect(c.deal!.state).toBe('Disputed');
    expect(await resendNotes(clientCtx, c, await readNotes(clientCtx, c))).toBe(true);
    cr = await refreshDeal(creatorCtx, cr);
    const seen = await readNotes(creatorCtx, cr);
    expect(seen.dispute).toEqual(reason);
    expect(seen.arbiterCopy.client).toBe(true);
  });
});

async function unpaidDeal(clientWrap?: (api: Api) => Api) {
  const creatorCtx = browser();
  const clientCtx = browser(clientWrap);
  const made = await createDeal(creatorCtx, INPUT);
  const client = await joinDeal(clientCtx, prepareClientKey(clientCtx, await loadDeal(clientCtx, made.token)));
  return { creatorCtx, clientCtx, client, token: made.token };
}

test('DealError is what the pages switch on', () => {
  expect(new DealError('used', 'x').code).toBe('used');
});
