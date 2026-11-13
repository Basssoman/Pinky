// Local development stack for the web app. Nothing touches a public network.
//   near-sandbox  +  escrow & mock USDC contracts  +  the real server process
//   +  a stand-in for 1Click (signs quotes with a local key, "delivers" a
//      payment with ft_transfer_call exactly like 1Click does on mainnet)
// It keeps running until stopped (Ctrl+C) and writes
//   web/.env.development.local   what `vite dev` needs (contract id, keys, ports)
//   $DEVSTACK_HOME/devstack.json the same for scripts
//   $DEVSTACK_HOME/arbiter/      a ready home for the arbiter tool
//
// Usage (WSL): bash scripts/devstack.sh
// Pretend the client paid:   curl -X POST http://127.0.0.1:8799/dev/pay
//   (?short=1 = less than the full amount arrived, ?fail=1 = the swap failed)
// Jump the chain clock ahead: curl -X POST 'http://127.0.0.1:8799/dev/forward?seconds=600'
// USDC straight to a deal:   curl -X POST 'http://127.0.0.1:8799/dev/transfer?deal=0&amount=1000000'

import { spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey, randomBytes, sign as edSign } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';

import { base58Encode } from '../src/encoding.ts';
import { quoteSigningMessage } from '../src/quoteSignature.ts';
import { newNoteKey } from './arbiter/crypto.ts';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB_DIR = resolve(SERVER_DIR, '..', 'web');
const env = (k: string, dflt?: string) => {
  const v = process.env[k] || dflt;
  if (!v) throw new Error(`${k} is required (run scripts/devstack.sh)`);
  return v;
};
const HOME = env('DEVSTACK_HOME', `${process.env.HOME}/kept-devstack`);
const RPC_PORT = Number(env('DEVSTACK_RPC_PORT', '3031'));
const API_PORT = Number(env('DEVSTACK_API_PORT', '8788'));
const ONECLICK_PORT = Number(env('DEVSTACK_ONECLICK_PORT', '8799'));

const procs: ChildProcess[] = [];
process.on('exit', () => procs.forEach((p) => p.kill('SIGKILL')));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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

/** ed25519 key from a 32-byte seed: NEAR-style public key + a signer. */
function edKey(seed: Buffer) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x: string };
  return { pk: `ed25519:${base58Encode(Buffer.from(jwk.x, 'base64url'))}`, sign: (m: string) => edSign(null, Buffer.from(m, 'utf8'), priv) };
}

async function main() {
  const bin = env('NEAR_SANDBOX_BIN');
  const escrowWasm = readFileSync(env('ESCROW_WASM'));
  const ftWasm = readFileSync(env('FT_WASM'));

  // 1. sandbox
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  const chainHome = join(HOME, 'chain');
  await new Promise<void>((res, rej) => {
    const p = spawn(bin, ['--home', chainHome, 'init', '--fast'], { stdio: 'ignore' });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`sandbox init exit ${code}`))));
  });
  const log = openSync(join(HOME, 'sandbox.log'), 'a');
  procs.push(
    spawn(bin, ['--home', chainHome, 'run', '--rpc-addr', `0.0.0.0:${RPC_PORT}`, '--network-addr', `127.0.0.1:${RPC_PORT + 1000}`], {
      stdio: ['ignore', log, log],
    }),
  );
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  await waitFor('sandbox rpc', async () => !!(await provider.viewBlock({ finality: 'final' })));
  console.log(`sandbox up at ${rpcUrl}`);

  const validator = JSON.parse(readFileSync(join(chainHome, 'validator_key.json'), 'utf8')) as { account_id: string; secret_key: string };
  const rootId = validator.account_id;
  const root = new Account(rootId, provider, validator.secret_key as KeyPairString);
  const rootPk = KeyPair.fromString(validator.secret_key as KeyPairString).getPublicKey();
  const relayerKey = KeyPair.fromRandom('ed25519');

  // 2. accounts + contracts
  const ids = {
    escrow: `escrow.${rootId}`,
    ft: `usdc.${rootId}`,
    relayer: `relayer.${rootId}`,
    arbiter: `arbiter.${rootId}`,
    payer: `payer.${rootId}`,
    fees: `fees.${rootId}`,
  };
  for (const [name, id] of Object.entries(ids)) {
    await root.createSubAccount({ accountOrPrefix: id, publicKey: name === 'relayer' ? relayerKey.getPublicKey() : rootPk, nearToTransfer: nearToYocto(50) });
  }
  // Somewhere to withdraw to (a named NEAR account must exist).
  for (const prefix of ['alice', 'bob']) {
    await root.createSubAccount({ accountOrPrefix: `${prefix}.${rootId}`, publicKey: rootPk, nearToTransfer: nearToYocto(1) });
  }
  const as = (id: string) => new Account(id, provider, validator.secret_key as KeyPairString);
  await as(ids.ft).deployContract(new Uint8Array(ftWasm));
  await as(ids.ft).callFunction({ contractId: ids.ft, methodName: 'new', args: {} });
  await as(ids.escrow).deployContract(new Uint8Array(escrowWasm));
  await as(ids.escrow).callFunction({
    contractId: ids.escrow,
    methodName: 'new',
    args: {
      owner_id: rootId,
      token_id: ids.ft,
      arbiter_id: ids.arbiter,
      relayer_id: ids.relayer,
      fee_account_id: ids.fees,
      // Short periods so every timer can be watched in the browser. The time
      // to pay stays long: the server keeps a 1 h margin before pay_by.
      periods: {
        min_review_period_ns: String(60n * 10n ** 9n),
        dispute_period_ns: String(5n * 60n * 10n ** 9n),
        pay_by_period_ns: String(3n * 3600n * 10n ** 9n),
        funding_grace_ns: String(60n * 10n ** 9n),
      },
    },
  });
  for (const id of [ids.escrow, ids.fees, `alice.${rootId}`, `bob.${rootId}`]) {
    await root.callFunction({ contractId: ids.ft, methodName: 'storage_deposit', args: { account_id: id }, deposit: nearToYocto('0.01') });
  }
  await root.callFunction({ contractId: ids.ft, methodName: 'mint', args: { account_id: ids.payer, amount: '1000000000000' } });
  console.log('contracts deployed');

  // 3. stand-in for 1Click
  const quoteKey = edKey(randomBytes(32));
  const usdcAsset = `nep141:${ids.ft}`;
  const tokens = [
    { assetId: 'nep141:tron-usdt.dev', symbol: 'USDT', blockchain: 'tron', decimals: 6, price: 1 },
    { assetId: 'nep141:eth-usdt.dev', symbol: 'USDT', blockchain: 'eth', decimals: 6, price: 1 },
    { assetId: 'nep141:ton-usdt.dev', symbol: 'USDT', blockchain: 'ton', decimals: 6, price: 1 },
    { assetId: 'nep141:eth-usdc.dev', symbol: 'USDC', blockchain: 'eth', decimals: 6, price: 1 },
    { assetId: 'nep141:sol-usdc.dev', symbol: 'USDC', blockchain: 'sol', decimals: 6, price: 1 },
    { assetId: usdcAsset, symbol: 'USDC', blockchain: 'near', decimals: 6, price: 1 },
    { assetId: 'nep141:eth.dev', symbol: 'ETH', blockchain: 'eth', decimals: 18, price: 3100 },
    { assetId: 'nep141:btc.dev', symbol: 'BTC', blockchain: 'btc', decimals: 8, price: 96000 },
    { assetId: 'nep141:ton.dev', symbol: 'TON', blockchain: 'ton', decimals: 9, price: 3.2 },
    { assetId: 'nep141:xrp.dev', symbol: 'XRP', blockchain: 'xrp', decimals: 6, price: 2.4 },
  ];
  type Swap = { req: Record<string, any>; status: string; at: number; paid: 'no' | 'full' | 'short' | 'fail'; delivered: boolean };
  const swaps = new Map<string, Swap>();
  let lastPay = '';

  const fmt = (units: bigint, decimals: number) => {
    const s = units.toString().padStart(decimals + 1, '0');
    const frac = s.slice(-decimals).replace(/0+$/, '');
    return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
  };

  function makeQuote(req: Record<string, any>) {
    const pay = req.swapType === 'EXACT_OUTPUT';
    const other = tokens.find((t) => t.assetId === (pay ? req.originAsset : req.destinationAsset));
    if (!other) throw new Error('unknown token');
    const usdc = BigInt(req.amount);
    // Pay: the coin amount for the USDC + 1.2% fees. Payout: the coin amount for the USDC - 1.2%.
    const coinUnits = (usd: number) => BigInt(Math.round((usd / Number(other.price)) * 1e6)) * 10n ** BigInt(other.decimals) / 1_000_000n;
    const usd = Number(usdc) / 1e6;
    const address = pay ? `DEV-${other.blockchain.toUpperCase()}-${randomBytes(12).toString('hex')}` : randomBytes(32).toString('hex');
    const quote: Record<string, unknown> = pay
      ? {
          amountIn: coinUnits(usd * 1.012).toString(),
          amountInFormatted: fmt(coinUnits(usd * 1.012), other.decimals),
          amountInUsd: (usd * 1.012).toFixed(4),
          minAmountIn: coinUnits(usd * 1.002).toString(),
          amountOut: req.amount,
          amountOutFormatted: fmt(usdc, 6),
          amountOutUsd: usd.toFixed(4),
          minAmountOut: req.amount,
        }
      : {
          amountIn: req.amount,
          amountInFormatted: fmt(usdc, 6),
          amountInUsd: usd.toFixed(4),
          minAmountIn: req.amount,
          amountOut: coinUnits(usd * 0.988).toString(),
          amountOutFormatted: fmt(coinUnits(usd * 0.988), other.decimals),
          amountOutUsd: (usd * 0.988).toFixed(4),
          minAmountOut: coinUnits(usd * 0.978).toString(),
        };
    if (!req.dry) {
      quote.depositAddress = address;
      // XRP-like networks need a memo: lets the page show that case.
      if (pay && other.blockchain === 'xrp') quote.depositMemo = String(100000 + Math.floor(Math.random() * 900000));
      quote.deadline = new Date(Date.parse(req.deadline) + 3 * 86400_000).toISOString();
      quote.timeEstimate = 30;
      swaps.set(address, { req, status: 'PENDING_DEPOSIT', at: Date.now(), paid: 'no', delivered: false });
      if (pay) lastPay = address;
    }
    const res: Record<string, unknown> = { correlationId: randomBytes(8).toString('hex'), timestamp: new Date().toISOString(), quoteRequest: req, quote };
    res.signature = `ed25519:${base58Encode(quoteKey.sign(quoteSigningMessage(res as never)))}`;
    return res;
  }

  /** What 1Click does when a deposit arrives: deliver USDC to the recipient with the message. */
  async function advance(address: string, s: Swap) {
    if (s.paid === 'no') return;
    const age = Date.now() - s.at;
    if (s.paid === 'short') s.status = age < 4000 ? 'KNOWN_DEPOSIT_TX' : age < 8000 ? 'INCOMPLETE_DEPOSIT' : 'REFUNDED';
    else if (s.paid === 'fail') s.status = age < 4000 ? 'KNOWN_DEPOSIT_TX' : age < 8000 ? 'PROCESSING' : 'FAILED';
    else if (age < 4000) s.status = 'KNOWN_DEPOSIT_TX';
    else if (!s.delivered) {
      s.status = 'PROCESSING';
      s.delivered = true;
      await as(ids.payer).callFunction({
        contractId: ids.ft,
        methodName: 'ft_transfer_call',
        args: { receiver_id: s.req.recipient, amount: s.req.amount, msg: s.req.customRecipientMsg ?? '' },
        deposit: 1n,
        gas: teraToGas(100),
      });
      s.status = 'SUCCESS';
      console.log(`[1click] delivered ${s.req.amount} to ${s.req.recipient} ${s.req.customRecipientMsg ?? ''} (${address})`);
    }
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((ok) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => ok(b));
    });
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/v0/tokens') return json(res, 200, tokens);
      if (url.pathname === '/v0/quote' && req.method === 'POST') return json(res, 200, makeQuote(JSON.parse(await readBody(req))));
      if (url.pathname === '/v0/status') {
        const address = url.searchParams.get('depositAddress') ?? '';
        const s = swaps.get(address);
        if (!s) return json(res, 404, { message: 'unknown deposit address' });
        await advance(address, s);
        return json(res, 200, { status: s.status, updatedAt: new Date().toISOString(), swapDetails: {} });
      }
      if (url.pathname === '/dev/pay' && req.method === 'POST') {
        const address = url.searchParams.get('address') ?? lastPay;
        const s = swaps.get(address);
        if (!s) return json(res, 404, { message: 'no payment address was requested yet' });
        s.paid = url.searchParams.get('short') ? 'short' : url.searchParams.get('fail') ? 'fail' : 'full';
        s.at = Date.now();
        return json(res, 200, { ok: true, address, paid: s.paid });
      }
      if (url.pathname === '/dev/transfer' && req.method === 'POST') {
        // USDC straight into the escrow for a deal (e.g. less than the price: it must go back to the client).
        const msg = JSON.stringify({ deal_id: Number(url.searchParams.get('deal') ?? '0') });
        const amount = url.searchParams.get('amount') ?? '1000000';
        await as(ids.payer).callFunction({ contractId: ids.ft, methodName: 'ft_transfer_call', args: { receiver_id: ids.escrow, amount, msg }, deposit: 1n, gas: teraToGas(100) });
        return json(res, 200, { ok: true, amount, msg });
      }
      if (url.pathname === '/dev/forward' && req.method === 'POST') {
        // The sandbox makes about one block per second: move the chain clock ahead.
        const blocks = Math.max(1, Math.round(Number(url.searchParams.get('seconds') ?? '60')));
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sandbox_fast_forward', params: { delta_height: blocks } }),
        });
        return json(res, 200, await r.json());
      }
      return json(res, 404, { message: 'not found' });
    } catch (e) {
      return json(res, 400, { message: (e as Error).message });
    }
  }).listen(ONECLICK_PORT, '127.0.0.1');

  // 4. arbiter tool home (its keys never go to the server)
  const arbiterApi = randomBytes(32);
  const note = newNoteKey();
  const arbiterHome = join(HOME, 'arbiter');
  mkdirSync(arbiterHome, { recursive: true });
  writeFileSync(
    join(arbiterHome, 'arbiter.json'),
    JSON.stringify(
      {
        network: 'sandbox',
        rpcUrl,
        apiUrl: `http://127.0.0.1:${API_PORT}`,
        contractId: ids.escrow,
        arbiterAccountId: ids.arbiter,
        arbiterPrivateKey: validator.secret_key,
        apiSeed: arbiterApi.toString('hex'),
        notePrivateKey: note.priv,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  // 5. the real server
  const serverLog = openSync(join(HOME, 'server.log'), 'a');
  procs.push(
    spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(SERVER_DIR, 'dist', 'src', 'main.js')], {
      stdio: ['ignore', serverLog, serverLog],
      env: {
        ...process.env,
        ENV_FILE: '',
        PORT: String(API_PORT),
        HOST: '0.0.0.0',
        NEAR_NETWORK: 'sandbox',
        NEAR_RPC_URL: rpcUrl,
        ESCROW_CONTRACT_ID: ids.escrow,
        RELAYER_ACCOUNT_ID: ids.relayer,
        RELAYER_PRIVATE_KEY: relayerKey.toString(),
        ONECLICK_API_KEY: 'devstack',
        ONECLICK_BASE_URL: `http://127.0.0.1:${ONECLICK_PORT}`,
        ONECLICK_FORCE_DRY: 'false',
        ONECLICK_QUOTE_PUBLIC_KEY: quoteKey.pk,
        ARBITER_API_PUBLIC_KEY: edKey(arbiterApi).pk,
        DB_PATH: join(HOME, 'dev.sqlite'),
        MIN_REVIEW_PERIOD_SECONDS: '60',
        MIN_DELIVERY_SECONDS: '60',
        RATE_WRITES_PER_MIN: '1000',
        RATE_QUOTES_PER_MIN: '1000',
        DAILY_PAY_QUOTES_PER_DEAL: '1000',
        USDC_ASSET_ID: usdcAsset,
        TOKEN_SYMBOLS: '',
        LOG_LEVEL: 'info',
      },
    }),
  );
  const api = `http://127.0.0.1:${API_PORT}`;
  await waitFor('server', async () => (await fetch(`${api}/api/config`)).ok, 30_000);

  const info = {
    rpcUrl,
    apiUrl: api,
    oneClickUrl: `http://127.0.0.1:${ONECLICK_PORT}`,
    contractId: ids.escrow,
    tokenAccountId: ids.ft,
    oneClickKey: quoteKey.pk,
    arbiterNoteKey: note.pub,
    arbiterHome,
    payoutAccounts: [`alice.${rootId}`, `bob.${rootId}`],
  };
  writeFileSync(join(HOME, 'devstack.json'), JSON.stringify(info, null, 2));
  writeFileSync(
    join(WEB_DIR, '.env.development.local'),
    [
      '# Written by server/scripts/devstack.ts: the local sandbox the dev site talks to.',
      `VITE_DEV_CONTRACT_ID=${ids.escrow}`,
      `VITE_DEV_TOKEN_ACCOUNT_ID=${ids.ft}`,
      `VITE_DEV_ONECLICK_KEY=${quoteKey.pk}`,
      `VITE_DEV_ARBITER_NOTE_KEY=${note.pub}`,
      `DEV_API_URL=${api}`,
      `DEV_RPC_URL=${rpcUrl}`,
      '',
    ].join('\n'),
  );
  console.log(JSON.stringify(info, null, 2));
  console.log('\nDEVSTACK READY (Ctrl+C to stop)');
  await new Promise(() => {});
}

main().catch((e) => {
  console.error('DEVSTACK FAILED:', e);
  process.exit(1);
});
