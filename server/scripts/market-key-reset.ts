// Operator tool: replace a creator's profile key after a support check.
// Edits the server's SQLite DB directly; there
// is no public admin route. Safe while the server runs (SQLite WAL + busy
// timeout); the server applies a confirmed reset by itself once 72 h passed.
//
//   issue <profile_id> <new_profile_pk> <account_url>
//        The owner made a NEW profile key on the site ("Lost your key?" in the
//        profile editor) and sent you its public key. <account_url> = an
//        account the profile pointed to BEFORE the trouble (portfolio link or
//        contact). Prints a reset code for the owner to put in that account's bio.
//   confirm <reset_id> --seen-in-bio
//        You opened <account_url> yourself and saw the code in the bio. The new
//        key takes effect in 72 h; until then the profile shows "the key is
//        being changed" and the CURRENT key can cancel it with one signature.
//   cancel <reset_id>      stop a reset in progress
//   list [profile_id]      resets (newest first), incl. the code and the account
//   apply-due              apply confirmed resets whose 72 h passed (the server does this too)
//
// Limits (honest): the bio is checked BY HAND. The automatic check of a
// verified account is not built, so this is not yet the
// "verified account beats the current key" rule: the current key can
// cancel every reset. On a theft report, hide the profile at once
// (`scripts/market-admin.ts hide`) and talk to the owner.
//
// DB: $DB_PATH, or DB_PATH from $ENV_FILE (same as the server).
// Run: node --disable-warning=ExperimentalWarning dist/scripts/market-key-reset.js <command> ...

import { randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { loadEnvFiles, readConfig } from '../src/config.ts';
import { parsePublicKey } from '../src/encoding.ts';
import { KEY_RESET_DELAY_MS } from '../src/market.ts';
import { MarketStore, type KeyResetRow } from '../src/market-store.ts';

/** Crockford base32 without look-alikes. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The reset code: looks unlike any other code of the site and
 * explains itself. 8 random characters (40 bits); the operator compares it by eye.
 */
export function resetCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `СБРОС-КЛЮЧА-${s.slice(0, 4)}-${s.slice(4)}`;
}

/** The lines the owner puts in the bio (a Russian line plus an English one). */
export const bioLines = (code: string): string[] => [
  `${code} — если вы не просили сброс ключа Pinky, не ставьте это`,
  `${code.replace('СБРОС-КЛЮЧА', 'PINKY-KEY-RESET')} — if you did not ask Pinky support to reset your key, do not post this`,
];

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? u.hostname.toLowerCase().replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

function show(r: KeyResetRow): string {
  const when = r.status === 'pending' ? `  takes effect ${r.effective_at}` : r.done_at ? `  ${r.status} ${r.done_at}` : '';
  return `${r.reset_id}  ${r.status.padEnd(9)} profile ${r.profile_id}  issued ${r.issued_at}${when}${r.cancelled_by ? ` by ${r.cancelled_by}` : ''}\n    account ${r.account_url}\n    code    ${r.code}\n    new key ${r.new_pk}`;
}

export function run(ms: MarketStore, args: string[], out: (s: string) => void = console.log): number {
  const [cmd, ...rest] = args;
  const fail = (msg: string) => {
    out(`error: ${msg}`);
    return 1;
  };
  switch (cmd) {
    case 'issue': {
      const [pid, newPk, account] = rest;
      if (!pid || !newPk || !account) return fail('usage: issue <profile_id> <new_profile_pk> <account_url>');
      if (!/^[0-9a-f]{24}$/.test(pid)) return fail('profile_id must be 24 hex chars');
      const p = ms.getProfile(pid);
      if (!p) return fail(`no profile ${pid}`);
      if (!parsePublicKey(newPk)) return fail('new_profile_pk must be "ed25519:<base58>" (the owner copies it from the site)');
      if (newPk === p.profile_pk) return fail('this is already the key of the profile');
      if (ms.profileByKey(newPk)) return fail('this key already belongs to a profile; the owner must make a NEW key');
      if (ms.resetForNewKey(newPk)) return fail('this key is already in another reset');
      const open = ms.openReset(pid);
      if (open) return fail(`a reset is already in progress: ${open.reset_id} (${open.status}); cancel it first`);
      const host = hostOf(account);
      if (!host) return fail('account_url must be an https link');
      const known = [...p.portfolio, ...p.contacts.map((c) => c.value)].some((v) => v.toLowerCase().includes(host) || hostOf(v) === host);
      const r = ms.insertReset({ reset_id: randomBytes(8).toString('hex'), profile_id: pid, old_pk: p.profile_pk, new_pk: newPk, account_url: account, code: resetCode() });
      out(`reset ${r.reset_id} issued for "${p.nickname}" (${pid})`);
      if (!known) out(`WARNING: ${host} is not among the profile's links now. Use only an account the profile showed BEFORE the trouble.`);
      out('Send the owner this text. They put ONE of the lines in the bio of:');
      out(`  ${account}`);
      for (const l of bioLines(r.code)) out(`  ${l}`);
      out(`Then open the account yourself, find the code, and run: confirm ${r.reset_id} --seen-in-bio`);
      return 0;
    }
    case 'confirm': {
      const [rid, flag] = rest;
      if (!rid || flag !== '--seen-in-bio') return fail('usage: confirm <reset_id> --seen-in-bio   (only after you saw the code in the bio yourself)');
      const r = ms.getReset(rid);
      if (!r) return fail(`no reset ${rid}`);
      if (!ms.confirmReset(rid, KEY_RESET_DELAY_MS)) return fail(`reset ${rid} is ${r.status}, not issued`);
      const now = ms.getReset(rid)!;
      out(`confirmed: the new key of ${r.profile_id} takes effect ${now.effective_at} (72 h). Until then the current key can cancel.`);
      return 0;
    }
    case 'cancel': {
      const [rid] = rest;
      if (!rid) return fail('usage: cancel <reset_id>');
      if (!ms.cancelReset(rid, 'operator')) return fail(`no reset ${rid} in progress`);
      out(`cancelled: ${rid}`);
      return 0;
    }
    case 'list': {
      const rows = ms.resets(200, rest[0]);
      if (!rows.length) out('no resets');
      for (const r of rows) out(show(r));
      return 0;
    }
    case 'apply-due': {
      const done = ms.applyDueResets();
      out(done.length ? done.map((r) => `applied: ${r.reset_id} profile ${r.profile_id}`).join('\n') : 'nothing due');
      return 0;
    }
    default:
      return fail('usage: issue <profile_id> <new_profile_pk> <account_url> | confirm <reset_id> --seen-in-bio | cancel <reset_id> | list [profile_id] | apply-due');
  }
}

// Run as a script (not when a test imports it).
if (process.argv[1] && /market-key-reset\.(js|ts)$/.test(process.argv[1])) {
  loadEnvFiles();
  const db = new DatabaseSync(readConfig().dbPath);
  const code = run(new MarketStore(db), process.argv.slice(2));
  db.close();
  process.exit(code);
}
