// Shared helpers for the live-test kit (mainnet, or a local sandbox for the
// dry run). Secrets live only under LIVE_HOME (default $HOME/escrow-live),
// files chmod 600. Nothing here prints a private key.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, type KeyPairString } from 'near-api-js';

import { base58Encode, implicitAccountId } from '../../src/encoding.ts';

export type Net = 'mainnet' | 'sandbox';

export const MAINNET_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const ROLES = ['escrow', 'relayer', 'owner', 'arbiter'] as const;
export type Role = (typeof ROLES)[number];

export interface LiveConfig {
  net: Net;
  rpcUrl: string;
  home: string;
  usdc: string;
  beneficiary: string;
  apiUrl: string;
  wasmPath: string;
  autoYes: boolean;
  /** Only for the sandbox dry run (mock 1Click signs with its own key). */
  quotePublicKeyOverride: string | null;
}

function fail(msg: string): never {
  throw new Error(msg);
}

export function liveConfig(): LiveConfig {
  const net = (process.env.LIVE_NETWORK ?? 'mainnet') as Net;
  if (net !== 'mainnet' && net !== 'sandbox') throw new Error('LIVE_NETWORK must be mainnet or sandbox');
  const autoYes = process.env.LIVE_AUTO_YES === '1';
  if (autoYes && net !== 'sandbox') throw new Error('LIVE_AUTO_YES is only allowed with LIVE_NETWORK=sandbox');
  const quotePk = process.env.LIVE_QUOTE_PUBLIC_KEY || null;
  if (quotePk && net !== 'sandbox') throw new Error('LIVE_QUOTE_PUBLIC_KEY is only allowed with LIVE_NETWORK=sandbox');
  return {
    net,
    rpcUrl: process.env.LIVE_RPC_URL || (net === 'mainnet' ? 'https://free.rpc.fastnear.com' : 'http://127.0.0.1:3030'),
    home: process.env.LIVE_HOME || `${process.env.HOME}/escrow-live`,
    usdc: process.env.LIVE_USDC || MAINNET_USDC,
    beneficiary: process.env.LIVE_BENEFICIARY || fail('set LIVE_BENEFICIARY=<your own NEAR account> (it receives the test payout and leftovers)'),
    apiUrl: process.env.LIVE_API || 'http://127.0.0.1:8787',
    wasmPath: process.env.LIVE_WASM || `${process.env.HOME}/target/escrow/near/escrow.wasm`,
    autoYes,
    quotePublicKeyOverride: quotePk,
  };
}

// ---------------------------------------------------------------- files

export function ensurePrivateDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function writeSecret(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}

// ---------------------------------------------------------------- account keys

export interface RoleKey {
  account_id: string;
  public_key: string;
  secret_key: string;
}

export function keysDir(cfg: LiveConfig): string {
  return join(cfg.home, 'keys');
}

/** Loads or creates the 4 implicit-account keys. Idempotent. */
export function ensureKeys(cfg: LiveConfig): Record<Role, RoleKey> {
  ensurePrivateDir(cfg.home);
  ensurePrivateDir(keysDir(cfg));
  const out = {} as Record<Role, RoleKey>;
  for (const role of ROLES) {
    const file = join(keysDir(cfg), `${role}.json`);
    if (existsSync(file)) {
      chmodSync(file, 0o600);
      out[role] = JSON.parse(readFileSync(file, 'utf8')) as RoleKey;
      continue;
    }
    const kp = KeyPair.fromRandom('ed25519');
    const public_key = kp.getPublicKey().toString();
    const k: RoleKey = { account_id: implicitAccountId(public_key), public_key, secret_key: kp.toString() };
    writeSecret(file, JSON.stringify(k, null, 2) + '\n');
    out[role] = k;
  }
  return out;
}

export function loadKeys(cfg: LiveConfig): Record<Role, RoleKey> {
  for (const role of ROLES) {
    if (!existsSync(join(keysDir(cfg), `${role}.json`))) throw new Error(`missing key for ${role}: run "keys" first`);
  }
  return ensureKeys(cfg);
}

export function signerAccount(cfg: LiveConfig, k: RoleKey): Account {
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  return new Account(k.account_id, provider, KeyPairSigner.fromSecretKey(k.secret_key as KeyPairString));
}

// ---------------------------------------------------------------- deal keys (browser-side, off-chain)

export interface DealKeyFile {
  pk: string;
  pkcs8_b64: string;
}

export function newDealKey(): DealKeyFile {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  return { pk: `ed25519:${base58Encode(raw)}`, pkcs8_b64: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64') };
}

export function signWith(k: DealKeyFile, message: string): string {
  const priv = createPrivateKey({ key: Buffer.from(k.pkcs8_b64, 'base64'), format: 'der', type: 'pkcs8' });
  // sanity: the stored pk belongs to this private key
  const raw = Buffer.from((createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x, 'base64url');
  if (`ed25519:${base58Encode(raw)}` !== k.pk) throw new Error('deal key file is inconsistent');
  return edSign(null, Buffer.from(message, 'utf8'), priv).toString('base64');
}

export const randomHex = (n: number) => randomBytes(n).toString('hex');

// ---------------------------------------------------------------- raw RPC (read-only)

export async function rpc<T = any>(cfg: LiveConfig, method: string, params: unknown): Promise<T> {
  const res = await fetch(cfg.rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'live', method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string; data?: unknown } };
  if (j.error) {
    const err = new Error(`${method}: ${j.error.cause?.name ?? j.error.message ?? 'rpc error'}`) as Error & { cause_name?: string };
    err.cause_name = j.error.cause?.name;
    throw err;
  }
  return j.result as T;
}

export interface AccountView {
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
}

export async function viewAccount(cfg: LiveConfig, accountId: string): Promise<AccountView | null> {
  try {
    return await rpc<AccountView>(cfg, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  } catch (e) {
    if ((e as { cause_name?: string }).cause_name === 'UNKNOWN_ACCOUNT') return null;
    throw e;
  }
}

export async function viewCall<T = any>(cfg: LiveConfig, contract: string, method: string, args: object): Promise<T> {
  const r = await rpc<{ result: number[] }>(cfg, 'query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
  });
  const text = Buffer.from(r.result).toString('utf8');
  return (text ? JSON.parse(text) : null) as T;
}

export async function accessKeys(cfg: LiveConfig, accountId: string): Promise<{ public_key: string }[]> {
  const r = await rpc<{ keys: { public_key: string }[] }>(cfg, 'query', {
    request_type: 'view_access_key_list',
    finality: 'final',
    account_id: accountId,
  });
  return r.keys;
}

export const EMPTY_CODE_HASH = '11111111111111111111111111111111';

/** NEAR code hash of a wasm = base58(sha256(bytes)). */
export function codeHash(wasm: Uint8Array): string {
  return base58Encode(createHash('sha256').update(wasm).digest());
}

// ---------------------------------------------------------------- units / output

export const YOCTO = 10n ** 24n;
export function fmtNear(yocto: bigint): string {
  const neg = yocto < 0n;
  const v = neg ? -yocto : yocto;
  const whole = v / YOCTO;
  const frac = ((v % YOCTO) * 100000n) / YOCTO;
  return `${neg ? '-' : ''}${whole}.${frac.toString().padStart(5, '0')}`;
}
/** Round up to 0.01 NEAR. */
export function ceilCentiNear(yocto: bigint): bigint {
  const c = 10n ** 22n;
  return ((yocto + c - 1n) / c) * c;
}
export function fmtUsdc(units: string | bigint): string {
  const v = BigInt(units);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`;
}

export function txLink(cfg: LiveConfig, hash: string): string {
  return cfg.net === 'mainnet' ? `https://nearblocks.io/txns/${hash}` : `(sandbox tx ${hash})`;
}
export function accountLink(cfg: LiveConfig, id: string): string {
  return cfg.net === 'mainnet' ? `https://nearblocks.io/address/${id}` : `(sandbox account ${id})`;
}

// ---------------------------------------------------------------- confirmation

export async function confirmYes(cfg: LiveConfig, what: string): Promise<void> {
  console.log(`\n${what}`);
  if (cfg.autoYes) {
    console.log('  [sandbox auto-confirm: YES]');
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Type YES to continue: ')).trim();
  rl.close();
  if (answer !== 'YES') {
    console.log('Aborted (nothing was sent).');
    process.exit(2);
  }
}

export async function pause(cfg: LiveConfig, what: string): Promise<void> {
  if (cfg.autoYes) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question(`${what} [Enter] `);
  rl.close();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Sends a tx and returns its hash; throws with the failure if it failed. */
export async function sendTx(account: Account, receiverId: string, actions: unknown[]): Promise<{ hash: string; value: unknown }> {
  const res = (await account.signAndSendTransaction({
    receiverId,
    actions: actions as never,
    // FINAL so that follow-up views (finality: final) already see the result
    waitUntil: 'FINAL',
    throwOnFailure: false,
  } as never)) as { transaction: { hash: string }; status: Record<string, unknown> };
  const hash = res.transaction.hash;
  if (res.status && 'Failure' in res.status) {
    throw new Error(`transaction ${hash} failed: ${JSON.stringify(res.status.Failure).slice(0, 400)}`);
  }
  const b64 = String((res.status as { SuccessValue?: string }).SuccessValue ?? '');
  let value: unknown = null;
  if (b64) {
    const t = Buffer.from(b64, 'base64').toString('utf8');
    try {
      value = JSON.parse(t);
    } catch {
      value = t;
    }
  }
  return { hash, value };
}
