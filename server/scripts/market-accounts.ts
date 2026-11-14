// Operator tool: creator accounts with a verification code in the bio
//. Edits the server's SQLite DB directly; there is no
// public admin route. Safe while the server runs (SQLite WAL + busy timeout).
//
//   waiting                 accounts a person must look at: X (the site cannot
//                           read X bios without signing in) and pages the site
//                           could not read (blocked, sign-in or consent page).
//                           Also confirmed-by-hand accounts not looked at for 30 days.
//   list [profile_id]       every account (newest first) with its code and log
//   confirm <account_id> --seen-in-bio
//                           you opened the account yourself and saw the code in
//                           the bio: the profile shows "account confirmed: @handle"
//                           (the log keeps "operator"). Look again now and then:
//                           the site cannot re-read X by itself.
//   lost <account_id>       the code is gone or the account changed hands: the mark goes
//   recheck [account_id]    read the bios again now (YouTube / Behance; one account or all confirmed)
//
// DB: $DB_PATH, or DB_PATH from $ENV_FILE (same as the server).
// Run: node --disable-warning=ExperimentalWarning dist/scripts/market-accounts.js <command> ...

import { DatabaseSync } from 'node:sqlite';

import { AUTO_PLATFORMS, processChecker, type AccountChecker } from '../src/accounts.ts';
import { loadEnvFiles, readConfig } from '../src/config.ts';
import { MarketStore, type AccountRow } from '../src/market-store.ts';

const HAND_RECHECK_MS = 30 * 24 * 3600 * 1000;

function show(a: AccountRow): string {
  const read = a.checked_ms ? new Date(a.checked_ms).toISOString() : 'never';
  return [
    `${a.account_id}  ${a.status.padEnd(9)} ${a.platform.padEnd(8)} ${a.handle}  profile ${a.profile_id}`,
    `    url     ${a.url}`,
    `    code    ${a.code}`,
    `    log     added ${a.created_at}${a.confirmed_at ? `, confirmed ${a.confirmed_at} by ${a.method ?? '?'}` : ''}${a.lost_at ? `, lost ${a.lost_at}` : ''}; last read ${read}: ${a.last_result ?? '-'}`,
  ].join('\n');
}

export async function run(ms: MarketStore, args: string[], out: (s: string) => void = console.log, checker: AccountChecker = processChecker(), now: () => number = () => ms.nowMs()): Promise<number> {
  const [cmd, ...rest] = args;
  const fail = (msg: string) => {
    out(`error: ${msg}`);
    return 1;
  };
  switch (cmd) {
    case 'waiting': {
      const rows = [
        ...ms.accountsByStatus('review'),
        ...ms.accountsByStatus('waiting').filter((a) => !AUTO_PLATFORMS.includes(a.platform as never)),
        ...ms.accountsByStatus('confirmed').filter((a) => a.method === 'operator' && !AUTO_PLATFORMS.includes(a.platform as never) && now() - a.checked_ms > HAND_RECHECK_MS),
      ];
      if (!rows.length) out('nothing to look at');
      for (const a of rows) out(show(a));
      if (rows.length) out('Open each url yourself. Code in the bio: confirm <account_id> --seen-in-bio. Confirmed but code gone: lost <account_id>.');
      return 0;
    }
    case 'list': {
      const rows = rest[0] ? ms.accountsOf(rest[0]) : ms.allAccounts();
      if (!rows.length) out('no accounts');
      for (const a of rows) out(show(a));
      return 0;
    }
    case 'confirm': {
      const [aid, flag] = rest;
      if (!aid || flag !== '--seen-in-bio') return fail('usage: confirm <account_id> --seen-in-bio   (only after you saw the code in the bio yourself)');
      const a = ms.getAccount(aid);
      if (!a) return fail(`no account ${aid}`);
      ms.confirmByOperator(aid);
      out(`confirmed by hand: ${a.handle} (${a.platform}) on profile ${a.profile_id}`);
      return 0;
    }
    case 'lost': {
      const [aid] = rest;
      if (!aid) return fail('usage: lost <account_id>');
      if (!ms.markLost(aid)) return fail(`no account ${aid}`);
      out(`mark removed: ${aid}`);
      return 0;
    }
    case 'recheck': {
      const rows = rest[0] ? [ms.getAccount(rest[0])].filter((a): a is AccountRow => !!a) : ms.accountsByStatus('confirmed');
      if (rest[0] && !rows.length) return fail(`no account ${rest[0]}`);
      for (const a of rows) {
        const result = await checker.check({ platform: a.platform as never, url: a.url, handle: a.handle, codes: [a.code] });
        const after = ms.recordCheck(a.account_id, result === 'refused' ? 'unreadable' : result)!;
        out(`${a.account_id} ${a.handle}: ${result} -> ${after.status}`);
      }
      if (!rows.length) out('no confirmed accounts');
      return 0;
    }
    default:
      return fail('usage: waiting | list [profile_id] | confirm <account_id> --seen-in-bio | lost <account_id> | recheck [account_id]');
  }
}

// Run as a script (not when a test imports it).
if (process.argv[1] && /market-accounts\.(js|ts)$/.test(process.argv[1])) {
  loadEnvFiles();
  const db = new DatabaseSync(readConfig().dbPath);
  const code = await run(new MarketStore(db), process.argv.slice(2));
  db.close();
  process.exit(code);
}
