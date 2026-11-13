// Operator tool for the "Report" button. Reads the
// server's SQLite DB directly; there is no public admin route.
//
//   list [all]            open reports, newest first ("all" = closed ones too)
//   show <id>             one report: what was reported, its text, and the
//                         exact command that hides it
//   close <id> [all]      mark it checked ("all" = every open report about the same thing)
//
// Hiding uses the existing tool (scripts/market-admin.ts):
//   node dist/scripts/market-admin.js hide <profile_id>
//   node dist/scripts/market-admin.js hide-review <deal_handle>
// On the hosted API run these inside the app container (DB_PATH is set there).
// DB: $DB_PATH, or DB_PATH from $ENV_FILE (same as the server).

import { DatabaseSync } from 'node:sqlite';

import { loadEnvFiles, readConfig } from '../src/config.ts';
import { MarketStore } from '../src/market-store.ts';
import { ReportStore, type ReportRow } from '../src/reports.ts';

loadEnvFiles();
const dbPath = readConfig().dbPath;
const [cmd, arg, extra] = process.argv.slice(2);
const usage = 'usage: reports.js list [all] | show <id> | close <id> [all]';

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
const rs = new ReportStore(db);
const ms = new MarketStore(db);
const ADMIN = 'node dist/scripts/market-admin.js';

const oneLine = (s: string, max = 80) => {
  const t = JSON.stringify(s);
  return t.length > max ? `${t.slice(0, max - 1)}…"` : t;
};

function line(r: ReportRow): string {
  return `#${r.id}  ${r.created_at.slice(0, 16).replace('T', ' ')}  ${r.kind} ${r.target_id}  ${r.reason}${r.status === 'closed' ? '  CLOSED' : ''}${r.text ? `  ${oneLine(r.text)}` : ''}`;
}

/** What was reported, as the operator needs it to decide, and how to hide it. */
function describe(r: ReportRow): string[] {
  switch (r.kind) {
    case 'profile': {
      const p = ms.getProfile(r.target_id);
      if (!p) return ['profile: no longer exists'];
      return [
        `profile "${p.nickname}"${p.hidden ? ' (ALREADY HIDDEN by the operator)' : ''}${p.self_hidden ? ' (hidden by its owner)' : ''}`,
        `bio: ${JSON.stringify(p.bio)}`,
        `work links: ${p.portfolio.join(' ') || '-'}`,
        `page: /creators/${p.profile_id}`,
        `hide it: ${ADMIN} hide ${p.profile_id}`,
      ];
    }
    case 'review':
    case 'reply': {
      const v = ms.getReviewById(r.target_id);
      if (!v) return ['review: no longer exists'];
      return [
        `review on /creators/${v.profile_id}: ${v.rating}★ ${JSON.stringify(v.text)}${v.hidden ? ' (ALREADY HIDDEN)' : ''}`,
        `creator's answer: ${v.reply_text === null ? '-' : JSON.stringify(v.reply_text)}`,
        `hide the review (its answer goes with it): ${ADMIN} hide-review ${v.deal_handle}`,
        ...(r.kind === 'reply' ? [`or, if the creator's answer is the problem, hide the creator: ${ADMIN} hide ${v.profile_id}`] : []),
      ];
    }
    case 'request': {
      const q = ms.getRequest(r.target_id);
      if (!q) return ['request: no longer exists'];
      const p = ms.getProfile(q.profile_id);
      return [
        `request to "${p?.nickname ?? '?'}" (/creators/${q.profile_id}), status ${q.status}, ${q.created_at.slice(0, 10)}`,
        `brief: ${JSON.stringify(q.brief)}`,
        `client contact: ${q.contact_kind} ${JSON.stringify(q.contact_value)}`,
        'A request is private between the two sides: there is nothing public to hide. The creator can decline it in the inbox.',
      ];
    }
  }
}

switch (cmd) {
  case 'list': {
    const rows = rs.list({ all: arg === 'all' });
    if (!rows.length) console.log(arg === 'all' ? 'no reports' : 'no open reports');
    for (const r of rows) console.log(line(r));
    break;
  }
  case 'show': {
    const id = Number(arg);
    const r = Number.isInteger(id) && id > 0 ? rs.get(id) : null;
    if (!r) fail(`no report ${arg ?? ''} in ${dbPath}`);
    console.log(line(r));
    if (r.text) console.log(`report text: ${JSON.stringify(r.text)}`);
    for (const l of describe(r)) console.log(`  ${l}`);
    console.log(`  open reports about this: ${rs.countOpenFor(r.kind, r.target_id)}; when done: node dist/scripts/reports.js close ${r.id} all`);
    break;
  }
  case 'close': {
    const id = Number(arg);
    if (!Number.isInteger(id) || id <= 0 || !rs.get(id)) fail(`no report ${arg ?? ''} in ${dbPath}`);
    const n = rs.close(id, extra === 'all');
    console.log(`closed ${n} report(s)`);
    break;
  }
  default:
    fail(usage);
}
db.close();
