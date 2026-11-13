#!/usr/bin/env node
// Pinky verify script: `npm run verify` from the repository root.
//
// Part A (local, no network money): builds the escrow contract and runs
//   contract/tests/verify.rs on a local near-sandbox: attack attempts must be
//   REFUSED with the contract's own error, honest paths must be OK.
// Part B (read-only mainnet RPC, no keys, no transactions):
//   - code hash of the deployed contract vs sha256 of a local build
//   - full-access keys on the contract account (none on the final one)
//   - config (token = NEAR-native USDC, periods)
//   - every listed deal transaction exists, succeeded and targets the contract
//   - the final outcome of every listed deal
//
// Exit code 0 only if every check behaves as expected.
//
// Options (after `npm run verify --`):
//   --contract <account>   contract to check on mainnet (default: the final
//                          contract from verify/mainnet-txs.json, or the TEST
//                          instance while the final one is a placeholder)
//   --build auto|reproducible|local|none   how to get the local wasm
//                          (auto = reproducible if docker is available, else local)
//   --wasm <file>          compare this wasm instead of building one
//   --skip-sandbox         only Part B
//   --skip-mainnet         only Part A
//   env NEAR_RPC, NEAR_ARCHIVAL_RPC to use your own RPC endpoints.

import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_DIR = join(ROOT, "contract");
const DATA = JSON.parse(readFileSync(join(ROOT, "verify", "mainnet-txs.json"), "utf8"));
const TEST_ID = "9e537c21716b2035d7c88f153f0283e8dda925af16bbb6cf6ea23256436c2c9c";
const FINAL_ID = "FINAL_CONTRACT_ID"; // placeholder until the key-less final contract is deployed
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const RPC = (process.env.NEAR_RPC || "https://rpc.mainnet.fastnear.com,https://near.drpc.org").split(",");
const ARCHIVAL = (process.env.NEAR_ARCHIVAL_RPC || "https://archival-rpc.mainnet.fastnear.com").split(",");
const EXPLORER = "https://nearblocks.io";

// ---------------------------------------------------------------- args
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const finalPlaceholder = FINAL_ID === "FINAL_CONTRACT_ID";
const contractId = opt("contract", finalPlaceholder ? TEST_ID : FINAL_ID);
const isTest = contractId === TEST_ID;
const buildMode = opt("build", "auto");
const wasmArg = opt("wasm", null);

// ---------------------------------------------------------------- report
const results = [];
const line = (s = "") => process.stdout.write(s + "\n");
function check(status, name, detail) {
  // status: PASS (as expected), FAIL (not as expected), INFO (expected on a test instance / not decisive)
  results.push({ status, name });
  line(`${status.padEnd(5)} ${name}`);
  if (detail) for (const d of String(detail).split("\n")) line(`      ${d}`);
}

// ---------------------------------------------------------------- helpers
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}

function unbase58(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const lead = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(n === 0n ? "" : hex, "hex")]);
}

/** ed25519 check of a deal-key signature, as the contract does it. */
function verifyEd25519(nearPk, message, sigB64) {
  const raw = unbase58(nearPk.replace(/^ed25519:/, ""));
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  return cryptoVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(sigB64, "base64"));
}

async function rpc(method, params, urls = RPC) {
  let last;
  for (const url of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
        });
        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        const j = await res.json();
        if (j.error) {
          last = new Error(JSON.stringify(j.error).slice(0, 300));
          break;
        }
        return j.result;
      } catch (e) {
        last = e;
      }
    }
  }
  throw last ?? new Error(`${method}: no RPC answered`);
}

async function view(account, method, args = {}) {
  const r = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString());
}

function run(cmd, args, opts = {}) {
  line(`$ ${cmd} ${args.join(" ")}${opts.cwd ? `   (in ${opts.cwd.replace(ROOT, ".")})` : ""}`);
  return spawnSync(cmd, args, { stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit", encoding: "utf8", shell: false, ...opts });
}

const has = (cmd) => spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
const targetDir = () => process.env.CARGO_TARGET_DIR || join(CONTRACT_DIR, "target");

// ---------------------------------------------------------------- part A
function partA() {
  line("\n=== Part A: attacks and honest paths on a local NEAR sandbox ===");
  if (!has("cargo")) {
    check("FAIL", "sandbox suite", "cargo not found. Install Rust (rustup) + cargo-near, see README 'Run from scratch'.");
    return;
  }
  const r = run("cargo", ["test", "--test", "verify", "--", "--nocapture", "--test-threads=1"], { cwd: CONTRACT_DIR, capture: true });
  const out = (r.stdout || "") + (r.stderr || "");
  // show the suite's own lines, not the compiler noise
  const shown = out
    .split("\n")
    .filter((l) => /^\s*(\[\d+\]|contract:|refused for|the contract|state |---|Pinky escrow|parties:|VERIFY_SANDBOX|test result|creator-dest|deal |client-dest|token balance|\d+ USDC|logged|revoke|settle_seq|error|panicked)/.test(l) || /^\s{11}\S/.test(l));
  for (const l of shown) line(l);
  const m = out.match(/VERIFY_SANDBOX attacks_refused=(\d+)\/(\d+) honest_ok=(\d+)\/(\d+) failures=(\d+)/);
  if (r.status !== 0 || !m) {
    line(out.split("\n").slice(-40).join("\n"));
    check("FAIL", "sandbox suite", `cargo test exited with ${r.status}`);
    return;
  }
  const [, ref, att, ok, hon, fails] = m.map(Number);
  check(fails === 0 && ref === att ? "PASS" : "FAIL", `sandbox attacks refused for the expected reason: ${ref}/${att}`);
  check(fails === 0 && ok === hon ? "PASS" : "FAIL", `sandbox honest paths OK: ${ok}/${hon}`);
  return { ref, att, ok, hon };
}

// ---------------------------------------------------------------- part B
function localWasm() {
  if (wasmArg) return { path: resolve(wasmArg), how: `given with --wasm` };
  let mode = buildMode;
  if (mode === "none") return null;
  if (mode === "auto") mode = has("docker") ? "reproducible" : "local";
  if (!has("cargo")) return { error: "cargo not found" };
  const sub = mode === "reproducible" ? "reproducible-wasm" : "non-reproducible-wasm";
  // A separate target dir, and the old output removed first: a cached wasm from an
  // earlier build must never be compared as if it were fresh.
  const dir = process.env.VERIFY_BUILD_TARGET_DIR || join(targetDir(), "verify-wasm");
  const expected = join(dir, "near", "escrow.wasm");
  rmSync(expected, { force: true });
  const started = Date.now();
  const r = run("cargo", ["near", "build", sub], { cwd: CONTRACT_DIR, capture: true, env: { ...process.env, CARGO_TARGET_DIR: dir } });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) return { error: `cargo near build ${sub} failed:\n${out.split("\n").slice(-15).join("\n")}` };
  // cargo-near prints the intermediate wasm32 build too; the deployable file is the last one, under near/
  const found = [...out.matchAll(/(\/[^\s"']+?escrow\.wasm|[A-Za-z]:\\[^\s"']+?escrow\.wasm)/g)].map((m) => m[1]);
  const path = found.filter((p) => /[\\/]near[\\/]escrow\.wasm$/.test(p)).pop() ?? expected;
  if (!existsSync(path) || statSync(path).mtimeMs < started - 2000) return { error: `no freshly built wasm at ${path}` };
  return { path, how: mode === "reproducible" ? "cargo near build reproducible-wasm (docker, NEP-330), fresh" : "cargo near build non-reproducible-wasm (local toolchain), fresh; byte-exact only with the same toolchain, paths and Cargo.toml", mode };
}

async function partB() {
  line(`\n=== Part B: read-only mainnet checks for ${contractId} ===`);
  line(isTest ? "Target: the TEST instance (short periods, has a full-access key). The final key-less contract is not deployed yet (placeholder FINAL_CONTRACT_ID)." : "Target: the FINAL contract (must have no full-access keys and match the repo build).");
  line(`Explorer: ${EXPLORER}/address/${contractId}`);
  const entry = DATA.contracts[contractId];

  // 1. account + code hash
  let account;
  try {
    account = await rpc("query", { request_type: "view_account", finality: "final", account_id: contractId });
  } catch (e) {
    check("FAIL", "contract account exists on mainnet", e.message);
    return;
  }
  check("PASS", "contract account exists on mainnet", `code_hash ${account.code_hash}, storage ${account.storage_usage} B`);

  // 2. reproducible build vs code hash
  const built = localWasm();
  if (!built) {
    check("INFO", "code hash vs local build", "skipped (--build none)");
  } else if (built.error) {
    check(isTest ? "INFO" : "FAIL", "code hash vs local build", built.error);
  } else if (!existsSync(built.path)) {
    check(isTest ? "INFO" : "FAIL", "code hash vs local build", `wasm not found at ${built.path}`);
  } else {
    const bytes = readFileSync(built.path);
    const hex = createHash("sha256").update(bytes).digest("hex");
    const b58 = base58(Buffer.from(hex, "hex"));
    const same = b58 === account.code_hash;
    const detail = `local wasm: ${built.how}\n  sha256 hex ${hex}\n  sha256 b58 ${b58}\non chain:   ${account.code_hash}`;
    if (same) check("PASS", "deployed code = this repository's build (sha256 matches)", detail);
    else if (isTest)
      check(
        "INFO",
        "deployed code vs this repository's build: DIFFERENT (allowed for the TEST instance)",
        detail +
          "\nThe test instance was deployed on 2026-11-06 from a non-reproducible local build; since then contract/Cargo.toml changed" +
          "\n(the NEP-330 repository link baked into the wasm), so a fresh build differs. The exact-match check is meant for the" +
          "\nfinal contract, built from the public repository with `--build reproducible`.",
      );
    else check("FAIL", "deployed code = this repository's build", detail + (built.mode === "local" ? "\nA local (non-reproducible) build is not byte-exact; rerun with --build reproducible (needs docker)." : ""));
  }

  // NEP-330 source metadata (cargo-near bakes the repository link + commit into the wasm)
  try {
    const meta = await view(contractId, "contract_source_metadata");
    check("INFO", "NEP-330 contract_source_metadata", JSON.stringify(meta));
  } catch {
    check("INFO", "NEP-330 contract_source_metadata", "not exposed by this build");
  }

  // 3. full-access keys
  try {
    const keys = await rpc("query", { request_type: "view_access_key_list", finality: "final", account_id: contractId });
    const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess");
    const txt = `${keys.keys.length} key(s), ${full.length} full-access`;
    if (full.length === 0) check("PASS", "no full-access keys: nobody can redeploy or drain the contract account", txt);
    else check(isTest ? "INFO" : "FAIL", `full-access keys present (${full.length})${isTest ? ": expected on the TEST instance" : ""}`, txt + (isTest ? "\nThe final contract will have 0." : ""));
  } catch (e) {
    check("FAIL", "access key list", e.message);
  }

  // 4. config
  try {
    const c = await view(contractId, "get_config");
    const ns = (v) => `${Number(BigInt(v) / 1_000_000_000n)} s`;
    const periods = `review >= ${ns(c.min_review_period_ns)}, dispute ${ns(c.dispute_period_ns)}, pay-by ${ns(c.pay_by_period_ns)}, admin delay ${ns(c.admin_delay_ns)}`;
    check(c.token_id === USDC ? "PASS" : "FAIL", "accepted token is NEAR-native USDC", c.token_id);
    check("PASS", `config: ${c.deals_count} deals, fee max ${c.max_fee_bps} bps, total_liabilities ${c.total_liabilities}, fees accrued ${c.fee_accrued}`, `periods: ${periods}\nowner ${c.owner_id}\narbiter ${c.arbiter_id}\nrelayer ${c.relayer_id}`);
    if (!isTest && BigInt(c.dispute_period_ns) < 86_400_000_000_000n) check("FAIL", "final contract uses real periods", periods);
    if (entry && entry.relayer && entry.relayer.length === 64 && entry.relayer !== c.relayer_id) check("FAIL", "relayer in verify/mainnet-txs.json matches get_config", `${entry.relayer} vs ${c.relayer_id}`);
  } catch (e) {
    check("FAIL", "get_config", e.message);
  }

  // 5. listed transactions
  if (!entry || entry.txs.length === 0) {
    check(isTest ? "FAIL" : "INFO", "deal transactions", `no transactions listed for ${contractId} in verify/mainnet-txs.json`);
  } else {
    let ok = 0;
    const bad = [];
    const sigs = { ok: 0, total: 0, bad: [] };
    const keys = new Map(); // deal id -> {creator_pk, client_pk}
    const dealKeys = async (id) => {
      if (!keys.has(id)) {
        const d = (await view(contractId, "get_deal", { deal_id: id })) ?? (await view(contractId, "get_tombstone", { deal_id: id }));
        keys.set(id, d);
      }
      return keys.get(id);
    };
    const checkSig = async (t, args) => {
      // every relayed action must carry a deal-key signature the relayer could not make
      let who = null;
      if (t.method === "create_deal") {
        const o = JSON.parse(args.offer);
        if (verifyEd25519(o.creator_pk, `escrow-v1|${contractId}|offer|${args.offer}`, args.offer_signature)) who = "creator (offer)";
      } else if (t.method === "act") {
        const d = await dealKeys(args.deal_id);
        const msg = `escrow-v1|${contractId}|${args.deal_id}|${args.action}|${args.payload}`;
        if (verifyEd25519(d.creator_pk, msg, args.signature)) who = "creator";
        else if (verifyEd25519(d.client_pk, msg, args.signature)) who = "client";
      } else if (t.method === "settle") {
        const d = await dealKeys(args.deal_id);
        const msg = `escrow-v1|${contractId}|${args.deal_id}|settle|${args.payload}`;
        if (verifyEd25519(d.creator_pk, msg, args.creator_signature) && verifyEd25519(d.client_pk, msg, args.client_signature)) who = "creator + client";
      } else return; // deploy, arbiter: plain account transactions
      sigs.total++;
      if (who) sigs.ok++;
      else sigs.bad.push(`${t.hash}: no deal key verifies this ${t.method}`);
    };
    for (const t of entry.txs) {
      const sender = t.sender === "relayer" ? entry.relayer : t.sender === "arbiter" ? entry.arbiter : t.sender;
      try {
        const r = await rpc("tx", { tx_hash: t.hash, sender_account_id: sender, wait_until: "FINAL" }, ARCHIVAL);
        const fc = r.transaction.actions.map((a) => a.FunctionCall?.method_name).filter(Boolean);
        const success = r.status && "SuccessValue" in r.status;
        const args = (() => {
          const a = r.transaction.actions.find((x) => x.FunctionCall)?.FunctionCall;
          try {
            return JSON.parse(Buffer.from(a.args, "base64").toString());
          } catch {
            return {};
          }
        })();
        const dealOk = t.deal === null || t.method === "create_deal" || args.deal_id === t.deal;
        const actOk = t.method !== "act" || t.action.startsWith(args.action);
        if (success && r.transaction.receiver_id === contractId && fc.includes(t.method) && dealOk && actOk) ok++;
        else bad.push(`${t.hash}: success=${success} receiver=${r.transaction.receiver_id} methods=${fc} deal=${args.deal_id} action=${args.action}`);
        try {
          await checkSig(t, args);
        } catch (e) {
          sigs.total++;
          sigs.bad.push(`${t.hash}: ${e.message}`);
        }
      } catch (e) {
        bad.push(`${t.hash}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    check(bad.length === 0 ? "PASS" : "FAIL", `deal transactions found on mainnet, succeeded, right contract/method/deal: ${ok}/${entry.txs.length}`, bad.join("\n") || `e.g. ${EXPLORER}/txns/${entry.txs[1]?.hash ?? entry.txs[0].hash}`);
    if (sigs.total)
      check(
        sigs.bad.length === 0 ? "PASS" : "FAIL",
        `relayed actions carry a valid deal-key signature (re-verified here with ed25519): ${sigs.ok}/${sigs.total}`,
        sigs.bad.join("\n") || "joins: creator's offer signature; act: creator or client key; settle: both keys. The relayer only paid gas.",
      );
  }

  // 6. deal outcomes
  if (entry && Object.keys(entry.deals).length) {
    const bad = [];
    let ok = 0;
    for (const [id, want] of Object.entries(entry.deals)) {
      try {
        const d = await view(contractId, "get_deal", { deal_id: Number(id) });
        if (d && JSON.stringify(d.outcome) === JSON.stringify(want)) ok++;
        else bad.push(`deal ${id}: state ${d?.state} outcome ${JSON.stringify(d?.outcome)} (expected ${JSON.stringify(want)})`);
      } catch (e) {
        bad.push(`deal ${id}: ${e.message}`);
      }
    }
    check(bad.length === 0 ? "PASS" : "FAIL", `deal outcomes on chain match the table: ${ok}/${Object.keys(entry.deals).length}`, bad.join("\n") || Object.entries(entry.deals).map(([i, w]) => `deal ${i}: ${JSON.stringify(w)}`).join(", "));
  }
}

// ---------------------------------------------------------------- main
line("Pinky judge — see VERIFY.md for what each check means.");
if (!flag("skip-sandbox")) partA();
if (!flag("skip-mainnet")) await partB();

const fails = results.filter((r) => r.status === "FAIL");
const counts = ["PASS", "INFO", "FAIL"].map((s) => `${s.toLowerCase()}=${results.filter((r) => r.status === s).length}`).join(" ");
line(`\nVERIFY_RESULT ${fails.length === 0 ? "OK" : "FAILED"} ${counts} contract=${contractId}${isTest ? " (TEST instance)" : ""}`);
if (finalPlaceholder) line("Note: FINAL_CONTRACT_ID is still a placeholder; rerun with --contract <final id> after it is deployed.");
process.exit(fails.length === 0 ? 0 : 1);
