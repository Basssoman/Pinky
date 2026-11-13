// Dry run of the whole live-test kit on a local sandbox, no network:
//   keys -> preflight -> (fund as the human would) -> deploy -> serverenv ->
//   server -> deal (mock 1Click + mock USDC) -> recover.
// The kit commands run as separate processes exactly as on mainnet, with
// LIVE_NETWORK=sandbox and LIVE_AUTO_YES=1 (auto-confirm, sandbox only).

import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas, type KeyPairString } from 'near-api-js';

import { base58Encode } from '../../src/encoding.ts';
import { quoteSigningMessage } from '../../src/quoteSignature.ts';

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIVE_JS = join(SERVER_DIR, 'dist', 'scripts', 'live', 'live.js');
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required (run scripts/live/prove-sandbox.sh)`);
  return v;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs: ChildProcess[] = [];
let home = '';
const cleanup = () => {
  for (const p of procs) p.kill('SIGKILL');
  if (home && !process.env.KEEP) rmSync(home, { recursive: true, force: true });
};
process.on('exit', cleanup);

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  console.log(`  ok - ${msg}`);
}

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

async function waitFor(what: string, fn: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
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

/** Runs a kit command as a child process; returns stdout (also echoed, indented). */
function kit(liveEnv: Record<string, string>, ...args: string[]): Promise<string> {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', LIVE_JS, ...args], {
      env: { ...process.env, ...liveEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
      process.stdout.write(String(d).replace(/^/gm, '    | '));
    });
    p.stderr.on('data', (d) => {
      out += d;
      process.stdout.write(String(d).replace(/^/gm, '    ! '));
    });
    p.on('exit', (code) => (code === 0 ? res(out) : rej(new Error(`live.js ${args[0]} exited ${code}`))));
  });
}

async function main() {
  const bin = env('NEAR_SANDBOX_BIN');
  const ftWasm = readFileSync(env('FT_WASM'));
  env('ESCROW_WASM');
  home = mkdtempSync(join(tmpdir(), 'escrow-live-prove-'));

  // ------------------------------------------------------------ sandbox
  await new Promise<void>((res, rej) => {
    const p = spawn(bin, ['--home', home, 'init', '--fast'], { stdio: 'ignore' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error('sandbox init failed'))));
  });
  const rpcPort = await freePort();
  const log = openSync(join(home, 'sandbox.log'), 'a');
  procs.push(
    spawn(bin, ['--home', home, 'run', '--rpc-addr', `127.0.0.1:${rpcPort}`, '--network-addr', `127.0.0.1:${await freePort()}`], {
      stdio: ['ignore', log, log],
    }),
  );
  const rpcUrl = `http://127.0.0.1:${rpcPort}`;
  const provider = new JsonRpcProvider({ url: rpcUrl });
  await waitFor('sandbox', async () => !!(await provider.viewBlock({ finality: 'final' })));
  const validator = JSON.parse(readFileSync(join(home, 'validator_key.json'), 'utf8')) as { account_id: string; secret_key: string };
  const rootId = validator.account_id; // plays the human's wallet (LIVE_BENEFICIARY)
  const rootKey = validator.secret_key as KeyPairString;
  const rootPk = KeyPair.fromString(rootKey).getPublicKey();
  const root = new Account(rootId, provider, rootKey);
  const as = (id: string) => new Account(id, provider, rootKey);
  const ftView = async (method: string, args: Record<string, unknown>) => provider.callFunction({ contractId: usdc, method, args });

  // mock USDC (same NEP-141/145 interface), payer standing in for intents.near
  const usdc = `usdc.${rootId}`;
  const payer = `intents.${rootId}`;
  for (const id of [usdc, payer]) await root.createSubAccount({ accountOrPrefix: id, publicKey: rootPk, nearToTransfer: nearToYocto(20) });
  await as(usdc).deployContract(new Uint8Array(ftWasm));
  await as(usdc).callFunction({ contractId: usdc, methodName: 'new', args: {} });
  await root.callFunction({ contractId: usdc, methodName: 'mint', args: { account_id: payer, amount: '1000000000' } });
  await root.callFunction({ contractId: usdc, methodName: 'mint', args: { account_id: rootId, amount: '0' } }); // register the "human"
  console.log(`sandbox ${rpcUrl}; human wallet = ${rootId}; mock USDC = ${usdc}`);

  const liveEnv: Record<string, string> = {
    LIVE_NETWORK: 'sandbox',
    LIVE_RPC_URL: rpcUrl,
    LIVE_HOME: join(home, 'live'),
    LIVE_USDC: usdc,
    LIVE_BENEFICIARY: rootId,
    LIVE_WASM: env('ESCROW_WASM'),
    LIVE_AUTO_YES: '1',
    ENV_FILE: '',
  };

  // ------------------------------------------------------------ 1. keys (twice: idempotent)
  console.log('\n[kit] keys');
  const k1 = await kit(liveEnv, 'keys');
  const k2 = await kit(liveEnv, 'keys');
  const ids = (s: string) => [...s.matchAll(/^\s+(escrow|relayer|owner|arbiter)\s+([0-9a-f]{64})$/gm)].map((m) => m[2]);
  check(ids(k1).length === 4 && ids(k1).join() === ids(k2).join(), 'keys: 4 implicit ids, idempotent');
  check(!/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/.test(k1), 'keys: no secret printed');
  const [escrowId, relayerId] = ids(k1);

  // ------------------------------------------------------------ 2. preflight, then fund exactly what it asks
  console.log('\n[kit] preflight (nothing funded yet)');
  await kit(liveEnv, 'preflight');
  const funding = JSON.parse(readFileSync(join(home, 'live', 'funding.json'), 'utf8')) as { role: string; account_id: string; send_yocto: string }[];
  for (const f of funding) {
    if (BigInt(f.send_yocto) === 0n) continue;
    // the human: a plain NEAR transfer to the implicit account (creates it)
    await root.transfer({ receiverId: f.account_id, amount: BigInt(f.send_yocto) });
    console.log(`  human sent ${Number(BigInt(f.send_yocto) / 10n ** 19n) / 1e5} NEAR to ${f.role}`);
  }
  console.log('\n[kit] preflight (after funding)');
  await kit(liveEnv, 'preflight');

  // ------------------------------------------------------------ 3. deploy
  console.log('\n[kit] deploy');
  const dep = await kit(liveEnv, 'deploy');
  check(/deployed \+ initialized/.test(dep) && /registered with USDC/.test(dep) && /NOT locked/.test(dep), 'deploy: batch deploy+init, USDC registration, not locked');
  const storageAfterInit = Number(/storage_usage after init: (\d+)/.exec(dep)?.[1]);

  // ------------------------------------------------------------ mock 1Click
  const qk = generateKeyPairSync('ed25519');
  const quotePk = `ed25519:${base58Encode(Buffer.from((qk.publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url'))}`;
  let depN = 0;
  const delivered = new Set<string>();
  const forwarders: NodeJS.Timeout[] = [];
  const mockPort = await freePort();
  const mock = createHttpServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/v0/tokens') return send(200, []);
      if (url.pathname === '/v0/status') {
        const a = url.searchParams.get('depositAddress') ?? '';
        return send(200, { status: delivered.has(a) ? 'SUCCESS' : 'PENDING_DEPOSIT', updatedAt: new Date().toISOString(), swapDetails: {} });
      }
      if (url.pathname === '/v0/quote' && req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
        const q = JSON.parse(raw);
        const depositAddress = `dep${++depN}.${rootId}`;
        await root.createSubAccount({ accountOrPrefix: depositAddress, publicKey: rootPk, nearToTransfer: nearToYocto(2) });
        const isPay = q.recipient === escrowId;
        const quote = {
          amountIn: isPay ? '4200000000' : q.amount,
          amountInFormatted: isPay ? '4.2' : (Number(q.amount) / 1e6).toString(),
          amountInUsd: '5.0',
          minAmountIn: isPay ? '4150000000' : q.amount,
          amountOut: q.amount,
          amountOutFormatted: (Number(q.amount) / 1e6).toString(),
          amountOutUsd: '5.0',
          minAmountOut: q.amount,
          depositAddress,
          deadline: q.deadline,
          timeEstimate: 20,
        };
        const body: Record<string, unknown> = { correlationId: `mock-${depN}`, timestamp: new Date().toISOString(), quoteRequest: q, quote };
        body.signature = `ed25519:${base58Encode(edSign(null, Buffer.from(quoteSigningMessage(body as never), 'utf8'), qk.privateKey))}`;
        send(201, body);
        if (isPay) {
          // "the human sends GRAM"; 1Click then delivers USDC with ft_transfer_call + customRecipientMsg
          setTimeout(async () => {
            await as(payer).callFunction({
              contractId: usdc,
              methodName: 'ft_transfer_call',
              args: { receiver_id: escrowId, amount: q.amount, msg: q.customRecipientMsg },
              deposit: 1n,
              gas: teraToGas(100),
            });
            delivered.add(depositAddress);
          }, 1500);
        } else {
          // payout: forward whatever reaches the deposit address to the recipient
          const t = setInterval(async () => {
            try {
              const bal = BigInt((await ftView('ft_balance_of', { account_id: depositAddress })) as string);
              if (bal > 0n) {
                clearInterval(t);
                // USDC on NEAR is forwarded; a TON or Confidential Intents payout
                // is "delivered" off-NEAR (the tokens stay at the mock address).
                if (q.destinationAsset === `nep141:${usdc}` && q.recipientType === 'DESTINATION_CHAIN') {
                  await as(depositAddress).callFunction({
                    contractId: usdc,
                    methodName: 'ft_transfer',
                    args: { receiver_id: q.recipient, amount: bal.toString() },
                    deposit: 1n,
                  });
                }
                delivered.add(depositAddress);
              }
            } catch {
              /* retry */
            }
          }, 1000);
          forwarders.push(t);
        }
        return;
      }
      send(404, { message: 'not found' });
    } catch (e) {
      send(500, { message: String(e) });
    }
  });
  await new Promise<void>((r) => mock.listen(mockPort, '127.0.0.1', () => r()));

  // ------------------------------------------------------------ 4. server env + server
  const apiPort = await freePort();
  const serverEnv = {
    ...liveEnv,
    LIVE_ONECLICK_BASE_URL: `http://127.0.0.1:${mockPort}`,
    LIVE_QUOTE_PUBLIC_KEY: quotePk,
    LIVE_PORT: String(apiPort),
  };
  console.log('\n[kit] serverenv');
  const se = await kit(serverEnv, 'serverenv');
  check(!se.includes('ed25519:') || !/RELAYER_PRIVATE_KEY=/.test(se), 'serverenv: no secret printed');
  const serverLog = openSync(join(home, 'server.log'), 'a');
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(SERVER_DIR, 'dist', 'src', 'main.js')], {
    env: { ...process.env, ENV_FILE: join(home, 'live', 'server.env') },
    stdio: ['ignore', serverLog, serverLog],
  });
  procs.push(server);
  await waitFor('server', async () => (await fetch(`http://127.0.0.1:${apiPort}/api/config`)).ok, 30_000);

  // ------------------------------------------------------------ 5. deal
  const nearOf = async (id: string) => BigInt(((await provider.viewAccount({ accountId: id })) as unknown as { amount: string | bigint }).amount);
  const relayerBefore = await nearOf(relayerId);
  const escrowBefore = await nearOf(escrowId);
  console.log('\n[kit] deal');
  const dealEnv = { ...serverEnv, LIVE_API: `http://127.0.0.1:${apiPort}` };
  const before = BigInt((await ftView('ft_balance_of', { account_id: rootId })) as string);
  const d = await kit(dealEnv, 'deal', '--refund', 'UQ-sandbox-ton-refund-address', '--amount', '5');
  check(/quote verified: 1Click signature OK/.test(d), 'deal: pay quote verified like the web would');
  check(/FUNDING ANSWER: YES/.test(d), 'deal: funding detected (funding path) and deal Funded');
  check(/DEAL COMPLETE/.test(d), 'deal: deliver, accept, payout quote, withdraw, PaidOut');
  const after = BigInt((await ftView('ft_balance_of', { account_id: rootId })) as string);
  check(after - before === 4_850_000n, 'the human received 5 USDC minus the 3% fee through the (mock) 1Click payout');
  const escView = (await provider.viewAccount({ accountId: escrowId })) as unknown as { storage_usage?: number; storageUsage?: number };
  const storageAfterDeal = Number(escView.storage_usage ?? escView.storageUsage);
  // resume is idempotent
  const again = await kit(dealEnv, 'deal');
  check(/resuming deal at step "done"/.test(again), 'deal: re-running resumes from saved progress');

  // ------------------------------------------------------------ 5b. scenarios: dispute, settle, refund (2 USDC each)
  const arbiterId = ids(k1)[3];
  await root.transfer({ receiverId: arbiterId, amount: nearToYocto(0.05) }); // the human funds the arbiter
  const beforeScen = BigInt((await ftView('ft_balance_of', { account_id: rootId })) as string);
  for (const sc of ['dispute', 'settle', 'refund']) {
    console.log(`\n[kit] deal --scenario ${sc}`);
    const out = await kit(dealEnv, 'deal', '--scenario', sc, '--amount', '2', '--refund', 'UQ-sandbox-ton-refund-address');
    check(new RegExp(`SCENARIO ${sc.toUpperCase()} COMPLETE`).test(out), `scenario ${sc}: complete`);
  }
  const afterScen = BigInt((await ftView('ft_balance_of', { account_id: rootId })) as string);
  // dispute 60/40: creator 1.2 - 3% = 1.164 to NEAR, client 0.8 to TON;
  // settle 70/30: creator 1.4 - 3% = 1.358 to Confidential Intents, client 0.6 to NEAR;
  // refund: client 2 to TON.
  check(afterScen - beforeScen === 1_164_000n + 600_000n, 'scenarios: the NEAR payouts reached the human (1.164 + 0.6 USDC)');
  forwarders.forEach(clearInterval);
  const fmt = (y: bigint) => (Number(y / 10n ** 16n) / 1e8).toFixed(5);
  console.log(`  measured NEAR spent during the deal: relayer ${fmt(relayerBefore - (await nearOf(relayerId)))}, escrow ${fmt(escrowBefore - (await nearOf(escrowId)))}`);

  // ------------------------------------------------------------ 6. fees + recover
  server.kill('SIGTERM');
  await sleep(500);
  console.log('\n[kit] withdraw-fees');
  await kit(liveEnv, 'withdraw-fees');
  const afterFees = BigInt((await ftView('ft_balance_of', { account_id: rootId })) as string);
  // 4.85 + 0.15 (accept) + 1.164 + 0.6 (scenario NEAR payouts) + 0.036 + 0.042 (scenario fees)
  check(afterFees - before === 6_842_000n, 'withdraw-fees: every fee reached the human too (6.842 USDC in total on NEAR)');
  const escConf = (await provider.callFunction({ contractId: escrowId, method: 'get_config', args: {} })) as { total_liabilities: string; fee_accrued: string };
  check(escConf.total_liabilities === '0' && escConf.fee_accrued === '0', 'escrow owes nothing after the fee withdrawal');
  const rootBefore = BigInt(((await provider.viewAccount({ accountId: rootId })) as unknown as { amount: string | bigint }).amount);
  console.log('\n[kit] recover');
  await kit(liveEnv, 'recover');
  for (const id of [escrowId, relayerId]) {
    let gone = false;
    try {
      await provider.viewAccount({ accountId: id });
    } catch {
      gone = true;
    }
    check(gone, `recover: ${id.slice(0, 8)}… deleted`);
  }
  const rootAfter = BigInt(((await provider.viewAccount({ accountId: rootId })) as unknown as { amount: string | bigint }).amount);
  console.log(`  human got back ${Number((rootAfter - rootBefore) / 10n ** 19n) / 1e5} NEAR`);
  check(rootAfter > rootBefore, 'recover: NEAR returned to the human');
  mock.close();

  console.log(`\nmeasured escrow storage: after init ${storageAfterInit} B, after one full deal ${storageAfterDeal} B`);
  console.log('LIVE KIT SANDBOX PROOF PASSED');
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((e) => {
    console.error('\nPROOF FAILED:', e instanceof Error ? e.message : e);
    if (home) console.error(`logs in ${home}`);
    home = '';
    for (const p of procs) p.kill('SIGKILL');
    process.exit(1);
  });
