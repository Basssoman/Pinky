// Verified creator accounts and their use in the key
// reset, plus the code shapes. The page reader is faked in the
// route tests (no network); the separate fetch process is run for real on
// inputs that never reach the network.

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { isPublicAddress, judgePage, parseAccountUrl, runChild, verifyCode, VERIFY_CODE_RE, type AccountChecker, type CheckJob, type CheckResult } from '../src/accounts.ts';
import { readAccount } from '../src/account-fetch.ts';
import { buildApp } from '../src/app.ts';
import { parsePublicKey } from '../src/encoding.ts';
import {
  accountAddMessage,
  accountCheckMessage,
  accountRemoveMessage,
  accountsReadMessage,
  inboxMessage,
  keyResetCancelMessage,
  profileIdOf,
  profileWriteMessage,
  VERIFIED_PROOF_MIN_AGE_MS,
  type Market,
} from '../src/market.ts';
import { SqliteStore } from '../src/store.ts';
import { run as accountsCli } from '../scripts/market-accounts.ts';
import { confirmAuto, resetCode, run as resetCli } from '../scripts/market-key-reset.ts';
import { CONTRACT_ID, FakeChain, FakeOneClick, keyFromSeed, testConfig, type DealKey } from './helpers.ts';

const DAY = 24 * 3600_000;

/** What each account page "says" in these tests. */
class FakeChecker implements AccountChecker {
  pages = new Map<string, string>();
  jobs: CheckJob[] = [];
  async check(job: CheckJob): Promise<CheckResult> {
    this.jobs.push(job);
    if (job.platform === 'x') return 'manual';
    const page = this.pages.get(job.url);
    return page === undefined ? 'unreadable' : judgePage(page, job, job.codes);
  }
}

let chain: FakeChain;
let app: FastifyInstance;
let checker: FakeChecker;
let clock = Date.now();
let seq = 0n;
const exp = () => ((BigInt(clock) + 300_000n) * 1_000_000n + seq++).toString();
const market = () => (app as unknown as { market: Market }).market;

beforeEach(async () => {
  clock = Date.now();
  chain = new FakeChain();
  chain.nowNs = () => BigInt(clock) * 1_000_000n;
  checker = new FakeChecker();
  app = await buildApp({
    config: testConfig({ rateWritesPerMin: 1000, rateInvalidPerMin: 1000, rateReadsPerMin: 1000, accountRecheckHours: 24 }),
    chain,
    oneClick: new FakeOneClick(),
    store: new SqliteStore(':memory:'),
    now: () => clock,
    accountChecker: checker,
  });
});

type PKey = DealKey & { id: string };
const profKey = (seed: number): PKey => {
  const k = keyFromSeed(seed);
  return { ...k, id: profileIdOf(parsePublicKey(k.pk)!) };
};
const alice = profKey(81);
const thiefNew = profKey(82);
const owner2 = profKey(83);

async function profile(k: PKey = alice) {
  const profile = { nickname: 'Alice Motion', bio: 'Logo animations', categories: ['motion'], portfolio: ['https://www.youtube.com/@alicemotion'], contacts: [], services: [] };
  const e = exp();
  const r = await app.inject({
    method: 'PUT',
    url: `/api/profiles/${k.id}`,
    payload: { profile_pk: k.pk, profile, expires_at_ns: e, sig: k.signRaw(profileWriteMessage(CONTRACT_ID, k.id, profile, e)) },
  });
  assert.ok(r.statusCode === 201 || r.statusCode === 200, r.body);
}

async function add(url: string, k: PKey = alice) {
  const e = exp();
  return app.inject({
    method: 'POST',
    url: `/api/profiles/${k.id}/accounts`,
    payload: { profile_pk: k.pk, url, expires_at_ns: e, sig: k.signRaw(accountAddMessage(CONTRACT_ID, k.id, url, e)) },
  });
}
async function check(aid: string, k: PKey = alice) {
  const e = exp();
  return app.inject({
    method: 'POST',
    url: `/api/profiles/${k.id}/accounts/${aid}/check`,
    payload: { profile_pk: k.pk, expires_at_ns: e, sig: k.signRaw(accountCheckMessage(CONTRACT_ID, k.id, aid, e)) },
  });
}
async function list(k: PKey = alice) {
  const e = exp();
  const q = new URLSearchParams({ profile_pk: k.pk, expires_at_ns: e, sig: k.signRaw(accountsReadMessage(CONTRACT_ID, k.id, e)) });
  return app.inject({ method: 'GET', url: `/api/profiles/${k.id}/accounts?${q}` });
}
const publicProfile = async (k: PKey = alice) => (await app.inject({ method: 'GET', url: `/api/profiles/${k.id}` })).json();

const ytPage = (desc: string) => `<html><head><link rel="canonical" href="https://www.youtube.com/@alicemotion"><meta name="description" content="${desc}"></head><body>@alicemotion</body></html>`;

// ---------------------------------------------------------------- pure parts

test('account links: only the profile page of a YouTube channel, an X account or a Behance profile; one canonical form', () => {
  assert.deepEqual(parseAccountUrl('https://youtube.com/@AliceMotion?si=1'), { platform: 'youtube', url: 'https://www.youtube.com/@alicemotion', handle: '@alicemotion' });
  assert.deepEqual(parseAccountUrl('https://m.youtube.com/@alicemotion/videos'), { platform: 'youtube', url: 'https://www.youtube.com/@alicemotion', handle: '@alicemotion' });
  assert.equal(parseAccountUrl('https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv')?.url, 'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv');
  assert.deepEqual(parseAccountUrl('https://twitter.com/Alice_M'), { platform: 'x', url: 'https://x.com/alice_m', handle: '@alice_m' });
  assert.deepEqual(parseAccountUrl('https://behance.net/AliceM'), { platform: 'behance', url: 'https://www.behance.net/alicem', handle: '@alicem' });
  for (const bad of [
    'http://www.youtube.com/@alicemotion', // not https
    'https://www.youtube.com/watch?v=abc', // a video
    'https://x.com/alice/status/1', // a post
    'https://x.com/home',
    'https://www.behance.net/search',
    'https://youtube.com.evil.example/@alice', // look-alike host
    'https://user:pw@x.com/alice',
    'https://x.com:8443/alice',
    'https://vimeo.com/alice',
    'not a link',
  ]) {
    assert.equal(parseAccountUrl(bad), null, bad);
  }
});

test('addresses: private, loopback, link-local, carrier NAT, mapped and odd IPv6 forms are refused', () => {
  for (const ip of ['142.250.74.110', '151.101.1.69', '2a00:1450:4001:82a::200e', '2606:4700::6810:84e5']) assert.equal(isPublicAddress(ip), true, ip);
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    'fc12::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::',
    '2001:db8::1',
    'fe80::1%eth0',
    'localhost',
    '',
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test('page check: found / absent only on a page that names the account; a wall page never takes a mark away', () => {
  const ref = { url: 'https://www.youtube.com/@alicemotion', handle: '@alicemotion' };
  const code = verifyCode();
  assert.equal(judgePage(ytPage(`Logo animations. ${code}`), ref, [code]), 'found');
  assert.equal(judgePage(ytPage('Logo animations.'), ref, [code]), 'absent');
  assert.equal(judgePage('<html><title>Before you continue</title>Sign in</html>', ref, [code]), 'unreadable');
  // Escaped forms in meta tags and JSON still count.
  const enc = code.replace('-', '\\u002d');
  assert.equal(judgePage(`${ytPage('x')}<script>{"description":"${enc}"}</script>`, ref, [code]), 'found');
});

test('codes: the verification code and the key-reset code look different; random per account', () => {
  const a = verifyCode();
  const b = verifyCode();
  assert.match(a, VERIFY_CODE_RE);
  assert.notEqual(a, b);
  assert.match(resetCode(), /^СБРОС-КЛЮЧА-/);
  assert.doesNotMatch(a, /СБРОС|RESET/i);
});

test('the fetch process: X and bad hosts never touch the network; no secret of the server reaches it', async () => {
  assert.equal((await readAccount({ platform: 'x', url: 'https://x.com/alice', handle: '@alice', codes: ['pinky-0123456789'] })).result, 'manual');
  assert.equal((await readAccount({ platform: 'youtube', url: 'https://youtube.com.evil.example/@a', handle: '@a', codes: ['x'] })).result, 'refused');
  assert.equal((await readAccount({ platform: 'youtube', url: 'http://www.youtube.com/@a', handle: '@a', codes: ['x'] })).result, 'refused');
  // The real child script: same answers through the process boundary.
  const script = fileURLToPath(new URL('../src/account-fetch.js', import.meta.url));
  assert.equal((await runChild(script, { platform: 'x', url: 'https://x.com/alice', handle: '@alice', codes: ['c'] })).result, 'manual');
  assert.equal((await runChild(script, { platform: 'behance', url: 'https://evil.example/alice', handle: '@alice', codes: ['c'] })).result, 'refused');
  // Empty environment: a stand-in child prints the names it can see.
  const dir = mkdtempSync(join(tmpdir(), 'pinky-env-'));
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `process.stdout.write(JSON.stringify({ result: 'found', why: Object.keys(process.env).join(',') }));`);
  process.env.PINKY_TEST_SECRET = 'do-not-leak';
  try {
    const a = await runChild(probe, { platform: 'youtube', url: 'https://www.youtube.com/@a', handle: '@a', codes: ['c'] });
    assert.equal(a.result, 'found');
    assert.doesNotMatch(a.why ?? '', /PINKY_TEST_SECRET|TELEGRAM|RELAYER|ONECLICK|NEARAI/);
  } finally {
    delete process.env.PINKY_TEST_SECRET;
  }
});

// ---------------------------------------------------------------- routes

test('add an account -> code per (profile, account) -> "Check now" finds it -> public "account confirmed: @handle"', async () => {
  await profile();
  const r = await add('https://youtube.com/@AliceMotion');
  assert.equal(r.statusCode, 201, r.body);
  const a = r.json().account;
  assert.equal(a.status, 'waiting');
  assert.equal(a.handle, '@alicemotion');
  assert.match(a.code, VERIFY_CODE_RE);
  assert.equal(a.by_hand, false);
  // The same link again: the same code (not a new one).
  assert.equal((await add('https://www.youtube.com/@alicemotion')).json().account.code, a.code);
  // Not public before it is confirmed; the code is never public.
  assert.deepEqual((await publicProfile()).accounts, []);
  checker.pages.set(a.url, ytPage('Logo animations'));
  const c1 = await check(a.account_id);
  assert.equal(c1.json().result, 'absent');
  assert.equal(c1.json().account.status, 'waiting');
  checker.pages.set(a.url, ytPage(`Logo animations ${a.code}`));
  const c2 = await check(a.account_id);
  assert.equal(c2.json().result, 'found');
  assert.equal(c2.json().account.status, 'confirmed');
  const pub = await publicProfile();
  assert.deepEqual(pub.accounts, [{ platform: 'youtube', handle: '@alicemotion', url: 'https://www.youtube.com/@alicemotion' }]);
  assert.ok(!JSON.stringify(pub).includes(a.code), 'the code is not public');
  // The log keeps how it was made (not public).
  assert.equal(market().store.getAccount(a.account_id)!.method, 'auto');
  // The owner's signed list has the code.
  assert.equal((await list()).json().items[0].code, a.code);
});

test('a code of another profile does not confirm; signatures and limits', async () => {
  await profile();
  await profile(owner2);
  const a = (await add('https://www.youtube.com/@alicemotion')).json().account;
  const b = (await add('https://www.youtube.com/@alicemotion', owner2)).json().account;
  assert.notEqual(a.code, b.code, 'random per (profile, account)');
  checker.pages.set(a.url, ytPage(`hi ${b.code}`));
  assert.equal((await check(a.account_id)).json().result, 'absent');
  // Another key cannot read, check or remove alice's accounts.
  const e = exp();
  const bad = await app.inject({
    method: 'POST',
    url: `/api/profiles/${alice.id}/accounts/${a.account_id}/check`,
    payload: { expires_at_ns: e, sig: owner2.signRaw(accountCheckMessage(CONTRACT_ID, alice.id, a.account_id, e)) },
  });
  assert.equal(bad.statusCode, 401);
  // Account id of another profile: not found.
  assert.equal((await check(b.account_id)).statusCode, 404);
  // Only account links; at most 3.
  assert.equal((await add('https://www.youtube.com/watch?v=1')).json().error, 'bad_account');
  assert.equal((await add('https://x.com/alice_m')).statusCode, 201);
  assert.equal((await add('https://www.behance.net/alicem')).statusCode, 201);
  assert.equal((await add('https://www.behance.net/alicem2')).json().error, 'too_many_accounts');
});

test('X: the site cannot read the bio -> waits for the team; the operator confirms by hand (the log says so)', async () => {
  await profile();
  const a = (await add('https://x.com/Alice_M')).json().account;
  assert.equal(a.by_hand, true);
  const c = await check(a.account_id);
  assert.equal(c.json().result, 'manual');
  assert.equal(c.json().account.status, 'review');
  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  assert.equal(await accountsCli(market().store, ['waiting'], out, checker), 0);
  assert.ok(lines.some((l) => l.includes(a.account_id) && l.includes(a.code)));
  assert.equal(await accountsCli(market().store, ['confirm', a.account_id], out, checker), 1, 'needs --seen-in-bio');
  assert.equal(await accountsCli(market().store, ['confirm', a.account_id, '--seen-in-bio'], out, checker), 0);
  assert.deepEqual((await publicProfile()).accounts, [{ platform: 'x', handle: '@alice_m', url: 'https://x.com/alice_m' }]);
  assert.equal(market().store.getAccount(a.account_id)!.method, 'operator');
  // The operator sees the code gone: the mark goes.
  assert.equal(await accountsCli(market().store, ['lost', a.account_id], out, checker), 0);
  assert.deepEqual((await publicProfile()).accounts, []);
});

test('re-check: the mark goes when the code is gone (2 reads in a row); a page the site cannot read keeps it', async () => {
  await profile();
  const a = (await add('https://www.youtube.com/@alicemotion')).json().account;
  checker.pages.set(a.url, ytPage(a.code));
  await check(a.account_id);
  assert.equal((await publicProfile()).accounts.length, 1);
  // A day later the page cannot be read (consent wall): the mark stays.
  checker.pages.delete(a.url);
  clock += DAY + 1;
  assert.equal(await market().recheckAccounts(), 1);
  assert.equal((await publicProfile()).accounts.length, 1);
  // The code was removed: one miss keeps it (a glitch), the second removes it.
  checker.pages.set(a.url, ytPage('new bio'));
  clock += DAY + 1;
  await market().recheckAccounts();
  assert.equal((await publicProfile()).accounts.length, 1);
  clock += DAY + 1;
  await market().recheckAccounts();
  assert.deepEqual((await publicProfile()).accounts, []);
  assert.equal(market().store.getAccount(a.account_id)!.status, 'lost');
  // Not read again before ACCOUNT_RECHECK_HOURS: nothing to do.
  assert.equal(await market().recheckAccounts(), 0);
  // Put back: "Check now" confirms again.
  checker.pages.set(a.url, ytPage(a.code));
  assert.equal((await check(a.account_id)).json().account.status, 'confirmed');
  // The owner removes it.
  const e = exp();
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/profiles/${alice.id}/accounts/${a.account_id}`,
    payload: { profile_pk: alice.pk, expires_at_ns: e, sig: alice.signRaw(accountRemoveMessage(CONTRACT_ID, alice.id, a.account_id, e)) },
  });
  assert.equal(del.statusCode, 200, del.body);
  assert.deepEqual((await publicProfile()).accounts, []);
});

// ---------------------------------------------------------------- #78

async function inboxKeyChange() {
  const e = exp();
  const q = new URLSearchParams({ profile_pk: alice.pk, expires_at_ns: e, sig: alice.signRaw(inboxMessage(CONTRACT_ID, alice.id, e)) });
  return (await app.inject({ method: 'GET', url: `/api/profiles/${alice.id}/requests?${q}` })).json().key_change;
}
async function ownerCancel(resetId: string) {
  const e = exp();
  return app.inject({
    method: 'POST',
    url: `/api/profiles/${alice.id}/key-reset/cancel`,
    payload: { profile_pk: alice.pk, reset_id: resetId, expires_at_ns: e, sig: alice.signRaw(keyResetCancelMessage(CONTRACT_ID, alice.id, resetId, e)) },
  });
}

test('#78: a reset proved through an account confirmed 14+ days before cannot be cancelled by the current key', async () => {
  await profile();
  const a = (await add('https://www.youtube.com/@alicemotion')).json().account;
  checker.pages.set(a.url, ytPage(a.code));
  await check(a.account_id);
  clock += VERIFIED_PROOF_MIN_AGE_MS + DAY;
  const ms = market().store;
  const lines: string[] = [];
  const out = (s: string) => lines.push(s);
  assert.equal(resetCli(ms, ['issue', alice.id, thiefNew.pk, 'https://youtube.com/@AliceMotion'], out), 0);
  assert.ok(lines.some((l) => l.startsWith('PROOF:')));
  const reset = ms.openReset(alice.id)!;
  assert.equal(reset.proof, 'verified');
  // --auto: the site reads the reset code in the bio (the English line also counts).
  checker.pages.set(a.url, ytPage(`${a.code} ${reset.code.replace('СБРОС-КЛЮЧА', 'PINKY-KEY-RESET')}`));
  assert.equal(await confirmAuto(ms, reset.reset_id, out, checker), 0);
  assert.equal(ms.getReset(reset.reset_id)!.status, 'pending');
  const kc = await inboxKeyChange();
  assert.equal(kc.cancellable, false);
  const r = await ownerCancel(reset.reset_id);
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().error, 'verified_proof');
  // Support can still stop it.
  assert.equal(resetCli(ms, ['cancel', reset.reset_id], out), 0);
});

test('#78: an account confirmed only recently (a thief could add one) gives no proof: the current key can cancel', async () => {
  await profile();
  const a = (await add('https://www.youtube.com/@alicemotion')).json().account;
  checker.pages.set(a.url, ytPage(a.code));
  await check(a.account_id);
  clock += 2 * DAY;
  const ms = market().store;
  const out = () => {};
  assert.equal(resetCli(ms, ['issue', alice.id, thiefNew.pk, a.url], out), 0);
  const reset = ms.openReset(alice.id)!;
  assert.equal(reset.proof, null);
  // --auto without the code in the bio: not confirmed.
  assert.equal(await confirmAuto(ms, reset.reset_id, out, checker), 1);
  assert.equal(resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], out), 0);
  assert.equal((await inboxKeyChange()).cancellable, true);
  assert.equal((await ownerCancel(reset.reset_id)).statusCode, 200);
});

test('#78: the proof drops when the account lost its mark before the operator confirms', async () => {
  await profile();
  const a = (await add('https://www.youtube.com/@alicemotion')).json().account;
  checker.pages.set(a.url, ytPage(a.code));
  await check(a.account_id);
  clock += VERIFIED_PROOF_MIN_AGE_MS + DAY;
  const ms = market().store;
  const out = () => {};
  resetCli(ms, ['issue', alice.id, thiefNew.pk, a.url], out);
  const reset = ms.openReset(alice.id)!;
  assert.equal(reset.proof, 'verified');
  ms.markLost(a.account_id);
  assert.equal(resetCli(ms, ['confirm', reset.reset_id, '--seen-in-bio'], out), 0);
  assert.equal(ms.getReset(reset.reset_id)!.proof, null);
  assert.equal((await ownerCancel(reset.reset_id)).statusCode, 200);
});
