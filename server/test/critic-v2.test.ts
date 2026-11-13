// Internal review of server v2 (2026-11-06): the attack scripts, kept as regression
// tests with INVERTED assertions. Each test replays the attack and checks that
// it is now blocked.
// No network. The chain is the repo's FakeChain plus the contract-v2 parse
// rules (contract/src/lib.rs line refs in comments), so a tx the server lets
// through but the contract would refuse shows up as a relayed failure.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { ChainCallError, NearChain, type Chain, type TxResult } from '../src/chain.ts';
import { parseTrustProxy, type Config } from '../src/config.ts';
import { revokeOfferMessage, sha256Hex, offerMessage } from '../src/encoding.ts';
import { SqliteStore } from '../src/store.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, randomKey, signedRequest, testConfig, type DealKey, type OfferBundle } from './helpers.ts';

const SEC = 1_000_000_000n;
const creator = keyFromSeed(41);
const client = keyFromSeed(42);

// ---------------------------------------------------------------- contract parity rules

/** serde_json (1.0.154, the contract's version) rejects these; JSON.parse accepts them (verified offline in WSL). */
function serdeRejects(s: string): string | null {
  // lone surrogate escape (\uD800-\uDFFF not part of a valid pair)
  const re = /\\u([dD][89abAB][0-9a-fA-F]{2})(\\u([dD][c-fC-F][0-9a-fA-F]{2}))?|\\u([dD][c-fC-F][0-9a-fA-F]{2})/g;
  for (const m of s.matchAll(re)) if (m[4] || !m[2]) return 'lone surrogate';
  let depth = 0;
  let max = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[' || c === '{') max = Math.max(max, ++depth);
    else if (c === ']' || c === '}') depth--;
  }
  return max > 128 ? 'recursion limit exceeded' : null;
}
const U64_MAX = 18446744073709551615n;

/** FakeChain + the contract rules the server pre-check does not mirror. Every call = one relayer tx. */
class StrictChain extends FakeChain {
  override async act(dealId: number, action: string, payload: string, signature: string): Promise<TxResult<unknown>> {
    // lib.rs:995 payload.len() is BYTES; lib.rs:997 serde_json
    if (Buffer.byteLength(payload, 'utf8') > 1024) return this.reject('act', [dealId, action], 'payload too long');
    if (serdeRejects(payload)) return this.reject('act', [dealId, action], 'payload is not JSON');
    const p = JSON.parse(payload);
    // lib.rs:1025 hash.len() is BYTES
    if (action === 'deliver' && Buffer.byteLength(String(p.deliverable_hash), 'utf8') > 192) return this.reject('act', [dealId, action], 'bad deliverable_hash');
    if (action === 'withdraw' && BigInt(p.expires_at_ns) > U64_MAX) return this.reject('act', [dealId, action], 'withdraw: expires_at_ns: out of range');
    if (action === 'dispute') {
      this.calls.push({ method: 'act', args: [dealId, action, payload, signature] });
      const d = this.deals[dealId];
      if (d.state !== 'Delivered') throw new ChainCallError('dispute: deal must be Delivered', 'tx');
      if (this.nowNs() > BigInt(d.review_ends_at_ns!)) throw new ChainCallError('dispute: review period is over', 'tx');
      d.state = 'Disputed';
      d.disputed_at_ns = this.nowNs().toString();
      d.dispute_ends_at_ns = (this.nowNs() + 7n * 86400n * SEC).toString();
      return { txHash: 'tx', value: true };
    }
    return super.act(dealId, action, payload, signature);
  }
  override async settle(dealId: number, payload: string, a: string, b: string): Promise<TxResult<unknown>> {
    if (Buffer.byteLength(payload, 'utf8') > 1024) return this.reject('settle', [dealId], 'payload too long');
    if (serdeRejects(payload)) return this.reject('settle', [dealId], 'payload is not JSON');
    // lib.rs:1115 parse_u64_strict
    if (BigInt(JSON.parse(payload).expires_at_ns) > U64_MAX) return this.reject('settle', [dealId], 'settle: expires_at_ns: out of range');
    return super.settle(dealId, payload, a, b);
  }
  override async createDeal(offer: string, sig: string, clientPk: string): Promise<TxResult<number>> {
    // lib.rs:680 offer.len() BYTES; lib.rs:708 offer_nonce.len() BYTES
    if (Buffer.byteLength(offer, 'utf8') > 1024) return this.reject('create_deal', [offer], 'offer too long');
    const nonce = JSON.parse(offer).offer_nonce as string;
    const n = Buffer.byteLength(nonce, 'utf8');
    if (n < 16 || n > 64) return this.reject('create_deal', [offer], 'offer_nonce must be 16..64 chars');
    return super.createDeal(offer, sig, clientPk);
  }
  private reject(method: string, args: unknown[], msg: string): never {
    this.calls.push({ method, args });
    throw new ChainCallError(msg, 'txfail');
  }
}

// ---------------------------------------------------------------- harness

interface Ctx {
  app: FastifyInstance;
  fake: StrictChain;
  config: Config;
  clock: { t: number };
}

async function makeApp(opts: { overrides?: Partial<Config>; queued?: { msPerTx: number; gate?: () => Promise<void> } } = {}): Promise<Ctx & { near?: NearChain }> {
  const clock = { t: Date.now() };
  const fake = new StrictChain();
  fake.nowNs = () => BigInt(clock.t) * 1_000_000n;
  const config = testConfig(opts.overrides ?? {});
  let chain: Chain = fake;
  let near: NearChain | undefined;
  if (opts.queued) {
    // The REAL relayer queue (chain.ts NearChain.call/pump); only `send` and views are stubbed.
    near = new NearChain({
      rpcUrl: 'http://127.0.0.1:9',
      contractId: CONTRACT_ID,
      relayerAccountId: 'relayer.test.near',
      relayerPrivateKey: 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
      nowNs: () => BigInt(clock.t) * 1_000_000n,
    });
    const q = opts.queued;
    const n = near as unknown as Record<string, unknown>;
    for (const m of ['getDeal', 'getNearBalances', 'getDealIdByOffer', 'isWithdrawUsed', 'accountExists'] as const) {
      n[m] = (...a: unknown[]) => (fake[m] as (...x: unknown[]) => unknown).apply(fake, a);
    }
    n.send = async (method: string, args: Record<string, any>) => {
      if (q.gate) await q.gate();
      await new Promise((r) => setTimeout(r, 1));
      clock.t += q.msPerTx; // each relayer tx takes msPerTx of chain time
      switch (method) {
        case 'act':
          return fake.act(args.deal_id, args.action, args.payload, args.signature);
        case 'create_deal':
          return fake.createDeal(args.offer, args.offer_signature, args.client_pk);
        case 'close_unpaid':
          return fake.closeUnpaid(args.deal_id);
        case 'settle':
          return fake.settle(args.deal_id, args.payload, args.creator_signature, args.client_signature);
        case 'revoke_offer':
          return fake.revokeOffer(args.offer, args.signature);
        default:
          throw new Error(`unexpected ${method}`);
      }
    };
    chain = near;
  }
  const app = await buildApp({ config, chain, oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), now: () => clock.t });
  return { app, fake, config, clock, near };
}

async function postOffer(c: Ctx, b: OfferBundle, ip = '127.0.0.1') {
  return c.app.inject({ method: 'POST', url: '/api/deals', remoteAddress: ip, payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms } });
}
async function joinDeal(c: Ctx, b: OfferBundle, key: DealKey, ip = '127.0.0.1') {
  return c.app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, remoteAddress: ip, headers: { 'x-deal-token': b.token }, payload: { client_pk: key.pk } });
}
async function newDeal(c: Ctx, cr: DealKey, cl: DealKey, opts: Parameters<typeof makeOffer>[1] = {}, ip = '127.0.0.1') {
  const b = makeOffer(cr, { nowMs: c.clock.t, ...opts });
  const p = await postOffer(c, b, ip);
  assert.equal(p.statusCode, 201, p.body);
  const j = await joinDeal(c, b, cl, ip);
  assert.equal(j.statusCode, 201, j.body);
  return { b, id: j.json().deal_id as number };
}
function act(c: Ctx, b: OfferBundle, id: number, key: DealKey, action: string, payload: string, ip = '127.0.0.1') {
  return c.app.inject({ method: 'POST', url: `/api/deals/${b.handle}/actions`, remoteAddress: ip, payload: { action, payload, signature: key.sign(id, action, payload) } });
}
const count = (c: Ctx, method: string) => c.fake.calls.filter((x) => x.method === method).length;

// ======================================================================
// Regression: /timeout jobs are queued with priority = "the
// moment they became due" (always in the PAST), so they outrank every
// deliver/dispute. Free never-paid deals let a creator push the client's
// dispute past the review end; the relayer then drops it (deadline_passed).
// ======================================================================

test('free close_unpaid timeouts no longer starve a dispute (timeouts queue behind it)', async () => {
  const c = await makeApp({ queued: { msPerTx: 1500 } });
  const t0 = c.clock.t;
  // Attacker: 60 never-paid deals from three /24s (20 joins per prefix = DAILY_JOINS_PER_IP default).
  const attacker: OfferBundle[] = [];
  for (let p = 0; p < 3; p++) {
    for (let i = 0; i < 20; i++) {
      const ip = `198.51.${100 + p}.${i + 1}`;
      const { b } = await newDeal(c, randomKey(), randomKey(), { nowMs: c.clock.t }, ip);
      attacker.push(b);
    }
  }
  // Victim deal (attacker is its creator), 1 h review.
  const v = await newDeal(c, creator, client, { reviewNs: 3600n * SEC, nowMs: c.clock.t });
  // Day 7 + 5.5 h: funded and delivered -> review ends 7 d 6.5 h after t0.
  c.clock.t = t0 + (7 * 86400 + 5.5 * 3600) * 1000;
  c.fake.fund(v.id, '5000000');
  assert.equal((await act(c, v.b, v.id, creator, 'deliver', '{"deliverable_hash":"h"}')).statusCode, 200);
  const reviewEnd = BigInt(c.fake.deals[v.id].review_ends_at_ns!);
  // 60 s before the review end the client disputes; the attacker fires /timeout on its 60 expired deals first.
  c.clock.t = Number(reviewEnd / 1_000_000n) - 60_000;
  const timeouts = attacker.map((b) =>
    c.app.inject({ method: 'POST', url: `/api/deals/${b.handle}/timeout`, headers: { 'x-deal-token': b.token } }),
  );
  await new Promise((r) => setTimeout(r, 5));
  const dispute = act(c, v.b, v.id, client, 'dispute', '{"nonce":"d1"}');
  const [res, ...tres] = await Promise.all([dispute, ...timeouts]);
  void tres;
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(c.fake.deals[v.id].state, 'Disputed', 'the dispute reached the chain in time');
  assert.ok(BigInt(c.fake.deals[v.id].disputed_at_ns!) <= reviewEnd);
});

test('failing delivers with byte-long hashes are never relayed, so they cannot hold the queue', async () => {
  const c = await makeApp({ queued: { msPerTx: 1500 } });
  const v = await newDeal(c, creator, client, { reviewNs: 86400n * SEC });
  c.fake.fund(v.id, '5000000');
  assert.equal((await act(c, v.b, v.id, creator, 'deliver', '{"deliverable_hash":"h"}')).statusCode, 200);
  const reviewEndMs = Number(BigInt(c.fake.deals[v.id].review_ends_at_ns!) / 1_000_000n);
  // Attacker deals (price 1 base unit, 1 h work time), funded so that their delivery deadline = review end - 1 s.
  const att: { b: OfferBundle; id: number; k: DealKey }[] = [];
  for (let i = 0; i < 3; i++) {
    const k = randomKey();
    // 1 base unit is refused now (1 USDC minimum); the attacker pays 1 USDC per deal
    const d = await newDeal(c, k, randomKey(), { amount: '1000000', durationNs: 3600n * SEC, nowMs: c.clock.t }, `198.18.0.${i + 1}`);
    att.push({ ...d, k });
  }
  c.clock.t = reviewEndMs - 3600_000 - 1000;
  for (const a of att) c.fake.fund(a.id, '1000000');
  const bad = JSON.stringify({ deliverable_hash: 'ж'.repeat(150) });
  let attackerTxs = 0;
  const loops = att.map(async (a) => {
    for (;;) {
      const r = await act(c, a.b, a.id, a.k, 'deliver', bad);
      if (r.statusCode === 422) attackerTxs++;
      else return; // refused by the pre-check (bytes) or the signer limit
    }
  });
  await new Promise((r) => setTimeout(r, 5));
  c.clock.t = Math.max(c.clock.t, reviewEndMs - 600_000); // victim disputes 10 min before the end
  const res = await act(c, v.b, v.id, client, 'dispute', '{"nonce":"late-but-in-time"}');
  await Promise.all(loops);
  assert.equal(attackerTxs, 0, 'no failing attacker tx reached the relayer');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(c.fake.deals[v.id].state, 'Disputed');
});

test('control: without the attacker the same dispute lands', async () => {
  const c = await makeApp({ queued: { msPerTx: 1500 } });
  const v = await newDeal(c, creator, client, { reviewNs: 3600n * SEC });
  c.fake.fund(v.id, '5000000');
  assert.equal((await act(c, v.b, v.id, creator, 'deliver', '{"deliverable_hash":"h"}')).statusCode, 200);
  c.clock.t = Number(BigInt(c.fake.deals[v.id].review_ends_at_ns!) / 1_000_000n) - 60_000;
  const res = await act(c, v.b, v.id, client, 'dispute', '{"nonce":"d1"}');
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(c.fake.deals[v.id].state, 'Disputed');
});

// ======================================================================
// Relayer drain: actions the server pre-check accepts but the
// contract rejects are relayed again and again. The signer bucket is only
// charged AFTER the tx; it never blocks a request that passes the pre-check.
// ======================================================================

test('a 150-char Cyrillic hash (300 bytes) is refused by the byte pre-check, never relayed', async () => {
  const c = await makeApp();
  const { b, id } = await newDeal(c, creator, client);
  c.fake.fund(id, '5000000'); // the price itself can be 1 base unit (no server minimum)
  const payload = JSON.stringify({ deliverable_hash: 'ж'.repeat(150) });
  const codes: number[] = [];
  for (let i = 0; i < 40; i++) codes.push((await act(c, b, id, creator, 'deliver', payload)).statusCode);
  assert.equal(count(c, 'act'), 0);
  assert.ok(codes.includes(409) && codes.includes(429), `pre-check, then the signer limit: ${[...new Set(codes)]}`);
});

test('a lone-surrogate payload is refused (serde_json would reject it), never relayed', async () => {
  const c = await makeApp();
  const { b, id } = await newDeal(c, creator, client);
  for (let i = 0; i < 40; i++) await act(c, b, id, creator, 'cancel', `{"n":"${i}\\ud800"}`);
  assert.equal(count(c, 'act'), 0);
  assert.equal(c.fake.deals[id].state, 'Created');
});

test('/settle with expires_at_ns > u64::MAX is refused before any tx', async () => {
  const c = await makeApp();
  const { b, id } = await newDeal(c, creator, client);
  c.fake.fund(id, '5000000');
  const payload = JSON.stringify({ split_bps: '5000', state: 'Funded', seq: '0', expires_at_ns: '99999999999999999999', nonce: 'x' });
  const body = { payload, creator_signature: creator.sign(id, 'settle', payload), client_signature: client.sign(id, 'settle', payload) };
  const codes: number[] = [];
  for (let i = 0; i < 40; i++) {
    codes.push((await c.app.inject({ method: 'POST', url: `/api/deals/${b.handle}/settle`, headers: { 'x-deal-token': b.token }, payload: body })).statusCode);
  }
  assert.equal(count(c, 'settle'), 0);
  assert.ok(codes.every((x) => x === 409 || x === 429), String([...new Set(codes)]));
});

test('an offer with a 40-char Cyrillic nonce (80 bytes) is refused when stored', async () => {
  const c = await makeApp();
  const b0 = makeOffer(creator, { nowMs: c.clock.t });
  const o = JSON.parse(b0.offer);
  o.offer_nonce = 'ж'.repeat(40);
  const offer = JSON.stringify(o);
  const b = { ...b0, offer, offer_signature: creator.signRaw(offerMessage(CONTRACT_ID, offer)) };
  assert.equal((await postOffer(c, b)).statusCode, 400);
  for (let i = 0; i < 10; i++) await joinDeal(c, b, client);
  assert.equal(count(c, 'create_deal'), 0);
});

test('valid revoke_settle has a daily budget per deal', async () => {
  const c = await makeApp();
  const { b, id } = await newDeal(c, creator, client);
  c.fake.fund(id, '5000000');
  const codes: number[] = [];
  for (let i = 0; i < 20; i++) codes.push((await act(c, b, id, client, 'revoke_settle', `{"seq":"${c.fake.deals[id].settle_seq}"}`)).statusCode);
  assert.equal(count(c, 'act'), c.config.dailyRevokeSettlePerDeal);
  assert.ok(codes.includes(429));
});

// ======================================================================
// Offers are free and only per-prefix capped; every revoke costs
// the relayer REVOKE_DEPOSIT (0.001 NEAR) + gas. No global cap, no reserve.
// ======================================================================

test('on-chain revoke_offer has a daily budget; above it the revoke is kept off-chain', async () => {
  const c = await makeApp();
  for (let p = 0; p < 2; p++) {
    for (let i = 0; i < 50; i++) {
      const ip = `203.0.${p}.${(i % 200) + 1}`;
      const k = randomKey();
      const b = makeOffer(k, { nowMs: c.clock.t });
      assert.equal((await postOffer(c, b, ip)).statusCode, 201);
      const r = await c.app.inject({
        method: 'POST',
        url: `/api/deals/${b.handle}/revoke`,
        remoteAddress: ip,
        payload: { signature: k.signRaw(revokeOfferMessage(CONTRACT_ID, b.offer)) },
      });
      assert.equal(r.statusCode, 200, r.body);
    }
  }
  assert.equal(count(c, 'revoke_offer'), c.config.dailyOnchainRevokes);
});

// ======================================================================
// Withdraw cycling. The cap is per deal party; each 1-unit
// top-up gives the attacker another relayed withdraw (0.00225 NEAR + 150 TGas).
// ======================================================================

test('1-unit top-ups are never withdrawn by the relayer (0.1 USDC minimum)', async () => {
  const c = await makeApp();
  let relayed = 0;
  for (let d = 0; d < 4; d++) {
    const { b, id } = await newDeal(c, randomKey(), client);
    for (let i = 0; i < 6; i++) {
      c.fake.fund(id, '1'); // an underpayment goes to client_payout (contract credit())
      const w = JSON.stringify({ destination: 'a'.repeat(64), amount: c.fake.deals[id].client_payout, expires_at_ns: ((BigInt(c.clock.t) + 600_000n + BigInt(i)) * 1_000_000n).toString() });
      const r = await act(c, b, id, client, 'withdraw', w);
      if (r.statusCode === 200) relayed++;
    }
  }
  assert.equal(relayed, 0);
});

test('withdraws of real top-ups are capped per network over all deals', async () => {
  const c = await makeApp();
  let relayed = 0;
  for (let d = 0; d < 6; d++) {
    const { b, id } = await newDeal(c, randomKey(), client);
    for (let i = 0; i < 5; i++) {
      c.fake.fund(id, '100000');
      const w = JSON.stringify({ destination: 'a'.repeat(64), amount: c.fake.deals[id].client_payout, expires_at_ns: ((BigInt(c.clock.t) + 600_000n + BigInt(i)) * 1_000_000n).toString() });
      if ((await act(c, b, id, client, 'withdraw', w)).statusCode === 200) relayed++;
    }
  }
  assert.equal(relayed, c.config.dailyWithdrawsPerPrefix);
});

// ======================================================================
// The same offer can be stored under a second handle. A client
// who joins via its own copy makes the creator's handle unmappable
// (deal_id UNIQUE, the error is swallowed): the creator never sees the deal,
// and /revoke even tells the creator "revoked".
// ======================================================================

test('a copied offer cannot be stored under a second handle', async () => {
  const c = await makeApp();
  const b = makeOffer(creator, { nowMs: c.clock.t });
  assert.equal((await postOffer(c, b)).statusCode, 201);
  // client reads the link, copies offer + terms under its own token
  const view = (await c.app.inject({ method: 'GET', url: `/api/deals/${b.handle}`, headers: { 'x-deal-token': b.token } })).json();
  const token2 = 'f'.repeat(32);
  const b2: OfferBundle = { token: token2, handle: sha256Hex(token2), offer: view.offer, offer_signature: view.offer_signature, terms: { title: view.terms.title, description: view.terms.description, revisions: view.terms.revisions, salt: view.terms.salt } };
  const r = await postOffer(c, b2, '192.0.2.9');
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'offer_taken');
});

// ======================================================================
// Cancel vs pay. The cancel guard only looks at quotes that
// already exist. A pay-quote issued while the creator's cancel waits in the
// relayer queue (or a swap still settling after the quote deadline) lands
// in a Cancelled deal.
// ======================================================================

test('no payment address while the creator\'s cancel is queued', async () => {
  let open!: () => void;
  let gated = false;
  const gate = new Promise<void>((r) => (open = r));
  const c = await makeApp({ queued: { msPerTx: 1000, gate: async () => { if (gated) await gate; } } });
  const { b, id } = await newDeal(c, creator, client);
  // the cancel passes every check and waits in the relayer queue / in flight
  gated = true;
  const cancel = act(c, b, id, creator, 'cancel', '{"n":"c"}');
  await new Promise((r) => setTimeout(r, 20));
  const q = await c.app.inject({ method: 'POST', url: `/api/deals/${b.handle}/pay-quote`, payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'nep141:eth.omft.near', refund_address: '0xabc' }, c.clock.t) });
  open();
  const cr = await cancel;
  assert.equal(q.statusCode, 409);
  assert.equal(q.json().error, 'cancel_pending');
  assert.equal(cr.statusCode, 200);
  assert.equal(c.fake.deals[id].state, 'Cancelled');
});

// ======================================================================
// Rate-limit bypass: per-minute buckets are keyed by the exact IP.
// Rotating IPv6 addresses inside one /64 (or GET with junk signed-read
// headers, which has no flood cache at all) turns junk into RPC reads.
// ======================================================================

test('junk from rotating IPv6 addresses in one /64 is limited and served from the flood cache', async () => {
  const c = await makeApp();
  const { b, id } = await newDeal(c, creator, client);
  let reads = 0;
  const orig = c.fake.getDeal.bind(c.fake);
  c.fake.getDeal = async (n: number) => {
    reads++;
    return orig(n);
  };
  const junkSig = Buffer.alloc(64, 7).toString('base64');
  let limited = 0;
  for (let i = 0; i < 300; i++) {
    const r = await c.app.inject({
      method: 'POST',
      url: `/api/deals/${b.handle}/actions`,
      remoteAddress: `2001:db8:1:2:0:0:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}`,
      payload: { action: 'accept', payload: '{}', signature: junkSig },
    });
    if (r.statusCode === 429) limited++;
  }
  const actionReads = reads;
  for (let i = 0; i < 300; i++) {
    const r = await c.app.inject({
      method: 'GET',
      url: `/api/deals/${b.handle}`,
      remoteAddress: `2001:db8:1:3::${(i + 1).toString(16)}`,
      headers: { 'x-deal-payload': '{}', 'x-deal-signature': junkSig },
    });
    if (r.statusCode === 429) limited++;
  }
  assert.ok(limited > 0);
  assert.ok(actionReads < 100, `actions: ${actionReads} chain reads`);
  assert.ok(reads - actionReads < 100, `signed GETs: ${reads - actionReads} chain reads`);
  void id;
});

test('quote routes are limited per address before any chain read; health balances are cached', async () => {
  const c = await makeApp();
  const b = makeOffer(randomKey(), { nowMs: c.clock.t }); // attacker's own free offer, never joined
  assert.equal((await postOffer(c, b)).statusCode, 201);
  let byOffer = 0;
  let balances = 0;
  const o1 = c.fake.getDealIdByOffer.bind(c.fake);
  c.fake.getDealIdByOffer = async (s: string) => (byOffer++, o1(s));
  const o2 = c.fake.getNearBalances.bind(c.fake);
  c.fake.getNearBalances = async () => (balances++, o2());
  const statuses = new Set<number>();
  for (let i = 0; i < 500; i++) {
    for (const r of ['pay-quote', 'payout-quote']) {
      statuses.add((await c.app.inject({ method: 'POST', url: `/api/deals/${b.handle}/${r}`, remoteAddress: '192.0.2.50', payload: {} })).statusCode);
    }
    statuses.add((await c.app.inject({ method: 'GET', url: '/api/health', remoteAddress: '192.0.2.50' })).statusCode);
  }
  assert.ok(byOffer < 100, `${byOffer} get_deal_id_by_offer reads`);
  assert.ok(statuses.has(429));
  assert.ok(balances <= 2, `${balances} balance reads`);
});

// ======================================================================
// TRUST_PROXY=true trusts every X-Forwarded-For hop, so
// behind a proxy that APPENDS (nginx $proxy_add_x_forwarded_for, most LBs)
// the client picks req.ip and bypasses the daily join cap per prefix.
// ======================================================================

test('TRUST_PROXY=true trusts one hop, so a spoofed X-Forwarded-For does not bypass the cap', async () => {
  assert.equal(parseTrustProxy('true'), 1);
  const c = await makeApp({ overrides: { trustProxy: parseTrustProxy('true') } });
  let ok = 0;
  for (let i = 0; i < 30; i++) {
    const b = makeOffer(randomKey(), { nowMs: c.clock.t });
    const xff = { 'x-forwarded-for': `100.${i}.0.1, 198.51.100.7` }; // proxy appended the real client IP
    await c.app.inject({ method: 'POST', url: '/api/deals', headers: xff, payload: { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms } });
    const r = await c.app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { ...xff, 'x-deal-token': b.token }, payload: { client_pk: randomKey().pk } });
    if (r.statusCode === 201) ok++;
  }
  assert.equal(ok, c.config.dailyJoinsPerIp);
});

// ======================================================================
// Privacy: Fastify's 404 log line carries the raw URL with
// the query string; a pay-status URL with a trailing slash leaks the address.
// ======================================================================

test('a 404 URL with a query string does not log the deposit address', async () => {
  const lines: string[] = [];
  const { Writable } = await import('node:stream');
  const stream = new Writable({ write(chunk, _e, cb) { lines.push(String(chunk)); cb(); } });
  const app = await buildApp({ config: testConfig(), chain: new FakeChain(), oneClick: new FakeOneClick(), store: new SqliteStore(':memory:'), logger: { level: 'info', stream } });
  await app.inject({ method: 'GET', url: `/api/deals/${'a'.repeat(64)}/pay-status/?deposit_address=SECRETDEPOSITADDR` });
  const all = lines.join('');
  assert.ok(!all.includes('SECRETDEPOSITADDR'));
  assert.ok(all.includes('"status":404'), 'the request is still logged (path + status)');
  await app.close();
});

// ======================================================================
// The pay quote's own deadline is not checked against what
// the server asked for (min(now+30 min, pay_by-1 h)). A quote deadline past
// the funding cutoff is passed to the client and also blocks cancel until then.
// ======================================================================

test('a quote that does not carry OUR signed deadline is refused; cancel is blocked only until our deadline', async () => {
  const clock = { t: Date.now() };
  const fake = new StrictChain();
  fake.nowNs = () => BigInt(clock.t) * 1_000_000n;
  const oc = new FakeOneClick();
  const app = await buildApp({ config: testConfig(), chain: fake, oneClick: oc, store: new SqliteStore(':memory:'), now: () => clock.t });
  const c: Ctx = { app, fake, config: testConfig(), clock };
  const { b, id } = await newDeal(c, creator, client);
  const late = new Date(Number(BigInt(fake.deals[id].funding_cutoff_ns) / 1_000_000n) + 86400_000).toISOString();
  oc.nextEchoOverride = { deadline: late };
  const q = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/pay-quote`, payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock.t) });
  assert.equal(q.statusCode, 502);
  assert.equal(q.json().error, 'quote_mismatch');
  // a normal quote: quote.deadline is 3 days later (real 1Click), our deadline 30 min
  const ok = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/pay-quote`, payload: signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, clock.t) });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(Date.parse(ok.json().address_inactive_at) > Date.parse(ok.json().deadline));
  clock.t += 2 * 3600_000;
  const cancel = await act(c, b, id, creator, 'cancel', '{}');
  assert.equal(cancel.statusCode, 200, 'nothing was stored, so cancel is not blocked');
});

test('server limits are tightened to the deployed contract config', async () => {
  const { alignWithContract } = await import('../src/config.ts');
  const cfg = testConfig({ maxOfferTtlSeconds: 7 * 86400, minReviewPeriodSeconds: 60, minDealAmount: 1_000_000n });
  const changed = alignWithContract(cfg, { max_offer_ttl_ns: String(3600n * SEC), min_review_period_ns: String(300n * SEC), min_amount: '2000000' });
  assert.equal(changed.length, 3);
  assert.equal(cfg.maxOfferTtlSeconds, 3600);
  assert.equal(cfg.minReviewPeriodSeconds, 300);
  assert.equal(cfg.minDealAmount, 2_000_000n);
  assert.deepEqual(alignWithContract(cfg, { max_offer_ttl_ns: String(7200n * SEC), min_review_period_ns: '1' }), [], 'never loosened');
});

test('a withdraw is never sent after its signed expiry', async () => {
  const { actionHardDeadline } = await import('../src/guards.ts');
  const deal = { review_ends_at_ns: '500', delivery_deadline_ns: '400' } as never;
  assert.equal(actionHardDeadline(deal, 'withdraw', { expires_at_ns: '12345' }), 12345n);
  assert.equal(actionHardDeadline(deal, 'accept'), null, 'accept has no time limit in the contract');
});

test('daily budgets per deal survive a server restart (SQLite); IP-prefix counters are not written to disk', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { DailyCounter, PERSISTED_COUNTERS } = await import('../src/guards.ts');
  const path = join(mkdtempSync(join(tmpdir(), 'escrow-')), 'db.sqlite');
  let t = 1_000_000;
  const s1 = new SqliteStore(path);
  const d1 = new DailyCounter(() => t, s1, (k) => PERSISTED_COUNTERS.test(k));
  for (let i = 0; i < 3; i++) d1.add('tx:7');
  d1.add('withdraw:7:client');
  d1.add('join:198.51.100.0/24');
  s1.close();
  const s2 = new SqliteStore(path); // "restart"
  const d2 = new DailyCounter(() => t, s2, (k) => PERSISTED_COUNTERS.test(k));
  assert.equal(d2.count('tx:7'), 3);
  assert.equal(d2.count('withdraw:7:client'), 1);
  assert.equal(d2.count('join:198.51.100.0/24'), 0, 'IP-prefix counters live in memory only');
  assert.equal(s2.countEventsSince('join:198.51.100.0/24', 0), 0, 'no IP prefix in the DB');
  t += 24 * 3600 * 1000 + 1;
  assert.equal(d2.count('tx:7'), 0, 'rolling 24 h window');
  s2.close();
});
