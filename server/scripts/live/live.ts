// Guided live-test kit: one tiny real deal on mainnet (or the local sandbox
// for a dry run). Run `node dist/scripts/live/live.js <command>`; see
// scripts/live/README.md for the order. Every command that sends a
// transaction shows the exact actions and waits for "YES".

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { actions, PublicKey } from 'near-api-js';

import { implicitAccountId, keyFingerprint, offerMessage, sha256Hex, signedMessage, termsHash } from '../../src/encoding.ts';
import { ONE_CLICK_MANAGER_PUBLIC_KEY, verifyQuoteSignature } from '../../src/quoteSignature.ts';
import {
  accessKeys,
  accountLink,
  ceilCentiNear,
  codeHash,
  confirmYes,
  EMPTY_CODE_HASH,
  ensureKeys,
  ensurePrivateDir,
  fmtNear,
  fmtUsdc,
  liveConfig,
  loadKeys,
  newDealKey,
  pause,
  randomHex,
  ROLES,
  rpc,
  sendTx,
  signerAccount,
  signWith,
  sleep,
  txLink,
  viewAccount,
  viewCall,
  writeSecret,
  type DealKeyFile,
  type LiveConfig,
  type Role,
  type RoleKey,
} from './common.ts';

const SEC_NS = 1_000_000_000n;
const TGAS = 10n ** 12n;
const MIN = 60n * SEC_NS;

// Short demo periods for a TEST instance only (contract v2 init `periods`):
// review 10 min (min 5), dispute 15 min, pay within 3 h (+30 min
// grace), offer TTL 60 min, work time 3 h, purge 1 h, admin delay 15 min
// (the contract requires >= the dispute period), sweep confirm 2 min.
// The pay window must stay > 1 h: pay quotes end 1 h before pay_by.
const DEMO = {
  minReviewNs: 5n * MIN,
  disputeNs: 15n * MIN,
  reviewNs: 10n * MIN,
  offerTtlNs: 60n * MIN,
  deliveryNs: 3n * 60n * MIN,
  payByNs: 3n * 60n * MIN,
  graceNs: 30n * MIN,
  purgeAfterNs: 60n * MIN,
  adminDelayNs: 15n * MIN,
  sweepConfirmNs: 2n * MIN,
};
/** Contract v2 fee; the server refuses any other value. */
const FEE_BPS = '300';
/** What a relayed `act(withdraw)` attaches (contract WITHDRAW_DEPOSIT). */
const WITHDRAW_DEPOSIT = 2_250_000_000_000_000_000_000n;
/** What the relayer attaches to `create_deal` (contract DEAL_DEPOSIT). */
const DEAL_DEPOSIT = 10_000_000_000_000_000_000_000n;

// Storage model (bytes); see README "Funding formula". Measured on sandbox.
const ACCOUNT_BYTES = 182n; // implicit account + one full-access key
const INIT_STATE_BYTES = 600n; // contract state right after `new` (measured: see README)
// Deal storage is paid by the relayer's DEAL_DEPOSIT and the withdraw hashes
// by WITHDRAW_DEPOSIT (contract v2), so the escrow budget has no per-deal part.
const PLANNED_DEALS = 2n;
const WITHDRAW_STORAGE_DEPOSITS = 2n; // relayed withdraws; the relayer attaches WITHDRAW_DEPOSIT to each (v2)
const MARGIN_PCT = 20n;
/** Owner txs for withdraw-fees: storage_deposit, withdraw_fees (150 TGas), ft_transfer, storage_unregister. */
const OWNER_FEE_TXS_TGAS = [30n, 150n, 30n, 30n];

function args(): { cmd: string; flags: Map<string, string | true>; rest: string[] } {
  const [cmd = 'help', ...more] = process.argv.slice(2);
  const flags = new Map<string, string | true>();
  const rest: string[] = [];
  for (let i = 0; i < more.length; i++) {
    const a = more[i];
    if (a.startsWith('--')) {
      const next = more[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(a.slice(2), next);
        i++;
      } else flags.set(a.slice(2), true);
    } else rest.push(a);
  }
  return { cmd, flags, rest };
}

function header(cfg: LiveConfig, title: string) {
  console.log(`\n=== ${title}  [network: ${cfg.net}, rpc: ${cfg.rpcUrl}]`);
}

// ====================================================================== keys

function cmdKeys(cfg: LiveConfig) {
  header(cfg, 'keys');
  const keys = ensureKeys(cfg);
  console.log(`keys are stored in ${cfg.home}/keys (chmod 600). Public account ids:`);
  for (const r of ROLES) console.log(`  ${r.padEnd(8)} ${keys[r].account_id}`);
  console.log('These are implicit accounts: they come into existence when NEAR is sent to them.');
}

// ====================================================================== preflight

interface Funding {
  role: Role;
  account_id: string;
  exists: boolean;
  available: bigint;
  need: bigint;
  send: bigint;
  why: string;
}

async function computeFunding(cfg: LiveConfig, keys: Record<Role, RoleKey>, wasmSize: bigint) {
  const pc = await rpc(cfg, 'EXPERIMENTAL_protocol_config', { finality: 'final' });
  const rc = pc.runtime_config;
  const price = BigInt(rc.storage_amount_per_byte);
  const gasPrice = BigInt((await rpc(cfg, 'gas_price', [null])).gas_price);
  const tc = rc.transaction_costs;
  const fee = (c: { send_not_sir: number; execution: number }) => BigInt(c.send_not_sir) + BigInt(c.execution);
  const deployGas =
    fee(tc.action_receipt_creation_config) +
    fee(tc.action_creation_config.deploy_contract_cost) +
    fee(tc.action_creation_config.deploy_contract_cost_per_byte) * wasmSize +
    fee(tc.action_creation_config.function_call_cost) +
    30n * TGAS; // `new` (prepaid)
  const bounds = await viewCall<{ min: string }>(cfg, cfg.usdc, 'storage_balance_bounds', {});
  const usdcStorage = BigInt(bounds.min);

  // A transaction can only be sent if the signer can pay its prepaid gas at
  // the PESSIMISTIC gas price: price * r^(1 + ceil(prepaid / min_receipt_gas)),
  // r = pessimistic_gas_price_inflation_ratio (103/100 on mainnet). For a
  // 200 TGas call that is ~10-12x the current price (measured on sandbox:
  // 0.2009 NEAR reserved for one act(200 TGas) at 1e8 yocto/gas).
  // Protocol 86+ (mainnet and sandbox today): inflation is [1,1] but prepaid
  // gas is bought at runtime_config.min_gas_purchase_price (1e9 = 10x the
  // 1e8 gas price), which is what the sandbox run measured.
  const [rNum, rDen] = (tc.pessimistic_gas_price_inflation_ratio ?? [103, 100]).map((x: number) => BigInt(x));
  const purchasePrice = rc.min_gas_purchase_price ? BigInt(rc.min_gas_purchase_price) : 0n;
  const minReceiptGas = BigInt(tc.action_receipt_creation_config.execution) + BigInt(tc.action_creation_config.function_call_cost.execution);
  const reservation = (prepaid: bigint) => {
    const steps = 1n + (prepaid + minReceiptGas - 1n) / minReceiptGas;
    let p = gasPrice > purchasePrice ? gasPrice : purchasePrice;
    for (let i = 0n; i < steps; i++) p = (p * rNum + rDen - 1n) / rDen;
    return prepaid * p;
  };

  const escrowBytes = ACCOUNT_BYTES + wasmSize + INIT_STATE_BYTES;
  const escrowGasBurnt = (deployGas + 30n * TGAS) * gasPrice; // deploy tx + storage_deposit tx (upper bound)
  const escrowNeed =
    escrowBytes * price +
    usdcStorage + // own registration with USDC
    escrowGasBurnt +
    reservation(deployGas); // must be available when the deploy tx is sent
  // create_deal, deliver, accept, withdraw (150 TGas), 2 spare. Worst case:
  // every tx costs its full prepaid gas at the purchase price (no refund).
  const relayerTxs = [30n, 30n, 30n, 150n, 30n, 30n];
  const relayerGas = relayerTxs.reduce((a, b) => a + b, 0n) * TGAS;
  const relayerReserve = reservation(relayerGas);
  const relayerNeed =
    ACCOUNT_BYTES * price + relayerReserve + WITHDRAW_DEPOSIT * WITHDRAW_STORAGE_DEPOSITS + DEAL_DEPOSIT * PLANNED_DEALS;
  const withMargin = (v: bigint) => ceilCentiNear(v + (v * MARGIN_PCT) / 100n);

  const out: Funding[] = [];
  const plan: Record<Role, { need: bigint; why: string }> = {
    escrow: {
      need: withMargin(escrowNeed),
      why: `storage ${escrowBytes} B x ${price} + USDC registration ${fmtNear(usdcStorage)} + deploy gas ${fmtNear(escrowGasBurnt)} + deploy reservation ${fmtNear(reservation(deployGas))}`,
    },
    relayer: {
      need: withMargin(relayerNeed),
      why: `own storage + ${relayerTxs.length} txs, ${relayerGas / TGAS} TGas prepaid, all at the purchase price, no refund assumed = ${fmtNear(relayerReserve)} + ${WITHDRAW_STORAGE_DEPOSITS} withdraw deposits x ${fmtNear(WITHDRAW_DEPOSIT)} + ${PLANNED_DEALS} deal deposits x ${fmtNear(DEAL_DEPOSIT)}`,
    },
    owner: {
      need: withMargin(ACCOUNT_BYTES * price + usdcStorage + reservation(OWNER_FEE_TXS_TGAS.reduce((x, y) => (x > y ? x : y)) * TGAS)),
      why: `fee account of the test instance: withdraw-fees at the end (USDC registration ${fmtNear(usdcStorage)} + gas); also assign-orphan/sweep if needed`,
    },
    arbiter: { need: 0n, why: 'not needed (no dispute in this test)' },
  };
  for (const role of ROLES) {
    const id = keys[role].account_id;
    const v = await viewAccount(cfg, id);
    // `need` already includes the account's own storage, so compare with the total balance
    const available = v ? BigInt(v.amount) : 0n;
    const need = plan[role].need;
    out.push({ role, account_id: id, exists: !!v, available, need, send: need > available ? need - available : 0n, why: plan[role].why });
  }
  return { out, price, gasPrice, purchasePrice, deployGas, usdcStorage, escrowBytes, relayerGas };
}

async function cmdPreflight(cfg: LiveConfig) {
  header(cfg, 'preflight (read-only, sends nothing)');
  const keys = loadKeys(cfg);
  if (!existsSync(cfg.wasmPath)) throw new Error(`wasm not found at ${cfg.wasmPath}: build it first`);
  const wasm = readFileSync(cfg.wasmPath);
  const hash = codeHash(wasm);
  console.log(`escrow wasm: ${cfg.wasmPath}, ${wasm.length} bytes, code hash ${hash}`);

  const meta = await viewCall<{ symbol: string; decimals: number; name: string }>(cfg, cfg.usdc, 'ft_metadata', {});
  console.log(`USDC token ${cfg.usdc}: ${meta.name} (${meta.symbol}), decimals ${meta.decimals}`);
  if (meta.decimals !== 6) throw new Error('unexpected USDC decimals');

  const esc = await viewAccount(cfg, keys.escrow.account_id);
  if (esc && esc.code_hash !== EMPTY_CODE_HASH) {
    console.log(
      esc.code_hash === hash
        ? 'escrow is deployed and its code hash MATCHES the built artifact'
        : `WARNING: deployed code hash ${esc.code_hash} does NOT match the artifact`,
    );
  } else {
    console.log('escrow has no code yet (deploy will install the artifact above)');
  }
  const ben = await viewAccount(cfg, cfg.beneficiary);
  console.log(`beneficiary ${cfg.beneficiary}: ${ben ? `exists, ${fmtNear(BigInt(ben.amount))} NEAR` : 'DOES NOT EXIST'}`);

  const f = await computeFunding(cfg, keys, BigInt(wasm.length));
  console.log(
    `\nstorage price ${f.price} yocto/byte, gas price ${f.gasPrice} yocto/gas, gas purchase price ${f.purchasePrice} yocto/gas, deploy tx gas ~${f.deployGas / TGAS} TGas`,
  );
  console.log('Note: a transfer that CREATES an implicit account may cost the sender an extra account-creation charge (0.007 NEAR on protocol 86).');
  console.log('\nFUNDING TABLE (send plain NEAR transfers from your wallet to these accounts):');
  console.log('  role     account id                                                           has      needs      SEND');
  for (const r of f.out) {
    console.log(
      `  ${r.role.padEnd(8)} ${r.account_id}  ${(r.exists ? fmtNear(r.available) : 'no account').padStart(11)}  ${fmtNear(r.need).padStart(9)}  ${fmtNear(r.send).padStart(9)}`,
    );
  }
  for (const r of f.out) console.log(`  - ${r.role}: ${r.why}`);
  const total = f.out.reduce((a, r) => a + r.send, 0n);
  console.log(`  TOTAL TO SEND: ${fmtNear(total)} NEAR (unused NEAR comes back with "recover")`);
  writeSecret(
    join(cfg.home, 'funding.json'),
    JSON.stringify(f.out.map((r) => ({ role: r.role, account_id: r.account_id, send_yocto: r.send.toString(), need_yocto: r.need.toString() })), null, 2),
  );
}

// ====================================================================== deploy

async function cmdDeploy(cfg: LiveConfig, lock: boolean) {
  header(cfg, 'deploy');
  const keys = loadKeys(cfg);
  const wasm = readFileSync(cfg.wasmPath);
  const hash = codeHash(wasm);
  const escrowId = keys.escrow.account_id;
  const esc = await viewAccount(cfg, escrowId);
  if (!esc) throw new Error(`escrow account ${escrowId} does not exist yet: fund it first (see preflight)`);
  const initArgs = {
    owner_id: keys.owner.account_id,
    token_id: cfg.usdc,
    arbiter_id: keys.arbiter.account_id,
    relayer_id: keys.relayer.account_id,
    // Test instance: fees accrue to the owner key (it can call withdraw_fees).
    fee_account_id: keys.owner.account_id,
    periods: {
      min_review_period_ns: DEMO.minReviewNs.toString(),
      dispute_period_ns: DEMO.disputeNs.toString(),
      pay_by_period_ns: DEMO.payByNs.toString(),
      funding_grace_ns: DEMO.graceNs.toString(),
      max_offer_ttl_ns: DEMO.offerTtlNs.toString(),
      purge_after_ns: DEMO.purgeAfterNs.toString(),
      admin_delay_ns: DEMO.adminDelayNs.toString(),
      sweep_confirm_delay_ns: DEMO.sweepConfirmNs.toString(),
    },
  };
  const bounds = await viewCall<{ min: string }>(cfg, cfg.usdc, 'storage_balance_bounds', {});
  const escrow = signerAccount(cfg, keys.escrow);

  if (esc.code_hash === EMPTY_CODE_HASH) {
    await confirmYes(
      cfg,
      [
        `TX 1 (signed by the escrow account ${escrowId}, receiver = itself), ONE batch:`,
        `  - DeployContract: ${wasm.length} bytes, code hash ${hash}`,
        `  - FunctionCall new(${JSON.stringify(initArgs)}), 30 TGas, 0 NEAR`,
        `  balance now: ${fmtNear(BigInt(esc.amount))} NEAR`,
      ].join('\n'),
    );
    const t1 = await sendTx(escrow, escrowId, [
      actions.deployContract(new Uint8Array(wasm)),
      actions.functionCall('new', initArgs, 30n * TGAS, 0n),
    ]);
    console.log(`  deployed + initialized: ${txLink(cfg, t1.hash)}`);
  } else if (esc.code_hash === hash) {
    console.log('escrow already deployed with this exact code; skipping TX 1');
  } else {
    throw new Error(`escrow already has different code (${esc.code_hash}); refusing`);
  }
  const after = await viewAccount(cfg, escrowId);
  if (after?.code_hash !== hash) throw new Error('code hash after deploy does not match the artifact');
  const conf = await viewCall(cfg, escrowId, 'get_config', {});
  console.log(`  get_config: ${JSON.stringify(conf)}`);
  console.log(`  escrow storage_usage after init: ${after.storage_usage} bytes`);

  const reg = await viewCall(cfg, cfg.usdc, 'storage_balance_of', { account_id: escrowId });
  if (!reg) {
    await confirmYes(
      cfg,
      `TX 2 (signed by escrow): ${cfg.usdc}.storage_deposit({account_id: escrow, registration_only: true}), attach ${fmtNear(BigInt(bounds.min))} NEAR, 30 TGas`,
    );
    const t2 = await sendTx(escrow, cfg.usdc, [
      actions.functionCall('storage_deposit', { account_id: escrowId, registration_only: true }, 30n * TGAS, BigInt(bounds.min)),
    ]);
    console.log(`  escrow registered with USDC: ${txLink(cfg, t2.hash)}`);
  } else {
    console.log('escrow already registered with USDC; skipping TX 2');
  }

  if (lock) {
    console.log('\nWARNING: --lock deletes the escrow full-access key. After that NOBODY can change the code');
    console.log('or recover the escrow NEAR ("recover" will refuse). Only do this for a real launch.');
    await confirmYes(cfg, `TX 3 (signed by escrow): DeleteKey ${keys.escrow.public_key}`);
    const t3 = await sendTx(escrow, escrowId, [actions.deleteKey(PublicKey.fromString(keys.escrow.public_key))]);
    console.log(`  escrow locked: ${txLink(cfg, t3.hash)}`);
  } else {
    console.log('\nNOTE: escrow NOT locked (default). Its full-access key still exists, so "recover" can drain it later.');
  }
  writeSecret(join(cfg.home, 'deployed.json'), JSON.stringify({ escrow: escrowId, code_hash: hash, at: new Date().toISOString() }, null, 2));
  console.log(`escrow: ${accountLink(cfg, escrowId)}`);
}

// ====================================================================== server env

function cmdServerEnv(cfg: LiveConfig) {
  header(cfg, 'server env');
  const keys = loadKeys(cfg);
  const lines = [
    `NEAR_NETWORK=${cfg.net}`,
    `NEAR_RPC_URL=${cfg.rpcUrl}`,
    `ESCROW_CONTRACT_ID=${keys.escrow.account_id}`,
    `RELAYER_ACCOUNT_ID=${keys.relayer.account_id}`,
    `RELAYER_PRIVATE_KEY=${keys.relayer.secret_key}`,
    `USDC_ASSET_ID=nep141:${cfg.usdc}`,
    `ONECLICK_FORCE_DRY=false`,
    `PAYOUT_REFUND_TYPE=INTENTS`,
    `PORT=${process.env.LIVE_PORT || '8787'}`,
    `HOST=127.0.0.1`,
    `DB_PATH=${cfg.home}/escrow.sqlite`,
    `MIN_REVIEW_PERIOD_SECONDS=${DEMO.minReviewNs / SEC_NS}`,
    `MAX_OFFER_TTL_SECONDS=${DEMO.offerTtlNs / SEC_NS}`,
    `MIN_DELIVERY_SECONDS=60`,
    `LOG_LEVEL=info`,
  ];
  if (cfg.net === 'sandbox') {
    // the dry run talks to a local mock 1Click; never send the real key there
    lines.push(`ONECLICK_API_KEY=unused-in-sandbox`);
    if (process.env.LIVE_ONECLICK_BASE_URL) lines.push(`ONECLICK_BASE_URL=${process.env.LIVE_ONECLICK_BASE_URL}`);
    if (cfg.quotePublicKeyOverride) lines.push(`ONECLICK_QUOTE_PUBLIC_KEY=${cfg.quotePublicKeyOverride}`);
  }
  const file = join(cfg.home, 'server.env');
  writeSecret(file, lines.join('\n') + '\n');
  console.log(`wrote ${file} (chmod 600; contains the relayer key, never print it).`);
  console.log(`start the server in WSL:\n  cd server && npm run build && ENV_FILE=${file} node --disable-warning=ExperimentalWarning dist/src/main.js`);
  if (cfg.net === 'mainnet') console.log('The 1Click API key is read from the repository .env by the server itself.');
}

// ====================================================================== deal driver

interface DealState {
  step: string;
  creator: DealKeyFile;
  client: DealKeyFile;
  token: string;
  handle: string;
  offer: string;
  terms: { title: string; description: string; revisions: string; salt: string };
  deal_id?: number;
  pay?: { deposit_address: string; deposit_memo: string | null; amount_in_formatted: string; amount_in: string; deadline: string };
  baseline?: { orphan: string; liabilities: string; escrow_usdc: string };
  payout?: { withdraw_payload: string; deposit_address: string; amount: string };
  beneficiary_usdc_before?: string;
  /** Scenario payouts (one per party that is owed money), processed in order. */
  payouts?: PayoutState[];
  scenario?: Scenario;
  txs: Record<string, string>;
}

/**
 * Live scenarios. After funding:
 * - accept:  deliver -> accept; creator -> USDC on NEAR (beneficiary)
 * - dispute: deliver -> dispute -> arbiter 60/40; creator -> USDC on NEAR,
 *            client -> GRAM on TON (the --refund address): a cross-chain payout
 * - settle:  "Agree on a split" 70/30 in Funded (both signatures, through the
 *            settle-proposal routes); creator -> Confidential Intents balance
 *            of the beneficiary, client -> USDC on NEAR
 * - refund:  the creator refunds; client -> GRAM on TON
 */
type Scenario = 'accept' | 'dispute' | 'settle' | 'refund';
type PayoutKind = 'near' | 'ton' | 'confidential';
interface PayoutState {
  party: 'creator' | 'client';
  kind: PayoutKind;
  step: 'quote' | 'withdraw' | 'wait' | 'done';
  withdraw_payload?: string;
  deposit_address?: string;
  amount?: string;
  before?: string;
}
const SCENARIO_PAYOUTS: Record<Scenario, { party: 'creator' | 'client'; kind: PayoutKind }[]> = {
  accept: [{ party: 'creator', kind: 'near' }],
  dispute: [
    { party: 'creator', kind: 'near' },
    { party: 'client', kind: 'ton' },
  ],
  settle: [
    { party: 'creator', kind: 'confidential' },
    { party: 'client', kind: 'near' },
  ],
  refund: [{ party: 'client', kind: 'ton' }],
};
/** GRAM on TON (also the pay-in asset). */
const GRAM = 'nep245:v2_1.omni.hot.tg:1117_';

const STEPS = ['offer', 'join', 'pay-quote', 'wait-funded', 'deliver', 'accept', 'payout-quote', 'withdraw', 'wait-paid', 'done'];

/** 1Click status of a deposit address, straight from 1Click (the kit cannot see TON or Confidential Intents balances). */
async function oneClickStatus(depositAddress: string): Promise<string> {
  const base = process.env.LIVE_ONECLICK_BASE_URL || 'https://1click.chaindefuser.com';
  let key = '';
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../.env');
  if (existsSync(envFile)) key = (/^ONECLICK_API_KEY=(.*)$/m.exec(readFileSync(envFile, 'utf8'))?.[1] ?? '').trim();
  const r = await fetch(`${base}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, { headers: key ? { 'X-API-Key': key } : {} });
  const j = (await r.json()) as { status?: string };
  return j.status ?? `HTTP ${r.status}`;
}

async function api(cfg: LiveConfig, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${cfg.apiUrl}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, json };
}

function must(r: { status: number; json: Record<string, any> }, ok: number[], what: string) {
  if (!ok.includes(r.status)) throw new Error(`${what} failed: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 500)}`);
  return r.json;
}

/** What the web must check before showing a deposit address / signing a withdraw. */
function verifyQuote(cfg: LiveConfig, qr: Record<string, any>, expect: Record<string, unknown>, minLeftSec: number) {
  const key = cfg.quotePublicKeyOverride ?? ONE_CLICK_MANAGER_PUBLIC_KEY;
  if (!verifyQuoteSignature(qr, key)) throw new Error('1Click quote signature does NOT verify');
  for (const [k, v] of Object.entries(expect)) {
    if (qr.quoteRequest?.[k] !== v) throw new Error(`quote field ${k} = ${JSON.stringify(qr.quoteRequest?.[k])}, expected ${JSON.stringify(v)}`);
  }
  const age = Date.now() - Date.parse(qr.timestamp);
  if (!(age <= 120_000 && age >= -30_000)) throw new Error(`quote timestamp not fresh (${age} ms)`);
  // The binding deadline is the one we asked for (signed echo); real 1Click's
  // quote.deadline is 3 days later (when the deposit address goes inactive).
  const left = (Date.parse(qr.quoteRequest?.deadline ?? qr.quote.deadline) - Date.now()) / 1000;
  if (!(left >= minLeftSec)) throw new Error(`quote deadline too close (${Math.round(left)} s left)`);
  console.log(`  quote verified: 1Click signature OK, request fields OK, fresh, ${Math.round(left / 60)} min left`);
}

function signedReq(cfg: LiveConfig, contractId: string, key: DealKeyFile, dealId: number, kind: string, fields: Record<string, string>) {
  const payload = JSON.stringify({ ...fields, issued_at_ns: (BigInt(Date.now()) * 1_000_000n).toString(), nonce: randomHex(8) });
  return { payload, signature: signWith(key, signedMessage(contractId, dealId, kind, payload)) };
}

async function chainSnapshot(cfg: LiveConfig, escrowId: string, dealId?: number) {
  const conf = await viewCall<{ orphan_amount: string; total_liabilities: string }>(cfg, escrowId, 'get_config', {});
  const bal = await viewCall<string>(cfg, cfg.usdc, 'ft_balance_of', { account_id: escrowId });
  const deal = dealId === undefined ? null : await viewCall<Record<string, any> | null>(cfg, escrowId, 'get_deal', { deal_id: dealId });
  return { orphan: conf.orphan_amount, liabilities: conf.total_liabilities, escrow_usdc: bal, deal };
}

async function cmdDeal(cfg: LiveConfig, flags: Map<string, string | true>) {
  header(cfg, 'deal driver');
  const keys = loadKeys(cfg);
  const escrowId = keys.escrow.account_id;
  const dir = join(cfg.home, 'deal');
  ensurePrivateDir(dir);
  const scenario = String(flags.get('scenario') ?? 'accept') as Scenario;
  if (!(scenario in SCENARIO_PAYOUTS)) throw new Error('--scenario must be accept | dispute | settle | refund');
  // The original accept run keeps state.json; every other scenario has its own file.
  const stateFile = join(dir, scenario === 'accept' ? 'state.json' : `state-${scenario}.json`);
  if (flags.has('reset') && existsSync(stateFile)) {
    renameSync(stateFile, join(dir, `state.${Date.now()}.json`));
    console.log('previous deal state archived');
  }
  const amountUnits = BigInt(Math.round(Number(flags.get('amount') ?? '5') * 1_000_000));
  const originAsset = String(flags.get('origin-asset') ?? 'nep245:v2_1.omni.hot.tg:1117_');
  const payoutRecipient = String(flags.get('payout-recipient') ?? cfg.beneficiary);
  const direct = flags.has('direct-payout');

  const cfgApi = must(await api(cfg, 'GET', '/api/config'), [200], 'GET /api/config');
  if (cfgApi.contract_id !== escrowId) throw new Error(`server is configured for ${cfgApi.contract_id}, expected ${escrowId}`);
  if (cfgApi.oneclick_dry_run) throw new Error('server runs with ONECLICK_FORCE_DRY=true; start it with the live server.env');
  const contractId = cfgApi.contract_id as string;

  let st: DealState;
  if (existsSync(stateFile)) {
    st = JSON.parse(readFileSync(stateFile, 'utf8'));
    console.log(`resuming deal at step "${st.step}" (state: ${stateFile})`);
    if ((st.scenario ?? 'accept') !== scenario) throw new Error(`this state file is for --scenario ${st.scenario ?? 'accept'}`);
  } else {
    const creator = newDealKey();
    const client = newDealKey();
    const token = randomHex(16);
    const now = BigInt(Date.now()) * 1_000_000n;
    const terms = {
      title: scenario === 'accept' ? 'Live test: motion logo' : `Live test: ${scenario}`,
      description: 'One tiny real deal to test the escrow end to end.',
      revisions: '1',
      salt: randomHex(16),
    };
    const duration = DEMO.deliveryNs.toString();
    const review = DEMO.reviewNs.toString();
    const offer = JSON.stringify({
      creator_pk: creator.pk,
      amount: amountUnits.toString(),
      fee_bps: FEE_BPS,
      delivery_duration_ns: duration,
      review_period_ns: review,
      terms_hash: termsHash({ ...terms, amount: amountUnits.toString(), delivery_duration_ns: duration, review_period_ns: review }),
      offer_nonce: randomHex(16),
      offer_expires_at_ns: (now + DEMO.offerTtlNs).toString(),
    });
    st = { step: 'offer', creator, client, token, handle: sha256Hex(token), offer, terms, txs: {}, scenario };
  }
  const save = () => writeSecret(stateFile, JSON.stringify(st, null, 2));
  const tok = { 'x-deal-token': st.token };
  const go = (step: string) => {
    st.step = step;
    save();
  };
  save();
  const at = (step: string) => STEPS.indexOf(st.step) <= STEPS.indexOf(step);

  if (at('offer') && st.step === 'offer') {
    console.log('\n[1] creator posts the signed offer (off-chain)');
    const sig = signWith(st.creator, offerMessage(contractId, st.offer));
    const r = await api(cfg, 'POST', '/api/deals', { handle: st.handle, offer: st.offer, offer_signature: sig, terms: st.terms });
    if (r.status !== 409) must(r, [201], 'POST /api/deals');
    console.log(`  offer stored; creator fingerprint ${keyFingerprint(st.creator.pk)}`);
    go('join');
  }

  if (st.step === 'join') {
    await confirmYes(cfg, `[2] client joins with its own key -> relayer sends create_deal (on-chain, relayer pays gas)`);
    const r = await api(cfg, 'POST', `/api/deals/${st.handle}/join`, { client_pk: st.client.pk }, tok);
    const j = must(r, [200, 201], 'join');
    st.deal_id = j.deal_id;
    if (j.tx_hash) st.txs.create_deal = j.tx_hash;
    console.log(`  deal ${j.deal_id} created ${j.tx_hash ? txLink(cfg, j.tx_hash) : '(recovered)'}`);
    const g = must(await api(cfg, 'GET', `/api/deals/${st.handle}`, undefined, tok), [200], 'GET deal');
    if (g.deal.client_pk !== st.client.pk || g.deal.creator_pk !== st.creator.pk || g.terms_verified !== true) {
      throw new Error('on-chain deal does not match our keys/terms: STOP, do not pay');
    }
    console.log(`  on-chain deal verified; client fingerprint ${g.deal.client_fingerprint}`);
    go('pay-quote');
  }

  if (st.step === 'pay-quote' || (st.step === 'wait-funded' && flags.has('requote'))) {
    const refund = flags.get('refund');
    if (typeof refund !== 'string') throw new Error('pass --refund <your TON address> (where 1Click refunds GRAM if the swap fails)');
    console.log(`\n[3] client asks for a pay quote: ${fmtUsdc(amountUnits)} USDC out, paid in ${originAsset}`);
    const r = await api(
      cfg,
      'POST',
      `/api/deals/${st.handle}/pay-quote`,
      signedReq(cfg, contractId, st.client, st.deal_id!, 'pay-quote', { origin_asset: originAsset, refund_address: refund }),
    );
    const j = must(r, [200], 'pay-quote');
    verifyQuote(
      cfg,
      j.quote_response,
      {
        dry: false,
        swapType: 'EXACT_OUTPUT',
        recipient: contractId,
        recipientType: 'DESTINATION_CHAIN',
        destinationAsset: `nep141:${cfg.usdc}`,
        customRecipientMsg: JSON.stringify({ deal_id: st.deal_id }),
        amount: amountUnits.toString(),
        refundTo: refund,
        originAsset,
      },
      600,
    );
    if (j.quote_response.quote.depositAddress !== j.deposit_address) throw new Error('deposit address mismatch');
    st.pay = {
      deposit_address: j.deposit_address,
      deposit_memo: j.deposit_memo,
      amount_in_formatted: j.amount_in_formatted,
      amount_in: j.amount_in,
      deadline: j.deadline,
    };
    const snap = await chainSnapshot(cfg, escrowId);
    st.baseline = { orphan: snap.orphan, liabilities: snap.liabilities, escrow_usdc: snap.escrow_usdc };
    go('wait-funded');
    console.log('\n  >>> HUMAN: send the payment now <<<');
    console.log(`  asset:    ${originAsset} (GRAM on TON)`);
    console.log(`  amount:   EXACTLY ${j.amount_in_formatted}  (base units ${j.amount_in})`);
    console.log(`  to:       ${j.deposit_address}`);
    if (j.deposit_memo) console.log(`  MEMO:     ${j.deposit_memo}   (REQUIRED)`);
    console.log(`  before:   ${j.deadline}`);
    await pause(cfg, '  Press Enter after you sent it (or Ctrl-C and re-run later; progress is saved).');
  }

  if (st.step === 'wait-funded') {
    console.log('\n[4] waiting for the money to reach the escrow (poll every 15 s; Ctrl-C is safe, re-run to resume)');
    const base = st.baseline!;
    // ft_transfer_call moves the tokens one receipt before ft_on_transfer
    // credits the deal: a single poll can see "balance up, deal not funded".
    // Only an unaccounted balance that stays for 3 polls counts.
    let plainSeen = 0;
    for (;;) {
      const s = await api(cfg, 'GET', `/api/deals/${st.handle}/pay-status?deposit_address=${encodeURIComponent(st.pay!.deposit_address)}`, undefined, tok);
      const snap = await chainSnapshot(cfg, escrowId, st.deal_id);
      const deal = snap.deal!;
      console.log(
        `  ${new Date().toISOString()} 1Click: ${s.json.status ?? s.status}  deal: ${deal.state} funded ${fmtUsdc(deal.funded_amount)}  orphan_amount ${fmtUsdc(snap.orphan)}  escrow USDC ${fmtUsdc(snap.escrow_usdc)}`,
      );
      if (deal.state === 'Funded') {
        console.log('  FUNDING ANSWER: YES - 1Click delivered with ft_transfer_call and our customRecipientMsg; the deal is Funded.');
        break;
      }
      if (BigInt(snap.orphan) > BigInt(base.orphan)) {
        console.log('  FUNDING ANSWER: NO - the money ARRIVED AS AN ORPHAN (ft_transfer_call without our deal id).');
        console.log(`  Fix: fund the owner (~0.05 NEAR) and run: assign-orphan ${st.deal_id} ${BigInt(snap.orphan) - BigInt(base.orphan)}`);
        process.exit(3);
      }
      if (BigInt(deal.client_payout) > 0n) {
        // Contract v2: an underpayment or money after the funding cutoff is credited to the client key.
        console.log(`  The money reached the deal but did NOT fund it: ${fmtUsdc(deal.client_payout)} USDC is the client's payout (less than the price, or too late).`);
        console.log('  FUNDING ANSWER: YES (ft_transfer_call with our deal id works); the client can withdraw that money with a payout quote.');
        process.exit(3);
      }
      if (BigInt(snap.escrow_usdc) > BigInt(base.escrow_usdc) && BigInt(deal.funded_amount) === 0n) plainSeen++;
      else plainSeen = 0;
      if (plainSeen >= 3) {
        console.log('  FUNDING ANSWER: NO - the money arrived as a PLAIN ft_transfer (not credited to any deal, unaccounted).');
        console.log(`  Fix: fund the owner (~0.05 NEAR) and run: sweep <amount> ${cfg.beneficiary}`);
        process.exit(3);
      }
      if (['REFUNDED', 'FAILED', 'INCOMPLETE_DEPOSIT'].includes(s.json.status)) {
        console.log(`  1Click status ${s.json.status}: the swap did not complete (refund goes to your TON address). Re-run with --requote to try again.`);
        process.exit(4);
      }
      await sleep(cfg.net === 'sandbox' ? 1000 : 15000);
    }
    go(scenario === 'settle' ? 'settle' : scenario === 'refund' ? 'refund' : 'deliver');
  }

  const act = async (who: 'creator' | 'client', action: string, payload: string) =>
    must(
      await api(cfg, 'POST', `/api/deals/${st.handle}/actions`, {
        action,
        payload,
        signature: signWith(st[who], signedMessage(contractId, st.deal_id!, action, payload)),
      }),
      [200],
      action,
    );
  /** The relayer returns at optimistic execution; views use finality "final". */
  const waitDeal = async (ok: (d: Record<string, any>) => boolean, what: string) => {
    for (let i = 0; i < 60; i++) {
      const d = (await chainSnapshot(cfg, escrowId, st.deal_id)).deal!;
      if (ok(d)) return d;
      await sleep(2000);
    }
    throw new Error(`timed out waiting for: ${what}`);
  };
  const toPayouts = () => {
    st.payouts = SCENARIO_PAYOUTS[scenario].map((x) => ({ ...x, step: 'quote' as const }));
    go('payouts');
  };

  if (st.step === 'refund') {
    const payload = JSON.stringify({ nonce: randomHex(8) });
    await confirmYes(cfg, `[5] creator signs refund ${payload} -> relayer sends act(refund); everything goes back to the client key`);
    const r = await act('creator', 'refund', payload);
    st.txs.refund = r.tx_hash;
    console.log(`  refunded: ${txLink(cfg, r.tx_hash)}`);
    const d = await waitDeal((x) => x.state === 'Refunded', 'deal Refunded');
    console.log(`  deal ${d.state}, outcome ${JSON.stringify(d.outcome)}, client payout ${fmtUsdc(d.client_payout)}, fee ${fmtUsdc(d.fee_amount)}`);
    toPayouts();
  }

  if (st.step === 'settle') {
    const deal = (await chainSnapshot(cfg, escrowId, st.deal_id)).deal!;
    const payload = JSON.stringify({
      split_bps: '7000',
      state: deal.state,
      seq: String(deal.settle_seq),
      expires_at_ns: ((BigInt(Date.now()) + 30n * 60_000n) * 1_000_000n).toString(),
      nonce: randomHex(8),
    });
    const sign = (who: 'creator' | 'client') => signWith(st[who], signedMessage(contractId, st.deal_id!, 'settle', payload));
    console.log(`\n[5] "Agree on a split": the creator publishes a signed 70/30 proposal, the client reads it and co-signs`);
    must(await api(cfg, 'POST', `/api/deals/${st.handle}/settle-proposal`, { payload, signature: sign('creator') }, tok), [201], 'settle-proposal');
    const list = must(await api(cfg, 'GET', `/api/deals/${st.handle}/settle-proposals`, undefined, tok), [200], 'settle-proposals');
    const prop = (list.proposals as { signer: string; payload: string }[]).find((x) => x.signer === 'creator');
    if (!prop || prop.payload !== payload) throw new Error('the published proposal is not the one the creator signed');
    await confirmYes(cfg, `[5] both keys signed ${payload} -> relayer sends settle(70% creator / 30% client, fee from the creator share)`);
    const r = must(
      await api(cfg, 'POST', `/api/deals/${st.handle}/settle`, { payload, creator_signature: sign('creator'), client_signature: sign('client') }, tok),
      [200],
      'settle',
    );
    st.txs.settle = r.tx_hash;
    console.log(`  settled: ${txLink(cfg, r.tx_hash)}`);
    const d = await waitDeal((x) => x.state === 'Released', 'deal Released');
    console.log(`  outcome ${JSON.stringify(d.outcome)}: creator ${fmtUsdc(d.creator_payout)}, client ${fmtUsdc(d.client_payout)}, fee ${fmtUsdc(d.fee_amount)}`);
    toPayouts();
  }

  if (st.step === 'deliver') {
    const payload = JSON.stringify({ deliverable_hash: `sha256:${sha256Hex('live test deliverable')}`, nonce: randomHex(8) });
    await confirmYes(cfg, `[5] creator signs deliver ${payload} -> relayer sends act(deliver)`);
    const r = must(
      await api(cfg, 'POST', `/api/deals/${st.handle}/actions`, { action: 'deliver', payload, signature: signWith(st.creator, signedMessage(contractId, st.deal_id!, 'deliver', payload)) }),
      [200],
      'deliver',
    );
    st.txs.deliver = r.tx_hash;
    console.log(`  delivered: ${txLink(cfg, r.tx_hash)}`);
    go(scenario === 'dispute' ? 'dispute' : 'accept');
  }

  if (st.step === 'dispute') {
    await waitDeal((x) => x.state === 'Delivered', 'deal Delivered');
    const payload = JSON.stringify({ reason: 'live test: unmet point 1', nonce: randomHex(8) });
    await confirmYes(cfg, `[6] client signs dispute ${payload} -> relayer sends act(dispute)`);
    const r = await act('client', 'dispute', payload);
    st.txs.dispute = r.tx_hash;
    console.log(`  disputed: ${txLink(cfg, r.tx_hash)}`);
    go('arbiter');
  }

  if (st.step === 'arbiter') {
    const d0 = await waitDeal((x) => x.state === 'Disputed', 'deal Disputed');
    const arb = keys.arbiter;
    const v = await viewAccount(cfg, arb.account_id);
    if (!v) throw new Error(`the arbiter account ${arb.account_id} does not exist: send it ~0.05 NEAR first`);
    await confirmYes(
      cfg,
      `[7] arbiter ${arb.account_id} calls ${escrowId}.resolve_dispute({deal_id: ${st.deal_id}, creator_share_bps: 6000}) (dispute ends ${new Date(Number(BigInt(d0.dispute_ends_at_ns) / 1_000_000n)).toISOString()}), 30 TGas`,
    );
    const t = await sendTx(signerAccount(cfg, arb), escrowId, [
      actions.functionCall('resolve_dispute', { deal_id: st.deal_id, creator_share_bps: 6000 }, 30n * TGAS, 0n),
    ]);
    st.txs.resolve_dispute = t.hash;
    console.log(`  resolved 60/40: ${txLink(cfg, t.hash)}`);
    const d = await waitDeal((x) => x.state === 'Released', 'deal Released');
    console.log(`  outcome ${JSON.stringify(d.outcome)}: creator ${fmtUsdc(d.creator_payout)}, client ${fmtUsdc(d.client_payout)}, fee ${fmtUsdc(d.fee_amount)}`);
    toPayouts();
  }

  if (st.step === 'accept') {
    const payload = JSON.stringify({ nonce: randomHex(8) });
    await confirmYes(cfg, `[6] client signs accept ${payload} -> relayer sends act(accept); the creator's payout becomes withdrawable`);
    const r = must(
      await api(cfg, 'POST', `/api/deals/${st.handle}/actions`, { action: 'accept', payload, signature: signWith(st.client, signedMessage(contractId, st.deal_id!, 'accept', payload)) }),
      [200],
      'accept',
    );
    st.txs.accept = r.tx_hash;
    console.log(`  accepted: ${txLink(cfg, r.tx_hash)}`);
    if (st.scenario && st.scenario !== 'accept') toPayouts();
    else go('payout-quote');
  }

  if (st.step === 'payouts') {
    const refundAddr = flags.get('refund');
    for (const [i, po] of st.payouts!.entries()) {
      const key = po.party === 'creator' ? st.creator : st.client;
      const label = `[payout ${i + 1}/${st.payouts!.length}] ${po.party} -> ${po.kind}`;
      const target =
        po.kind === 'near'
          ? { destination_asset: `nep141:${cfg.usdc}`, recipient: cfg.beneficiary, recipient_type: 'DESTINATION_CHAIN' }
          : po.kind === 'confidential'
            ? { destination_asset: `nep141:${cfg.usdc}`, recipient: cfg.beneficiary, recipient_type: 'CONFIDENTIAL_INTENTS' }
            : { destination_asset: GRAM, recipient: String(refundAddr ?? ''), recipient_type: 'DESTINATION_CHAIN' };
      if (po.kind === 'ton' && typeof refundAddr !== 'string') throw new Error('pass --refund <your TON address> (the client payout goes there)');
      if (po.step === 'quote') {
        const d = (await chainSnapshot(cfg, escrowId, st.deal_id)).deal!;
        const payout = String(po.party === 'creator' ? d.creator_payout : d.client_payout);
        if (BigInt(payout) <= 0n) throw new Error(`${po.party} has no payout (deal ${d.state})`);
        console.log(`\n${label}: payout quote ${fmtUsdc(payout)} USDC -> ${target.recipient} (${target.destination_asset}, ${target.recipient_type})`);
        const j = must(
          await api(cfg, 'POST', `/api/deals/${st.handle}/payout-quote`, signedReq(cfg, contractId, key, st.deal_id!, 'payout-quote', target)),
          [200],
          'payout-quote',
        );
        verifyQuote(
          cfg,
          j.quote_response,
          {
            dry: false,
            swapType: 'EXACT_INPUT',
            originAsset: `nep141:${cfg.usdc}`,
            destinationAsset: target.destination_asset,
            recipient: target.recipient,
            recipientType: target.recipient_type,
            amount: payout,
            refundType: 'INTENTS',
            refundTo: implicitAccountId(key.pk),
          },
          600,
        );
        const wp = JSON.parse(j.withdraw_payload);
        if (wp.destination !== j.quote_response.quote.depositAddress || wp.amount !== payout || j.quote_response.quote.depositMemo) {
          throw new Error('withdraw payload does not match the quote');
        }
        console.log(`  1Click deposit address ${wp.destination}; expected out ${j.quote_response.quote.amountOutFormatted}`);
        Object.assign(po, { step: 'withdraw', withdraw_payload: j.withdraw_payload, deposit_address: wp.destination, amount: payout });
        save();
      }
      if (po.step === 'withdraw') {
        // A previous run may have sent it already (an RPC error after sending):
        // trust the chain before signing again.
        const d0 = (await chainSnapshot(cfg, escrowId, st.deal_id)).deal!;
        const left0 = BigInt(po.party === 'creator' ? d0.creator_payout : d0.client_payout);
        const pend0 = BigInt(po.party === 'creator' ? d0.creator_pending : d0.client_pending);
        if (left0 === 0n && pend0 === 0n) {
          console.log(`  ${label}: already withdrawn on-chain (an earlier run); waiting for 1Click`);
          po.step = 'wait';
          save();
        }
      }
      if (po.step === 'withdraw') {
        if (po.kind === 'near') po.before = await viewCall<string>(cfg, cfg.usdc, 'ft_balance_of', { account_id: cfg.beneficiary });
        await confirmYes(cfg, `${label}: ${po.party} signs withdraw ${po.withdraw_payload} -> the escrow sends ${fmtUsdc(po.amount!)} USDC to ${po.deposit_address}`);
        const r = await api(cfg, 'POST', `/api/deals/${st.handle}/actions`, {
          action: 'withdraw',
          payload: po.withdraw_payload,
          signature: signWith(key, signedMessage(contractId, st.deal_id!, 'withdraw', po.withdraw_payload!)),
        });
        if (r.status === 504 || r.status >= 500) {
          // Outcome unknown (relayer timeout): trust the chain.
          const d = await waitDeal((x) => BigInt(po.party === 'creator' ? x.creator_pending : x.client_pending) === 0n, 'withdraw settled');
          const left = BigInt(po.party === 'creator' ? d.creator_payout : d.client_payout);
          if (left > 0n) throw new Error('the withdraw did not land (payout still there); re-run to get a new quote');
          console.log('  withdraw landed (relayer timed out, verified on-chain)');
        } else {
          const j = must(r, [200], 'withdraw');
          st.txs[`withdraw_${po.party}`] = j.tx_hash;
          console.log(`  withdraw ${j.ok ? 'succeeded' : 'FAILED (payout restored)'}: ${txLink(cfg, j.tx_hash)}`);
          if (!j.ok) {
            po.step = 'quote';
            save();
            process.exit(5);
          }
        }
        po.step = 'wait';
        save();
      }
      if (po.step === 'wait') {
        console.log(`  ${label}: waiting for 1Click to deliver`);
        for (;;) {
          const status = await oneClickStatus(po.deposit_address!);
          let extra = '';
          if (po.kind === 'near') {
            const now = BigInt(await viewCall<string>(cfg, cfg.usdc, 'ft_balance_of', { account_id: cfg.beneficiary }));
            extra = `  ${cfg.beneficiary} USDC +${fmtUsdc(now - BigInt(po.before ?? '0'))}`;
          }
          console.log(`  ${new Date().toISOString()} 1Click ${status}${extra}`);
          if (status === 'SUCCESS') break;
          if (['REFUNDED', 'FAILED'].includes(status)) {
            throw new Error(`1Click ${status}: the payout went to the refund account (the ${po.party} key's INTENTS balance)`);
          }
          await sleep(cfg.net === 'sandbox' ? 1000 : 15000);
        }
        po.step = 'done';
        save();
      }
    }
    const snap = await chainSnapshot(cfg, escrowId, st.deal_id);
    console.log(`  deal ${snap.deal!.state}, escrow liabilities ${fmtUsdc(snap.liabilities)} (fees stay until withdraw-fees)`);
    go('done');
    console.log(`\nSCENARIO ${scenario.toUpperCase()} COMPLETE.`);
  }

  if (st.step === 'payout-quote') {
    // the relayer returns at optimistic execution; views use finality "final"
    let snap = await chainSnapshot(cfg, escrowId, st.deal_id);
    for (let i = 0; i < 30 && BigInt(snap.deal!.creator_payout) <= 0n; i++) {
      await sleep(2000);
      snap = await chainSnapshot(cfg, escrowId, st.deal_id);
    }
    const payout = String(snap.deal!.creator_payout);
    if (BigInt(payout) <= 0n) throw new Error(`creator has no payout (deal state ${snap.deal!.state})`);
    if (direct) {
      const expires = ((BigInt(Date.now()) + 30n * 60_000n) * 1_000_000n).toString();
      st.payout = {
        withdraw_payload: JSON.stringify({ destination: payoutRecipient, amount: payout, expires_at_ns: expires }),
        deposit_address: payoutRecipient,
        amount: payout,
      };
      console.log(`\n[7] direct payout (no 1Click): ${fmtUsdc(payout)} USDC straight to ${payoutRecipient}`);
    } else {
      console.log(`\n[7] creator asks for a payout quote: ${fmtUsdc(payout)} USDC -> ${payoutRecipient} (USDC on NEAR)`);
      const r = await api(
        cfg,
        'POST',
        `/api/deals/${st.handle}/payout-quote`,
        signedReq(cfg, contractId, st.creator, st.deal_id!, 'payout-quote', {
          destination_asset: `nep141:${cfg.usdc}`,
          recipient: payoutRecipient,
          recipient_type: 'DESTINATION_CHAIN',
        }),
      );
      const j = must(r, [200], 'payout-quote');
      verifyQuote(
        cfg,
        j.quote_response,
        {
          dry: false,
          swapType: 'EXACT_INPUT',
          originAsset: `nep141:${cfg.usdc}`,
          destinationAsset: `nep141:${cfg.usdc}`,
          recipient: payoutRecipient,
          recipientType: 'DESTINATION_CHAIN',
          amount: payout,
          refundType: 'INTENTS',
          refundTo: implicitAccountId(st.creator.pk),
        },
        600,
      );
      const wp = JSON.parse(j.withdraw_payload);
      if (wp.destination !== j.quote_response.quote.depositAddress || wp.amount !== payout || j.quote_response.quote.depositMemo) {
        throw new Error('withdraw payload does not match the quote');
      }
      if (BigInt(wp.expires_at_ns) >= BigInt(Date.parse(j.quote_response.quote.deadline)) * 1_000_000n) throw new Error('withdraw expiry not before the quote deadline');
      console.log(`  1Click deposit address ${wp.destination}; expected out ${j.quote_response.quote.amountOutFormatted} USDC`);
      st.payout = { withdraw_payload: j.withdraw_payload, deposit_address: wp.destination, amount: payout };
    }
    go('withdraw');
  }

  if (st.step === 'withdraw') {
    const p = st.payout!;
    st.beneficiary_usdc_before = await viewCall<string>(cfg, cfg.usdc, 'ft_balance_of', { account_id: payoutRecipient });
    await confirmYes(cfg, `[8] creator signs withdraw ${p.withdraw_payload} -> relayer sends act(withdraw); the escrow sends ${fmtUsdc(p.amount)} USDC to ${p.deposit_address}`);
    const r = await api(cfg, 'POST', `/api/deals/${st.handle}/actions`, {
      action: 'withdraw',
      payload: p.withdraw_payload,
      signature: signWith(st.creator, signedMessage(contractId, st.deal_id!, 'withdraw', p.withdraw_payload)),
    });
    const j = must(r, [200], 'withdraw');
    st.txs.withdraw = j.tx_hash;
    console.log(`  withdraw ${j.ok ? 'succeeded' : 'FAILED (payout restored; re-run with a new quote)'}: ${txLink(cfg, j.tx_hash)}`);
    if (!j.ok) {
      go('payout-quote');
      process.exit(5);
    }
    go('wait-paid');
  }

  if (st.step === 'wait-paid') {
    console.log(`\n[9] waiting for PaidOut and for ${payoutRecipient} to receive USDC`);
    const before = BigInt(st.beneficiary_usdc_before ?? '0');
    for (;;) {
      const snap = await chainSnapshot(cfg, escrowId, st.deal_id);
      const now = BigInt(await viewCall<string>(cfg, cfg.usdc, 'ft_balance_of', { account_id: payoutRecipient }));
      console.log(`  ${new Date().toISOString()} deal ${snap.deal!.state} settled=${snap.deal!.settled}  ${payoutRecipient} USDC +${fmtUsdc(now - before)}  liabilities ${fmtUsdc(snap.liabilities)}`);
      if (snap.deal!.state === 'PaidOut' && now > before) break;
      await sleep(cfg.net === 'sandbox' ? 1000 : 15000);
    }
    go('done');
  }

  console.log('\nDEAL COMPLETE. Transactions:');
  for (const [k, h] of Object.entries(st.txs)) console.log(`  ${k.padEnd(12)} ${txLink(cfg, h)}`);
  console.log(`escrow: ${accountLink(cfg, escrowId)}`);
}

// ====================================================================== owner tools

async function cmdAssignOrphan(cfg: LiveConfig, dealId: string, amount: string) {
  header(cfg, 'assign-orphan (owner)');
  const keys = loadKeys(cfg);
  await confirmYes(cfg, `owner ${keys.owner.account_id} calls ${keys.escrow.account_id}.assign_orphan({deal_id: ${dealId}, amount: "${amount}"})`);
  const t = await sendTx(signerAccount(cfg, keys.owner), keys.escrow.account_id, [
    actions.functionCall('assign_orphan', { deal_id: Number(dealId), amount }, 30n * TGAS, 0n),
  ]);
  console.log(`  ${txLink(cfg, t.hash)}`);
}

/**
 * Contract v2: recorded orphans go out with `sweep_orphans`
 * (no balance read); untracked tokens (plain transfers) with
 * `sweep_unaccounted`, which needs two calls at least the confirm delay
 * apart with nothing changing on the escrow in between. Run this command
 * again after the delay; the second run sweeps.
 */
async function cmdSweep(cfg: LiveConfig, amount: string, receiver: string) {
  header(cfg, 'sweep (owner)');
  const keys = loadKeys(cfg);
  const escrowId = keys.escrow.account_id;
  const owner = signerAccount(cfg, keys.owner);
  const conf = await viewCall<{ orphan_amount: string; sweep_confirm_delay_ns: string }>(cfg, escrowId, 'get_config', {});
  const want = BigInt(amount);
  const fromOrphans = want < BigInt(conf.orphan_amount) ? want : BigInt(conf.orphan_amount);
  if (fromOrphans > 0n) {
    await confirmYes(cfg, `owner ${keys.owner.account_id} calls ${escrowId}.sweep_orphans({receiver_id: ${receiver}, amount: "${fromOrphans}"}), 1 yocto, 200 TGas`);
    const t = await sendTx(owner, escrowId, [
      actions.functionCall('sweep_orphans', { receiver_id: receiver, amount: fromOrphans.toString() }, 200n * TGAS, 1n),
    ]);
    console.log(`  orphans: result ${JSON.stringify(t.value)} ${txLink(cfg, t.hash)}`);
  }
  const rest = want - fromOrphans;
  if (rest <= 0n) return;
  const delayS = BigInt(conf.sweep_confirm_delay_ns) / 1_000_000_000n;
  await confirmYes(
    cfg,
    `owner calls ${escrowId}.sweep_unaccounted({receiver_id: ${receiver}, amount: "${rest}"}) (untracked tokens; needs 2 calls >= ${delayS} s apart), 1 yocto, 200 TGas`,
  );
  const t = await sendTx(owner, escrowId, [actions.functionCall('sweep_unaccounted', { receiver_id: receiver, amount: rest.toString() }, 200n * TGAS, 1n)]);
  console.log(`  untracked: result ${JSON.stringify(t.value)} ${txLink(cfg, t.hash)}`);
  if (t.value !== true) {
    console.log(`  The first call only records the escrow balance. Run "sweep ${rest} ${receiver}" again in ${delayS} s or more;`);
    console.log('  nothing may change on the escrow in between (no payments, withdraws, sweeps).');
  }
}

// ====================================================================== fees

/**
 * Contract v2: the 3% fee stays in the escrow's liabilities until the fee
 * account withdraws it. On the test instance the fee account is the owner:
 * register it with USDC, withdraw_fees(all), forward the USDC to the
 * beneficiary, unregister (storage back), so `recover` can drain the escrow.
 */
async function cmdWithdrawFees(cfg: LiveConfig) {
  header(cfg, 'withdraw-fees (fee account = owner on the test instance)');
  const keys = loadKeys(cfg);
  const escrowId = keys.escrow.account_id;
  const ownerId = keys.owner.account_id;
  const conf = await viewCall<{ fee_account_id: string; fee_accrued: string; fee_pending: string }>(cfg, escrowId, 'get_config', {});
  if (conf.fee_account_id !== ownerId) throw new Error(`fee account is ${conf.fee_account_id}, not the owner key of this kit`);
  if (BigInt(conf.fee_pending) > 0n) throw new Error('a fee withdrawal is already in flight; wait and re-run');
  const owner = signerAccount(cfg, keys.owner);
  const accrued = BigInt(conf.fee_accrued);
  if (accrued > 0n) {
    if (!(await viewCall(cfg, cfg.usdc, 'storage_balance_of', { account_id: ownerId }))) {
      const bounds = await viewCall<{ min: string }>(cfg, cfg.usdc, 'storage_balance_bounds', {});
      await confirmYes(cfg, `owner registers itself with USDC: ${cfg.usdc}.storage_deposit, attach ${fmtNear(BigInt(bounds.min))} NEAR`);
      const t = await sendTx(owner, cfg.usdc, [
        actions.functionCall('storage_deposit', { account_id: ownerId, registration_only: true }, 30n * TGAS, BigInt(bounds.min)),
      ]);
      console.log(`  owner registered with USDC: ${txLink(cfg, t.hash)}`);
    }
    await confirmYes(cfg, `owner calls ${escrowId}.withdraw_fees({amount: "${accrued}"}) (${fmtUsdc(accrued)} USDC), 1 yocto, 150 TGas`);
    const t = await sendTx(owner, escrowId, [actions.functionCall('withdraw_fees', { amount: accrued.toString() }, 150n * TGAS, 1n)]);
    console.log(`  fees withdrawn (result ${JSON.stringify(t.value)}): ${txLink(cfg, t.hash)}`);
  } else {
    console.log('no accrued fees on the escrow');
  }
  const reg = await viewCall(cfg, cfg.usdc, 'storage_balance_of', { account_id: ownerId });
  if (!reg) return;
  const bal = BigInt(await viewCall<string>(cfg, cfg.usdc, 'ft_balance_of', { account_id: ownerId }));
  if (bal > 0n) {
    await confirmYes(cfg, `owner sends its ${fmtUsdc(bal)} USDC to ${cfg.beneficiary} (ft_transfer, 1 yocto)`);
    const t = await sendTx(owner, cfg.usdc, [
      actions.functionCall('ft_transfer', { receiver_id: cfg.beneficiary, amount: bal.toString(), memo: 'escrow test fees' }, 30n * TGAS, 1n),
    ]);
    console.log(`  fees forwarded to ${cfg.beneficiary}: ${txLink(cfg, t.hash)}`);
  }
  const t = await sendTx(owner, cfg.usdc, [actions.functionCall('storage_unregister', { force: false }, 30n * TGAS, 1n)]);
  console.log(`  owner unregistered from USDC (storage back): ${txLink(cfg, t.hash)}`);
}

// ====================================================================== recover

async function cmdRecover(cfg: LiveConfig) {
  header(cfg, 'recover (drain NEAR back)');
  const keys = loadKeys(cfg);
  const ben = await viewAccount(cfg, cfg.beneficiary);
  if (!ben) throw new Error(`beneficiary ${cfg.beneficiary} does not exist`);
  const plan: { role: Role; amount: bigint; steps: string[] }[] = [];
  let escrowUnregister = false;
  for (const role of ['relayer', 'owner', 'arbiter', 'escrow'] as Role[]) {
    const id = keys[role].account_id;
    const v = await viewAccount(cfg, id);
    if (!v) {
      console.log(`  ${role}: does not exist, nothing to recover`);
      continue;
    }
    if (role === 'escrow') {
      const ks = await accessKeys(cfg, id);
      if (!ks.some((k) => k.public_key === keys.escrow.public_key)) {
        console.log('  escrow: LOCKED (no full-access key) - its NEAR cannot be recovered. Skipping.');
        continue;
      }
      if (v.code_hash !== EMPTY_CODE_HASH) {
        const conf = await viewCall<{ total_liabilities: string; sweep_reserved: string; orphan_amount: string; fee_accrued?: string; fee_pending?: string }>(
          cfg,
          id,
          'get_config',
          {},
        );
        const usdc = await viewCall<string>(cfg, cfg.usdc, 'ft_balance_of', { account_id: id });
        if (BigInt(conf.fee_accrued ?? '0') > 0n || BigInt(conf.fee_pending ?? '0') > 0n) {
          throw new Error(`escrow still holds ${fmtUsdc(BigInt(conf.fee_accrued ?? '0'))} USDC of fees: run "withdraw-fees" first`);
        }
        if (BigInt(conf.total_liabilities) > 0n || BigInt(conf.sweep_reserved) > 0n) {
          throw new Error(`escrow still owes ${fmtUsdc(conf.total_liabilities)} USDC to deals: finish/withdraw them first`);
        }
        if (BigInt(usdc) > 0n) {
          throw new Error(`escrow still holds ${fmtUsdc(usdc)} USDC (orphan/unaccounted): run "sweep ${usdc} ${cfg.beneficiary}" first`);
        }
      }
      // DeleteAccount refuses accounts with more than 10,000 B of non-code
      // state (protocol). Check first: unregistering from USDC and then
      // failing the delete would strand the code stake.
      const acc = await viewAccount(cfg, id);
      const wasmLen = existsSync(cfg.wasmPath) ? readFileSync(cfg.wasmPath).length : 0;
      if (acc && wasmLen > 0 && acc.storage_usage - wasmLen > 10_000) {
        throw new Error(
          `escrow has ${acc.storage_usage - wasmLen} B of state besides the code (> 10,000 B): DeleteAccount would fail. ` +
            'Purge never-funded deals first, or accept that its NEAR stays locked.',
        );
      }
      escrowUnregister = !!(await viewCall(cfg, cfg.usdc, 'storage_balance_of', { account_id: id }));
    }
    const steps = [
      ...(role === 'escrow' && escrowUnregister ? [`${cfg.usdc}.storage_unregister() (1 yocto) -> USDC storage deposit back to escrow`] : []),
      `DeleteAccount ${id} -> all NEAR to ${cfg.beneficiary}`,
    ];
    plan.push({ role, amount: BigInt(v.amount), steps });
  }
  if (!plan.length) return console.log('nothing to recover');
  await confirmYes(
    cfg,
    ['Make sure the server is STOPPED (it uses the relayer key). Then:', ...plan.map((p) => `  ${p.role} (${fmtNear(p.amount)} NEAR): ${p.steps.join('; ')}`)].join('\n'),
  );
  for (const p of plan) {
    const acct = signerAccount(cfg, keys[p.role]);
    if (p.role === 'escrow' && escrowUnregister) {
      const t = await sendTx(acct, cfg.usdc, [actions.functionCall('storage_unregister', { force: false }, 30n * TGAS, 1n)]);
      console.log(`  escrow unregistered from USDC: ${txLink(cfg, t.hash)}`);
    }
    try {
      const t = await sendTx(acct, keys[p.role].account_id, [actions.deleteAccount(cfg.beneficiary)]);
      console.log(`  ${p.role} deleted, NEAR sent to ${cfg.beneficiary}: ${txLink(cfg, t.hash)}`);
    } catch (e) {
      // near-api-js reads the signer again after a DeleteAccount and throws
      // "Signer ... does not exist" although the delete went through (seen on
      // mainnet 2026-11-06): trust the chain, not the error.
      if (!/does not exist/.test(String((e as Error)?.message ?? e)) || (await viewAccount(cfg, keys[p.role].account_id))) throw e;
      console.log(`  ${p.role} deleted (verified on-chain), NEAR sent to ${cfg.beneficiary}`);
    }
  }
  console.log('Note: implicit accounts can be re-created later by sending NEAR to the same ids (keys are kept).');
}

// ====================================================================== main

async function main() {
  const cfg = liveConfig();
  const { cmd, flags, rest } = args();
  switch (cmd) {
    case 'keys':
      return cmdKeys(cfg);
    case 'preflight':
      return cmdPreflight(cfg);
    case 'deploy':
      return cmdDeploy(cfg, flags.has('lock'));
    case 'serverenv':
      return cmdServerEnv(cfg);
    case 'deal':
      return cmdDeal(cfg, flags);
    case 'assign-orphan':
      if (rest.length !== 2) throw new Error('usage: assign-orphan <deal_id> <amount_base_units>');
      return cmdAssignOrphan(cfg, rest[0], rest[1]);
    case 'sweep':
      if (rest.length < 1) throw new Error('usage: sweep <amount_base_units> [receiver]');
      return cmdSweep(cfg, rest[0], rest[1] ?? cfg.beneficiary);
    case 'withdraw-fees':
      return cmdWithdrawFees(cfg);
    case 'recover':
      return cmdRecover(cfg);
    default:
      console.log(
        'commands: keys | preflight | deploy [--lock] | serverenv | deal --refund <TON addr> [--reset] [--requote] [--direct-payout] | assign-orphan <id> <amount> | sweep <amount> [receiver] | withdraw-fees | recover',
      );
  }
}

main().catch((e) => {
  console.error(`\nERROR: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
