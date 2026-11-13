// Request life, the profile-key proofs the client's browser checks and the
// profile key reset by support. Mocked chain (FakeChain), in-memory SQLite.

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { beforeEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.ts';
import { parsePublicKey, sha256Hex, verifySignature } from '../src/encoding.ts';
import {
  declineMessage,
  declineReasonMessage,
  discussMessage,
  inboxMessage,
  keyResetCancelMessage,
  profileIdOf,
  profileWriteMessage,
  requestDealMessage,
  type Market,
} from '../src/market.ts';
import { run as resetCli } from '../scripts/market-key-reset.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, makeOffer, testConfig, type DealKey } from './helpers.ts';

let chain: FakeChain;
let app: FastifyInstance;
let clock = Date.now();
const DAY = 24 * 3600_000;

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  app = await buildApp({
    config: testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000 }),
    chain,
    oneClick: new FakeOneClick(),
    store: new (await import('../src/store.ts')).SqliteStore(':memory:'),
    now: () => clock,
  });
});

const market = () => (app as unknown as { market: Market }).market;
type PKey = DealKey & { id: string };
const profKey = (seed: number): PKey => {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
};
const alice = profKey(61);
const thief = profKey(62);
const fresh = profKey(63);
const creatorDeal = keyFromSeed(64);

let seq = 0n;
const exp = (aheadMs = 5 * 60_000) => ((BigInt(clock) + BigInt(aheadMs)) * 1_000_000n + seq++).toString();

const profileBody = (nickname = 'Alice Motion', contact = '@alice_motion') => ({
  nickname,
  bio: 'Logo animations',
  categories: ['motion'],
  portfolio: ['https://www.behance.net/alice'],
  contacts: [{ kind: 'telegram', value: contact }],
  services: [{ title: 'Logo animation', description: '10 s', price_from_usdc: 150, delivery_days: 5 }],
});

function put(k: DealKey, id: string, profile: unknown) {
  const e = exp();
  return app.inject({
    method: 'PUT',
    url: `/api/profiles/${id}`,
    payload: { profile_pk: k.pk, profile, expires_at_ns: e, sig: k.signRaw(profileWriteMessage(CONTRACT_ID, id, profile, e)) },
  });
}

async function openRequest(profileId: string) {
  const token = randomBytes(16).toString('hex');
  const handle = sha256Hex(token);
  const res = await app.inject({
    method: 'POST',
    url: '/api/requests',
    payload: { handle, profile_id: profileId, brief: 'A logo animation', client_contact: { kind: 'telegram', value: '@client' }, client_box_pk: randomBytes(32).toString('hex') },
  });
  assert.equal(res.statusCode, 201, res.body);
  return { token, handle, pinned: res.json().profile_pk as string };
}

const byKey = async (pk: string) => (await app.inject({ method: 'GET', url: `/api/profiles/by-key?pk=${encodeURIComponent(pk)}` })).json();

const view = async (r: { handle: string; token: string }) =>
  (await app.inject({ method: 'GET', url: `/api/requests/${r.handle}`, headers: { 'x-request-token': r.token } })).json();

function inbox(k: PKey) {
  const e = exp();
  const q = new URLSearchParams({ profile_pk: k.pk, expires_at_ns: e, sig: k.signRaw(inboxMessage(CONTRACT_ID, k.id, e)) });
  return app.inject({ method: 'GET', url: `/api/profiles/${k.id}/requests?${q}` });
}

function discuss(k: DealKey, handle: string) {
  const e = exp();
  return app.inject({ method: 'POST', url: `/api/requests/${handle}/discuss`, payload: { expires_at_ns: e, sig: k.signRaw(discussMessage(CONTRACT_ID, handle, e)) } });
}

/** `signedReason` null = sign the message without a reason. */
function decline(k: DealKey, handle: string, reason?: string, signedReason: string | null | undefined = reason) {
  const e = exp();
  const msg = signedReason === undefined || signedReason === null ? declineMessage(CONTRACT_ID, handle, e) : declineReasonMessage(CONTRACT_ID, handle, signedReason, e);
  return app.inject({ method: 'POST', url: `/api/requests/${handle}/decline`, payload: { reason, expires_at_ns: e, sig: k.signRaw(msg) } });
}

const cancel = (r: { handle: string; token: string }) =>
  app.inject({ method: 'POST', url: `/api/requests/${r.handle}/cancel`, headers: { 'x-request-token': r.token }, payload: {} });

async function dealFrom(k: DealKey, requestHandle: string, offerExpiresMs = 3600_000) {
  const b = makeOffer(creatorDeal, { nowMs: clock, expiresNs: BigInt(clock + offerExpiresMs) * 1_000_000n });
  const e = exp();
  const res = await app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: {
      handle: b.handle,
      offer: b.offer,
      offer_signature: b.offer_signature,
      terms: b.terms,
      request_handle: requestHandle,
      request_expires_at_ns: e,
      request_sig: k.signRaw(requestDealMessage(CONTRACT_ID, requestHandle, creatorDeal.pk, e)),
      deal_link_box: { epk: 'a'.repeat(64), iv: 'b'.repeat(24), ct: 'c'.repeat(96) },
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return b;
}

// ---------------------------------------------------------------- what the client's browser checks

test('request view: the profile key, the signed profile and the deal proof verify against that key', async () => {
  assert.equal((await put(alice, alice.id, profileBody())).statusCode, 201);
  // Not in public output; the client gets it when sending the request (and pins it).
  const pub = await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` });
  assert.ok(!pub.body.includes(alice.pk));
  const r = await openRequest(alice.id);
  assert.equal(r.pinned, alice.pk);
  let v = await view(r);
  assert.equal(v.profile.profile_pk, alice.pk);
  assert.equal(v.deal_proof, null);
  // The signed profile: the nickname comes from what the profile key signed.
  const pp = v.profile_proof;
  assert.equal(pp.profile.nickname, 'Alice Motion');
  assert.ok(verifySignature(alice.pk, profileWriteMessage(CONTRACT_ID, alice.id, pp.profile, pp.expires_at_ns), pp.sig));
  assert.ok(!verifySignature(thief.pk, profileWriteMessage(CONTRACT_ID, alice.id, pp.profile, pp.expires_at_ns), pp.sig));
  // A served nickname changed by someone else would not match the signature.
  assert.ok(!verifySignature(alice.pk, profileWriteMessage(CONTRACT_ID, alice.id, { ...pp.profile, nickname: 'Mallory' }, pp.expires_at_ns), pp.sig));

  await dealFrom(alice, r.handle);
  v = await view(r);
  assert.equal(v.status, 'deal_ready');
  const dp = v.deal_proof;
  assert.equal(dp.creator_pk, creatorDeal.pk);
  assert.equal(dp.profile_pk, alice.pk);
  assert.ok(verifySignature(alice.pk, requestDealMessage(CONTRACT_ID, r.handle, dp.creator_pk, dp.expires_at_ns), dp.sig));
  // Bound to this request: the same proof does not fit another request.
  assert.ok(!verifySignature(alice.pk, requestDealMessage(CONTRACT_ID, 'f'.repeat(64), dp.creator_pk, dp.expires_at_ns), dp.sig));
});

// ---------------------------------------------------------------- request life

test('request life: sent -> viewed (inbox read) -> in discussion -> declined with a reason', async () => {
  await put(alice, alice.id, profileBody());
  const r = await openRequest(alice.id);
  assert.equal((await view(r)).status, 'open');
  assert.ok((await view(r)).closes_at);
  // The creator sees it as new once; then it is "viewed" for both.
  const first = (await inbox(alice)).json();
  assert.equal(first.items[0].status, 'open');
  assert.equal((await view(r)).status, 'viewed');
  assert.equal((await inbox(alice)).json().items[0].status, 'viewed');
  // Only the profile key can mark it "in discussion".
  assert.equal((await discuss(thief, r.handle)).statusCode, 401);
  const d = await discuss(alice, r.handle);
  assert.equal(d.statusCode, 200, d.body);
  let v = await view(r);
  assert.equal(v.status, 'discussing');
  assert.equal(v.closes_at, null);
  // A reason must be signed: a signature without it does not cover a reason added on the way.
  assert.equal((await decline(alice, r.handle, 'Too busy this month', null)).statusCode, 401);
  assert.equal((await decline(alice, r.handle, ' padded ')).json().error, 'bad_reason');
  assert.equal((await decline(alice, r.handle, 'x'.repeat(301))).json().error, 'bad_reason');
  const dec = await decline(alice, r.handle, 'Too busy this month');
  assert.equal(dec.statusCode, 200, dec.body);
  v = await view(r);
  assert.equal(v.status, 'declined');
  assert.equal(v.decline_reason, 'Too busy this month');
  assert.equal((await inbox(alice)).json().items[0].decline_reason, 'Too busy this month');
  assert.equal((await discuss(alice, r.handle)).json().error, 'declined');
  // A decline without a reason still works (old message).
  const r2 = await openRequest(alice.id);
  assert.equal((await decline(alice, r2.handle)).statusCode, 200);
  assert.equal((await view(r2)).decline_reason, null);
});

test('request life: no answer for 7 days closes it; an answered one stays', async () => {
  await put(alice, alice.id, profileBody());
  const quiet = await openRequest(alice.id);
  const seen = await openRequest(alice.id);
  const talked = await openRequest(alice.id);
  await inbox(alice); // both become "viewed"
  await discuss(alice, talked.handle);
  clock += 7 * DAY - 60_000;
  assert.equal((await view(quiet)).status, 'viewed');
  clock += 2 * 60_000;
  assert.equal((await view(quiet)).status, 'closed');
  assert.equal((await view(seen)).status, 'closed');
  assert.equal((await view(talked)).status, 'discussing');
  // Closed: no cancel, no answer, no deal.
  assert.equal((await cancel(quiet)).json().error, 'closed');
  assert.equal((await discuss(alice, quiet.handle)).json().error, 'closed');
  assert.equal((await decline(alice, quiet.handle)).json().error, 'closed');
  const e = exp();
  const b = makeOffer(creatorDeal, { nowMs: clock });
  const res = await app.inject({
    method: 'POST',
    url: '/api/deals',
    payload: {
      handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms,
      request_handle: quiet.handle, request_expires_at_ns: e, request_sig: alice.signRaw(requestDealMessage(CONTRACT_ID, quiet.handle, creatorDeal.pk, e)),
    },
  });
  assert.equal(res.json().error, 'request_closed');
  // The client may still cancel a request in discussion.
  assert.equal((await cancel(talked)).statusCode, 200);
});

test('request life: a deal that expired unpaid or was cancelled puts the request back "in discussion"', async () => {
  await put(alice, alice.id, profileBody());
  // Never joined: back once the offer expired.
  const r = await openRequest(alice.id);
  await dealFrom(alice, r.handle, 3600_000);
  assert.equal((await view(r)).status, 'deal_ready');
  clock += 3600_000 + 31_000;
  let v = await view(r);
  assert.equal(v.status, 'discussing');
  assert.equal(v.deal_link_box, null);
  // A new deal from it: ready again; the client cannot cancel while it waits.
  await dealFrom(alice, r.handle);
  assert.equal((await view(r)).status, 'deal_ready');
  assert.equal((await cancel(r)).json().error, 'deal_created');

  // Joined, then expired unpaid on-chain: the refresher puts it back.
  const r2 = await openRequest(alice.id);
  const b = await dealFrom(alice, r2.handle);
  const j = await app.inject({ method: 'POST', url: `/api/deals/${b.handle}/join`, headers: { 'x-deal-token': b.token }, payload: { client_pk: keyFromSeed(65).pk } });
  assert.equal(j.statusCode, 201, j.body);
  Object.assign(chain.deals[j.json().deal_id], { state: 'Expired' });
  clock += 31_000;
  await market().refreshLinks();
  assert.equal((await view(r2)).status, 'discussing');
  // Only the newest deal of a request counts: an older dead deal does not reopen a newer live one.
  const r3 = await openRequest(alice.id);
  const old = await dealFrom(alice, r3.handle, 3600_000);
  await dealFrom(alice, r3.handle, 10 * 3600_000);
  clock += 3600_000 + 31_000;
  await market().refreshLinks();
  assert.equal((await view(r3)).status, 'deal_ready');
  assert.ok(market().store.getLink(old.handle)!.final);
});

// ---------------------------------------------------------------- key reset by support

test('key reset: code from the CLI, 72 h wait, then the new key owns the profile; the old one is out', async () => {
  await put(thief, thief.id, profileBody('Thief', '@thief')); // another profile (its key cannot be used as a new key)
  await put(alice, alice.id, profileBody());
  const ms = market().store;
  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  // The new key must be new.
  assert.equal(resetCli(ms, ['issue', alice.id, thief.pk, 'https://www.behance.net/alice'], out), 1);
  assert.equal(resetCli(ms, ['issue', alice.id, fresh.pk, 'https://www.behance.net/alice'], out), 0);
  const reset = ms.openReset(alice.id)!;
  assert.match(reset.code, /^СБРОС-КЛЮЧА-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(lines.some((l) => l.includes(reset.code) && l.includes('не ставьте')));
  // While issued, the new key cannot start its own profile.
  assert.equal((await put(fresh, fresh.id, profileBody('Fresh'))).json().error, 'key_in_use');
  // Not yet confirmed: nothing public.
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json().key_changing, false);
  assert.equal(resetCli(ms, ['confirm', reset.reset_id], out), 1); // needs --seen-in-bio
  assert.equal(resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], out), 0);
  const prof = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(prof.key_changing, true);
  // The owner (current key) sees the id and the time in the signed inbox, to cancel.
  const kc = (await inbox(alice)).json().key_change;
  assert.equal(kc.reset_id, reset.reset_id);
  assert.equal(Date.parse(kc.effective_at) - clock, 72 * 3600_000);
  assert.equal((await byKey(alice.pk)).profile_id, alice.id);
  const log = (await app.inject({ method: 'GET', url: '/api/key-resets' })).json().items;
  assert.equal(log.length, 1);
  assert.equal(log[0].status, 'pending');
  assert.ok(!JSON.stringify(log).includes(reset.code) && !JSON.stringify(log).includes(fresh.pk));
  const pending = await byKey(fresh.pk);
  assert.equal(pending.profile_id, null);
  assert.equal(pending.pending.profile_id, alice.id);

  clock += 72 * 3600_000 + 1000;
  const after = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(after.key_changing, false);
  assert.deepEqual(after.recent_change, { what: 'key', days_ago: 0 });
  assert.equal((await byKey(fresh.pk)).profile_id, alice.id);
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/by-key?pk=${encodeURIComponent(alice.pk)}` })).statusCode, 404);
  // The old key is out; the new key writes the SAME profile id (no longer the hash of the key).
  assert.equal((await put(alice, alice.id, profileBody('Stolen'))).statusCode, 403);
  const w = await put(fresh, alice.id, profileBody('Alice Motion'));
  assert.equal(w.statusCode, 200, w.body);
  assert.equal((await app.inject({ method: 'GET', url: '/api/key-resets' })).json().items[0].status, 'changed');
  // A request sent now pins the new key; the old signed profile is gone until the next save, then signed by the new key.
  const r = await openRequest(alice.id);
  const v = await view(r);
  assert.equal(v.profile.profile_pk, fresh.pk);
  assert.equal(v.profile.recent_change.what, 'key');
  assert.equal(r.pinned, fresh.pk);
  assert.ok(verifySignature(fresh.pk, profileWriteMessage(CONTRACT_ID, alice.id, v.profile_proof.profile, v.profile_proof.expires_at_ns), v.profile_proof.sig));
  // 14 days later the note is gone.
  clock += 14 * DAY;
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json().recent_change, null);
});

test('key reset: the current key cancels it with one signature; operator cancel; contact change note', async () => {
  await put(alice, alice.id, profileBody());
  const ms = market().store;
  const quiet = () => undefined;
  resetCli(ms, ['issue', alice.id, fresh.pk, 'https://www.behance.net/alice'], quiet);
  const reset = ms.openReset(alice.id)!;
  resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], quiet);
  const cancelBy = (k: DealKey, rid = reset.reset_id) => {
    const e = exp();
    return app.inject({
      method: 'POST',
      url: `/api/profiles/${alice.id}/key-reset/cancel`,
      payload: { reset_id: rid, expires_at_ns: e, sig: k.signRaw(keyResetCancelMessage(CONTRACT_ID, alice.id, rid, e)) },
    });
  };
  assert.equal((await cancelBy(fresh)).statusCode, 401); // the NEW key cannot (only the current one)
  const c = await cancelBy(alice);
  assert.equal(c.statusCode, 200, c.body);
  assert.equal((await cancelBy(alice)).json().error, 'reset_done');
  clock += 73 * 3600_000;
  assert.equal((await byKey(alice.pk)).profile_id, alice.id);
  assert.equal(ms.getReset(reset.reset_id)!.cancelled_by, 'owner_key');
  // Operator cancel and the log.
  resetCli(ms, ['issue', alice.id, fresh.pk, 'https://x.com/alice'], quiet);
  const second = ms.openReset(alice.id)!;
  assert.equal(resetCli(ms, ['cancel', second.reset_id], quiet), 0);
  assert.equal(resetCli(ms, ['cancel', second.reset_id], quiet), 1);
  // Contacts changed: "contact changed N days ago" for 14 days.
  assert.equal((await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json().recent_change, null);
  await put(alice, alice.id, profileBody('Alice Motion', '@alice_new'));
  const p = (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}` })).json();
  assert.equal(p.recent_change.what, 'contact');
});
