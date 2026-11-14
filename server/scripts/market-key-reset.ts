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
//        being changed" and the CURRENT key can cancel it with one signature
//        (unless the reset has a verified-account proof, see below).
//   confirm <reset_id> --auto
//        The site reads the bio of <account_url> itself (YouTube / Behance, the
//        same rules as the site). If it cannot read it, check by hand (--seen-in-bio).
//   cancel <reset_id>      stop a reset in progress
//   list [profile_id]      resets (newest first), incl. the code and the account
//   apply-due              apply confirmed resets whose 72 h passed (the server does this too)
//
// When <account_url> is an account CONFIRMED on this profile
// (ops/accounts.sh, "account confirmed: @handle") at least 14 days before the
// reset, the reset carries a verified-account proof: the current key can NOT
// cancel it (a thief with the stolen key cannot stop it); only you can
// (cancel). Without it, the current key can cancel with one signature.
// The 14 days: a thief holding the key could add and confirm an account of
// their own; it shows on the public profile long before it counts.
// On a theft report, hide the profile at once (ops/profile-hide.sh) and talk
// to the owner. Pausing a profile is still your call (no proof rule in code).
//
// DB: $DB_PATH, or DB_PATH from $ENV_FILE (same as the server).
// Run: node --disable-warning=ExperimentalWarning dist/scripts/market-key-reset.js <command> ...

import { randomBytes, randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { loadEnvFiles, readConfig } from '../src/config.ts';
import { parsePublicKey } from '../src/encoding.ts';
import { KEY_RESET_DELAY_MS, verifiedProof } from '../src/market.ts';
import { parseAccountUrl, processChecker, type AccountChecker } from '../src/accounts.ts';
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
      const proof = verifiedProof(ms, pid, account, ms.nowMs());
      const r = ms.insertReset({
        reset_id: randomBytes(8).toString('hex'),
        profile_id: pid,
        old_pk: p.profile_pk,
        new_pk: newPk,
        account_url: proof ? proof.url : account,
        code: resetCode(),
        proof: proof ? 'verified' : null,
      });
      out(`reset ${r.reset_id} issued for "${p.nickname}" (${pid})`);
      out(
        proof
          ? `PROOF: ${proof.handle} is an account confirmed on this profile since ${proof.confirmed_at}. The current key will NOT be able to cancel this reset.`
          : 'No verified-account proof (no account at this link confirmed on this profile 14+ days ago): the current key CAN cancel this reset.',
      );
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
      return confirm(ms, rid, out);
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
      return fail(
        'usage: issue <profile_id> <new_profile_pk> <account_url> | confirm <reset_id> --seen-in-bio|--auto | cancel <reset_id> | list [profile_id] | apply-due',
      );
  }
}

function confirm(ms: MarketStore, rid: string, out: (s: string) => void): number {
  const r = ms.getReset(rid);
  if (!r) {
    out(`error: no reset ${rid}`);
    return 1;
  }
  // The proof holds only while the account is still confirmed.
  if (r.proof === 'verified' && !verifiedProof(ms, r.profile_id, r.account_url, Date.parse(r.issued_at))) {
    ms.dropResetProof(rid);
    out('NOTE: the account is no longer confirmed on this profile: no verified-account proof; the current key CAN cancel.');
  }
  if (!ms.confirmReset(rid, KEY_RESET_DELAY_MS)) {
    out(`error: reset ${rid} is ${r.status}, not issued`);
    return 1;
  }
  const now = ms.getReset(rid)!;
  out(
    `confirmed: the new key of ${r.profile_id} takes effect ${now.effective_at} (72 h). ${
      now.proof === 'verified' ? 'Verified-account proof: only you can cancel it.' : 'Until then the current key can cancel.'
    }`,
  );
  return 0;
}

/** `confirm <reset_id> --auto`: the site reads the bio itself (same rules as the site); "found" confirms. */
export async function confirmAuto(ms: MarketStore, rid: string, out: (s: string) => void = console.log, checker: AccountChecker = processChecker()): Promise<number> {
  const r = ms.getReset(rid);
  if (!r) {
    out(`error: no reset ${rid}`);
    return 1;
  }
  const ref = parseAccountUrl(r.account_url);
  if (!ref) {
    out('error: the site can only read YouTube / Behance account pages; check by hand (--seen-in-bio)');
    return 1;
  }
  const result = await checker.check({ platform: ref.platform, url: ref.url, handle: ref.handle, codes: [r.code, r.code.replace('СБРОС-КЛЮЧА', 'PINKY-KEY-RESET')] });
  if (result !== 'found') {
    out(`the site could not see the code (${result}). Open ${r.account_url} yourself; if the code is there: confirm ${rid} --seen-in-bio`);
    return 1;
  }
  out('the code is in the bio (read by the site).');
  return confirm(ms, rid, out);
}

// Run as a script (not when a test imports it).
if (process.argv[1] && /market-key-reset\.(js|ts)$/.test(process.argv[1])) {
  loadEnvFiles();
  const db = new DatabaseSync(readConfig().dbPath);
  const ms = new MarketStore(db);
  const args = process.argv.slice(2);
  const code = args[0] === 'confirm' && args[2] === '--auto' && args[1] ? await confirmAuto(ms, args[1]) : run(ms, args);
  db.close();
  process.exit(code);
}
