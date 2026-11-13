// Operator tool for the marketplace: hide a profile
// or a review. Edits the server's SQLite DB directly; there is no public admin
// route. Safe while the server runs (SQLite WAL + busy timeout).
//
//   hide <profile_id>            hide a profile from the catalog and its page
//   unhide <profile_id>
//   reviews <profile_id>         list its reviews (with the deal handle to hide one)
//   hide-review <deal_handle>    hide one review (counters are recounted)
//   unhide-review <deal_handle>
//
// DB: $DB_PATH, or DB_PATH from $ENV_FILE (same as the server).

import { DatabaseSync } from 'node:sqlite';

import { loadEnvFiles, readConfig } from '../src/config.ts';
import { MarketStore } from '../src/market-store.ts';

loadEnvFiles();
const dbPath = readConfig().dbPath;
const [cmd, arg] = process.argv.slice(2);
const usage = 'usage: profile-hide.sh <profile_id> [unhide] | reviews <profile_id> | hide-review <deal_handle> | unhide-review <deal_handle>';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

if (!cmd || !arg) fail(usage);
const db = new DatabaseSync(dbPath);
const ms = new MarketStore(db);
const isProfile = (s: string) => /^[0-9a-f]{24}$/.test(s);
const isHandle = (s: string) => /^[0-9a-f]{64}$/.test(s);

switch (cmd) {
  case 'hide':
  case 'unhide': {
    if (!isProfile(arg)) fail('profile_id must be 24 hex chars');
    if (!ms.setOperatorHidden(arg, cmd === 'hide')) fail(`no profile ${arg} in ${dbPath}`);
    const p = ms.getProfile(arg)!;
    console.log(`${cmd === 'hide' ? 'hidden' : 'shown'}: ${arg} "${p.nickname}" (self-hidden: ${p.self_hidden})`);
    break;
  }
  case 'reviews': {
    if (!isProfile(arg)) fail('profile_id must be 24 hex chars');
    const rows = ms.allReviewsOf(arg);
    if (!rows.length) console.log('no reviews');
    for (const r of rows) {
      console.log(`${r.deal_handle}  ${r.rating}★  ${r.created_at.slice(0, 7)}${r.refunded ? '  refunded' : ''}${r.hidden ? '  HIDDEN' : ''}  ${JSON.stringify(r.text)}`);
    }
    break;
  }
  case 'hide-review':
  case 'unhide-review': {
    if (!isHandle(arg)) fail('deal_handle must be 64 hex chars');
    const pid = ms.setReviewHidden(arg, cmd === 'hide-review');
    if (!pid) fail(`no review for deal ${arg} in ${dbPath}`);
    console.log(`${cmd === 'hide-review' ? 'hidden' : 'shown'}: review of deal ${arg} (profile ${pid}); counters recounted`);
    break;
  }
  default:
    fail(usage);
}
db.close();
