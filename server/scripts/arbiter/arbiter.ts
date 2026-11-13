// The arbiter's tool. The team decides disputes
// by hand; this is what they use:
//
//   init      make the arbiter's own keys (API key + evidence decryption key)
//   keys      print the two PUBLIC keys (server env + web config)
//   queue     disputed deals from the chain, most urgent first, with countdowns
//   case N    the terms, the client's reason and both sides' files links, decrypted
//             (--files <path>... checks local files against the delivery fingerprint)
//   resolve N <percent to the creator> "<one-line reason>"
//             sends resolve_dispute from the arbiter account, then writes the
//             public log line. On mainnet it asks to type YES first.
//
// Keys live in $ARBITER_HOME/arbiter.json (chmod 600), apart from the server:
// the server only knows the API PUBLIC key and stores ciphertext.
//
// Usage: ARBITER_HOME=<dir> node dist/scripts/arbiter/arbiter.js <command> ...

import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { Account, JsonRpcProvider, teraToGas, type KeyPairString } from 'near-api-js';

import type { DealView } from '../../src/chain.ts';
import { base58Encode, baseUnitsToUsdc, signedMessage, verifySignature } from '../../src/encoding.ts';
import { newNoteKey, notePublicKey, openAsArbiter } from './crypto.ts';

interface Config {
  network: string;
  rpcUrl: string;
  apiUrl: string;
  contractId: string;
  arbiterAccountId: string;
  /** NEAR key of the arbiter account: inline (sandbox) or a key file with `private_key` / `secret_key`. */
  arbiterPrivateKey?: string;
  arbiterKeyFile?: string;
  /** ed25519 seed (hex) for requests to our API. */
  apiSeed: string;
  /** x25519 private key (hex) that opens the evidence. */
  notePrivateKey: string;
}

const HOME = resolve(process.env.ARBITER_HOME ?? './arbiter-home');
const FILE = join(HOME, 'arbiter.json');

function load(): Config {
  if (!existsSync(FILE)) throw new Error(`no ${FILE}: run "init" first (or set ARBITER_HOME)`);
  return JSON.parse(readFileSync(FILE, 'utf8')) as Config;
}

function apiKey(seedHex: string) {
  const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const jwk = createPublicKey(priv).export({ format: 'jwk' }) as { x: string };
  return { pk: `ed25519:${base58Encode(Buffer.from(jwk.x, 'base64url'))}`, sign: (m: string) => edSign(null, Buffer.from(m, 'utf8'), priv).toString('base64') };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function post(cfg: Config, op: string, fields: Record<string, unknown>) {
  const payload = JSON.stringify({ ...fields, issued_at_ns: (BigInt(Date.now()) * 1_000_000n).toString(), nonce: randomBytes(8).toString('hex') });
  const signature = apiKey(cfg.apiSeed).sign(`escrow-v1|${cfg.contractId}|arbiter|${op}|${payload}`);
  const res = await fetch(`${cfg.apiUrl}/api/arbiter/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload, signature }) });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new Error(`server answered ${res.status}: ${body.message ?? body.error ?? ''}`);
  return body;
}

const view = <T>(cfg: Config, method: string, args: Record<string, unknown>) =>
  new JsonRpcProvider({ url: cfg.rpcUrl }).callFunction({ contractId: cfg.contractId, method, args }) as Promise<T>;

const when = (ns: string | null) => (ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace('.000Z', 'Z') : '-');
function leftText(ns: string | null): string {
  if (!ns) return '-';
  const ms = Number(BigInt(ns) / 1_000_000n) - Date.now();
  if (ms <= 0) return 'OVER (50/50 can be triggered by anyone)';
  const h = Math.floor(ms / 3_600_000);
  return h >= 48 ? `${Math.floor(h / 24)} d ${h % 24} h` : h >= 1 ? `${h} h ${Math.floor((ms % 3_600_000) / 60_000)} min` : `${Math.ceil(ms / 60_000)} min`;
}

// ---------------------------------------------------------------- init / keys

function init(args: string[]) {
  if (existsSync(FILE)) throw new Error(`${FILE} already exists: the keys are not replaced (move the file away first)`);
  const need = (name: string) => {
    const v = flag(args, name);
    if (!v) throw new Error(`--${name} is required`);
    return v;
  };
  const cfg: Config = {
    network: need('network'),
    rpcUrl: need('rpc'),
    apiUrl: need('api').replace(/\/+$/, ''),
    contractId: need('contract'),
    arbiterAccountId: need('account'),
    arbiterKeyFile: need('key-file'),
    apiSeed: randomBytes(32).toString('hex'),
    notePrivateKey: newNoteKey().priv,
  };
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log(`written ${FILE}`);
  keys();
}

function keys() {
  const cfg = load();
  console.log('Public keys (safe to share):');
  console.log(`  server env   ARBITER_API_PUBLIC_KEY=${apiKey(cfg.apiSeed).pk}`);
  console.log(`  web config   arbiterNoteKey: '${notePublicKey(cfg.notePrivateKey)}'`);
}

// ---------------------------------------------------------------- queue

async function queue() {
  const cfg = load();
  const { deals_count } = await view<{ deals_count: number }>(cfg, 'get_config', {});
  const disputed: DealView[] = [];
  for (let from = 0; from < deals_count; from += 50) {
    const page = await view<DealView[]>(cfg, 'get_deals', { from, limit: 50 });
    disputed.push(...page.filter((d) => d.state === 'Disputed'));
  }
  disputed.sort((a, b) => (BigInt(a.dispute_ends_at_ns ?? '0') < BigInt(b.dispute_ends_at_ns ?? '0') ? -1 : 1));
  console.log(`${disputed.length} open dispute(s) on ${cfg.contractId} (${deals_count} deals in total)`);
  for (const d of disputed) {
    console.log(`  deal ${d.id}   ${baseUnitsToUsdc(d.amount)} USDC   opened ${when(d.disputed_at_ns)}   decide before ${when(d.dispute_ends_at_ns)}   left: ${leftText(d.dispute_ends_at_ns)}`);
  }
  if (disputed.length) console.log('Next: "case <deal id>"');
}

// ---------------------------------------------------------------- case

function filesIn(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) out.push(...filesIn(readdirSync(p).map((f) => join(p, f))));
    else out.push(p);
  }
  return out;
}

/** Same fingerprint as web/src/lib/files.ts. */
function filesFingerprint(salt: string, files: string[]): string {
  const lines = files.map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')} ${statSync(f).size}`).sort();
  const manifest = `kept-files-v1\n${lines.join('\n')}`;
  return `v1:${createHash('sha256').update(Buffer.concat([Buffer.from(salt, 'hex'), Buffer.from(manifest, 'utf8')])).digest('hex')}`;
}

interface Delivery {
  link: string;
  salt: string;
}

async function showCase(args: string[]) {
  const cfg = load();
  const dealId = Number(args[0]);
  if (!Number.isSafeInteger(dealId)) throw new Error('usage: case <deal id> [--files <path>...]');
  const c = await post(cfg, 'case', { deal_id: dealId });
  // The chain is the source of truth for the deal; the server only adds the terms text and the notes.
  const deal = await view<DealView | null>(cfg, 'get_deal', { deal_id: dealId });
  if (!deal) throw new Error('deal not found on-chain');
  const t = c.terms as Record<string, any>;
  console.log(`\nDEAL ${dealId}   state ${deal.state}   ${baseUnitsToUsdc(deal.amount)} USDC`);
  console.log(`  terms match the hash on-chain: ${deal.terms_hash === t.terms_hash ? 'yes' : 'NO — do not rely on the text below'}`);
  console.log(`  delivered ${when(deal.delivered_at_ns)}   dispute opened ${when(deal.disputed_at_ns)}   decide before ${when(deal.dispute_ends_at_ns)} (left: ${leftText(deal.dispute_ends_at_ns)})`);
  console.log('\nTERMS (signed by the creator, accepted by the client)');
  console.log(`  ${t.title}`);
  for (const line of String(t.description).split('\n')) console.log(`  ${line}`);
  console.log(`  revisions: ${t.revisions === '' ? 'not set' : t.revisions}   work time: ${Math.round(t.delivery_duration_seconds / 3600)} h   review: ${Math.round(t.review_period_seconds / 3600)} h`);

  const notes = c.notes as { kind: string; signer: string; payload: string; signature: string }[];
  const read = <T>(kind: string, signerPk: string): T | null => {
    const n = notes.find((x) => x.kind === kind);
    if (!n) return null;
    if (!verifySignature(signerPk, signedMessage(cfg.contractId, dealId, 'note', n.payload), n.signature)) {
      console.log(`  (!) the ${kind} note is NOT signed by the right deal key: ignored`);
      return null;
    }
    try {
      return openAsArbiter<T>(cfg.notePrivateKey, { contractId: cfg.contractId, dealId, kind }, JSON.parse(n.payload).data);
    } catch {
      console.log(`  (!) the ${kind} note could not be decrypted with the arbiter key`);
      return null;
    }
  };
  const fromClient = read<{ point: string; pointText: string; text: string; delivery: Delivery | null }>('dispute_arbiter', deal.client_pk);
  const fromCreator = read<Delivery>('delivery_arbiter', deal.creator_pk);

  console.log('\nTHE CLIENT SAYS');
  if (!fromClient) console.log('  nothing readable (no unmet point named: by the rules the dispute goes to the creator)');
  else {
    console.log(`  unmet point: ${fromClient.pointText}`);
    console.log(`  ${fromClient.text}`);
  }
  console.log('\nFILES');
  console.log(`  fingerprint on-chain: ${deal.deliverable_hash ?? '-'}`);
  console.log(`  link from the client:  ${fromClient?.delivery?.link ?? '(none)'}`);
  console.log(`  link from the creator: ${fromCreator?.link ?? '(not sent yet: the creator has not opened the deal since the dispute)'}`);
  if (fromClient?.delivery && fromCreator) {
    console.log(`  both sides name the same link and salt: ${fromClient.delivery.link === fromCreator.link && fromClient.delivery.salt === fromCreator.salt ? 'yes' : 'NO'}`);
  }
  const fi = args.indexOf('--files');
  if (fi >= 0) {
    const files = filesIn(args.slice(fi + 1));
    for (const [who, d] of [
      ['client', fromClient?.delivery],
      ['creator', fromCreator],
    ] as const) {
      if (!d) continue;
      console.log(`  ${files.length} local file(s) vs the fingerprint, with the ${who}'s salt: ${filesFingerprint(d.salt, files) === deal.deliverable_hash ? 'MATCH (these are the delivered files)' : 'no match'}`);
    }
  }
  console.log(`\nNext: resolve ${dealId} <percent to the creator, 0..100> "<one-line reason for the public log>"`);
}

// ---------------------------------------------------------------- resolve

async function resolveDispute(args: string[]) {
  const cfg = load();
  const dealId = Number(args[0]);
  const pct = Number(args[1]);
  const reason = args.slice(2).filter((a) => a !== '--yes').join(' ').trim();
  if (!Number.isSafeInteger(dealId) || !Number.isFinite(pct) || pct < 0 || pct > 100 || !reason) {
    throw new Error('usage: resolve <deal id> <percent to the creator, 0..100> "<one-line reason>"');
  }
  const bps = Math.round(pct * 100);
  const deal = await view<DealView | null>(cfg, 'get_deal', { deal_id: dealId });
  if (!deal || deal.state !== 'Disputed') throw new Error(`deal ${dealId} is not in a dispute (state: ${deal?.state ?? 'none'})`);
  const share = (BigInt(deal.amount) * BigInt(bps)) / 10_000n;
  console.log(`Deal ${dealId}, ${baseUnitsToUsdc(deal.amount)} USDC on ${cfg.contractId} (${cfg.network}):`);
  console.log(`  creator ${pct}% = ${baseUnitsToUsdc(share)} USDC before the fee, client ${baseUnitsToUsdc(BigInt(deal.amount) - share)} USDC`);
  console.log(`  public log line: "${reason}"`);
  if (cfg.network !== 'sandbox' || !args.includes('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('This signs a transaction from the arbiter account and cannot be undone. Type YES to send: ');
    rl.close();
    if (answer.trim() !== 'YES') throw new Error('not sent');
  }
  const secret = cfg.arbiterPrivateKey ?? (() => {
    const k = JSON.parse(readFileSync(cfg.arbiterKeyFile!, 'utf8')) as Record<string, string>;
    return k.private_key ?? k.secret_key;
  })();
  const arbiter = new Account(cfg.arbiterAccountId, new JsonRpcProvider({ url: cfg.rpcUrl }), secret as KeyPairString);
  await arbiter.callFunction({ contractId: cfg.contractId, methodName: 'resolve_dispute', args: { deal_id: dealId, creator_share_bps: bps }, gas: teraToGas(30) });
  console.log('resolve_dispute sent.');
  const line = await post(cfg, 'decision', { deal_id: dealId, outcome: bps === 10_000 ? 'creator' : bps === 0 ? 'client' : 'split', reason });
  console.log(`public log: ${line.month}: ${line.outcome}: ${line.reason} (shown from tomorrow)`);
}

const [command, ...rest] = process.argv.slice(2);
const run: Record<string, () => unknown> = {
  init: () => init(rest),
  keys,
  queue,
  case: () => showCase(rest),
  resolve: () => resolveDispute(rest),
};
if (!command || !run[command]) {
  console.log('commands: init | keys | queue | case <deal id> [--files <path>...] | resolve <deal id> <percent> "<reason>"');
  process.exit(command ? 1 : 0);
}
Promise.resolve(run[command]()).catch((e) => {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
});
