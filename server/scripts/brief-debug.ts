// DEBUG ONLY, read-only: one real brief call to NEAR AI Cloud, then the same
// verification steps as the /api/brief route, printing which step passes or
// fails. Never prints the API key or the auth header.
//
// Usage (WSL): node --disable-warning=ExperimentalWarning dist/scripts/brief-debug.js [path/to/server.env] [model]
// Costs one small chat completion on the account of that key.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { answerOf, briefRequestBody, cleanChecklist, makeVerifier } from '../src/brief.ts';

const envFile = process.argv[2] || 'server.env';
const env: Record<string, string> = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const apiKey = env.NEARAI_API_KEY ?? '';
const base = (env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/+$/, '');
const model = process.argv[3] || env.NEARAI_MODEL || 'Qwen/Qwen3.8-27B';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const t0 = Date.now();
const log = (step: string, detail = '') => console.log(`[${String(Date.now() - t0).padStart(6)} ms] ${step.padEnd(12)} ${detail}`);

if (!apiKey) {
  console.log(`NEARAI_API_KEY is not set in ${envFile}`);
  process.exit(1);
}
log('setup', `base=${base} model=${model} key=set`);

const user = 'Client request:\nLogo animation for our token launch, 8 seconds, for X and Telegram';
const headers = { Authorization: `Bearer ${apiKey}`, accept: 'application/json', 'content-type': 'application/json' };

async function call(body: string) {
  const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body, signal: AbortSignal.timeout(60_000) });
  return { res, text: await res.text() };
}

let requestBody = briefRequestBody(model, user);
let { res, text } = await call(requestBody);
log('chat', `status ${res.status}, ${text.length} bytes`);
if (res.status === 400 || res.status === 422) {
  log('chat', `refused (${text.slice(0, 200)}); retrying without chat_template_kwargs`);
  requestBody = briefRequestBody(model, user, false);
  ({ res, text } = await call(requestBody));
  log('chat', `status ${res.status}, ${text.length} bytes`);
}
if (!res.ok) {
  log('FAIL', `chat error: ${text.slice(0, 300)}`);
  process.exit(1);
}
const parsed = JSON.parse(text) as Record<string, unknown>;
const { content, reasoningOnly } = answerOf(parsed);
log('answer', `id=${String(parsed.id)} model=${String(parsed.model)} content=${content.length} chars reasoningOnly=${reasoningOnly}`);
log('answer', `top-level keys: ${Object.keys(parsed).join(',')}`);
console.log(cleanChecklist(content).split('\n').map((l) => `             | ${l}`).join('\n'));
log('hashes', `our request sha256=${sha(requestBody)} response sha256=${sha(text)}`);

const verifier = makeVerifier({ base, model, apiKey, fetch, now: Date.now, trace: (s, d) => log(s, d) });
try {
  const r = await verifier.check(String(parsed.id), requestBody, text);
  log('OK', `verified; TEE signer ${r.signer}; GPU ${r.gpu ? 'checked by NVIDIA' : 'SKIPPED (NRAS not reachable) -> site shows the TDX-only wording'}`);
} catch (e) {
  log('FAIL', e instanceof Error ? e.message : String(e));
  // Extra look at the signature answer (no secrets in it).
  try {
    const r = await fetch(`${base}/signature/${encodeURIComponent(String(parsed.id))}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`, {
      headers: { Authorization: headers.Authorization, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const s = await r.text();
    log('sig raw', `status ${r.status}: ${s.slice(0, 600)}`);
  } catch (e2) {
    log('sig raw', `no answer (${e2 instanceof Error ? e2.message : 'error'})`);
  }
  process.exitCode = 2;
}
