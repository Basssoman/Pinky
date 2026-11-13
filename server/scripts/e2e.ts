// End-to-end: local near-sandbox + escrow wasm + mock FT + the real server
// process, walking deals through the full lifecycle via the REST API with the
// OFFER flow: the creator's "browser" signs an offer, the client's "browser"
// generates its own key and joins. Nothing touches a public network: the
// 1Click base URL is pointed at a closed local port.
//
// Usage (WSL): bash scripts/e2e.sh   (builds wasm, finds the sandbox binary)
// Env: NEAR_SANDBOX_BIN, ESCROW_WASM, FT_WASM

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';

import { keyFingerprint, revokeOfferMessage } from '../src/encoding.ts';
import { makeOffer, randomKey, signedRequest, type DealKey, type OfferBundle } from '../test/helpers.ts';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required (run scripts/e2e.sh)`);
  return v;
};

const procs: ChildProcess[] = [];
let home = '';
function cleanup() {
  for (const p of procs) p.kill('SIGKILL');
  if (home) rmSync(home, { recursive: true, force: true });
}
process.on('exit', cleanup);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => res(port));
    });
    s.on('error', rej);
  });
}

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${what}`);
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  console.log(`  ok - ${msg}`);
}

/** Pay window and grace of the local test instance (seconds). */
const PAY_BY_S = 25;
const GRACE_S = 3;
/** 3% fee from the creator's share (contract v2). */
const fee = (creatorShare: bigint) => (creatorShare * 300n) / 10_000n;

async function main() {
  const bin = env('NEAR_SANDBOX_BIN');
  const escrowWasm = readFileSync(env('ESCROW_WASM'));
  const ftWasm = readFileSync(env('FT_WASM'));

  // 1. sandbox
  home = mkdtempSync(join(tmpdir(), 'escrow-e2e-'));
  await new Promise<void>((res, rej) => {
    const p = spawn(bin, ['--home', home, 'init', '--fast'], { stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`sandbox init exit ${code}`))));
  });
  const rpcPort = await freePort();
  const netPort = await freePort();
  const log = openSync(join(home, 'sandbox.log'), 'a');
  procs.push(
    spawn(bin, ['--home', home, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`, '--network-addr', `127.0.0.1:${netPort}`], {
      stdio: ['ignore', log, log],
    }),
  );
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  await waitFor('sandbox rpc', async () => !!(await provider.viewBlock({ finality: 'final' })));
  console.log(`sandbox up at ${rpcUrl}`);

  const validator = JSON.parse(readFileSync(join(home, 'validator_key.json'), 'utf8')) as { account_id: string; secret_key: string };
  const rootId = validator.account_id;
  const root = new Account(rootId, provider, validator.secret_key as KeyPairString);
  const rootPk = KeyPair.fromString(validator.secret_key as KeyPairString).getPublicKey();
  const relayerKey = KeyPair.fromRandom('ed25519');

  // 2. accounts + contracts (owner = root, separate from relayer and arbiter)
  const ids = {
    escrow: `escrow.${rootId}`,
    ft: `usdc.${rootId}`,
    relayer: `relayer.${rootId}`,
    arbiter: `arbiter.${rootId}`,
    payer: `payer.${rootId}`,
    fees: `fees.${rootId}`,
  };
  for (const [name, id] of Object.entries(ids)) {
    await root.createSubAccount({
      accountOrPrefix: id,
      publicKey: name === 'relayer' ? relayerKey.getPublicKey() : rootPk,
      nearToTransfer: nearToYocto(50),
    });
  }
  // Payout destinations must exist: the server refuses withdraws to named
  // accounts that do not.
  for (const prefix of ['payout-dest-1', 'payout-dest-2', 'refund-dest-3', 'c4', 'k4', 'c5', 'k5', 'k6', 'k7', 'k8']) {
    await root.createSubAccount({ accountOrPrefix: `${prefix}.${rootId}`, publicKey: rootPk, nearToTransfer: nearToYocto(1) });
  }
  const as = (id: string) => new Account(id, provider, validator.secret_key as KeyPairString);
  await as(ids.ft).deployContract(new Uint8Array(ftWasm));
  await as(ids.ft).callFunction({ contractId: ids.ft, methodName: 'new', args: {} });
  await as(ids.escrow).deployContract(new Uint8Array(escrowWasm));
  // `new` is #[private]: called by the escrow account itself
  await as(ids.escrow).callFunction({
    contractId: ids.escrow,
    methodName: 'new',
    args: {
      owner_id: rootId,
      token_id: ids.ft,
      arbiter_id: ids.arbiter,
      relayer_id: ids.relayer,
      fee_account_id: ids.fees,
      // Short periods for this local test instance (contract v2 init params).
      periods: {
        min_review_period_ns: String(1_000_000_000),
        dispute_period_ns: String(4_000_000_000),
        pay_by_period_ns: String(PAY_BY_S * 1_000_000_000),
        funding_grace_ns: String(GRACE_S * 1_000_000_000),
      },
    },
  });
  for (const id of [ids.escrow, ids.fees]) {
    await root.callFunction({ contractId: ids.ft, methodName: 'storage_deposit', args: { account_id: id }, deposit: nearToYocto('0.01') });
  }
  await root.callFunction({ contractId: ids.ft, methodName: 'mint', args: { account_id: ids.payer, amount: '1000000000' } });
  console.log('contracts deployed');

  // 3. server (real process, real NearChain relayer)
  const port = await freePort();
  const serverLog = openSync(join(home, 'server.log'), 'a');
  procs.push(
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(SERVER_DIR, 'dist', 'src', 'main.js')], {
      stdio: ['ignore', serverLog, serverLog],
      env: {
        ...process.env,
        ENV_FILE: '',
        PORT: String(port),
        HOST: '127.0.0.1',
        NEAR_NETWORK: 'sandbox',
        NEAR_RPC_URL: rpcUrl,
        ESCROW_CONTRACT_ID: ids.escrow,
        RELAYER_ACCOUNT_ID: ids.relayer,
        RELAYER_PRIVATE_KEY: relayerKey.toString(),
        // never reach the real 1Click from the e2e run
        ONECLICK_API_KEY: 'unused-in-e2e',
        ONECLICK_BASE_URL: 'http://127.0.0.1:9',
        ONECLICK_FORCE_DRY: 'true',
        DB_PATH: join(home, 'e2e.sqlite'),
        MIN_REVIEW_PERIOD_SECONDS: '1',
        MIN_DELIVERY_SECONDS: '1',
        RATE_WRITES_PER_MIN: '1000',
        USDC_ASSET_ID: 'nep141:' + ids.ft,
        LOG_LEVEL: 'warn',
      },
    }),
  );
  const api = `http://127.0.0.1:${port}`;
  await waitFor('server', async () => (await fetch(`${api}/api/config`)).ok, 30_000);
  const cfg = (await (await fetch(`${api}/api/config`)).json()) as { contract_id: string };
  check(cfg.contract_id === ids.escrow, 'server reports the escrow contract id');
  const health = (await (await fetch(`${api}/api/health`)).json()) as { balances: { relayer_yocto: string } };
  check(BigInt(health.balances.relayer_yocto) > 0n, 'health reports the relayer NEAR balance');

  async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }
  const tok = (b: OfferBundle) => ({ 'x-deal-token': b.token });
  async function getDeal(b: OfferBundle) {
    return (await http('GET', `/api/deals/${b.handle}`, undefined, tok(b))).json;
  }
  async function act(b: OfferBundle, id: number, key: DealKey, action: string, payload: string) {
    return http('POST', `/api/deals/${b.handle}/actions`, { action, payload, signature: key.sign(id, action, payload, cfg.contract_id) });
  }
  async function balance(account: string): Promise<bigint> {
    const v = await provider.callFunction({ contractId: ids.ft, method: 'ft_balance_of', args: { account_id: account } });
    return BigInt(v as string);
  }
  // Stand-in for 1Click delivering USDC with customRecipientMsg {"deal_id":N}.
  async function fundViaIntents(id: number, amount: string) {
    await as(ids.payer).callFunction({
      contractId: ids.ft,
      methodName: 'ft_transfer_call',
      args: { receiver_id: ids.escrow, amount, msg: JSON.stringify({ deal_id: id }) },
      deposit: 1n,
      gas: teraToGas(100),
    });
  }
  // What the web does after a payout quote: amount + expiry bound in the payload.
  const withdrawPayload = (destination: string, amount: string) =>
    JSON.stringify({ destination, amount, expires_at_ns: String((BigInt(Date.now()) + 600_000n) * 1_000_000n) });

  /** Creator posts an offer; the client opens the link, checks it and joins with its own key. */
  async function newDeal(durationSeconds: number, reviewSeconds: number) {
    const creator = randomKey();
    const client = randomKey();
    const b = makeOffer(creator, {
      contractId: cfg.contract_id,
      // v2: work time counted from funding, not a fixed date
      durationNs: BigInt(durationSeconds) * 1_000_000_000n,
      reviewNs: BigInt(reviewSeconds) * 1_000_000_000n,
      title: 'Motion logo',
    });
    let r = await http('POST', '/api/deals', { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms });
    check(r.status === 201, 'creator posted a signed offer');
    r = await http('GET', `/api/deals/${b.handle}`);
    check(r.status === 404, 'deal is invisible without the link token');
    const before = await getDeal(b);
    check(before.deal === null && before.offer === b.offer, 'client sees the offer, no deal yet');
    r = await http('POST', `/api/deals/${b.handle}/join`, { client_pk: client.pk }, tok(b));
    check(r.status === 201, `client joined with its own key (deal ${r.json.deal_id}, tx ${r.json.tx_hash})`);
    const id = r.json.deal_id as number;
    const after = await getDeal(b);
    check(
      after.deal.client_pk === client.pk && after.deal.creator_pk === creator.pk && after.terms_verified === true,
      'on-chain deal has the client key, the offer creator key and the terms hash',
    );
    check(after.deal.client_fingerprint === keyFingerprint(client.pk), 'client fingerprint matches the client key');
    return { b, id, creator, client };
  }

  // ---------------------------------------------------------- flow 1
  console.log('\nflow 1: offer -> join -> fund -> deliver -> accept -> withdraw');
  {
    const { b, id, creator, client } = await newDeal(3600, 600);
    let r = await http('POST', `/api/deals/${b.handle}/join`, { client_pk: randomKey().pk }, tok(b));
    check(r.status === 409, 'a second join (e.g. by the creator) is refused');
    await fundViaIntents(id, '5000000');
    check((await getDeal(b)).deal.state === 'Funded', 'funded via ft_transfer_call');
    r = await act(b, id, client, 'deliver', '{"deliverable_hash":"sha256:abc"}');
    check(r.status === 403, 'client key cannot deliver (no gas spent)');
    r = await act(b, id, creator, 'deliver', '{"deliverable_hash":"sha256:abc"}');
    check(r.status === 200 && r.json.ok === true, `deliver relayed (tx ${r.json.tx_hash})`);
    r = await act(b, id, creator, 'accept', '{}');
    check(r.status === 403, 'creator key cannot accept');
    r = await act(b, id, client, 'accept', '{}');
    check(r.status === 200, 'client accepted');
    r = await act(b, id, creator, 'withdraw', withdrawPayload(ids.ft, '5000000'));
    check(r.status === 409, 'withdrawing to the token contract is refused before gas');
    const dest = `payout-dest-1.${rootId}`; // stands in for a 1Click deposit address
    const accepted = (await getDeal(b)).deal;
    check(
      accepted.creator_payout === '4850000' && accepted.fee_amount === '150000' && accepted.outcome === 'Accepted',
      'creator payout is 5 USDC minus the 3% fee; outcome Accepted',
    );
    r = await act(b, id, creator, 'withdraw', withdrawPayload(dest, '4850001'));
    check(r.status === 409, 'withdrawing more than the payout is refused');
    r = await act(b, id, creator, 'withdraw', withdrawPayload(dest, '1'));
    check(r.status === 409, 'a dust withdraw (less than the whole payout) is refused before gas');
    r = await act(b, id, creator, 'withdraw', withdrawPayload(`missing.${rootId}`, '4850000'));
    check(r.status === 409, 'a withdraw to a named account that does not exist is refused before gas');
    const nearOf = async (a: string) => BigInt(((await provider.viewAccount({ accountId: a })) as unknown as { amount: string | bigint }).amount);
    const relayerNearBefore = await nearOf(ids.relayer);
    const p = withdrawPayload(dest, '4850000');
    r = await act(b, id, creator, 'withdraw', p);
    check(r.status === 200 && r.json.ok === true && r.json.result === true, 'withdraw succeeded');
    check(r.json.act_call.deposit === '2250000000000000000000', 'the relayed withdraw attaches 0.00225 NEAR');
    check(relayerNearBefore - (await nearOf(ids.relayer)) >= 2_250_000_000_000_000_000_000n, 'the relayer, not the escrow, paid the withdraw deposit');
    check((await balance(dest)) === 4_850_000n, 'destination received 4.85 USDC');
    const d = (await getDeal(b)).deal;
    check(d.state === 'PaidOut' && d.settled === true, 'deal is PaidOut and settled');
    r = await act(b, id, creator, 'withdraw', p);
    check(r.status === 200 && r.json.duplicate === true, 'resubmitting the same withdraw is deduplicated, no new tx');
    check(typeof r.json.act_call?.args?.signature === 'string', 'response exposes the permissionless act call');
  }

  // ---------------------------------------------------------- flow 2
  console.log('\nflow 2: deliver -> review period passes -> timeout release -> withdraw');
  {
    const { b, id, creator, client } = await newDeal(3600, 3);
    await fundViaIntents(id, '5000000');
    await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
    let r = await http('POST', `/api/deals/${b.handle}/timeout`, {}, tok(b));
    check(r.status === 409, 'release refused before the review period ends');
    await sleep(5000);
    r = await act(b, id, client, 'dispute', '{}');
    check(r.status === 409, 'dispute refused after the review period');
    r = await http('POST', `/api/deals/${b.handle}/timeout`, {}, tok(b));
    check(r.status === 200 && r.json.outcome === 'released', 'auto-release after review period');
    check((await getDeal(b)).deal.outcome === 'AutoReleased', 'outcome AutoReleased');
    const dest = `payout-dest-2.${rootId}`;
    r = await act(b, id, creator, 'withdraw', withdrawPayload(dest, '4850000'));
    check(r.json.ok === true && (await balance(dest)) === 4_850_000n, 'creator withdrew (minus the fee)');
  }

  // ---------------------------------------------------------- flow 3
  console.log('\nflow 3: no delivery -> deadline passes -> client refund -> withdraw');
  {
    const { b, id, creator, client } = await newDeal(5, 600);
    check((await getDeal(b)).deal.delivery_deadline_ns === null, 'no delivery deadline before funding (v2)');
    await sleep(3000); // the work time starts at funding, not at the offer
    await fundViaIntents(id, '5000000');
    const funded = (await getDeal(b)).deal;
    check(BigInt(funded.delivery_deadline_ns) === BigInt(funded.funded_at_ns) + 5_000_000_000n, 'delivery deadline = funded_at + 5 s duration');
    let r = await act(b, id, client, 'refund', '{}');
    check(r.status === 409, 'refund refused before the delivery deadline');
    await sleep(7000);
    r = await act(b, id, creator, 'deliver', '{"deliverable_hash":"late"}');
    check(r.status === 409, 'late delivery refused');
    r = await act(b, id, client, 'refund', '{}');
    check(r.status === 200, 'client refunded after the deadline');
    const refunded = (await getDeal(b)).deal;
    check(
      refunded.client_payout === '5000000' && refunded.fee_amount === '0' && refunded.outcome === 'RefundedAfterDeadline',
      'refund is 100% to the client, no fee',
    );
    const dest = `refund-dest-3.${rootId}`;
    r = await act(b, id, client, 'withdraw', withdrawPayload(dest, '5000000'));
    check(r.json.ok === true && (await balance(dest)) === 5_000_000n, 'client withdrew');
  }

  // ---------------------------------------------------------- flow 4
  console.log('\nflow 4: dispute -> arbiter split -> both withdraw');
  {
    const { b, id, creator, client } = await newDeal(3600, 600);
    await fundViaIntents(id, '5000000');
    await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
    let r = await act(b, id, client, 'dispute', '{}');
    check(r.status === 200, 'client disputed');
    await as(ids.arbiter).callFunction({ contractId: ids.escrow, methodName: 'resolve_dispute', args: { deal_id: id, creator_share_bps: 6000 } });
    const d = (await getDeal(b)).deal;
    check(d.creator_payout === '2910000' && d.client_payout === '2000000' && d.fee_amount === '90000', 'arbiter split 60/40, fee only from the creator share');
    r = await act(b, id, creator, 'withdraw', withdrawPayload(`c4.${rootId}`, '2910000'));
    check(r.json.ok === true, 'creator withdrew share');
    r = await act(b, id, client, 'withdraw', withdrawPayload(`k4.${rootId}`, '2000000'));
    check(r.json.ok === true, 'client withdrew share');
    check((await getDeal(b)).deal.state === 'PaidOut', 'deal is PaidOut');
  }

  // ---------------------------------------------------------- flow 5
  console.log('\nflow 5: dispute -> arbiter absent -> default 50/50 after the dispute period');
  {
    const { b, id, creator, client } = await newDeal(3600, 600);
    await fundViaIntents(id, '5000000');
    await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
    await act(b, id, client, 'dispute', '{}');
    let r = await http('POST', `/api/deals/${b.handle}/timeout`, {}, tok(b));
    check(r.status === 409, 'default split refused during the dispute period');
    await sleep(6000);
    r = await http('POST', `/api/deals/${b.handle}/timeout`, {}, tok(b));
    check(r.status === 200 && r.json.outcome === 'split_50_50', 'default split triggered');
    const d = (await getDeal(b)).deal;
    check(d.creator_payout === '2425000' && d.client_payout === '2500000', '50/50 payouts, fee from the creator half');
    // pay-quote is client-signed; with 1Click offline it fails upstream, never 401
    r = await http('POST', `/api/deals/${b.handle}/pay-quote`, signedRequest(client, id, 'pay-quote', { origin_asset: 'a', refund_address: 'r' }, Date.now(), cfg.contract_id));
    check(r.status === 409, 'pay-quote refused for a resolved deal');
  }

  // ---------------------------------------------------------- flow 6
  console.log('\nflow 6: settle (mutual split): proposal -> the other side signs -> relayer submits settle');
  {
    const { b, id, creator, client } = await newDeal(3600, 600);
    await fundViaIntents(id, '5000000');
    await act(b, id, creator, 'deliver', '{"deliverable_hash":"h"}');
    const payload = (seq: string, bps: string) =>
      JSON.stringify({
        split_bps: bps,
        state: 'Delivered',
        seq,
        expires_at_ns: String((BigInt(Date.now()) + 600_000n) * 1_000_000n),
        nonce: randomKey().pk.slice(8, 24),
      });
    const sign = (k: DealKey, p: string) => k.sign(id, 'settle', p, cfg.contract_id);
    // an old proposal dies once a party revokes it
    const old = payload('0', '9000');
    let r = await http('POST', `/api/deals/${b.handle}/settle-proposal`, { payload: old, signature: sign(creator, old) }, tok(b));
    check(r.status === 201 && r.json.signer === 'creator', 'creator published a 90/10 proposal');
    r = await act(b, id, client, 'revoke_settle', '{"seq":"0"}');
    check(r.status === 200, 'client revoked open proposals (revoke_settle)');
    check((await getDeal(b)).deal.settle_seq === 1, 'settle_seq is 1 on-chain');
    r = await http('POST', `/api/deals/${b.handle}/settle`, { payload: old, creator_signature: sign(creator, old), client_signature: sign(client, old) }, tok(b));
    check(r.status === 409, 'the revoked proposal is refused before gas');
    const p = payload('1', '7000');
    r = await http('POST', `/api/deals/${b.handle}/settle-proposal`, { payload: p, signature: sign(client, p) }, tok(b));
    check(r.status === 201 && r.json.signer === 'client', 'client published a 70/30 proposal');
    const list = await http('GET', `/api/deals/${b.handle}/settle-proposals`, undefined, tok(b));
    const theirs = (list.json.proposals as { signer: string; payload: string; signature: string }[]).find((x) => x.signer === 'client')!;
    check(theirs.payload === p, 'the creator reads the client proposal with the link');
    r = await http('POST', `/api/deals/${b.handle}/settle`, { payload: p, creator_signature: sign(creator, p), client_signature: theirs.signature }, tok(b));
    check(r.status === 200 && r.json.ok === true, `settle relayed (tx ${r.json.tx_hash})`);
    const d = (await getDeal(b)).deal;
    check(
      d.state === 'Released' && d.creator_payout === String(3_500_000n - fee(3_500_000n)) && d.client_payout === '1500000',
      'settled 70/30, fee only from the creator share',
    );
    check(d.outcome?.Settled?.creator_share_bps === 7000, 'outcome Settled(7000)');
    r = await act(b, id, creator, 'withdraw', withdrawPayload(`c5.${rootId}`, d.creator_payout));
    check(r.json.ok === true, 'creator withdrew the settled share');
    r = await act(b, id, client, 'withdraw', withdrawPayload(`k5.${rootId}`, '1500000'));
    check(r.json.ok === true && (await getDeal(b)).deal.state === 'PaidOut', 'client withdrew; PaidOut');
  }

  // ---------------------------------------------------------- flow 7
  console.log('\nflow 7: an underpayment goes to the client at once (withdrawable while Created); one full payment funds');
  {
    const { b, id, creator, client } = await newDeal(3600, 600);
    await fundViaIntents(id, '2000000');
    let d = (await getDeal(b)).deal;
    check(d.state === 'Created' && d.funded_amount === '0' && d.client_payout === '2000000', 'a 2 USDC payment does not fund; it is the client payout');
    let r = await act(b, id, client, 'withdraw', withdrawPayload(`k6.${rootId}`, '2000000'));
    check(r.status === 200 && r.json.ok === true, 'client withdrew the underpayment mid-deal');
    check((await getDeal(b)).deal.state === 'Created', 'still Created after the withdraw (PaidOut only for resolved deals, X1)');
    await fundViaIntents(id, '6000000');
    d = (await getDeal(b)).deal;
    check(d.state === 'Funded' && d.funded_amount === '5000000' && d.client_payout === '1000000', 'one 6 USDC payment funds; 1 USDC extra to the client');
    r = await act(b, id, client, 'withdraw', withdrawPayload(`k7.${rootId}`, '1000000'));
    check(r.json.ok === true && (await getDeal(b)).deal.state === 'Funded', 'client withdrew the extra while Funded');
    r = await act(b, id, creator, 'refund', '{}');
    check(r.status === 200 && (await getDeal(b)).deal.outcome === 'RefundedByCreator', 'creator refunded (outcome RefundedByCreator)');
    r = await act(b, id, client, 'withdraw', withdrawPayload(`k7.${rootId}`, '5000000'));
    check(r.json.ok === true && (await getDeal(b)).deal.state === 'PaidOut', 'client withdrew the refund; PaidOut');
  }

  // ---------------------------------------------------------- flow 8
  console.log('\nflow 8: revoke an unjoined link; a never-paid deal closes after the funding cutoff (close_unpaid)');
  {
    const creator = randomKey();
    const b = makeOffer(creator, { contractId: cfg.contract_id, durationNs: 3600n * 1_000_000_000n, reviewNs: 600n * 1_000_000_000n });
    let r = await http('POST', '/api/deals', { handle: b.handle, offer: b.offer, offer_signature: b.offer_signature, terms: b.terms });
    check(r.status === 201, 'creator posted an offer');
    r = await http('POST', `/api/deals/${b.handle}/revoke`, { signature: creator.signRaw(revokeOfferMessage(cfg.contract_id, b.offer)) });
    check(r.status === 200, `creator revoked the link on-chain (tx ${r.json.tx_hash})`);
    const revoked = await provider.callFunction({ contractId: ids.escrow, method: 'is_offer_revoked', args: { offer: b.offer } });
    check(revoked === true, 'the contract knows the offer is revoked');
    r = await http('POST', `/api/deals/${b.handle}/join`, { client_pk: randomKey().pk }, tok(b));
    check(r.status === 410, 'joining a revoked link is refused');

    const x = await newDeal(3600, 600);
    await fundViaIntents(x.id, '1000000');
    r = await http('POST', `/api/deals/${x.b.handle}/timeout`, {}, tok(x.b));
    check(r.status === 409 && r.json.error === 'too_early', 'close_unpaid refused inside the pay window');
    const cutoff = BigInt((await getDeal(x.b)).deal.funding_cutoff_ns);
    await sleep(Math.max(0, Number(cutoff / 1_000_000n) - Date.now()) + 2000);
    await fundViaIntents(x.id, '5000000');
    let d = (await getDeal(x.b)).deal;
    check(d.state === 'Created' && d.client_payout === '6000000', 'a full payment after the cutoff does not fund; it goes to the client');
    r = await http('POST', `/api/deals/${x.b.handle}/timeout`, {}, tok(x.b));
    check(r.status === 200 && r.json.outcome === 'closed_unpaid', 'timeout closed the unpaid deal (close_unpaid)');
    d = (await getDeal(x.b)).deal;
    check(d.state === 'Expired' && d.outcome === 'ClosedUnpaid', 'deal is Expired / ClosedUnpaid');
    r = await act(x.b, x.id, x.client, 'withdraw', withdrawPayload(`k8.${rootId}`, '6000000'));
    check(r.json.ok === true && (await getDeal(x.b)).deal.state === 'PaidOut', 'client withdrew all late money; PaidOut');
    r = await act(x.b, x.id, x.creator, 'cancel', '{}');
    check(r.status === 409, 'cancel after expiry is refused before gas');
  }

  // ---------------------------------------------------------- solvency + fees
  type Conf = { total_liabilities: string; fee_accrued: string };
  const conf = (await provider.callFunction({ contractId: ids.escrow, method: 'get_config', args: {} })) as Conf;
  const expectedFees = fee(5_000_000n) * 2n + fee(3_000_000n) + fee(2_500_000n) + fee(3_500_000n);
  check(BigInt(conf.fee_accrued) === expectedFees, `fees accrued: ${conf.fee_accrued} (flows 1, 2, 4, 5, 6)`);
  const escrowUsdc = await balance(ids.escrow);
  check(escrowUsdc === BigInt(conf.total_liabilities), 'contract liabilities match its token balance');
  check(escrowUsdc === 5_000_000n - fee(2_500_000n) + expectedFees, 'escrow holds the undistributed flow-5 money plus the fees');
  await as(ids.fees).callFunction({ contractId: ids.escrow, methodName: 'withdraw_fees', args: { amount: conf.fee_accrued }, deposit: 1n, gas: teraToGas(150) });
  check((await balance(ids.fees)) === expectedFees, 'the fee account withdrew all fees');
  const after = (await provider.callFunction({ contractId: ids.escrow, method: 'get_config', args: {} })) as Conf;
  check(after.fee_accrued === '0' && BigInt(after.total_liabilities) === (await balance(ids.escrow)), 'after the fee withdrawal liabilities still match the balance');
  console.log('\nE2E PASSED');
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((e) => {
    console.error('\nE2E FAILED:', e instanceof Error ? e.message : e);
    if (home) console.error(`logs kept in ${home} (sandbox.log, server.log)`);
    home = '';
    for (const p of procs) p.kill('SIGKILL');
    process.exit(1);
  });
